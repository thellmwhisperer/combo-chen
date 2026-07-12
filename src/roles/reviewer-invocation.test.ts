/**
 * @overview Contract tests for local reviewer command safety and artifact prompt rendering.
 * @exports none
 * @deps vitest, ./reviewer-invocation
 */
import { describe, expect, it } from "vitest";
import {
  assertReviewerCommandSafe,
  buildLocalReviewerInvocation,
  localReviewerPrompt,
} from "./reviewer-invocation.js";

const combo = {
  schemaVersion: 1,
  id: "o-r-1",
  issueUrl: "https://github.com/o/r/issues/1",
  repoDir: "/repo",
  worktree: "/repo/.worktrees/1",
  branch: "feat/1",
  tmuxSession: "combo-1",
  createdAt: "2026-01-01T00:00:00Z",
};
const input = {
  combo,
  runDir: "/runs/1",
  round: 1,
  sha: "a".repeat(40),
  baseRef: "main",
  reviewerInstructions: "review carefully",
};

// -- 1/1 CORE · local-only reviewer contract <- START HERE --
describe("local reviewer invocation", () => {
  it("requires a local verdict artifact and forbids GitHub writes", () => {
    const prompt = localReviewerPrompt(input);
    expect(prompt).toContain("Do not write to GitHub at all");
    expect(prompt).toContain("verdict-1.json.tmp");
    expect(prompt).toContain("schemaVersion 1");
  });

  it("renders worktree and prompt placeholders", () => {
    const command = buildLocalReviewerInvocation({
      ...input,
      reviewerCommand: "review --cwd {worktree} {prompt}",
    });
    expect(command).toContain("'/repo/.worktrees/1'");
    expect(command).toContain("Local pre-publish review");
  });

  it("rejects compound shell commands", () => {
    expect(() => assertReviewerCommandSafe("review {prompt} && gh pr comment")).toThrow(/one plain command/);
  });
});
// -/ 1/1
