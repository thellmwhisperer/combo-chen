/**
 * @overview Director application services for initial-gate retry and pre/post-PR orchestration.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at tickDirector          <- one deterministic observer pass (pre- and post-PR).
 *   2. Then syncDirectorPrLabels     <- best-effort GitHub PR label projection.
 *   3. Then runInitialGateRetryIfNeeded <- pre-PR gate failure recovery.
 *   4. Then runReadyForMergeIfNeeded <- current-head READY agreement.
 *   5. READY pure helpers            <- head, gate, and review predicates.
 *
 *   MAIN FLOW
 *   ---------
 *   runInitialGateRetryIfNeeded -> inspectWorkerPanes -> wait for PR -> tickReviewer -> auto-closure or nudgeReviewComments
 *     -> runPostAddressGateIfNeeded -> route local PR-head sync recovery -> runReadyForMergeIfNeeded -> syncDirectorPrLabels
 *
 *   PUBLIC API
 *   ----------
 *   DirectorDeps              Dependencies for director ticks.
 *   tickDirector              Run one director-owned observer pass.
 *   headStateAllowsReady      Pure PR-head readiness predicate.
 *   gateStateAllowsReady      Pure gate/current-head readiness predicate.
 *   reviewStateAllowsReady    Pure reviewer/current-head readiness predicate.
 *
 *   INTERNALS
 *   ---------
 *   syncDirectorPrLabels, runInitialGateRetryIfNeeded, runReadyForMergeIfNeeded, workerWindowsForEvents,
 *   worker recovery helpers, human-hold helpers, retry-count helpers, required READY check helpers, review-comment helpers
 *
 * @exports DirectorDeps, tickDirector, headStateAllowsReady, gateStateAllowsReady, reviewStateAllowsReady
 * @deps ../../core/combo, ../../core/events, ../../core/gh-api, ../../core/state, ../../infra/config-snapshot, ../../infra/tmux, ../gate/gate, ../github/checks, ../github/github, ../lifecycle/closure, ../runtime/sessions, ./coder, ./pr-labels, ./reviewer, ./watch-status, ./worker-monitor
 */
import { deriveStatus } from "../../core/combo.js";
import { appendEvent, latestPrUrlFromEvents, readEvents, type ComboEvent } from "../../core/events.js";
import { createGhApiCache } from "../../core/gh-api.js";
import { comboHome, readCombo, runDirFor } from "../../core/state.js";
import { loadRuntimeConfig } from "../../infra/config-snapshot.js";
import type { TmuxResult } from "../../infra/tmux.js";
import { nudgePrConflict, nudgeReviewComments, recoverDeadCoder, recoverStuckWorker } from "./coder.js";
import {
  checkRollupSucceeded,
  externalReviewSkippedByConfiguredAgent,
  requiredChecksSucceeded,
} from "../github/checks.js";
import { closeMergedCombo } from "../lifecycle/closure.js";
import { buildDirectorWatchStatusLine, type DirectorWatchPrSnapshot } from "./watch-status.js";
import { latestGateStatus, latestPublishedGateSha, GATEKEEPER_WINDOW } from "../gate/gate.js";
import { blockingReadyMergeState, parsePrView } from "../github/github.js";
import { syncComboPrLabels } from "./pr-labels.js";
import {
  closurePendingReviewerEvent,
  livePinnedLgtmSha,
  terminalReviewerEvent,
  tickReviewer,
} from "./reviewer.js";
import { CODER_WINDOW, REVIEWER_WINDOW } from "../runtime/sessions.js";
import {
  appendWorkerEscalation,
  inspectWorkerPanes,
  resetWorkerSnapshot,
  workerRecoveryAttempts,
  type WorkerPaneFinding,
} from "./worker-monitor.js";

// -- 1/3 HELPER · Dependency contract --
export interface DirectorDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  tmux: (args: string[]) => TmuxResult;
  git: (args: string[], cwd: string) => { status: number; stdout: string; stderr: string };
  treehouse: (args: string[], cwd: string) => { status: number; stdout: string; stderr: string };
  gh: (args: string[]) => { status: number; stdout: string; stderr: string };
  noMistakes: (
    args: string[],
    cwd: string,
    options?: { timeoutMs?: number },
  ) => { status: number; stdout: string; stderr: string };
  sleep: (ms: number) => Promise<void>;
}
// -/ 1/3

// -- 2/3 CORE · tickDirector <- START HERE --
export async function tickDirector(input: {
  deps: DirectorDeps;
  home: string;
  comboId: string;
  cli: string;
}): Promise<void> {
  const { deps, home, comboId, cli } = input;
  const runDir = runDirFor(home, comboId);
  const combo = readCombo(runDir);
  const ghApiCache = createGhApiCache();
  const config = loadRuntimeConfig(runDir, { repoDir: combo.repoDir, env: deps.env });
  const initialGateActioned = await runInitialGateRetryIfNeeded({
    deps,
    combo,
    runDir,
    cli,
    events: readEvents(runDir),
    retryAttempts: config.gatekeeperInitialGateRetryAttempts,
    backoffSeconds: config.gatekeeperInitialGateRetryBackoffSeconds,
  });
  if (initialGateActioned) {
    emitTickComplete({
      deps,
      comboId,
      cli,
      runDir,
      pollSeconds: config.limits.babysitPollSeconds,
      readyRequiredChecks: config.readyRequiredChecks,
      ambientCheckNames: config.externalCommentAgents,
    });
    return;
  }

  let events = readEvents(runDir);
  let workerSummaries: string[] = [];
  const workerWindows = workerWindowsForEvents(events, CODER_WINDOW);
  const workerHoldReason = activeNonWorkerNeedsHumanReason(events);
  if (workerWindows.length > 0 && workerHoldReason !== undefined) {
    const summary = `worker recovery paused: needs_human ${workerHoldReason}`;
    workerSummaries = [summary];
    deps.out(`director: ${summary}`);
  } else if (workerWindows.length > 0) {
    const prAlreadyOpened = latestPrUrlFromEvents(events) !== undefined;
    const workerInspection = inspectWorkerPanes({
      deps,
      combo,
      runDir,
      workerWindows,
      stallTicks: config.workerStallTicks,
      coderGnhfProgressMaxAgeMs: config.coderGnhfProgressMaxAgeMs,
      gatekeeperStatusTimeoutMs: config.gatekeeperStatusTimeoutMs,
      recoverableDeadWorkers: prAlreadyOpened ? [] : [CODER_WINDOW],
      recoverableStalledWorkers: prAlreadyOpened ? [CODER_WINDOW] : [],
      recoverablePermissionPromptWorkers:
        config.workerPermissionPromptPolicy === "recreate-non-interactive" && prAlreadyOpened
          ? [CODER_WINDOW]
          : [],
      autoApprovePermissionPromptMaxAttempts: config.workerRecoveryAttempts,
      permissionPromptPatterns: config.workerPermissionPromptPatterns,
      permissionPromptPolicy: config.workerPermissionPromptPolicy,
    });
    workerSummaries = workerInspection.summaries;
    if (workerInspection.escalated) {
      const recovered = recoverWorkerFindings({
        deps,
        home,
        comboId,
        runDir,
        findings: workerInspection.findings,
        events: readEvents(runDir),
        coderWindowName: CODER_WINDOW,
        maxAttempts: config.workerRecoveryAttempts,
      });
      const statusEvents = readEvents(runDir);
      if (recovered) {
        events = statusEvents;
      } else {
        const prUrl = latestPrUrlFromEvents(statusEvents);
        if (prUrl === undefined) {
          emitTickComplete({
            deps,
            comboId,
            cli,
            runDir,
            pollSeconds: config.limits.babysitPollSeconds,
            readyRequiredChecks: config.readyRequiredChecks,
            ambientCheckNames: config.externalCommentAgents,
            events: statusEvents,
            workerSummaries,
          });
          return;
        }
        events = statusEvents;
      }
    } else {
      events = readEvents(runDir);
    }
  }

  const openedPrUrl = latestPrUrlFromEvents(events);
  if (openedPrUrl === undefined) {
    emitTickComplete({
      deps,
      comboId,
      cli,
      runDir,
      pollSeconds: config.limits.babysitPollSeconds,
      readyRequiredChecks: config.readyRequiredChecks,
      ambientCheckNames: config.externalCommentAgents,
      events,
      workerSummaries,
    });
    return;
  }

  await tickReviewer({ deps, home, comboId, ghApiCache });
  let postReviewEvents = readEvents(runDir);
  if (terminalReviewerEvent(postReviewEvents)) {
    syncDirectorPrLabels({ deps, combo, runDir, events: postReviewEvents, prUrl: openedPrUrl });
    emitTickComplete({
      deps,
      comboId,
      cli,
      runDir,
      pollSeconds: config.limits.babysitPollSeconds,
      readyRequiredChecks: config.readyRequiredChecks,
      ambientCheckNames: config.externalCommentAgents,
      events: postReviewEvents,
      workerSummaries,
    });
    return;
  }
  if (closurePendingReviewerEvent(postReviewEvents)) {
    await runClosureIfPending({ deps, home, comboId });
    postReviewEvents = readEvents(runDir);
    syncDirectorPrLabels({ deps, combo, runDir, events: postReviewEvents, prUrl: openedPrUrl });
    emitTickComplete({
      deps,
      comboId,
      cli,
      runDir,
      pollSeconds: config.limits.babysitPollSeconds,
      readyRequiredChecks: config.readyRequiredChecks,
      ambientCheckNames: config.externalCommentAgents,
      events: postReviewEvents,
      workerSummaries,
    });
    return;
  }
  const postReviewHoldReason = activeNonWorkerNeedsHumanReason(postReviewEvents);
  if (postReviewHoldReason !== undefined) {
    syncDirectorPrLabels({ deps, combo, runDir, events: postReviewEvents, prUrl: openedPrUrl });
    emitTickComplete({
      deps,
      comboId,
      cli,
      runDir,
      pollSeconds: config.limits.babysitPollSeconds,
      readyRequiredChecks: config.readyRequiredChecks,
      ambientCheckNames: config.externalCommentAgents,
      events: postReviewEvents,
      workerSummaries,
    });
    return;
  }

  nudgeReviewComments({ deps, home, comboId, ghApiCache });

  const prUrl = latestPrUrlFromEvents(readEvents(runDir)) ?? openedPrUrl;

  runReadyForMergeIfNeeded(deps, comboId);
  const finalEvents = readEvents(runDir);
  syncDirectorPrLabels({
    deps,
    combo,
    runDir,
    events: finalEvents,
    prUrl,
  });
  emitTickComplete({
    deps,
    comboId,
    cli,
    runDir,
    pollSeconds: config.limits.babysitPollSeconds,
    readyRequiredChecks: config.readyRequiredChecks,
    ambientCheckNames: config.externalCommentAgents,
    events: finalEvents,
    workerSummaries,
  });
}

// -- 3/3 HELPER · Closure, initial gate retry, and READY agreement --
async function runClosureIfPending(input: {
  deps: DirectorDeps;
  home: string;
  comboId: string;
}): Promise<void> {
  try {
    await closeMergedCombo({
      deps: input.deps,
      home: input.home,
      comboId: input.comboId,
    });
  } catch (error) {
    input.deps.out(
      `director: closure convergence failed for ${input.comboId}: ${
        error instanceof Error ? error.message : String(error)
      }; will retry on next tick`,
    );
  }
}

function emitTickComplete(input: {
  deps: DirectorDeps;
  comboId: string;
  cli: string;
  runDir: string;
  pollSeconds: number;
  readyRequiredChecks: string[];
  ambientCheckNames: string[];
  events?: ComboEvent[];
  workerSummaries?: string[];
  actionOverride?: string;
}): void {
  const events = input.events ?? readEvents(input.runDir);
  const now = new Date();
  const prUrl = latestPrUrlFromEvents(events);
  const pr = prUrl === undefined ? undefined : directorWatchPrSnapshot(input.deps, prUrl, now);
  input.deps.out(
    buildDirectorWatchStatusLine({
      comboId: input.comboId,
      cli: input.cli,
      events,
      now,
      pollSeconds: input.pollSeconds,
      pr,
      workerSummaries: input.workerSummaries,
      readyRequiredChecks: input.readyRequiredChecks,
      ambientCheckNames: input.ambientCheckNames,
      actionOverride: input.actionOverride,
    }),
  );
}

function directorWatchPrSnapshot(deps: DirectorDeps, prUrl: string, polledAt: Date): DirectorWatchPrSnapshot {
  const result = deps.gh([
    "pr",
    "view",
    prUrl,
    "--json",
    "headRefOid,state,mergeStateStatus,mergeable,statusCheckRollup,comments",
  ]);
  if (result.status !== 0) {
    return {
      state: "unknown",
      polledAt,
      error: result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`,
    };
  }
  try {
    const pr = parsePrView(result.stdout);
    return {
      state: pr.state,
      headSha: pr.headSha,
      mergeStateStatus: pr.mergeStateStatus,
      mergeable: pr.mergeable,
      statusCheckRollup: pr.statusCheckRollup,
      comments: pr.comments,
      polledAt,
    };
  } catch (error) {
    return {
      state: "unknown",
      polledAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function syncDirectorPrLabels(input: {
  deps: DirectorDeps;
  combo: ReturnType<typeof readCombo>;
  runDir: string;
  events: ComboEvent[];
  prUrl: string;
}): void {
  try {
    syncComboPrLabels({
      gh: input.deps.gh,
      runDir: input.runDir,
      prUrl: input.prUrl,
      events: input.events,
      source: "director-watch",
    });
  } catch (error) {
    input.deps.out(
      `director: PR label sync failed for ${input.combo.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function workerWindowsForEvents(events: ComboEvent[], coderWindowName: string): string[] {
  if (latestPrUrlFromEvents(events) !== undefined) {
    const workerWindows = [REVIEWER_WINDOW];
    if (coderWindowName !== CODER_WINDOW || hasRoutedCoderPrompt(events)) {
      workerWindows.push(coderWindowName);
    }
    return [...new Set(workerWindows)];
  }

  const status = deriveStatus(events);
  switch (status.phase) {
    case "CODING":
      return [CODER_WINDOW];
    case "GATING":
      return [GATEKEEPER_WINDOW];
    case "STALLED":
      if (status.reason === "coder_failed") return [CODER_WINDOW];
      return [];
    default:
      return [];
  }
}

function hasRoutedCoderPrompt(events: ComboEvent[]): boolean {
  return events.some((event) => event.event === "review_comment" || event.event === "pr_conflict");
}

const WORKER_NEEDS_HUMAN_REASONS = new Set(["worker_dead", "worker_permission_prompt", "worker_stalled"]);
const NEEDS_HUMAN_CLEARING_EVENTS = new Set<ComboEvent["event"]>([
  "coder_started",
  "gate_started",
  "pr_opened",
  "ready_for_merge",
  "stopped",
  "combo_closed",
]);

function activeNonWorkerNeedsHumanReason(events: ComboEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (NEEDS_HUMAN_CLEARING_EVENTS.has(event.event)) return undefined;
    if (event.event !== "needs_human") continue;
    const reason = typeof event["reason"] === "string" ? event["reason"] : "needs_human";
    return WORKER_NEEDS_HUMAN_REASONS.has(reason) ? undefined : reason;
  }
  return undefined;
}

function recoverWorkerFindings(input: {
  deps: DirectorDeps;
  home: string;
  comboId: string;
  runDir: string;
  findings: WorkerPaneFinding[];
  events: ComboEvent[];
  coderWindowName: string;
  maxAttempts: number;
}): boolean {
  let recovered = false;
  const actioned = new Set<string>();
  for (const finding of input.findings) {
    const isStalledOrPrompt =
      (finding.reason === "worker_stalled" || finding.reason === "worker_permission_prompt") &&
      finding.worker === input.coderWindowName;
    const isDeadCoder = finding.reason === "worker_dead" && finding.worker === CODER_WINDOW;

    if (
      (!isStalledOrPrompt && !isDeadCoder) ||
      finding.needsHumanRecorded ||
      actioned.has(`${finding.worker}:${finding.reason}`)
    ) {
      continue;
    }
    actioned.add(`${finding.worker}:${finding.reason}`);
    const attempts = workerRecoveryAttempts(input.events, finding.worker, finding.reason);
    if (attempts >= input.maxAttempts) {
      appendWorkerEscalation(
        input.runDir,
        input.deps,
        finding.worker,
        finding.reason,
        `recovery attempts exhausted after ${input.maxAttempts}; ${finding.detail}`,
      );
      continue;
    }
    if (finding.reason === "worker_dead") {
      try {
        const didRecover = recoverDeadCoder({
          deps: input.deps,
          home: input.home,
          comboId: input.comboId,
          recovery: {
            worker: finding.worker,
            reason: finding.reason,
            detail: finding.detail,
            attempt: attempts + 1,
            maxAttempts: input.maxAttempts,
          },
        });
        if (didRecover) {
          resetWorkerSnapshot(input.runDir, finding.worker);
          recovered = true;
        } else {
          appendEvent(input.runDir, "worker_recovery_failed", {
            worker: finding.worker,
            reason: finding.reason,
            detail: "recovery skipped: worker did not match initial coder window",
            attempt: attempts + 1,
            max_attempts: input.maxAttempts,
          });
        }
      } catch (error) {
        appendEvent(input.runDir, "worker_recovery_failed", {
          worker: finding.worker,
          reason: finding.reason,
          detail: `recovery failed: ${error instanceof Error ? error.message : String(error)}`,
          attempt: attempts + 1,
          max_attempts: input.maxAttempts,
        });
      }
      continue;
    }
    try {
      const didRecover = recoverStuckWorker({
        deps: input.deps,
        home: input.home,
        comboId: input.comboId,
        recovery: {
          worker: finding.worker,
          reason: finding.reason,
          detail: finding.detail,
          attempt: attempts + 1,
          maxAttempts: input.maxAttempts,
        },
      });
      if (didRecover) {
        resetWorkerSnapshot(input.runDir, finding.worker);
        recovered = true;
      } else {
        appendEvent(input.runDir, "worker_recovery_failed", {
          worker: finding.worker,
          reason: finding.reason,
          detail: "recovery skipped: worker did not match configured coder responding window",
          attempt: attempts + 1,
          max_attempts: input.maxAttempts,
        });
      }
    } catch (error) {
      appendEvent(input.runDir, "worker_recovery_failed", {
        worker: finding.worker,
        reason: finding.reason,
        detail: `recovery failed: ${error instanceof Error ? error.message : String(error)}`,
        attempt: attempts + 1,
        max_attempts: input.maxAttempts,
      });
    }
  }
  return recovered;
}

interface InitialGateRetryState {
  failures: number;
  retryNumber: number;
  retryAttempts: number;
}

function latestPrePrGateFailureState(
  events: ComboEvent[],
  retryAttempts: number,
): InitialGateRetryState | undefined {
  if (latestPrUrlFromEvents(events) !== undefined) return undefined;
  if (!events.some((event) => event.event === "coder_done")) return undefined;

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.event === "needs_human" && event["reason"] === "gate_failed") return undefined;
    if (event.event === "gate_started") return undefined;
    if (event.event === "gate_failed") {
      const failures = events.slice(0, i + 1).filter((candidate) => candidate.event === "gate_failed").length;
      return {
        failures,
        retryNumber: Math.max(0, failures - 1) + 1,
        retryAttempts,
      };
    }
  }
  return undefined;
}

function pluralizeRetry(count: number): string {
  return count === 1 ? "retry" : "retries";
}

async function runInitialGateRetryIfNeeded(input: {
  deps: DirectorDeps;
  combo: ReturnType<typeof readCombo>;
  runDir: string;
  cli: string;
  events: ComboEvent[];
  retryAttempts: number;
  backoffSeconds: number;
}): Promise<boolean> {
  const state = latestPrePrGateFailureState(input.events, input.retryAttempts);
  if (state === undefined) return false;

  const retriesUsed = Math.max(0, state.failures - 1);
  if (retriesUsed >= state.retryAttempts) {
    appendEvent(input.runDir, "needs_human", { reason: "gate_failed" });
    input.deps.out(
      `director: initial gate retries exhausted for ${input.combo.id} ` +
        `after ${retriesUsed} ${pluralizeRetry(retriesUsed)}`,
    );
    return true;
  }

  input.deps.out(
    `director: retrying initial gate for ${input.combo.id} after gate_failed ` +
      `(attempt ${state.retryNumber}/${state.retryAttempts})`,
  );
  if (input.backoffSeconds > 0) {
    await input.deps.sleep(input.backoffSeconds * 1000);
  }
  appendEvent(input.runDir, "needs_human", { reason: "gate_failed" });
  input.deps.out(
    `director: initial gate retry unavailable for ${input.combo.id} ` +
      `after ${state.retryNumber} attempt(s); needs_human`,
  );
  return true;
}

function hasReadyForMerge(events: ComboEvent[], headSha: string): boolean {
  return events.some((event) => event.event === "ready_for_merge" && event["sha"] === headSha);
}

function hasPrConflict(events: ComboEvent[], headSha: string, prUrl: string, mergeState: string): boolean {
  return events.some(
    (event) =>
      event.event === "pr_conflict" &&
      event["sha"] === headSha &&
      event["pr_url"] === prUrl &&
      event["merge_state"] === mergeState &&
      event["action"] === "rebase_required",
  );
}

function hasCurrentGateForHead(events: ComboEvent[], headSha: string): boolean {
  const status = latestGateStatus(events);
  if (
    status?.state === "fix_inflight" ||
    status?.state === "failed" ||
    status?.state === "awaiting_approval"
  ) {
    return false;
  }
  return latestPublishedGateSha(events) === headSha;
}

function canReconcileGateFromGithub(events: ComboEvent[]): boolean {
  const status = latestGateStatus(events);
  if (status?.state === "fix_inflight" || status?.state === "awaiting_approval") return false;
  if (status?.state === "failed") return latestGateFailureReason(events) === "daemon_dead";
  return status !== undefined || latestPublishedGateSha(events) !== undefined;
}

function latestGateFailureReason(events: ComboEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.event === "gate_failed") {
      return typeof event["reason"] === "string" ? event["reason"] : undefined;
    }
    if (event.event === "gate_started") return undefined;
  }
  return undefined;
}

export function headStateAllowsReady(
  events: ComboEvent[],
  prView: { headSha: string; state: string; mergeStateStatus?: string; mergeable?: string },
): boolean {
  return (
    prView.state === "OPEN" &&
    blockingReadyMergeState(prView) === undefined &&
    !hasReadyForMerge(events, prView.headSha)
  );
}

export function gateStateAllowsReady(events: ComboEvent[], headSha: string): boolean {
  return hasCurrentGateForHead(events, headSha);
}

export function reviewStateAllowsReady(events: ComboEvent[], headSha: string): boolean {
  return livePinnedLgtmSha(events) === headSha;
}

function runReadyForMergeIfNeeded(deps: DirectorDeps, comboId: string): void {
  const runDir = runDirFor(comboHome(deps.env), comboId);
  let events = readEvents(runDir);
  const combo = readCombo(runDir);
  const config = loadRuntimeConfig(runDir, { repoDir: combo.repoDir, env: deps.env });
  const prUrl = latestPrUrlFromEvents(events);
  if (prUrl === undefined) return;
  if (!canReconcileGateFromGithub(events) || livePinnedLgtmSha(events) === undefined) return;

  const pr = deps.gh([
    "pr",
    "view",
    prUrl,
    "--json",
    "headRefOid,state,baseRefName,mergeStateStatus,mergeable,statusCheckRollup,comments",
  ]);
  if (pr.status !== 0) {
    deps.out(
      `director: gh pr view failed for ${comboId} (status ${pr.status}): ${pr.stderr.trim() || "unknown error"}`,
    );
    return;
  }

  let prView;
  try {
    prView = parsePrView(pr.stdout);
  } catch (error) {
    deps.out(
      `director: failed to parse READY data for ${comboId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  const headSha = prView.headSha;
  const blockingMergeState = blockingReadyMergeState(prView);
  if (prView.state === "OPEN" && blockingMergeState !== undefined) {
    if (!hasPrConflict(events, headSha, prUrl, blockingMergeState)) {
      try {
        nudgePrConflict({
          deps,
          home: comboHome(deps.env),
          comboId,
          conflict: {
            prUrl,
            headSha,
            mergeState: blockingMergeState,
            ...(prView.mergeable !== undefined ? { mergeable: prView.mergeable } : {}),
            ...(prView.baseRefName !== undefined ? { baseRef: prView.baseRefName } : {}),
          },
        });
        appendEvent(runDir, "pr_conflict", {
          sha: headSha,
          pr_url: prUrl,
          merge_state: blockingMergeState,
          ...(prView.mergeable !== undefined ? { mergeable: prView.mergeable } : {}),
          ...(prView.baseRefName !== undefined ? { base_ref: prView.baseRefName } : {}),
          action: "rebase_required",
          source: "github",
        });
        deps.out(`director: pr_conflict ${headSha} ${blockingMergeState}; action rebase_required`);
      } catch (error) {
        deps.out(
          `director: pr_conflict nudge failed for ${comboId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return;
  }
  if (!headStateAllowsReady(events, prView)) return;
  if (!reviewStateAllowsReady(events, headSha)) return;
  if (
    !checkRollupSucceeded(prView.statusCheckRollup, {
      requiredCheckNames: config.readyRequiredChecks,
      ambientCheckNames: config.externalCommentAgents,
    })
  )
    return;
  if (
    externalReviewSkippedByConfiguredAgent(prView.comments, config.externalCommentAgents) ||
    !requiredChecksSucceeded(prView.statusCheckRollup, config.readyRequiredChecks)
  )
    return;
  if (!gateStateAllowsReady(events, headSha)) {
    const status = latestGateStatus(events);
    if (status?.state === "fix_inflight" || status?.state === "awaiting_approval") return;
    // This substitutes local gate evidence only for daemon-death recovery.
    // GitHub checks, required checks, and pinned LGTM must already agree on the
    // PR head, and generic no-mistakes failures are not recoverable here.
    appendEvent(runDir, "gate_status", { state: "idle", head_sha: headSha, source: "github" });
    appendEvent(runDir, "gate_validated", { sha: headSha, source: "github" });
    events = readEvents(runDir);
  }
  if (!gateStateAllowsReady(events, headSha)) {
    deps.out(`director: gate not ready for ${comboId}: gate evidence unavailable or stale after recovery`);
    return;
  }

  appendEvent(runDir, "ready_for_merge", { sha: headSha, pr_url: prUrl });
  deps.out(`director: ready_for_merge ${headSha}`);
}
// -/ 3/3
