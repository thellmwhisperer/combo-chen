/**
 * @overview Director CLI helpers. ~425 lines, 5 exports, initial-gate retry and post-PR orchestration.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at tickDirector          <- one deterministic post-PR pass.
 *   2. Then runInitialGateRetryIfNeeded <- pre-PR gate failure recovery.
 *   3. Then runReadyForMergeIfNeeded <- current-head READY agreement.
 *   4. READY pure helpers            <- head, gate, and review predicates.
 *
 *   MAIN FLOW
 *   ---------
 *   runInitialGateRetryIfNeeded -> wait for PR -> inspectWorkerPanes -> tickReviewer -> nudgeReviewComments
 *     -> runPostAddressGateIfNeeded -> runReadyForMergeIfNeeded
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
 *   runInitialGateRetryIfNeeded, runReadyForMergeIfNeeded, retry-count helpers,
 *   hasCleanAmbientReviewerSignal, review-comment helpers
 *
 * @exports DirectorDeps, tickDirector, headStateAllowsReady, gateStateAllowsReady, reviewStateAllowsReady
 * @deps ../core/{events,gh-api,state}, ../infra/{config,tmux}, ../roles/coder-responding, ./checks, ./gate, ./github, ./reviewer, ./coder, ./worker-monitor
 */
import { appendEvent, readEvents, type ComboEvent } from "../core/events.js";
import { createGhApiCache, readGhArray, type GhApiCache } from "../core/gh-api.js";
import { comboHome, readCombo, runDirFor } from "../core/state.js";
import { loadConfig } from "../infra/config.js";
import type { TmuxResult } from "../infra/tmux.js";
import { latestPrUrl, parsePullRequestUrl } from "../roles/coder-responding.js";
import { nudgeReviewComments } from "./coder.js";
import { ambientCheckSucceeded, checkRollupSucceeded } from "./checks.js";
import {
  latestGateStatus,
  latestPublishedGateSha,
  runPostAddressGateIfNeeded,
  GATEKEEPER_WINDOW,
  startInitialGateRetry,
} from "./gate.js";
import { parsePrView } from "./github.js";
import { livePinnedLgtmSha, terminalReviewerEvent, tickReviewer } from "./reviewer.js";
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
  const config = loadConfig({ repoDir: combo.repoDir, env: deps.env });
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
    deps.out(`director: tick complete for ${comboId}`);
    return;
  }

  if (latestPrUrl(readEvents(runDir)) === undefined) {
    deps.out(`director: tick complete for ${comboId}`);
    return;
  }

  const workerWindows = [...new Set([
    CODER_WINDOW,
    REVIEWER_WINDOW,
    GATEKEEPER_WINDOW,
    config.coderRespondingWindowName,
  ])];

  const workerInspection = inspectWorkerPanes({
    deps,
    combo,
    runDir,
    workerWindows,
    stallTicks: config.workerStallTicks,
    permissionPromptPatterns: config.workerPermissionPromptPatterns,
  });
  if (workerInspection.escalated) {
    deps.out(`director: tick complete for ${comboId}`);
    return;
  }

  await tickReviewer({ deps, home, comboId, ghApiCache });
  if (terminalReviewerEvent(readEvents(runDir))) {
    deps.out(`director: tick complete for ${comboId}`);
    return;
  }

  nudgeReviewComments({ deps, home, comboId, ghApiCache });

  const prUrl = latestPrUrl(readEvents(runDir));
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

  runReadyForMergeIfNeeded(deps, comboId, ghApiCache);
  deps.out(`director: tick complete for ${comboId}`);
}
// -/ 2/3

// -- 3/3 HELPER · Initial gate retry and READY agreement --
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
  const result = startInitialGateRetry({
    deps: input.deps,
    combo: input.combo,
    runDir: input.runDir,
    cli: input.cli,
  });
  if (!result.started) {
    appendEvent(input.runDir, "gate_failed", { exit_code: 1 });
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function shaMatches(candidate: unknown, headSha: string): boolean {
  if (typeof candidate !== "string" || candidate.trim() === "") return false;
  return candidate.trim().toLowerCase() === headSha.toLowerCase();
}

function isAmbientReviewerAuthor(value: unknown, ambientReviewerAgents: string[]): boolean {
  if (ambientReviewerAgents.length === 0) return false;
  if (!isRecord(value)) return false;
  const login = value["login"];
  if (typeof login !== "string") return false;
  const normalizedLogin = login.toLowerCase();
  return ambientReviewerAgents.some((agent) => {
    const normalizedAgent = agent.trim().toLowerCase();
    return normalizedAgent.length > 0 && normalizedLogin.startsWith(normalizedAgent);
  });
}

const AMBIENT_REVIEWER_NO_REVIEW = /\breview\s+skipped\b|rate[-\s]?limit(?:ed)?|\bno[-\s]?review\b|unable to review|could not review/i;

interface AmbientReviewerComment {
  body: string;
  t: number;
}

function timestampFromGitHubItem(item: Record<string, unknown>): number {
  const raw =
    item["submitted_at"] ??
    item["submittedAt"] ??
    item["created_at"] ??
    item["createdAt"] ??
    item["updated_at"] ??
    item["updatedAt"];
  const parsed = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

function ambientReviewerCommentForHead(
  item: unknown,
  headSha: string,
  ambientReviewerAgents: string[],
): AmbientReviewerComment | undefined {
  if (!isRecord(item)) return undefined;
  if (!isAmbientReviewerAuthor(item["user"] ?? item["author"], ambientReviewerAgents)) return undefined;
  const body = item["body"];
  if (typeof body !== "string" || body.trim() === "") return undefined;
  const itemSha = item["commit_id"] ?? item["commitId"] ?? item["original_commit_id"] ?? item["originalCommitId"];
  if (!shaMatches(itemSha, headSha) && !body.toLowerCase().includes(headSha.toLowerCase())) {
    return undefined;
  }
  return { body, t: timestampFromGitHubItem(item) };
}

function latestAmbientReviewerCommentForHead(
  gh: DirectorDeps["gh"],
  prUrl: string,
  headSha: string,
  ambientReviewerAgents: string[],
  cache?: GhApiCache,
): AmbientReviewerComment | undefined {
  const ref = parsePullRequestUrl(prUrl);
  if (!ref) return undefined;
  const endpoints = [
    `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`,
    `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`,
  ];
  const comments = endpoints.flatMap((endpoint) =>
    readGhArray(gh, endpoint, cache)
      .map((item) => ambientReviewerCommentForHead(item, headSha, ambientReviewerAgents))
      .filter((item): item is AmbientReviewerComment => item !== undefined),
  );
  comments.sort((a, b) => a.t - b.t);
  return comments.at(-1);
}

function hasCleanAmbientReviewerSignal(
  deps: DirectorDeps,
  prUrl: string,
  headSha: string,
  rollup: unknown[] | undefined,
  ambientReviewerAgents: string[],
  cache?: GhApiCache,
): boolean {
  if (ambientReviewerAgents.length === 0) return true;
  if (!ambientCheckSucceeded(rollup, ambientReviewerAgents)) return false;
  const latestComment = latestAmbientReviewerCommentForHead(
    deps.gh,
    prUrl,
    headSha,
    ambientReviewerAgents,
    cache,
  );
  return latestComment !== undefined && !AMBIENT_REVIEWER_NO_REVIEW.test(latestComment.body);
}

function hasReadyForMerge(events: ComboEvent[], headSha: string): boolean {
  return events.some((event) => event.event === "ready_for_merge" && event["sha"] === headSha);
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
  prView: { headSha: string; state: string },
): boolean {
  return prView.state === "OPEN" && !hasReadyForMerge(events, prView.headSha);
}

export function gateStateAllowsReady(events: ComboEvent[], headSha: string): boolean {
  return hasCurrentGateForHead(events, headSha);
}

export function reviewStateAllowsReady(events: ComboEvent[], headSha: string): boolean {
  return livePinnedLgtmSha(events) === headSha;
}

function runReadyForMergeIfNeeded(deps: DirectorDeps, comboId: string, ghApiCache?: GhApiCache): void {
  const runDir = runDirFor(comboHome(deps.env), comboId);
  let events = readEvents(runDir);
  const combo = readCombo(runDir);
  const config = loadConfig({ repoDir: combo.repoDir, env: deps.env });
  const prUrl = latestPrUrl(events);
  if (prUrl === undefined) return;
  if (!canReconcileGateFromGithub(events) || livePinnedLgtmSha(events) === undefined) return;

  const pr = deps.gh(["pr", "view", prUrl, "--json", "headRefOid,state,statusCheckRollup"]);
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
  if (!headStateAllowsReady(events, prView)) return;
  if (!reviewStateAllowsReady(events, headSha)) return;
  if (!checkRollupSucceeded(prView.statusCheckRollup, { ambientCheckNames: config.ambientReviewerAgents })) return;
  if (!gateStateAllowsReady(events, headSha)) {
    const status = latestGateStatus(events);
    if (status?.state === "fix_inflight" || status?.state === "awaiting_approval") return;
    // This substitutes local gate evidence only for daemon-death recovery.
    // GitHub checks, ambient review, and pinned LGTM must already agree on the
    // PR head, and generic no-mistakes failures are not recoverable here.
    appendEvent(runDir, "gate_status", { state: "idle", head_sha: headSha, source: "github" });
    appendEvent(runDir, "gate_validated", { sha: headSha, source: "github" });
    events = readEvents(runDir);
  }
  if (!gateStateAllowsReady(events, headSha)) return;

  let ambientReviewerClean = false;
  try {
    ambientReviewerClean = hasCleanAmbientReviewerSignal(
      deps,
      prUrl,
      headSha,
      prView.statusCheckRollup,
      config.ambientReviewerAgents,
      ghApiCache,
    );
  } catch (error) {
    deps.out(
      `director: failed to read ambient reviewer signal for ${comboId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }
  if (!ambientReviewerClean) return;

  appendEvent(runDir, "ready_for_merge", { sha: headSha, pr_url: prUrl });
  deps.out(`director: ready_for_merge ${headSha}`);
}
// -/ 3/3
