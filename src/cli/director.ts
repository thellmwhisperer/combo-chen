/**
 * @overview Director CLI helpers. ~580 lines, 5 exports, initial-gate retry and pre/post-PR orchestration.
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
 *   runInitialGateRetryIfNeeded -> inspectWorkerPanes -> wait for PR -> tickReviewer -> nudgeReviewComments
 *     -> runPostAddressGateIfNeeded -> runReadyForMergeIfNeeded -> syncDirectorPrLabels
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
 *   retry-count helpers, required READY check helpers, review-comment helpers
 *
 * @exports DirectorDeps, tickDirector, headStateAllowsReady, gateStateAllowsReady, reviewStateAllowsReady
 * @deps ../core/{events,gh-api,state}, ../infra/{config-snapshot,tmux}, ../roles/coder-responding, ./checks, ./gate, ./github, ./pr-labels, ./reviewer, ./coder, ./worker-monitor
 */
import { deriveStatus } from "../core/combo.js";
import { appendEvent, appendEvents, readEvents, type ComboEvent } from "../core/events.js";
import { createGhApiCache } from "../core/gh-api.js";
import { comboHome, readCombo, runDirFor } from "../core/state.js";
import { loadRuntimeConfig } from "../infra/config-snapshot.js";
import { listWindowsArgs } from "../infra/tmux.js";
import type { TmuxResult } from "../infra/tmux.js";
import { latestPrUrl } from "../roles/coder-responding.js";
import { nudgePrConflict, nudgeReviewComments } from "./coder.js";
import { checkRollupSucceeded, requiredChecksSucceeded } from "./checks.js";
import { buildDirectorWatchStatusLine, type DirectorWatchPrSnapshot } from "./director-watch-status.js";
import {
  latestGateStatus,
  latestPublishedGateSha,
  runPostAddressGateIfNeeded,
  GATEKEEPER_WINDOW,
  startInitialGateRetry,
} from "./gate.js";
import { blockingReadyMergeState, parsePrView } from "./github.js";
import { syncComboPrLabels } from "./pr-labels.js";
import { closurePendingReviewerEvent, livePinnedLgtmSha, terminalReviewerEvent, tickReviewer } from "./reviewer.js";
import { CODER_WINDOW, REVIEWER_WINDOW } from "./sessions.js";
import { inspectWorkerPanes } from "./worker-monitor.js";

// -- 1/3 HELPER · Dependency contract --
export interface DirectorDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  tmux: (args: string[]) => TmuxResult;
  git: (args: string[], cwd: string) => { status: number; stdout: string; stderr: string };
  gh: (args: string[]) => { status: number; stdout: string; stderr: string };
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
  const workerWindows = workerWindowsForEvents(events, config.coderRespondingWindowName);
  if (workerWindows.length > 0) {
    const workerInspection = inspectWorkerPanes({
      deps,
      combo,
      runDir,
      workerWindows,
      stallTicks: config.workerStallTicks,
      permissionPromptPatterns: config.workerPermissionPromptPatterns,
    });
    workerSummaries = workerInspection.summaries;
    if (workerInspection.escalated) {
      const statusEvents = readEvents(runDir);
      const prUrl = latestPrUrl(statusEvents);
      if (prUrl !== undefined) {
        syncDirectorPrLabels({ deps, combo, runDir, events: statusEvents, prUrl, config });
      }
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
    events = readEvents(runDir);
  }

  const openedPrUrl = latestPrUrl(events);
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
  const postReviewEvents = readEvents(runDir);
  if (terminalReviewerEvent(postReviewEvents) || closurePendingReviewerEvent(postReviewEvents)) {
    syncDirectorPrLabels({ deps, combo, runDir, events: postReviewEvents, prUrl: openedPrUrl, config });
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

  const prUrl = latestPrUrl(readEvents(runDir)) ?? openedPrUrl;
  if (prUrl !== undefined) {
    try {
      runPostAddressGateIfNeeded({ deps, combo, runDir, prUrl, cli });
    } catch (err) {
      deps.out(
        `director: post-address gate check failed for ${comboId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  runReadyForMergeIfNeeded(deps, comboId);
  const finalEvents = readEvents(runDir);
  syncDirectorPrLabels({
    deps,
    combo,
    runDir,
    events: finalEvents,
    prUrl,
    config,
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

// -- 3/3 HELPER · Initial gate retry and READY agreement --
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
}): void {
  const events = input.events ?? readEvents(input.runDir);
  const now = new Date();
  const prUrl = latestPrUrl(events);
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
    }),
  );
  input.deps.out(`director: tick complete for ${input.comboId}`);
}

function directorWatchPrSnapshot(
  deps: DirectorDeps,
  prUrl: string,
  polledAt: Date,
): DirectorWatchPrSnapshot {
  const result = deps.gh(["pr", "view", prUrl, "--json", "headRefOid,state,mergeStateStatus,mergeable,statusCheckRollup"]);
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
  config: {
    coderRespondingWindowName: string;
    readyRequiredChecks: string[];
    externalCommentAgents: string[];
    prLabelGreenCheckNames: string[];
  };
}): void {
  try {
    syncComboPrLabels({
      gh: input.deps.gh,
      runDir: input.runDir,
      prUrl: input.prUrl,
      events: input.events,
      activity: livePrLabelActivity(input.deps, input.combo, input.config.coderRespondingWindowName),
      requiredCheckNames: input.config.readyRequiredChecks,
      ambientCheckNames: input.config.externalCommentAgents,
      greenCheckNames: input.config.prLabelGreenCheckNames,
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

function livePrLabelActivity(
  deps: Pick<DirectorDeps, "tmux">,
  combo: ReturnType<typeof readCombo>,
  coderRespondingWindowName: string,
): { coderRespondingActive?: boolean; reviewerActive?: boolean; gateActive?: boolean } {
  const listed = deps.tmux(listWindowsArgs(combo.tmuxSession));
  if (listed.status !== 0) return {};
  const windows = new Set(listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  return {
    coderRespondingActive: windows.has(coderRespondingWindowName),
    reviewerActive: windows.has(REVIEWER_WINDOW),
    gateActive: windows.has(GATEKEEPER_WINDOW),
  };
}

function workerWindowsForEvents(events: ComboEvent[], coderRespondingWindowName: string): string[] {
  if (latestPrUrl(events) !== undefined) {
    return [...new Set([
      CODER_WINDOW,
      REVIEWER_WINDOW,
      GATEKEEPER_WINDOW,
      coderRespondingWindowName,
    ])];
  }

  switch (deriveStatus(events).phase) {
    case "CODING":
      return [CODER_WINDOW];
    case "GATING":
      return [GATEKEEPER_WINDOW];
    default:
      return [];
  }
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
  if (latestPrUrl(events) !== undefined) return undefined;
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
  let result: ReturnType<typeof startInitialGateRetry>;
  try {
    result = startInitialGateRetry({
      deps: input.deps,
      combo: input.combo,
      runDir: input.runDir,
      cli: input.cli,
    });
  } catch (error) {
    appendFailedInitialGateRetry(input.runDir);
    input.deps.out(
      `director: initial gate retry failed to start for ${input.combo.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return true;
  }
  if (!result.started && result.reason !== "uncommitted_changes") {
    appendFailedInitialGateRetry(input.runDir);
  }
  return true;
}

function appendFailedInitialGateRetry(runDir: string): void {
  appendEvents(runDir, [
    { event: "gate_started", payload: { source: "director_retry" } },
    { event: "gate_failed", payload: { exit_code: 1, reason: "retry_start_failed" } },
  ]);
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
  const prUrl = latestPrUrl(events);
  if (prUrl === undefined) return;
  if (!canReconcileGateFromGithub(events) || livePinnedLgtmSha(events) === undefined) return;

  const pr = deps.gh([
    "pr",
    "view",
    prUrl,
    "--json",
    "headRefOid,state,baseRefName,mergeStateStatus,mergeable,statusCheckRollup",
  ]);
  if (pr.status !== 0) {
    deps.out(`director: gh pr view failed for ${comboId} (status ${pr.status}): ${pr.stderr.trim() || "unknown error"}`);
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
  if (!checkRollupSucceeded(prView.statusCheckRollup, { requiredCheckNames: config.readyRequiredChecks, ambientCheckNames: config.externalCommentAgents })) return;
  if (!requiredChecksSucceeded(prView.statusCheckRollup, config.readyRequiredChecks)) return;
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
  if (!gateStateAllowsReady(events, headSha)) return;

  appendEvent(runDir, "ready_for_merge", { sha: headSha, pr_url: prUrl });
  deps.out(`director: ready_for_merge ${headSha}`);
}
// -/ 3/3
