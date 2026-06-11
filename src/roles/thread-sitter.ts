/**
 * Thread-sitter nudges: hard review signals in, interactive rower attention
 * out. This module does not mutate GitHub or the repo; it only writes the
 * combo journal and sends keys to the already-owned sitter window.
 */
import type { ComboEvent } from "../core/events.js";
import { appendEvent, readEvents } from "../core/events.js";
import { nudgeWindowArgs, type TmuxResult } from "../infra/tmux.js";

export const THREAD_SITTER_WINDOW = "thread-sitter";

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface ReviewCommentSignal {
  author: string;
  kind: string;
  url: string;
}

interface PullRef {
  owner: string;
  repo: string;
  number: number;
}

export function buildReviewNudgePrompt(comment: ReviewCommentSignal): string {
  return [
    "New review comment for the thread-sitter:",
    comment.url,
    "",
    "Use the two-bucket contract: handle mechanical fixes autonomously with TDD, code, push, and PR replies; escalate intent-touching decisions with needs_human before changing code.",
    "Before pushing, check the hodor push semaphore.",
  ].join("\n");
}

export function routeReviewComments(input: {
  runDir: string;
  tmuxSession: string;
  comments: ReviewCommentSignal[];
  tmux: (args: string[]) => TmuxResult;
  windowName?: string;
}): ReviewCommentSignal[] {
  const seen = routedReviewCommentUrls(input.runDir);
  const routed: ReviewCommentSignal[] = [];
  const windowName = input.windowName ?? THREAD_SITTER_WINDOW;

  for (const comment of input.comments) {
    if (seen.has(comment.url)) continue;
    const prompt = buildReviewNudgePrompt(comment);
    for (const args of nudgeWindowArgs(input.tmuxSession, windowName, prompt)) {
      const result = input.tmux(args);
      if (result.status !== 0) {
        throw new Error(`tmux nudge failed: ${result.stderr.trim() || "unknown error"}`);
      }
    }
    appendEvent(input.runDir, "review_comment", {
      author: comment.author,
      kind: comment.kind,
      url: comment.url,
    });
    seen.add(comment.url);
    routed.push(comment);
  }

  return routed;
}

export function latestPrUrl(events: ComboEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.event === "pr_opened" && typeof event.url === "string") {
      return event.url;
    }
  }
  return undefined;
}

export function fetchReviewCommentSignals(
  prUrl: string,
  gh: (args: string[]) => CommandResult,
): ReviewCommentSignal[] {
  const pr = parsePullRequestUrl(prUrl);
  const endpoints = [
    { kind: "pr_comment", path: `repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments` },
    { kind: "review_comment", path: `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments` },
    { kind: "review", path: `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews` },
  ];
  const seen = new Set<string>();
  const signals: ReviewCommentSignal[] = [];

  for (const endpoint of endpoints) {
    for (const item of readGhArray(gh, endpoint.path)) {
      const signal =
        endpoint.kind === "review"
          ? signalFromReview(item)
          : signalFromComment(item, endpoint.kind);
      if (signal === undefined || seen.has(signal.url)) continue;
      seen.add(signal.url);
      signals.push(signal);
    }
  }

  return signals;
}

function routedReviewCommentUrls(runDir: string): Set<string> {
  const urls = new Set<string>();
  for (const event of readEvents(runDir)) {
    if (event.event === "review_comment" && typeof event.url === "string") {
      urls.add(event.url);
    }
  }
  return urls;
}

function parsePullRequestUrl(url: string): PullRef {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(
    url.trim(),
  );
  if (!match) {
    throw new Error(`Not a GitHub pull request URL: "${url}"`);
  }
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]!) };
}

function readGhArray(gh: (args: string[]) => CommandResult, endpoint: string): unknown[] {
  const result = gh(["api", endpoint]);
  if (result.status !== 0) {
    throw new Error(`gh api failed for ${endpoint}: ${result.stderr.trim() || "unknown error"}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`gh api returned invalid JSON for ${endpoint}: ${message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`gh api returned non-array JSON for ${endpoint}`);
  }
  return parsed;
}

function signalFromComment(item: unknown, kind: string): ReviewCommentSignal | undefined {
  if (!isRecord(item) || !hasNonEmptyBody(item)) return undefined;
  const url = item["html_url"];
  const user = item["user"];
  if (typeof url !== "string" || url.trim() === "") return undefined;
  if (!isRecord(user) || typeof user["login"] !== "string" || user["login"].trim() === "") {
    return undefined;
  }
  return { author: user["login"], kind, url };
}

function signalFromReview(item: unknown): ReviewCommentSignal | undefined {
  if (!isRecord(item) || item["state"] === "APPROVED") return undefined;
  return signalFromComment(item, "review");
}

function hasNonEmptyBody(item: Record<string, unknown>): boolean {
  return typeof item["body"] === "string" && item["body"].trim() !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
