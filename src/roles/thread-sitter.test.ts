import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readEvents } from "../core/events.js";
import {
  buildReviewNudgePrompt,
  routeReviewComments,
  type ReviewCommentSignal,
} from "./thread-sitter.js";

function runDir(): string {
  return mkdtempSync(join(tmpdir(), "combo-chen-thread-sitter-"));
}

const comment: ReviewCommentSignal = {
  author: "coderabbitai",
  kind: "review_comment",
  url: "https://github.com/o/r/pull/7#discussion_r1",
};

describe("buildReviewNudgePrompt", () => {
  it("includes the comment URL and the sitter's two-bucket contract", () => {
    const prompt = buildReviewNudgePrompt(comment);

    expect(prompt).toContain(comment.url);
    expect(prompt).toContain("mechanical");
    expect(prompt).toContain("intent-touching");
    expect(prompt).toContain("needs_human");
  });
});

describe("routeReviewComments", () => {
  it("sends exactly one nudge for a new comment and stays idempotent on re-read", () => {
    const dir = runDir();
    const tmuxCalls: string[][] = [];
    const tmux = (args: string[]) => {
      tmuxCalls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    };

    expect(
      routeReviewComments({
        runDir: dir,
        tmuxSession: "combo-chen-o-r-7",
        comments: [comment],
        tmux,
      }),
    ).toEqual([comment]);
    expect(
      routeReviewComments({
        runDir: dir,
        tmuxSession: "combo-chen-o-r-7",
        comments: [comment],
        tmux,
      }),
    ).toEqual([]);

    expect(tmuxCalls).toHaveLength(2);
    expect(tmuxCalls[0]).toEqual([
      "send-keys",
      "-l",
      "-t",
      "combo-chen-o-r-7:thread-sitter",
      buildReviewNudgePrompt(comment),
    ]);
    expect(tmuxCalls[1]).toEqual([
      "send-keys",
      "-t",
      "combo-chen-o-r-7:thread-sitter",
      "Enter",
    ]);
    expect(readEvents(dir).map((event) => event.event)).toEqual(["review_comment"]);
    expect(readEvents(dir)[0]).toMatchObject(comment);
  });
});
