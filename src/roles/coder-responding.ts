/**
 * Coder responding nudges: hard review signals in, interactive coder attention
 * out. This module does not mutate GitHub or the repo; it only writes the
 * combo journal and delivers prompts to the already-owned coder window
 * via paste-buffer (set-buffer, paste-buffer, send-keys C-m).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { shellQuote } from "../core/combo.js";
import type { ComboEvent } from "../core/events.js";
import { appendEvent, readEvents } from "../core/events.js";
import { renderCommand } from "../infra/config.js";
import { nudgeWindowArgs, type TmuxResult } from "../infra/tmux.js";
import {
  CODER_THREAD_ARTIFACT,
  LEGACY_ROWER_THREAD_ARTIFACT,
  type CoderThreadArtifact,
} from "./coder.js";

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

export function buildCoderRespondingResumeCommand(
  artifact: CoderThreadArtifact,
  resumeCommand: string,
): string {
  return renderCommand(resumeCommand, { thread_id: artifact.thread_id });
}

export function buildReviewWatchCommand(input: {
  cli: string;
  comboId: string;
  pollSeconds: number;
}): string {
  return `while :; do ${input.cli} nudge-review-comments -n ${shellQuote(input.comboId)}; sleep ${input.pollSeconds}; done`;
}

export function routeReviewComments(input: {
  runDir: string;
  tmuxSession: string;
  comments: ReviewCommentSignal[];
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

export function parsePullRequestUrl(url: string): PullRef {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(
    url.trim(),
  );
  if (!match) {
    throw new Error(`Not a GitHub pull request URL: "${url}"`);
  }
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]!) };
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

export function signalFromComment(item: unknown, kind: string): ReviewCommentSignal | undefined {
  if (!isRecord(item) || !hasNonEmptyBody(item)) return undefined;
  const url = item["html_url"];
  const user = item["user"];
  if (typeof url !== "string" || url.trim() === "") return undefined;
  if (!isRecord(user) || typeof user["login"] !== "string" || user["login"].trim() === "") {
    return undefined;
  }
  return { author: user["login"], kind, url };
}

export function signalFromReview(item: unknown): ReviewCommentSignal | undefined {
  if (!isRecord(item) || item["state"] === "APPROVED") return undefined;
  return signalFromComment(item, "review");
}

function hasNonEmptyBody(item: Record<string, unknown>): boolean {
  return typeof item["body"] === "string" && item["body"].trim() !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
