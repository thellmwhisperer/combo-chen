/**
 * @overview Director CLI helpers. ~290 lines, 5 exports, post-PR orchestration.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at tickDirector          <- one deterministic post-PR pass.
 *   2. Then runReadyForMergeIfNeeded <- current-head READY agreement.
 *   3. READY pure helpers            <- head, gate, and review predicates.
 *
 *   MAIN FLOW
 *   ---------
 *   tickReviewer -> nudgeReviewComments -> runPostAddressGateIfNeeded -> runReadyForMergeIfNeeded
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
 *   runReadyForMergeIfNeeded, hasCleanCodeRabbitSignal, rollup helpers
 *
 * @exports DirectorDeps, tickDirector, headStateAllowsReady, gateStateAllowsReady, reviewStateAllowsReady
 * @deps ../core/{events,gh-api,state}, ../roles/coder-responding, ./gate, ./github, ./reviewer, ./coder
 */
import { appendEvent, readEvents, type ComboEvent } from "../core/events.js";
import { createGhApiCache, readGhArray, type GhApiCache } from "../core/gh-api.js";
import { comboHome, readCombo, runDirFor } from "../core/state.js";
import { latestPrUrl, parsePullRequestUrl } from "../roles/coder-responding.js";
import { nudgeReviewComments } from "./coder.js";
import {
  latestGateStatus,
  latestPublishedGateSha,
  runPostAddressGateIfNeeded,
} from "./gate.js";
import { parsePrView } from "./github.js";
import { livePinnedLgtmSha, terminalReviewerEvent, tickReviewer } from "./reviewer.js";
import type { TmuxResult } from "../infra/tmux.js";

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

// -- 3/3 HELPER · READY agreement --
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function upperString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim().toUpperCase() : undefined;
}

const SUCCESSFUL_CHECK_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const SUCCESSFUL_STATUS_STATES = new Set(["SUCCESS"]);

function checkSignalSucceeded(item: unknown): boolean {
  if (!isRecord(item)) return false;
  const conclusion = upperString(item["conclusion"]);
  if (conclusion !== undefined) return SUCCESSFUL_CHECK_CONCLUSIONS.has(conclusion);
  const state = upperString(item["state"]);
  if (state !== undefined) return SUCCESSFUL_STATUS_STATES.has(state);
  return false;
}

function checkSignalIsSuccess(item: unknown): boolean {
  if (!isRecord(item)) return false;
  const conclusion = upperString(item["conclusion"]);
  if (conclusion !== undefined) return conclusion === "SUCCESS";
  const state = upperString(item["state"]);
  if (state !== undefined) return state === "SUCCESS";
  return false;
}

function checkName(item: unknown): string {
  if (!isRecord(item)) return "";
  const parts = [item["name"], item["context"], item["workflowName"]];
  const app = item["app"];
  if (isRecord(app)) parts.push(app["name"], app["slug"]);
  return parts.filter((part): part is string => typeof part === "string").join(" ");
}

function isCodeRabbitCheck(item: unknown): boolean {
  return checkName(item).toLowerCase().includes("coderabbit");
}

function ciRollupSucceeded(rollup: unknown[] | undefined): boolean {
  if (rollup === undefined) return false;
  const ciChecks = rollup.filter((item) => !isCodeRabbitCheck(item));
  return ciChecks.length > 0 && ciChecks.every(checkSignalSucceeded);
}

function codeRabbitCheckSucceeded(rollup: unknown[] | undefined): boolean {
  return rollup !== undefined && rollup.some((item) => isCodeRabbitCheck(item) && checkSignalIsSuccess(item));
}

function shaMatches(candidate: unknown, headSha: string): boolean {
  if (typeof candidate !== "string" || candidate.trim() === "") return false;
  return candidate.trim().toLowerCase() === headSha.toLowerCase();
}

function isCodeRabbitAuthor(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const login = value["login"];
  return typeof login === "string" && login.toLowerCase().startsWith("coderabbit");
}

const CODERABBIT_NO_REVIEW = /\breview\s+skipped\b|rate[-\s]?limit(?:ed)?|\bno[-\s]?review\b|unable to review|could not review/i;

interface CodeRabbitComment {
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

function codeRabbitCommentForHead(item: unknown, headSha: string): CodeRabbitComment | undefined {
  if (!isRecord(item)) return undefined;
  if (!isCodeRabbitAuthor(item["user"] ?? item["author"])) return undefined;
  const body = item["body"];
  if (typeof body !== "string" || body.trim() === "") return undefined;
  const itemSha = item["commit_id"] ?? item["commitId"] ?? item["original_commit_id"] ?? item["originalCommitId"];
  if (!shaMatches(itemSha, headSha) && !body.toLowerCase().includes(headSha.toLowerCase())) {
    return undefined;
  }
  return { body, t: timestampFromGitHubItem(item) };
}

function latestCodeRabbitCommentForHead(
  gh: DirectorDeps["gh"],
  prUrl: string,
  headSha: string,
  cache?: GhApiCache,
): CodeRabbitComment | undefined {
  const ref = parsePullRequestUrl(prUrl);
  if (!ref) return undefined;
  const endpoints = [
    `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`,
    `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`,
  ];
  const comments = endpoints.flatMap((endpoint) =>
    readGhArray(gh, endpoint, cache)
      .map((item) => codeRabbitCommentForHead(item, headSha))
      .filter((item): item is CodeRabbitComment => item !== undefined),
  );
  comments.sort((a, b) => a.t - b.t);
  return comments.at(-1);
}

function hasCleanCodeRabbitSignal(
  deps: DirectorDeps,
  prUrl: string,
  headSha: string,
  rollup: unknown[] | undefined,
  cache?: GhApiCache,
): boolean {
  if (!codeRabbitCheckSucceeded(rollup)) return false;
  const latestComment = latestCodeRabbitCommentForHead(deps.gh, prUrl, headSha, cache);
  return latestComment !== undefined && !CODERABBIT_NO_REVIEW.test(latestComment.body);
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
  const events = readEvents(runDir);
  const prUrl = latestPrUrl(events);
  if (prUrl === undefined) return;
  if (latestPublishedGateSha(events) === undefined || livePinnedLgtmSha(events) === undefined) return;

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
  if (!gateStateAllowsReady(events, headSha)) return;
  if (!reviewStateAllowsReady(events, headSha)) return;
  if (!ciRollupSucceeded(prView.statusCheckRollup)) return;

  let codeRabbitClean = false;
  try {
    codeRabbitClean = hasCleanCodeRabbitSignal(deps, prUrl, headSha, prView.statusCheckRollup, ghApiCache);
  } catch (error) {
    deps.out(
      `director: failed to read CodeRabbit signal for ${comboId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }
  if (!codeRabbitClean) return;

  appendEvent(runDir, "ready_for_merge", { sha: headSha, pr_url: prUrl });
  deps.out(`director: ready_for_merge ${headSha}`);
}
// -/ 3/3
