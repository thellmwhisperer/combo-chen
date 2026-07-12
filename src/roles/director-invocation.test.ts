/**
 * @overview Unit tests for the promptable director role. ~55 lines, prompt
 *   contract and command rendering.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at defaultDirectorPrompt tests <- persistent director contract.
 *   2. Then buildDirectorInvocation tests   <- command template rendering.
 *
 * @exports none
 * @deps vitest, ./director-invocation
 */
import { describe, expect, it } from "vitest";

import { buildDirectorInvocation, defaultDirectorPrompt } from "./director-invocation.js";

const combo = {
  id: "o-r-9",
  issueUrl: "https://github.com/o/r/issues/9",
  repoDir: "/repos/r",
  worktree: "/repos/r/.worktrees/issue-9",
  branch: "combo/issue-9",
  tmuxSession: "combo-chen-o-r-9",
  createdAt: "2026-06-10T00:00:00.000Z",
};

// -- 1/1 CORE · director prompt + invocation --
describe("defaultDirectorPrompt", () => {
  it("keeps the director window promptable without replacing the supervisor", () => {
    const prompt = defaultDirectorPrompt({ combo });

    expect(prompt).toContain("Combo director for o-r-9");
    expect(prompt).toContain("Stay in this tmux window");
    expect(prompt).toContain("in-process supervisor");
    expect(prompt).not.toContain("director-watch");
    expect(prompt).toContain("needs_human");
    expect(prompt).toContain("Do not review or answer review threads");
    expect(prompt).toContain("GitHub writes");
    expect(prompt).toContain("reviewer or gatekeeper");
  });
});

describe("buildDirectorInvocation", () => {
  it("renders the configured director command with the prompt", () => {
    const command = buildDirectorInvocation({
      combo,
      directorCommand: "claude {prompt}",
    });

    expect(command).toContain("claude 'Combo director for o-r-9");
    expect(command).toContain("combo/issue-9");
  });
});
// -/ 1/1
