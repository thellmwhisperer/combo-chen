import { describe, expect, it } from "vitest";

import { buildJudgeInvocation, defaultJudgePrompt } from "./judge.js";

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
const protocol = "La Roca review protocol 7989 + project overlay 8034";

describe("defaultJudgePrompt", () => {
  it("injects the PR URL, protocol, and the COMMENT-only verdict contract", () => {
    const prompt = defaultJudgePrompt({ combo, prUrl, protocol });

    expect(prompt).toContain(prUrl);
    expect(prompt).toContain(protocol);
    expect(prompt).toContain("COMMENT reviews or issue comments");
    expect(prompt).toContain("never APPROVE");
    expect(prompt).toContain("lgtm @ <sha>");
    expect(prompt).toContain("never write code");
  });
});

describe("buildJudgeInvocation", () => {
  it("renders the configured judge command with quoted PR facts and prompt", () => {
    const command = buildJudgeInvocation({
      judgeCommand: "claude --judge {pr_url} {protocol} {prompt}",
      combo,
      prUrl,
      protocol,
    });

    expect(command).toContain("--judge 'https://github.com/o/r/pull/9'");
    expect(command).toContain("'La Roca review protocol 7989 + project overlay 8034'");
    expect(command).toContain("COMMENT reviews or issue comments");
    expect(command).toContain("lgtm @ <sha>");
  });

  it("lets a custom prompt replace the default contract text", () => {
    const command = buildJudgeInvocation({
      judgeCommand: "judge {prompt}",
      combo,
      prUrl,
      protocol,
      prompt: "review this one diff only",
    });

    expect(command).toBe("judge 'review this one diff only'");
  });
});
