/**
 * @overview Unit tests for the reviewer role. ~78 lines, testing
 *   the default reviewer prompt contract (COMMENT-only, never-APPROVE,
 *   lgtm convention, reviewer!=coder rule), shell-safe review submission,
 *   local skill routing, and reviewer invocation command rendering.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at describe("defaultReviewerPrompt")   ← verdict contract
 *   2. Then describe("buildReviewerInvocation")     ← command rendering
 *
 *   ┌─ TEST AREAS ──────────────────────────────────────┐
 *   │ defaultReviewerPrompt    Prompt contract rules + local skill │
 *   │ buildReviewerInvocation  Command template render + safety   │
 *   └────────────────────────────────────────────────────┘
 *
 * @exports none (test file)
 * @deps vitest, ./reviewer
 */
import { describe, expect, it } from "vitest";

import {
  ReviewerInvocationError,
  buildReviewerInvocation,
  defaultReviewerPrompt,
} from "./reviewer.js";

const combo = {
  id: "o-r-9",
  issueUrl: "https://github.com/o/r/issues/9",
  repoDir: "/repos/r",
  worktree: "/repos/r/.worktrees/issue-9",
  branch: "combo/issue-9",
  tmuxSession: "combo-chen-o-r-9",
  createdAt: "2026-06-10T00:00:00.000Z",
};

const prUrl = "https://github.com/o/r/pull/9";
const protocol = "repository review protocol + project overlay 8034";

// -- 1/1 CORE · defaultReviewerPrompt + buildReviewerInvocation ← START HERE --
describe("defaultReviewerPrompt", () => {
  it("injects the PR URL, protocol, and the COMMENT-only verdict contract", () => {
    const prompt = defaultReviewerPrompt({ combo, prUrl, protocol });

    expect(prompt).toContain(prUrl);
    expect(prompt).toContain(protocol);
    expect(prompt).toContain("COMMENT reviews or issue comments");
    expect(prompt).toContain("never APPROVE");
    expect(prompt).toContain("lgtm @ <sha>");
    expect(prompt).toContain("never write code");
    expect(prompt).toContain("reviewer != coder");
  });

  it("spells out the allowlist-friendly submit command and command discipline", () => {
    const prompt = defaultReviewerPrompt({ combo, prUrl, protocol });

    expect(prompt).toContain('local review skill "pr-review-protocol"');
    expect(prompt).toContain("gh pr review");
    expect(prompt).toContain("--comment --body");
    expect(prompt).toContain("Do not use heredocs, temp files, cat, rm, shell redirection, pipes, semicolons, or &&/||");
    expect(prompt).toContain("one plain command per tool call");
  });

  it("lets config override the local review skill name", () => {
    const prompt = defaultReviewerPrompt({ combo, prUrl, protocol, skillName: "repo-review" });

    expect(prompt).toContain('local review skill "repo-review"');
  });
});

describe("buildReviewerInvocation", () => {
  it("renders the configured reviewer command with quoted PR facts and prompt", () => {
    const command = buildReviewerInvocation({
      reviewerCommand: "claude --judge {pr_url} {protocol} {prompt}",
      combo,
      prUrl,
      protocol,
    });

    expect(command).toContain("--judge 'https://github.com/o/r/pull/9'");
    expect(command).toContain("'repository review protocol + project overlay 8034'");
    expect(command).toContain("COMMENT reviews or issue comments");
    expect(command).toContain("lgtm @ <sha>");
  });

  it("lets a custom prompt replace the default contract text", () => {
    const command = buildReviewerInvocation({
      reviewerCommand: "judge {prompt}",
      combo,
      prUrl,
      protocol,
      prompt: "review this one diff only",
    });

    expect(command).toBe("judge 'review this one diff only'");
  });

  it("rejects compound reviewer commands before launching a stuck worker", () => {
    expect(() =>
      buildReviewerInvocation({
        reviewerCommand: "claude {prompt} && rm -f /tmp/review.md",
        combo,
        prUrl,
        protocol,
      }),
    ).toThrow(ReviewerInvocationError);
  });
});
// -/ 1/1
