import { describe, expect, it } from "vitest";

import { buildRowerInvocation, defaultPrompt } from "./rower.js";

const combo = {
  id: "o-r-7",
  issueUrl: "https://github.com/o/r/issues/7",
  repoDir: "/repos/r",
  worktree: "/repos/r/.worktrees/issue-7",
  branch: "combo/issue-7",
  tmuxSession: "combo-chen-o-r-7",
  createdAt: "2026-06-10T00:00:00.000Z",
};

describe("defaultPrompt", () => {
  it("tells the rower which issue to row and to work test-first", () => {
    const prompt = defaultPrompt(combo.issueUrl);
    expect(prompt).toContain(combo.issueUrl);
    expect(prompt).toContain("gh issue view");
    expect(prompt.toLowerCase()).toContain("test");
  });
});

describe("buildRowerInvocation", () => {
  it("renders the configured template with the combo's facts", () => {
    const command = buildRowerInvocation({
      rowerCommand: 'gnhf --x {issue_url} --wt {worktree} "{prompt}"',
      combo,
    });
    expect(command).toContain("--x https://github.com/o/r/issues/7");
    expect(command).toContain("--wt /repos/r/.worktrees/issue-7");
    expect(command).toContain("Implement GitHub issue");
  });

  it("lets a custom prompt replace the default", () => {
    const command = buildRowerInvocation({
      rowerCommand: 'gnhf "{prompt}"',
      combo,
      prompt: "fix the flaky test only",
    });
    expect(command).toBe('gnhf "fix the flaky test only"');
  });
});
