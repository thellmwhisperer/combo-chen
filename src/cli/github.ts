/**
 * @overview GitHub CLI parsing helpers. ~565 lines, gh JSON normalization.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at fetchIssueDetails     <- issue title/body for runner PR intent.
 *   2. Then reviewer signal parsers   <- legacy LGTM pins may be author-filtered; verdict blocks are content contracts.
 *   3. Then parsePrView              <- normalized PR state for reviewer tick.
 *   4. Finish at fetchForensicsGithubFacts <- read-only report enrichment.
 *
 *   MAIN FLOW
 *   ---------
 *   gh stdout -> JSON parse -> typed issue/PR/LGTM facts
 *
 *   PUBLIC API
 *   ----------
 *   GhResult, GhRunner, IssueDetails, GithubSignalState, ReviewerVerdict, ForensicsGithubFacts
 *   remoteSlug, fetchIssueDetails, latestGitHubLgtmSha, latestGitHubReviewerVerdict
 *   PrView, blockingReadyMergeState, parsePrView, fetchForensicsGithubFacts
 *
 *   INTERNALS
 *   ---------
 *   LatestReviewerSignalOptions, GitHubPin, TimedReviewerVerdict, loginFromItem,
 *   reviewerCandidateLines, lgtmPinFromBody, reviewerVerdictFromBody, pinsFromItems,
 *   reviewerVerdictsFromItems, rollupSignal, parseIssueView
 *
 * @exports GhResult, GhRunner, IssueDetails, GithubSignalState, ReviewerVerdict, ForensicsGithubFacts, remoteSlug, fetchIssueDetails, latestGitHubLgtmSha, latestGitHubReviewerVerdict, PrView, blockingReadyMergeState, parsePrView, fetchForensicsGithubFacts
 * @deps ../core/gh-api, ../core/pr-url, ./checks
 */
import { readGhArray, type GhApiCache } from "../core/gh-api.js";
import { parseGitHubPullRequestUrl } from "../core/pr-url.js";
import { checkNameMatchesAny } from "./checks.js";

// -- 1/5 CORE · Issue metadata and remoteSlug <- START HERE --
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
    readyRequiredChecks?: GithubSignalState;
    ambientReviewer?: GithubSignalState;
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
// -/ 1/5

// -- 2/5 HELPER · Reviewer signal parsing --
interface GitHubPin {
  sha: string;
  t: number;
}

export interface ReviewerVerdict {
  headSha: string;
  code: 0 | 1 | 2 | 3;
  author?: string;
}

interface TimedReviewerVerdict extends ReviewerVerdict {
  t: number;
}

interface LatestReviewerSignalOptions {
  allowedAuthors?: string[];
}

const LGTM_PIN_LINE = /^\s*lgtm\s*@\s*([0-9a-f]{7,40})\s*$/i;
const REVIEWER_VERDICT_HEADER = /^\s*combo-chen-reviewer-verdict:\s*$/i;
const REVIEWER_VERDICT_HEAD = /^\s*head:\s*([0-9a-f]{7,40})\s*$/i;
const REVIEWER_VERDICT_CODE = /^\s*code:\s*([0-3])\s*$/i;

function reviewerCandidateLines(body: string): string[] {
  const lines: string[] = [];
  let inCodeFence = false;

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (/^(?:```|~~~)/.test(trimmed)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence || trimmed.startsWith(">")) continue;
    if (line.startsWith("    ")) continue;

    lines.push(line.replace(/`[^`\r\n]*`/g, ""));
  }

  return lines;
}

function lgtmPinFromBody(body: string): string | undefined {
  for (const line of reviewerCandidateLines(body)) {
    const match = LGTM_PIN_LINE.exec(line);
    if (!match) continue;
    return match[1]!;
  }
  return undefined;
}

function loginFromItem(entry: object): string | undefined {
  const user = (entry as { user?: unknown }).user;
  if (typeof user !== "object" || user === null) return undefined;
  const login = (user as { login?: unknown }).login;
  return typeof login === "string" && login.trim().length > 0 ? login : undefined;
}

function authorAllowed(entry: object, allowedAuthorsSet: Set<string> | undefined): boolean {
  if (allowedAuthorsSet === undefined) return true;
  const author = loginFromItem(entry);
  return author !== undefined && allowedAuthorsSet.has(author.toLowerCase());
}

function timestampFromItem(entry: object): number {
  const rawTime =
    (entry as { submitted_at?: unknown }).submitted_at ??
    (entry as { submittedAt?: unknown }).submittedAt ??
    (entry as { created_at?: unknown }).created_at ??
    (entry as { createdAt?: unknown }).createdAt ??
    (entry as { updated_at?: unknown }).updated_at ??
    (entry as { updatedAt?: unknown }).updatedAt;
  const t = typeof rawTime === "string" ? Date.parse(rawTime) : Number.NaN;
  return Number.isNaN(t) ? 0 : t;
}

function validReviewerEntries(entries: unknown[], options: LatestReviewerSignalOptions): object[] {
  const allowedAuthorsSet = options.allowedAuthors
    ? new Set(options.allowedAuthors.map((author) => author.toLowerCase()))
    : undefined;
  return entries.filter((entry): entry is object => {
    if (typeof entry !== "object" || entry === null) return false;
    return authorAllowed(entry, allowedAuthorsSet);
  });
}

function pinsFromItems(entries: unknown[], options: LatestReviewerSignalOptions = {}): GitHubPin[] {
  const pins: GitHubPin[] = [];
  for (const entry of validReviewerEntries(entries, options)) {
    const body = (entry as { body?: unknown }).body;
    if (typeof body !== "string") continue;
    const sha = lgtmPinFromBody(body);
    if (!sha) continue;
    pins.push({ sha, t: timestampFromItem(entry) });
  }
  return pins;
}

function reviewerVerdictFromBody(body: string, currentHeadSha: string): ReviewerVerdict | undefined {
  const lines = reviewerCandidateLines(body);
  const headerIndexes = lines
    .map((line, index) => (REVIEWER_VERDICT_HEADER.test(line) ? index : -1))
    .filter((index) => index >= 0);
  if (headerIndexes.length !== 1) return undefined;

  let headSha: string | undefined;
  let code: ReviewerVerdict["code"] | undefined;
  for (const line of lines.slice(headerIndexes[0]! + 1)) {
    if (line.trim() === "") break;
    const headMatch = REVIEWER_VERDICT_HEAD.exec(line);
    if (headMatch) {
      if (headSha !== undefined) return undefined;
      headSha = headMatch[1]!;
      continue;
    }
    const codeMatch = REVIEWER_VERDICT_CODE.exec(line);
    if (codeMatch) {
      if (code !== undefined) return undefined;
      code = Number(codeMatch[1]) as ReviewerVerdict["code"];
      continue;
    }
    const lgtmMatch = LGTM_PIN_LINE.exec(line);
    if (lgtmMatch) {
      if (lgtmMatch[1]!.toLowerCase() !== currentHeadSha.toLowerCase()) return undefined;
      continue;
    }
    return undefined;
  }

  if (headSha === undefined || code === undefined) return undefined;
  if (headSha.toLowerCase() !== currentHeadSha.toLowerCase()) return undefined;
  return { headSha: currentHeadSha, code };
}

function reviewerVerdictsFromItems(
  entries: unknown[],
  currentHeadSha: string,
): TimedReviewerVerdict[] {
  const verdicts: TimedReviewerVerdict[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const body = (entry as { body?: unknown }).body;
    if (typeof body !== "string") continue;
    const verdict = reviewerVerdictFromBody(body, currentHeadSha);
    if (verdict === undefined) continue;
    verdicts.push({ ...verdict, author: loginFromItem(entry), t: timestampFromItem(entry) });
  }
  return verdicts;
}
// -/ 2/5

// -- 3/5 CORE · latestGitHubLgtmSha + latestGitHubReviewerVerdict --
export function latestGitHubLgtmSha(
  gh: GhRunner,
  prUrl: string,
  cache?: GhApiCache,
  options: LatestReviewerSignalOptions = {},
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
  const pins = [...pinsFromItems(comments, options), ...pinsFromItems(reviews, options)];
  pins.sort((a, b) => a.t - b.t);
  return pins.at(-1)?.sha;
}

export function latestGitHubReviewerVerdict(
  gh: GhRunner,
  prUrl: string,
  currentHeadSha: string,
  cache?: GhApiCache,
  _options: LatestReviewerSignalOptions = {},
): ReviewerVerdict | undefined {
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
  const verdicts = [
    ...reviewerVerdictsFromItems(comments, currentHeadSha),
    ...reviewerVerdictsFromItems(reviews, currentHeadSha),
  ];
  verdicts.sort((a, b) => a.t - b.t);
  const latest = verdicts.at(-1);
  return latest === undefined ? undefined : { headSha: latest.headSha, code: latest.code, author: latest.author };
}
// -/ 3/5

// -- 4/5 CORE · parsePrView --
export interface PrView {
  headSha: string;
  state: string;
  mergedAt?: string;
  mergedBy?: string;
  baseRefName?: string;
  mergeStateStatus?: string;
  mergeable?: string;
  mergeSha?: string;
  statusCheckRollup?: unknown[];
  comments?: unknown[];
}

const READY_BLOCKING_MERGE_STATES = new Set(["DIRTY", "CONFLICTING"]);

function upperNonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value.trim().toUpperCase();
}

export function blockingReadyMergeState(prView: Pick<PrView, "mergeStateStatus" | "mergeable">): string | undefined {
  const mergeStateStatus = upperNonEmpty(prView.mergeStateStatus);
  if (mergeStateStatus !== undefined && READY_BLOCKING_MERGE_STATES.has(mergeStateStatus)) {
    return mergeStateStatus;
  }
  const mergeable = upperNonEmpty(prView.mergeable);
  if (mergeable !== undefined && READY_BLOCKING_MERGE_STATES.has(mergeable)) {
    return mergeable;
  }
  return undefined;
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
    const mergeable = (parsed as { mergeable?: unknown }).mergeable;
    const mergeCommit = (parsed as { mergeCommit?: unknown }).mergeCommit;
    const statusCheckRollup = (parsed as { statusCheckRollup?: unknown }).statusCheckRollup;
    const comments = (parsed as { comments?: unknown }).comments;
    const view: PrView = {
      headSha: (parsed as { headRefOid: string }).headRefOid,
      state: typeof state === "string" && state.length > 0 ? state : "OPEN",
    };
    if (Array.isArray(statusCheckRollup)) {
      view.statusCheckRollup = statusCheckRollup;
    }
    if (Array.isArray(comments)) {
      view.comments = comments;
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
    if (typeof mergeable === "string" && mergeable.length > 0) {
      view.mergeable = mergeable;
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
  issueUrl: string | undefined,
  prUrl: string | undefined,
  cache?: GhApiCache,
  options: { requiredCheckNames?: string[]; ambientCheckNames?: string[]; reviewerLogins?: string[] } = {},
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
          ci: rollupSignal(parsed.statusCheckRollup, {
            requiredCheckNames: options.requiredCheckNames,
            selectRequired: false,
            ambientCheckNames: options.ambientCheckNames,
          }),
          readyRequiredChecks: rollupSignal(parsed.statusCheckRollup, {
            requiredCheckNames: options.requiredCheckNames,
            selectRequired: true,
            ambientCheckNames: options.ambientCheckNames,
          }),
          ambientReviewer: rollupAmbientSignal(parsed.statusCheckRollup, options.ambientCheckNames ?? []),
          ...(parsed.mergedAt !== undefined ? { mergedAt: parsed.mergedAt } : {}),
          ...(parsed.mergeStateStatus !== undefined
            ? {
                mergeState: parsed.mergeStateStatus,
                branchBehind: parsed.mergeStateStatus.toUpperCase() === "BEHIND",
              }
            : {}),
        };
        try {
          facts.pr.reviewerPinnedSha =
            latestGitHubLgtmSha(gh, prUrl, cache, { allowedAuthors: options.reviewerLogins }) ?? null;
        } catch {
          // Forensics is best-effort: PR metadata is still useful if comments or
          // reviews are temporarily unreadable.
        }
      } catch {
        // Leave PR facts unknown when gh returns an unexpected shape.
      }
    }
  }

  if (issueUrl !== undefined && issueUrl.trim() !== "") {
    const issue = gh(["issue", "view", issueUrl, "--json", "state,closedAt"]);
    if (issue.status === 0) {
      const parsed = parseIssueView(issue.stdout);
      if (parsed !== undefined) facts.issue = parsed;
    }
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

function rollupSignal(
  rollup: unknown[] | undefined,
  options: { requiredCheckNames?: string[]; selectRequired: boolean; ambientCheckNames?: string[] },
): GithubSignalState {
  if (rollup === undefined) return "unknown";
  const requiredCheckNames = options.requiredCheckNames ?? [];
  const ambientCheckNames = options.ambientCheckNames ?? [];
  const items = rollup.filter((item) => {
    const isRequired = checkNameMatchesAny(item, requiredCheckNames);
    const isAmbient = checkNameMatchesAny(item, ambientCheckNames);
    if (isAmbient) return false;
    return isRequired === options.selectRequired;
  });
  if (items.length === 0) return "unknown";
  const states = items.map((item) => checkSignalState(item, options.selectRequired));
  if (states.includes("failure")) return "failure";
  if (states.every((state) => state === "success")) return "success";
  if (states.includes("pending")) return "pending";
  return "unknown";
}

function rollupAmbientSignal(rollup: unknown[] | undefined, ambientCheckNames: string[]): GithubSignalState | undefined {
  if (rollup === undefined || ambientCheckNames.length === 0) return undefined;
  const items = rollup.filter((item) => checkNameMatchesAny(item, ambientCheckNames));
  if (items.length === 0) return "unknown";
  const states = items.map((item) => checkSignalState(item, false));
  if (states.includes("failure")) return "failure";
  if (states.every((state) => state === "success")) return "success";
  if (states.includes("pending")) return "pending";
  return "unknown";
}

function checkSignalState(item: unknown, strictSuccess = false): GithubSignalState {
  if (!isRecord(item)) return "unknown";
  const conclusion = upperString(item["conclusion"]);
  if (conclusion !== undefined) {
    if (strictSuccess) {
      if (conclusion === "SUCCESS") return "success";
    } else if (SUCCESSFUL_CHECK_CONCLUSIONS.has(conclusion)) {
      return "success";
    }
    if (FAILURE_CHECK_CONCLUSIONS.has(conclusion)) return "failure";
    return "unknown";
  }
  const state = upperString(item["state"] ?? item["status"]);
  if (state !== undefined) {
    if (strictSuccess) {
      if (state === "SUCCESS") return "success";
    } else if (SUCCESSFUL_STATUS_STATES.has(state)) {
      return "success";
    }
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

function upperString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim().toUpperCase() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
// -/ 5/5
