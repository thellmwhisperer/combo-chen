/**
 * @overview Unit tests for the interactive director role adapter. Pins the
 *   launch-time director contract and command rendering.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at defaultDirectorPrompt tests <- contract text.
 *   2. Then buildDirectorInvocation tests   <- command template rendering.
 *
 *   MAIN FLOW
 *   ---------
 *   combo record -> director prompt -> renderCommand -> tmux window command
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   combo
 *
 * @exports none
 * @deps vitest, ../core/state, ./director
 */
import { describe, expect, it } from "vitest";

import type { ComboRecord } from "../core/state.js";
import { buildDirectorInvocation, defaultDirectorPrompt } from "./director.js";

// -- 1/1 CORE · Director contract tests <- START HERE --
function combo(): ComboRecord {
  return {
    id: "o-r-7",
    issueUrl: "https://github.com/o/r/issues/7",
    workItemSourceType: "github_issue",
    workItemSourceReference: "https://github.com/o/r/issues/7",
    workItemTitle: "Promptable director",
    repoDir: "/repo",
    worktree: "/repo/.worktrees/issue-7",
    branch: "combo/issue-7",
    tmuxSession: "combo-chen-o-r-7",
    createdAt: "2026-06-21T00:00:00.000Z",
  };
}

describe("defaultDirectorPrompt", () => {
  it("loads the director contract without asking the director to poll", () => {
    const prompt = defaultDirectorPrompt({ combo: combo() });

    expect(prompt).toContain("Combo director contract");
    expect(prompt).toContain("Combo: o-r-7");
    expect(prompt).toContain("Work item: Promptable director");
    expect(prompt).toContain("Do not poll");
    expect(prompt).toContain("Wait for prompts pasted into this tmux window");
    expect(prompt).toContain("Do not edit code, answer review threads, approve PRs, push, merge, or deploy");
  });
});

describe("buildDirectorInvocation", () => {
  it("renders the configured director command with the frozen contract prompt", () => {
    const command = buildDirectorInvocation({
      combo: combo(),
      directorCommand: "director-agent --repo {repo} --worktree {worktree} {prompt}",
    });

    expect(command).toContain("director-agent --repo '/repo'");
    expect(command).toContain("--worktree '/repo/.worktrees/issue-7'");
    expect(command).toContain("Combo director contract");
    expect(command).toContain("combo/issue-7");
  });
});
// -/ 1/1
