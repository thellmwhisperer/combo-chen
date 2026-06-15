/**
 * @overview Coder responding mode: routes hard review signals into the combo
 *   journal and delivers prompts to the coder tmux window via paste-buffer.
 *   Reads only; never mutates GitHub or the repo. ~316 lines, 11 exports.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at routeReviewComments      ← the core nudge pipeline
 *   2. fetchReviewCommentSignals         ← GitHub → ReviewCommentSignal[]
 *   3. buildCoderRespondingResumeCommand ← resume the coder from thread_id
 *   4. signalFromComment / signalFromReview ← signal extraction helpers
 *
 *   MAIN FLOW
 *   ─────────
 *   nudge-review-comments command
 *     → fetchReviewCommentSignals(prUrl, gh)
 *       → readGhArray(gh, endpoint)
 *         → signalFromComment / signalFromReview
 *     → routeReviewComments({comments, tmuxSession, windowName})
 *       → buildReviewNudgePrompt → nudgeWindowArgs → tmux(paste-buffer)
 *       → appendEvent("review_comment", ...)
 *
 *   ┌─ PUBLIC API ─────────────────────────────────────────────────────┐
 *   │ routeReviewComments           Route new comments → coder window   │
 *   │ fetchReviewCommentSignals     Pull review signals from GitHub     │
 *   │ buildCoderRespondingResumeCommand Resume coder from thread_id     │
 *   │ buildReviewNudgePrompt        Render nudge prompt from template   │
 *   │ readCoderThreadArtifact       Load persisted thread_id            │
 *   │ latestPrUrl                   Find pr_opened URL in journal       │
 *   │ parsePullRequestUrl           Parse PR URL → {owner,repo,number}  │
 *   │ readGhArray                   gh api --paginate → parsed array    │
 *   │ signalFromComment             Extract signal from comment JSON    │
 *   │ signalFromReview              Extract signal from review JSON     │
 *   ├─ INTERNALS ──────────────────────────────────────────────────────┤
 *   │ ReviewCommentSignal, routedReviewCommentUrls, artifactNameFor,   │
 *   │ bodyText, meaningfulLines, isCodeRabbitRetriggerBookkeeping,       │
 *   │ isCodeRabbitRateLimitComment, isPinnedLgtmReview, isRecord        │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * @exports ReviewCommentSignal, buildReviewNudgePrompt, readCoderThreadArtifact, buildCoderRespondingResumeCommand, routeReviewComments, latestPrUrl, fetchReviewCommentSignals, parsePullRequestUrl, readGhArray, signalFromComment, signalFromReview
 * @deps node:fs, node:path, ../core/combo, ../core/events, ../core/pr-url, ../infra/config,
 *   ../infra/tmux, ./coder
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ComboEvent } from "../core/events.js";
import { appendEvent, readEvents } from "../core/events.js";
import {
  parseGitHubPullRequestUrl,
  type GitHubPullRequestRef,
} from "../core/pr-url.js";
import { renderCommand } from "../infra/config.js";
import { nudgeWindowArgs, type TmuxResult } from "../infra/tmux.js";
import {
  CODER_THREAD_ARTIFACT,
  LEGACY_ROWER_THREAD_ARTIFACT,
  type CoderThreadArtifact,
} from "./coder.js";

// -- 1/4 HELPER · Types + buildReviewNudgePrompt + readCoderThreadArtifact --
export interface ReviewCommentSignal {
  author: string;
  kind: string;
  url: string;
}

export function buildReviewNudgePrompt(
  comment: ReviewCommentSignal,
  template: string,
): string {
  return renderCommand(template, {
    author: comment.author,
    kind: comment.kind,
    url: comment.url,
  });
}

export function readCoderThreadArtifact(runDir: string): CoderThreadArtifact {
  const artifactName = artifactNameFor(runDir);
  if (artifactName === undefined) {
    throw new Error(
      `Missing coder thread artifact: expected ${CODER_THREAD_ARTIFACT} or ${LEGACY_ROWER_THREAD_ARTIFACT} in ${runDir}`,
    );
  }
  const artifactPath = join(runDir, artifactName);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(artifactPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${artifactName} is not valid JSON: ${message}`);
  }
  if (
    !isRecord(parsed) ||
    parsed["agent"] !== "codex" ||
    typeof parsed["thread_id"] !== "string" ||
    parsed["thread_id"].trim() === "" ||
    typeof parsed["source"] !== "string"
  ) {
    throw new Error(`${artifactName} is not a valid Codex coder thread artifact`);
  }
  return {
    agent: parsed["agent"],
    thread_id: parsed["thread_id"],
    source: parsed["source"],
  };
}

function artifactNameFor(runDir: string): string | undefined {
  if (existsSync(join(runDir, CODER_THREAD_ARTIFACT))) return CODER_THREAD_ARTIFACT;
  if (existsSync(join(runDir, LEGACY_ROWER_THREAD_ARTIFACT))) return LEGACY_ROWER_THREAD_ARTIFACT;
  return undefined;
}
// -/ 1/4

// -- 2/4 CORE · Resume + route ← START HERE --
export function buildCoderRespondingResumeCommand(
  artifact: CoderThreadArtifact,
  resumeCommand: string,
): string {
  return renderCommand(resumeCommand, { thread_id: artifact.thread_id });
}

export function routeReviewComments(input: {
  runDir: string;
  tmuxSession: string;
  comments: ReviewCommentSignal[];
  headSha?: string;
  reviewNudgePrompt: string;
  tmux: (args: string[]) => TmuxResult;
  windowName: string;
}): ReviewCommentSignal[] {
  const seen = routedReviewCommentUrls(input.runDir);
  const routed: ReviewCommentSignal[] = [];

  for (const comment of input.comments) {
    if (seen.has(comment.url)) continue;
    const prompt = buildReviewNudgePrompt(comment, input.reviewNudgePrompt);
    for (const args of nudgeWindowArgs(input.tmuxSession, input.windowName, prompt)) {
      const result = input.tmux(args);
      if (result.status !== 0) {
        throw new Error(`tmux nudge failed: ${result.stderr.trim() || "unknown error"}`);
      }
    }
    const payload: Record<string, unknown> = {
      author: comment.author,
      kind: comment.kind,
      url: comment.url,
    };
    if (input.headSha !== undefined) payload["head_sha"] = input.headSha;
    appendEvent(input.runDir, "review_comment", payload);
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
// -/ 2/4

// -- 3/4 CORE · fetchReviewCommentSignals + readGhArray --
export function fetchReviewCommentSignals(
  prUrl: string,
  gh: (args: string[]) => TmuxResult,
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

export function parsePullRequestUrl(url: string): GitHubPullRequestRef {
  const ref = parseGitHubPullRequestUrl(url.trim());
  if (ref === undefined) {
    throw new Error(`Not a GitHub pull request URL: "${url}"`);
  }
  return ref;
}

export function readGhArray(gh: (args: string[]) => TmuxResult, endpoint: string): unknown[] {
  const result = gh(["api", "--paginate", endpoint]);
  if (result.status !== 0) {
    throw new Error(`gh api failed for ${endpoint}: ${result.stderr.trim() || "unknown error"}`);
  }
  const chunks = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (chunks.length === 0) return [];

  const values: unknown[] = [];
  for (const chunk of chunks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(chunk);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`gh api returned invalid JSON for ${endpoint}: ${message}`);
    }
    if (Array.isArray(parsed)) {
      values.push(...parsed);
    } else if (isRecord(parsed)) {
      values.push(parsed);
    } else {
      throw new Error(`gh api returned non-array JSON for ${endpoint}`);
    }
  }
  return values;
}
// -/ 3/4

// -- 4/4 HELPER · Signal extraction from GitHub JSON --
export function signalFromComment(item: unknown, kind: string): ReviewCommentSignal | undefined {
  if (!isRecord(item)) return undefined;
  const body = bodyText(item);
  if (body === undefined) return undefined;
  const url = item["html_url"];
  const user = item["user"];
  if (typeof url !== "string" || url.trim() === "") return undefined;
  if (!isRecord(user) || typeof user["login"] !== "string" || user["login"].trim() === "") {
    return undefined;
  }
  const author = user["login"];
  if (kind === "pr_comment" && isCodeRabbitRetriggerBookkeeping(body)) return undefined;
  if (kind === "pr_comment" && isCodeRabbitRateLimitComment(author, body)) return undefined;
  return { author, kind, url };
}

export function signalFromReview(item: unknown): ReviewCommentSignal | undefined {
  if (!isRecord(item)) return undefined;
  const state = typeof item["state"] === "string" ? item["state"].toUpperCase() : "";
  if (state === "APPROVED") return undefined;
  const body = bodyText(item);
  if (state === "COMMENTED" && body !== undefined && isPinnedLgtmReview(body)) return undefined;
  return signalFromComment(item, "review");
}

function bodyText(item: Record<string, unknown>): string | undefined {
  const body = item["body"];
  return typeof body === "string" && body.trim() !== "" ? body : undefined;
}

function meaningfulLines(body: string): string[] {
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function isCodeRabbitRetriggerBookkeeping(body: string): boolean {
  const lines = meaningfulLines(body);
  if (lines.length === 0 || !/^@coderabbitai\s+review\s*$/i.test(lines[0]!)) return false;
  return lines.slice(1).every((line) => {
    const lower = line.toLowerCase();
    return lower.includes("codex") && lower.includes("coderabbit");
  });
}

function isCodeRabbitRateLimitComment(author: string, body: string): boolean {
  return (
    author.toLowerCase().startsWith("coderabbit") &&
    /\breview\s+limit\s+reached\b|rate[-\s]?limit(?:ed)?|\breview\s+skipped\b|couldn'?t start this review/i.test(body)
  );
}

function isPinnedLgtmReview(body: string): boolean {
  return /^\s*lgtm\s*@\s*[0-9a-f]{6,40}\b/i.test(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
// -/ 4/4
