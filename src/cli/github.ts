/**
 * @overview GitHub CLI parsing helpers. ~330 lines, gh JSON normalization.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at fetchIssueDetails     <- issue title/body for runner PR intent.
 *   2. Then latestGitHubLgtmSha       <- latest LGTM pin from comments/reviews.
 *   3. Then parsePrView              <- normalized PR state for reviewer tick.
 *   4. Finish at fetchForensicsGithubFacts <- read-only report enrichment.
 *
 *   MAIN FLOW
 *   ---------
 *   gh stdout -> JSON parse -> typed issue/PR/LGTM facts
 *
 *   PUBLIC API
 *   ----------
 *   GhResult, GhRunner, IssueDetails, ForensicsGithubFacts, remoteSlug, fetchIssueDetails
 *   latestGitHubLgtmSha, PrView, parsePrView, fetchForensicsGithubFacts
 *
 *   INTERNALS
 *   ---------
 *   GitHubPin, lgtmPinFromBody, pinsFromItems, rollupSignal, parseIssueView
 *
 * @exports GhResult, GhRunner, IssueDetails, ForensicsGithubFacts, remoteSlug, fetchIssueDetails, latestGitHubLgtmSha, PrView, parsePrView, fetchForensicsGithubFacts
 * @deps ../core/gh-api, ../core/pr-url
 */
import { readGhArray, type GhApiCache } from "../core/gh-api.js";
import { parseGitHubPullRequestUrl } from "../core/pr-url.js";

// -- 1/4 CORE · Issue metadata and remoteSlug <- START HERE --
export interface GhResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type GhRunner = (args: string[]) => GhResult;

export interface IssueDetails {
  title: string;
  body: string;
}

export type GithubSignalState = "success" | "failure" | "pending" | "unknown";

export interface ForensicsGithubFacts {
  pr?: {
    url: string;
    headSha?: string;
    reviewerPinnedSha?: string | null;
    state?: string;
    mergedAt?: string;
    ci?: GithubSignalState;
    codeRabbit?: GithubSignalState;
    mergeState?: string;
    branchBehind?: boolean;
  };
  issue?: {
    state?: string;
    closedAt?: string;
  };
}

/**
 * Extract the "owner/repo" slug from a git remote URL. Handles the two
 * shapes git uses in practice: scp-like ssh and https, with or without ".git".
 */
export function remoteSlug(remoteUrl: string): string | undefined {
  const match = /^(?:git@[^:/]+:|https:\/\/[^/]+\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(remoteUrl);
  return match?.[1];
}

export function fetchIssueDetails(gh: GhRunner, issueUrl: string): IssueDetails {
  const result = gh(["issue", "view", issueUrl, "--json", "title,body"]);
  if (result.status !== 0) {
    throw new Error(`Issue details not reachable: ${issueUrl} (gh issue view failed)`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Issue details not readable: ${issueUrl} (gh issue view returned invalid JSON)`);
  }

  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`Issue details not readable: ${issueUrl} (gh issue view returned invalid JSON)`);
  }

  const title = "title" in parsed ? parsed.title : undefined;
  const body = "body" in parsed ? parsed.body : undefined;
  if (typeof title !== "string") {
    throw new Error(`Issue details not readable: ${issueUrl} (missing title)`);
  }
  if (body !== undefined && body !== null && typeof body !== "string") {
    throw new Error(`Issue details not readable: ${issueUrl} (invalid body)`);
  }
  return { title, body: body ?? "" };
}
// -/ 1/4

// -- 2/4 HELPER · LGTM pin parsing --
interface GitHubPin {
  sha: string;
  t: number;
}

const LGTM_PIN = /\blgtm\s*@\s*([0-9a-f]{6,40})\b/gi;
const LGTM_NEGATION_PREFIX = /\b(?:no|not|sin)[\s,!.:;-]+$/i;

function lgtmPinFromBody(body: string): string | undefined {
  for (const match of body.matchAll(LGTM_PIN)) {
    const start = match.index ?? 0;
    if (LGTM_NEGATION_PREFIX.test(body.slice(0, start))) continue;
    return match[1]!;
  }
  return undefined;
}

function pinsFromItems(entries: unknown[]): GitHubPin[] {
  const pins: GitHubPin[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const body = (entry as { body?: unknown }).body;
    if (typeof body !== "string") continue;
    const sha = lgtmPinFromBody(body);
    if (!sha) continue;
    const rawTime =
      (entry as { submitted_at?: unknown }).submitted_at ??
      (entry as { submittedAt?: unknown }).submittedAt ??
      (entry as { created_at?: unknown }).created_at ??
      (entry as { createdAt?: unknown }).createdAt ??
      (entry as { updated_at?: unknown }).updated_at ??
      (entry as { updatedAt?: unknown }).updatedAt;
    const t = typeof rawTime === "string" ? Date.parse(rawTime) : Number.NaN;
    pins.push({ sha, t: Number.isNaN(t) ? 0 : t });
  }
  return pins;
}
// -/ 2/4

// -- 3/4 CORE · latestGitHubLgtmSha --
export function latestGitHubLgtmSha(
  gh: GhRunner,
  prUrl: string,
  cache?: GhApiCache,
): string | undefined {
  const ref = parseGitHubPullRequestUrl(prUrl);
  if (!ref) return undefined;

  const comments = readGhArray(
    gh,
    `repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`,
    cache,
  );
  const reviews = readGhArray(
    gh,
    `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`,
    cache,
  );
  const pins = [...pinsFromItems(comments), ...pinsFromItems(reviews)];
  pins.sort((a, b) => a.t - b.t);
  return pins.at(-1)?.sha;
}
// -/ 3/4

// -- 4/5 CORE · parsePrView --
export interface PrView {
  headSha: string;
  state: string;
  mergedAt?: string;
  mergedBy?: string;
  baseRefName?: string;
  mergeStateStatus?: string;
  mergeSha?: string;
  statusCheckRollup?: unknown[];
}

export function parsePrView(stdout: string): PrView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`gh pr view returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (
    typeof parsed === "object" &&
    parsed !== null &&
    typeof (parsed as { headRefOid?: unknown }).headRefOid === "string" &&
    (parsed as { headRefOid: string }).headRefOid.length > 0
  ) {
    const state = (parsed as { state?: unknown }).state;
    const mergedAt = (parsed as { mergedAt?: unknown }).mergedAt;
    const mergedBy = (parsed as { mergedBy?: unknown }).mergedBy;
    const baseRefName = (parsed as { baseRefName?: unknown }).baseRefName;
    const mergeStateStatus = (parsed as { mergeStateStatus?: unknown }).mergeStateStatus;
    const mergeCommit = (parsed as { mergeCommit?: unknown }).mergeCommit;
    const statusCheckRollup = (parsed as { statusCheckRollup?: unknown }).statusCheckRollup;
    const view: PrView = {
      headSha: (parsed as { headRefOid: string }).headRefOid,
      state: typeof state === "string" && state.length > 0 ? state : "OPEN",
    };
    if (Array.isArray(statusCheckRollup)) {
      view.statusCheckRollup = statusCheckRollup;
    }
    if (typeof baseRefName === "string" && baseRefName.length > 0) {
      view.baseRefName = baseRefName;
    }
    if (typeof mergedAt === "string" && mergedAt.length > 0) {
      view.mergedAt = mergedAt;
    }
    if (typeof mergeStateStatus === "string" && mergeStateStatus.length > 0) {
      view.mergeStateStatus = mergeStateStatus;
    }
    if (
      typeof mergeCommit === "object" &&
      mergeCommit !== null &&
      typeof (mergeCommit as { oid?: unknown }).oid === "string" &&
      (mergeCommit as { oid: string }).oid.length > 0
    ) {
      view.mergeSha = (mergeCommit as { oid: string }).oid;
    }
    if (
      typeof mergedBy === "object" &&
      mergedBy !== null &&
      typeof (mergedBy as { login?: unknown }).login === "string" &&
      (mergedBy as { login: string }).login.length > 0
    ) {
      view.mergedBy = (mergedBy as { login: string }).login;
    }
    return view;
  }

  throw new Error("gh pr view did not return headRefOid");
}
// -/ 4/5

// -- 5/5 CORE · fetchForensicsGithubFacts --
export function fetchForensicsGithubFacts(
  gh: GhRunner,
  issueUrl: string,
  prUrl: string | undefined,
  cache?: GhApiCache,
): ForensicsGithubFacts | undefined {
  const facts: ForensicsGithubFacts = {};

  if (prUrl !== undefined) {
    const pr = gh([
      "pr",
      "view",
      prUrl,
      "--json",
      "headRefOid,state,mergedAt,mergeStateStatus,statusCheckRollup",
    ]);
    if (pr.status === 0) {
      try {
        const parsed = parsePrView(pr.stdout);
        facts.pr = {
          url: prUrl,
          headSha: parsed.headSha,
          state: parsed.state,
          ci: rollupSignal(parsed.statusCheckRollup, false),
          codeRabbit: rollupSignal(parsed.statusCheckRollup, true),
          ...(parsed.mergedAt !== undefined ? { mergedAt: parsed.mergedAt } : {}),
          ...(parsed.mergeStateStatus !== undefined
            ? {
                mergeState: parsed.mergeStateStatus,
                branchBehind: parsed.mergeStateStatus.toUpperCase() === "BEHIND",
              }
            : {}),
        };
        try {
          facts.pr.reviewerPinnedSha = latestGitHubLgtmSha(gh, prUrl, cache) ?? null;
        } catch {
          // Forensics is best-effort: PR metadata is still useful if comments or
          // reviews are temporarily unreadable.
        }
      } catch {
        // Leave PR facts unknown when gh returns an unexpected shape.
      }
    }
  }

  const issue = gh(["issue", "view", issueUrl, "--json", "state,closedAt"]);
  if (issue.status === 0) {
    const parsed = parseIssueView(issue.stdout);
    if (parsed !== undefined) facts.issue = parsed;
  }

  return facts.pr === undefined && facts.issue === undefined ? undefined : facts;
}

function parseIssueView(stdout: string): ForensicsGithubFacts["issue"] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const state = (parsed as { state?: unknown }).state;
  const closedAt = (parsed as { closedAt?: unknown }).closedAt;
  return {
    ...(typeof state === "string" && state.length > 0 ? { state } : {}),
    ...(typeof closedAt === "string" && closedAt.length > 0 ? { closedAt } : {}),
  };
}

function rollupSignal(rollup: unknown[] | undefined, onlyCodeRabbit: boolean): GithubSignalState {
  if (rollup === undefined) return "unknown";
  const items = rollup.filter((item) => isCodeRabbitCheck(item) === onlyCodeRabbit);
  if (items.length === 0) return "unknown";
  const states = items.map(checkSignalState);
  if (states.includes("failure")) return "failure";
  if (states.every((state) => state === "success")) return "success";
  if (states.includes("pending")) return "pending";
  return "unknown";
}

function checkSignalState(item: unknown): GithubSignalState {
  if (!isRecord(item)) return "unknown";
  const conclusion = upperString(item["conclusion"]);
  if (conclusion !== undefined) {
    if (SUCCESSFUL_CHECK_CONCLUSIONS.has(conclusion)) return "success";
    if (FAILURE_CHECK_CONCLUSIONS.has(conclusion)) return "failure";
    return "unknown";
  }
  const state = upperString(item["state"] ?? item["status"]);
  if (state !== undefined) {
    if (SUCCESSFUL_STATUS_STATES.has(state)) return "success";
    if (FAILURE_STATUS_STATES.has(state)) return "failure";
    if (PENDING_STATUS_STATES.has(state)) return "pending";
  }
  return "unknown";
}

const SUCCESSFUL_CHECK_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILURE_CHECK_CONCLUSIONS = new Set([
  "ACTION_REQUIRED",
  "CANCELLED",
  "FAILURE",
  "STARTUP_FAILURE",
  "TIMED_OUT",
]);
const SUCCESSFUL_STATUS_STATES = new Set(["SUCCESS", "COMPLETED"]);
const FAILURE_STATUS_STATES = new Set(["ERROR", "FAILURE", "FAILED", "CANCELLED", "TIMED_OUT"]);
const PENDING_STATUS_STATES = new Set(["EXPECTED", "IN_PROGRESS", "PENDING", "QUEUED", "REQUESTED", "WAITING"]);

function isCodeRabbitCheck(item: unknown): boolean {
  return checkName(item).toLowerCase().includes("coderabbit");
}

function checkName(item: unknown): string {
  if (!isRecord(item)) return "";
  const parts = [item["name"], item["context"], item["workflowName"]];
  const app = item["app"];
  if (isRecord(app)) parts.push(app["name"], app["slug"]);
  return parts.filter((part): part is string => typeof part === "string").join(" ");
}

function upperString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim().toUpperCase() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
// -/ 5/5
