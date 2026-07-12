/**
 * @overview Findings-aware external review evidence for the v1 READY leg
 *   (issue #295 slice B): a provider SUCCESS check is not proof of a clean
 *   review. Evidence is clean only when a fresh, non-skipped agent review is
 *   pinned to the current head AND no unresolved actionable agent thread
 *   remains. ~200 lines, deterministic states, no LLM consultation.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at fetchExternalReviewEvidence <- the state decision, in order.
 *   2. Then readAgentReviewAtHead           <- REST review freshness + skip marker.
 *   3. Then readUnresolvedAgentThreads      <- GraphQL reviewThreads pagination.
 *
 *   MAIN FLOW
 *   ---------
 *   gh REST pulls/N/reviews + gh api graphql reviewThreads
 *     -> missing | skipped | findings | unknown | clean
 *
 *   PUBLIC API
 *   ----------
 *   ExternalReviewEvidenceState  The five evidence states; only clean unblocks READY.
 *   ExternalReviewFinding        One unresolved actionable thread projection.
 *   ExternalReviewEvidence       Complete evidence for one head.
 *   fetchExternalReviewEvidence  Read reviews + threads and classify.
 *   externalReviewEvidenceClean  True only for the clean state.
 *
 *   INTERNALS
 *   ---------
 *   REVIEW_THREADS_QUERY, ACTIONABLE_COUNT_PATTERN, reviewAuthorLogin,
 *   readAgentReviewAtHead, readReviewThreads, readUnresolvedAgentThreads,
 *   GraphQLThreadsError
 *
 * @exports ExternalReviewEvidenceState, ExternalReviewFinding, ExternalReviewEvidence, fetchExternalReviewEvidence, externalReviewEvidenceClean
 * @deps ../../core/{gh-api,guards,pr-url}, ./checks, ./github
 */
import { readGhArray, type GhApiCache } from "../../core/gh-api.js";
import { isRecord } from "../../core/guards.js";
import { parseGitHubPullRequestUrl, type GitHubPullRequestRef } from "../../core/pr-url.js";
import { authorMatchesConfiguredAgent, configuredAgents, textLooksReviewSkipped } from "./checks.js";
import type { GhRunner } from "./github.js";

// -- 1/4 CORE · evidence contract <- START HERE --
export type ExternalReviewEvidenceState = "clean" | "findings" | "missing" | "skipped" | "unknown";

export interface ExternalReviewFinding {
  author: string;
  path?: string;
  line?: number;
  excerpt: string;
  url?: string;
}

export interface ExternalReviewEvidence {
  state: ExternalReviewEvidenceState;
  headSha: string;
  /** Commit the freshest configured-agent review is pinned to, when one exists at head. */
  agentReviewSha?: string;
  agentReviewAuthor?: string;
  unresolvedFindings: ExternalReviewFinding[];
  detail?: string;
}

export function externalReviewEvidenceClean(evidence: Pick<ExternalReviewEvidence, "state">): boolean {
  return evidence.state === "clean";
}
// -/ 1/4

// -- 2/4 HELPER · REST agent review at head --
/** CodeRabbit-style review summary counter; any positive count is a findings claim. */
const ACTIONABLE_COUNT_PATTERN = /actionable\s+comments?\s+posted:\s*([0-9]+)/i;
const FINDING_EXCERPT_LIMIT = 200;

function reviewAuthorLogin(review: Record<string, unknown>): string | undefined {
  const user = review["user"];
  if (!isRecord(user)) return undefined;
  const login = user["login"];
  return typeof login === "string" && login.trim() !== "" ? login.trim() : undefined;
}

function readAgentReviewAtHead(
  gh: GhRunner,
  ref: GitHubPullRequestRef,
  headSha: string,
  agents: string[],
  cache?: GhApiCache,
): { author: string; body: string; sha: string } | undefined {
  const reviews = readGhArray(gh, `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`, cache);
  let latest: { author: string; body: string; sha: string; t: number } | undefined;
  for (const review of reviews) {
    if (!isRecord(review)) continue;
    const author = reviewAuthorLogin(review);
    if (author === undefined || !authorMatchesConfiguredAgent(author.toLowerCase(), agents)) continue;
    if (review["commit_id"] !== headSha) continue;
    const submitted = review["submitted_at"];
    const t = typeof submitted === "string" ? Date.parse(submitted) : 0;
    if (latest !== undefined && t <= latest.t) continue;
    const body = review["body"];
    latest = { author, body: typeof body === "string" ? body : "", sha: headSha, t };
  }
  return latest === undefined ? undefined : { author: latest.author, body: latest.body, sha: latest.sha };
}
// -/ 2/4

// -- 3/4 HELPER · GraphQL review threads --
class GraphQLThreadsError extends Error {}

const REVIEW_THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          isOutdated
          path
          line
          comments(first: 1) { nodes { author { login } body url } }
        }
      }
    }
  }
}`;

interface ReviewThread {
  isResolved: boolean;
  isOutdated: boolean;
  path?: string;
  line?: number;
  author?: string;
  body: string;
  url?: string;
}

function parseThreadNode(node: unknown): ReviewThread | undefined {
  if (!isRecord(node)) return undefined;
  const comments = node["comments"];
  const first = isRecord(comments) && Array.isArray(comments["nodes"]) ? comments["nodes"][0] : undefined;
  const author =
    isRecord(first) && isRecord(first["author"]) && typeof first["author"]["login"] === "string"
      ? first["author"]["login"]
      : undefined;
  const body = isRecord(first) && typeof first["body"] === "string" ? first["body"] : "";
  const url = isRecord(first) && typeof first["url"] === "string" ? first["url"] : undefined;
  return {
    isResolved: node["isResolved"] === true,
    isOutdated: node["isOutdated"] === true,
    ...(typeof node["path"] === "string" ? { path: node["path"] } : {}),
    ...(typeof node["line"] === "number" ? { line: node["line"] } : {}),
    ...(author === undefined ? {} : { author }),
    body,
    ...(url === undefined ? {} : { url }),
  };
}

function readReviewThreads(gh: GhRunner, ref: GitHubPullRequestRef): ReviewThread[] {
  const threads: ReviewThread[] = [];
  let cursor: string | undefined;
  do {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${REVIEW_THREADS_QUERY}`,
      "-f",
      `owner=${ref.owner}`,
      "-f",
      `repo=${ref.repo}`,
      "-F",
      `number=${ref.number}`,
      ...(cursor === undefined ? [] : ["-f", `cursor=${cursor}`]),
    ];
    const result = gh(args);
    if (result.status !== 0) {
      throw new GraphQLThreadsError(
        `review threads query failed (status ${result.status}): ${result.stderr.trim() || "unknown error"}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      throw new GraphQLThreadsError(
        `review threads query returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const connection =
      isRecord(parsed) &&
      isRecord(parsed["data"]) &&
      isRecord(parsed["data"]["repository"]) &&
      isRecord(parsed["data"]["repository"]["pullRequest"])
        ? parsed["data"]["repository"]["pullRequest"]["reviewThreads"]
        : undefined;
    if (!isRecord(connection) || !Array.isArray(connection["nodes"])) {
      throw new GraphQLThreadsError("review threads query returned no reviewThreads connection");
    }
    for (const node of connection["nodes"]) {
      const thread = parseThreadNode(node);
      if (thread !== undefined) threads.push(thread);
    }
    const pageInfo = connection["pageInfo"];
    cursor =
      isRecord(pageInfo) && pageInfo["hasNextPage"] === true && typeof pageInfo["endCursor"] === "string"
        ? pageInfo["endCursor"]
        : undefined;
  } while (cursor !== undefined);
  return threads;
}

function readUnresolvedAgentThreads(
  gh: GhRunner,
  ref: GitHubPullRequestRef,
  agents: string[],
): { unresolved: ExternalReviewFinding[]; agentThreadCount: number } {
  const unresolved: ExternalReviewFinding[] = [];
  let agentThreadCount = 0;
  for (const thread of readReviewThreads(gh, ref)) {
    if (thread.author === undefined || !authorMatchesConfiguredAgent(thread.author.toLowerCase(), agents)) {
      continue;
    }
    agentThreadCount += 1;
    if (thread.isResolved || thread.isOutdated) continue;
    unresolved.push({
      author: thread.author,
      ...(thread.path === undefined ? {} : { path: thread.path }),
      ...(thread.line === undefined ? {} : { line: thread.line }),
      excerpt: thread.body.slice(0, FINDING_EXCERPT_LIMIT),
      ...(thread.url === undefined ? {} : { url: thread.url }),
    });
  }
  return { unresolved, agentThreadCount };
}
// -/ 3/4

// -- 4/4 CORE · fetchExternalReviewEvidence --
/**
 * Classification order:
 * 1. unparsable PR url or failed thread query -> unknown (never clean);
 * 2. no configured-agent review pinned to the current head -> missing
 *    (#295: a stale review at a superseded head is not current evidence);
 * 3. the head review carries a skip marker -> skipped;
 * 4. any unresolved, non-outdated agent thread -> findings; a head review
 *    claiming a positive actionable count with zero visible agent threads is
 *    also findings (the claim is evidence, the missing threads are not proof
 *    of resolution);
 * 5. otherwise clean.
 */
export function fetchExternalReviewEvidence(
  gh: GhRunner,
  prUrl: string,
  headSha: string,
  externalCommentAgents: string[],
  cache?: GhApiCache,
): ExternalReviewEvidence {
  const ref = parseGitHubPullRequestUrl(prUrl);
  if (ref === undefined) {
    return { state: "unknown", headSha, unresolvedFindings: [], detail: `unparsable PR url: ${prUrl}` };
  }
  const agents = configuredAgents(externalCommentAgents);
  try {
    const review = agents.length === 0 ? undefined : readAgentReviewAtHead(gh, ref, headSha, agents, cache);
    if (review === undefined) {
      return {
        state: "missing",
        headSha,
        unresolvedFindings: [],
        detail: `no configured-agent review pinned to head ${headSha}`,
      };
    }
    if (textLooksReviewSkipped(review.body)) {
      return {
        state: "skipped",
        headSha,
        agentReviewSha: review.sha,
        agentReviewAuthor: review.author,
        unresolvedFindings: [],
        detail: "agent review at head reports the review was skipped",
      };
    }
    const { unresolved, agentThreadCount } = readUnresolvedAgentThreads(gh, ref, agents);
    if (unresolved.length > 0) {
      return {
        state: "findings",
        headSha,
        agentReviewSha: review.sha,
        agentReviewAuthor: review.author,
        unresolvedFindings: unresolved,
      };
    }
    const actionableMatch = ACTIONABLE_COUNT_PATTERN.exec(review.body);
    const actionableClaimed = actionableMatch === null ? 0 : Number(actionableMatch[1]);
    if (actionableClaimed > 0 && agentThreadCount === 0) {
      return {
        state: "findings",
        headSha,
        agentReviewSha: review.sha,
        agentReviewAuthor: review.author,
        unresolvedFindings: [],
        detail:
          `head review claims ${actionableClaimed} actionable comment(s) ` +
          "but no agent thread is visible to prove resolution",
      };
    }
    return {
      state: "clean",
      headSha,
      agentReviewSha: review.sha,
      agentReviewAuthor: review.author,
      unresolvedFindings: [],
    };
  } catch (error) {
    return {
      state: "unknown",
      headSha,
      unresolvedFindings: [],
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
// -/ 4/4
