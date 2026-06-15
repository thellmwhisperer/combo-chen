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

interface PullRequestRef {
  owner: string;
  repo: string;
  number: string;
}

function parsePullRequestUrl(prUrl: string): PullRequestRef | undefined {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(prUrl);
  if (!match) return undefined;
  return { owner: match[1]!, repo: match[2]!, number: match[3]! };
}

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

function pinsFromPayload(stdout: string): GitHubPin[] {
  let parsed: unknown[];
  try {
    parsed = [JSON.parse(stdout)];
  } catch {
    parsed = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  const entries = parsed.flatMap((entry) => (Array.isArray(entry) ? entry : [entry]));
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

export function latestGitHubLgtmSha(gh: GhRunner, prUrl: string): string | undefined {
  const ref = parsePullRequestUrl(prUrl);
  if (!ref) return undefined;

  const comments = gh([
    "api",
    `repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`,
    "--paginate",
  ]);
  if (comments.status !== 0) {
    throw new Error(`gh issue comments failed for ${prUrl}: ${comments.stderr.trim() || "unknown error"}`);
  }

  const reviews = gh([
    "api",
    `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`,
    "--paginate",
  ]);
  if (reviews.status !== 0) {
    throw new Error(`gh pull reviews failed for ${prUrl}: ${reviews.stderr.trim() || "unknown error"}`);
  }

  const pins = [...pinsFromPayload(comments.stdout), ...pinsFromPayload(reviews.stdout)];
  pins.sort((a, b) => a.t - b.t);
  return pins.at(-1)?.sha;
}

export interface PrView {
  headSha: string;
  state: string;
  mergedBy?: string;
  baseRefName?: string;
  mergeSha?: string;
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
    const mergedBy = (parsed as { mergedBy?: unknown }).mergedBy;
    const baseRefName = (parsed as { baseRefName?: unknown }).baseRefName;
    const mergeCommit = (parsed as { mergeCommit?: unknown }).mergeCommit;
    const view: PrView = {
      headSha: (parsed as { headRefOid: string }).headRefOid,
      state: typeof state === "string" && state.length > 0 ? state : "OPEN",
    };
    if (typeof baseRefName === "string" && baseRefName.length > 0) {
      view.baseRefName = baseRefName;
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
