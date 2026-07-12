/**
 * @overview Unit tests for the reviewer role. ~155 lines, testing
 *   the default reviewer prompt contract (COMMENT-only, never-APPROVE,
 *   lgtm convention, reviewer!=coder rule), shell-safe review submission,
 *   reviewer instructions, and reviewer invocation command rendering.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at describe("defaultReviewerPrompt")   ← v0 verdict contract
 *   2. Then describe("buildReviewerInvocation")     ← command rendering
 *   3. Then describe("localReviewerPrompt")         ← v1 verdict-file contract
 *
 *   ┌─ TEST AREAS ──────────────────────────────────────┐
 *   │ defaultReviewerPrompt    Prompt contract rules + instructions │
 *   │ buildReviewerInvocation  Command template render + safety   │
 *   │ localReviewerPrompt      v1 local review verdict-file prompt │
 *   │ buildLocalReviewerInvocation  v1 command rendering + safety  │
 *   └────────────────────────────────────────────────────┘
 *
 * @exports none (test file)
 * @deps vitest, ../core/verdict, ./reviewer-invocation
 */
import { describe, expect, it } from "vitest";

import { LOCAL_REVIEW_CHECKLIST } from "../core/verdict.js";
import {
  CRITICAL_SURFACES,
  LOCAL_REVIEW_PROMPT_VERSION,
  ReviewerInvocationError,
  buildLocalReviewerInvocation,
  buildReviewerInvocation,
  defaultReviewerPrompt,
  localReviewerPrompt,
} from "./reviewer-invocation.js";

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
    expect(prompt).toContain(
      "Do not use heredocs, temp files, cat, rm, shell redirection, pipes, semicolons, or &&/||",
    );
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

  it.each([
    ["escaped quote before a separator", 'reviewer \\" ; echo extra'],
    ["unmatched single quote", "reviewer 'unterminated"],
    ["unmatched double quote", 'reviewer "unterminated'],
    ["background command", "reviewer {prompt} & echo extra"],
    ["command substitution", "reviewer $(echo extra) {prompt}"],
    ["backtick substitution", "reviewer `echo extra` {prompt}"],
    ["newline", "reviewer {prompt}\necho extra"],
    ["shell grouping", "reviewer (echo extra) {prompt}"],
    ["shell comment", "reviewer {prompt} # ignored"],
    ["braced variable expansion", "reviewer ${VAR} {prompt}"],
    ["trailing escape", "reviewer {prompt} \\"],
  ])("rejects unsupported shell syntax: %s", (_case, reviewerCommand) => {
    expect(() =>
      buildReviewerInvocation({
        reviewerCommand,
        combo,
        prUrl,
        reviewerInstructions,
      }),
    ).toThrow(ReviewerInvocationError);
  });

  it("accepts escaped and quoted arguments in one plain reviewer command", () => {
    expect(() =>
      buildReviewerInvocation({
        reviewerCommand: 'reviewer path\\ with\\ spaces "quoted value" {prompt}',
        combo,
        prUrl,
        reviewerInstructions,
      }),
    ).not.toThrow();
  });
});
// -/ 1/2

// -- 2/2 CORE · local pre-publish review prompt (v1) --
const localInput = {
  combo,
  runDir: "/runs/o-r-9",
  round: 2,
  sha: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0",
  baseRef: "origin/main",
  reviewerInstructions,
};

describe("localReviewerPrompt", () => {
  it("instructs write-then-rename of the round's verdict file instead of GitHub posting", () => {
    const prompt = localReviewerPrompt(localInput);

    expect(prompt).toContain("/runs/o-r-9/verdict-2.json.tmp");
    expect(prompt).toContain("/runs/o-r-9/verdict-2.json");
    expect(prompt).toContain("rename");
    expect(prompt).toContain("Do not write to GitHub");
    expect(prompt).not.toContain("gh pr review");
    expect(prompt).not.toContain("COMMENT reviews");
    expect(prompt).toContain("There is no PR yet");
  });

  it("reviews the frozen local changeset and pins round and sha attribution", () => {
    const prompt = localReviewerPrompt(localInput);

    expect(prompt).toContain("round 2");
    expect(prompt).toContain("origin/main..HEAD");
    expect(prompt).toContain(localInput.sha);
    expect(prompt).toContain(combo.worktree);
    expect(prompt).toContain(`prompt v${LOCAL_REVIEW_PROMPT_VERSION}`);
  });

  it("carries the critical-surfaces calibration with minimum code 1", () => {
    const prompt = localReviewerPrompt(localInput);

    for (const surface of CRITICAL_SURFACES) {
      expect(prompt).toContain(surface.id);
    }
    expect(prompt).toContain("minimum code 1");
    expect(prompt).toContain("even if pre-existing");
    expect(prompt).toContain("criticalSurface");
  });

  it("requires the full embedded checklist and declares partial verdicts malformed", () => {
    const prompt = localReviewerPrompt(localInput);

    for (const item of LOCAL_REVIEW_CHECKLIST) {
      expect(prompt).toContain(item.id);
    }
    expect(prompt).toContain("malformed");
  });

  it("demands stable finding ids, machine-readable follow-ups, and produced identity", () => {
    const prompt = localReviewerPrompt(localInput);

    expect(prompt).toContain("same id");
    expect(prompt).toContain("followUps");
    expect(prompt).toContain("never the only home of a finding");
    expect(prompt).toContain("identity");
    expect(prompt).toContain("model");
    expect(prompt).toContain("runtime");
  });

  it("hints the resolved reviewer identity when the launch contract declared one", () => {
    const prompt = localReviewerPrompt({
      ...localInput,
      identity: { model: "claude-fable-5", runtime: "claude" },
    });

    expect(prompt).toContain("claude-fable-5");
  });

  it("keeps the verdict-code semantics and the anti-slop guardrails from v0", () => {
    const prompt = localReviewerPrompt(localInput);

    expect(prompt).toContain("0 = OK");
    expect(prompt).toContain("1 = mechanical fix required");
    expect(prompt).toContain("2 = ambiguous or intent-sensitive");
    expect(prompt).toContain("3 = needs human");
    expect(prompt).toContain("Anti-slop checks");
    expect(prompt).toContain("pnpm surface or an equivalent repo search");
    expect(prompt).toContain("who/when/why");
    expect(prompt).toContain("surface budget");
    expect(prompt).toContain("reviewer != coder");
    expect(prompt).toContain("never write code");
  });
});

describe("buildLocalReviewerInvocation", () => {
  it("renders the reviewer command without requiring a PR URL", () => {
    const command = buildLocalReviewerInvocation({
      ...localInput,
      reviewerCommand: "claude {prompt}",
    });

    expect(command.startsWith("claude '")).toBe(true);
    expect(command).toContain("verdict-2.json");
  });

  it("rejects compound reviewer commands", () => {
    expect(() =>
      buildLocalReviewerInvocation({
        ...localInput,
        reviewerCommand: "claude {prompt} && rm -rf /",
      }),
    ).toThrow(ReviewerInvocationError);
  });
});
// -/ 2/2
