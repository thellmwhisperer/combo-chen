/**
 * @overview Unit tests for the reviewer role. ~120 lines, testing
 *   the default reviewer prompt contract (COMMENT-only, never-APPROVE,
 *   lgtm convention, reviewer!=coder rule), shell-safe review submission,
 *   reviewer instructions, and reviewer invocation command rendering.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at describe("defaultReviewerPrompt")   ← verdict contract
 *   2. Then describe("buildReviewerInvocation")     ← command rendering
 *
 *   ┌─ TEST AREAS ──────────────────────────────────────┐
 *   │ defaultReviewerPrompt    Prompt contract rules + instructions │
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
const reviewerInstructions = "apply local reviewer instructions 8034";

// -- 1/1 CORE · defaultReviewerPrompt + buildReviewerInvocation ← START HERE --
describe("defaultReviewerPrompt", () => {
  it("injects the PR URL, reviewer instructions, and the COMMENT-only verdict contract", () => {
    const prompt = defaultReviewerPrompt({ combo, prUrl, reviewerInstructions });

    expect(prompt).toContain(prUrl);
    expect(prompt).toContain(`Reviewer instructions: ${reviewerInstructions}.`);
    expect(prompt).toContain("COMMENT reviews or issue comments");
    expect(prompt).toContain("never APPROVE");
    expect(prompt).toContain("lgtm @ <sha>");
    expect(prompt).toContain("never write code");
    expect(prompt).toContain("reviewer != coder");
  });

  it("spells out the allowlist-friendly submit command and command discipline", () => {
    const prompt = defaultReviewerPrompt({ combo, prUrl, reviewerInstructions });

    expect(prompt).toContain("gh pr review");
    expect(prompt).toContain("--comment --body");
    expect(prompt).toContain("Do not use heredocs, temp files, cat, rm, shell redirection, pipes, semicolons, or &&/||");
    expect(prompt).toContain("one plain command per tool call");
  });

  it("requires one machine-readable reviewer verdict block with routing codes", () => {
    const prompt = defaultReviewerPrompt({ combo, prUrl, reviewerInstructions });

    expect(prompt).toContain("combo-chen-reviewer-verdict:");
    expect(prompt).toContain("head: <current PR head SHA>");
    expect(prompt).toContain("code: <0|1|2|3>");
    expect(prompt).toContain("0 = OK, current-head LGTM");
    expect(prompt).toContain("1 = mechanical fix required");
    expect(prompt).toContain("2 = ambiguous or intent-sensitive");
    expect(prompt).toContain("3 = needs human");
    expect(prompt).toContain("exactly one");
  });

  it("requires anti-slop review checks for helpers, config, old paths, and tests", () => {
    const prompt = defaultReviewerPrompt({ combo, prUrl, reviewerInstructions });

    expect(prompt).toContain("Anti-slop checks");
    expect(prompt).toContain("pnpm surface or an equivalent repo search");
    expect(prompt).toContain("equivalent helper already exists");
    expect(prompt).toContain("who/when/why in the PR");
    expect(prompt).toContain("compatibility path without a removal issue or date");
    expect(prompt).toContain("contract tests");
    expect(prompt).toContain("surface budget");
  });

});

describe("buildReviewerInvocation", () => {
  it("renders the configured reviewer command with quoted PR facts and prompt", () => {
    const command = buildReviewerInvocation({
      reviewerCommand: "claude --judge {pr_url} {prompt}",
      combo,
      prUrl,
      reviewerInstructions,
    });

    expect(command).toContain("--judge 'https://github.com/o/r/pull/9'");
    expect(command).toContain("Reviewer instructions: apply local reviewer instructions 8034.");
    expect(command).toContain("COMMENT reviews or issue comments");
    expect(command).toContain("lgtm @ <sha>");
  });

  it("lets a custom prompt replace the default contract text", () => {
    const command = buildReviewerInvocation({
      reviewerCommand: "judge {prompt}",
      combo,
      prUrl,
      reviewerInstructions,
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
        reviewerInstructions,
      }),
    ).toThrow(ReviewerInvocationError);
  });
});
// -/ 1/1
