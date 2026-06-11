import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readEvents } from "../core/events.js";
import {
  buildReviewNudgePrompt,
  buildReviewWatchCommand,
  buildThreadSitterResumeCommand,
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

describe("thread-sitter activation commands", () => {
  it("resumes the implementing Codex thread from the persisted rower artifact", () => {
    expect(
      buildThreadSitterResumeCommand({
        agent: "codex",
        thread_id: "019eb3f5-c135-76d2-88c5-0aa8edfe4c84",
        source: ".gnhf/runs/implement-github-iss-e6510c/iteration-1.jsonl",
      }),
    ).toBe("codex resume '019eb3f5-c135-76d2-88c5-0aa8edfe4c84'");
  });

  it("builds a small polling watcher around the read-only nudge helper", () => {
    expect(
      buildReviewWatchCommand({
        cli: '"node" "/opt/combo/dist/cli.mjs"',
        comboId: "o-r-7",
        pollSeconds: 7,
      }),
    ).toBe(
      'while :; do "node" "/opt/combo/dist/cli.mjs" nudge-review-comments -n \'o-r-7\'; sleep 7; done',
    );
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
