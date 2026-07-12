/**
 * @overview Director application handler integration tests: coder activation and review routing.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at the describe blocks  <- command contracts and their effects.
 *
 *   MAIN FLOW
 *   ---------
 *   shared fakeDeps -> createProgram -> extracted handler -> recorded effects
 *
 *   PUBLIC API
 *   ----------
 *   None (test file).
 *
 *   INTERNALS
 *   ---------
 *   Command-specific fixtures live inside their describe block.
 *
 * @exports none
 * @deps ../../testing/cli-harness
 */

import {
  CODER_THREAD_ARTIFACT,
  CODEX_THREAD_ID,
  ISSUE,
  describe,
  exec,
  expect,
  fakeDeps,
  home,
  it,
  join,
  mkdtempSync,
  runDirFor,
  tmpdir,
  writeCombo,
  writeFileSync,
} from "../../testing/cli-harness.js";

// -- 1/1 CORE · command contracts <- START HERE --
describe("activate-coder", () => {
  it("uses the persistent coder window as the default coder responding worker", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    writeFileSync(
      join(dir, CODER_THREAD_ARTIFACT),
      `${JSON.stringify({
        agent: "codex",
        thread_id: CODEX_THREAD_ID,
        source: ".gnhf/runs/implement-github-iss-e6510c/iteration-1.jsonl",
      })}\n`,
    );
    const { deps, calls, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["activate-coder", "-n", "o-r-7"]);

    const newWindows = calls.filter((call) => call[0] === "tmux" && call[1] === "new-window");
    expect(newWindows).toHaveLength(1);
    expect(newWindows[0]).toContain("coder");
    expect(newWindows[0]).not.toContain("coder-responding");
    expect(out.join("\n")).toContain("coder responding active for o-r-7");
  });

  it("starts the resumed sitter window from the coder thread artifact", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      '[limits]\nbabysit_poll_seconds = 7\n\n[roles.coder]\nrespond_command = "codex --profile sitter --no-alt-screen resume {thread_id}"\n',
    );
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    writeFileSync(
      join(dir, CODER_THREAD_ARTIFACT),
      `${JSON.stringify({
        agent: "codex",
        thread_id: CODEX_THREAD_ID,
        source: ".gnhf/runs/implement-github-iss-e6510c/iteration-1.jsonl",
      })}\n`,
    );
    const { deps, calls } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["activate-coder", "-n", "o-r-7"]);

    const newWindows = calls.filter((call) => call[0] === "tmux" && call[1] === "new-window");
    expect(newWindows).toHaveLength(1);
    expect(newWindows[0]).toContain("coder");
    expect(newWindows[0]?.at(-1)).toBe(`codex --profile sitter --no-alt-screen resume '${CODEX_THREAD_ID}'`);
    expect(calls.some((call) => call[0] === "git")).toBe(false);
    expect(calls.some((call) => call[0] === "gh")).toBe(false);
  });

  it("reports resumed coder startup failures", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      '[roles.coder]\nrespond_command = "codex resume {thread_id}"\n',
    );
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    writeFileSync(
      join(dir, CODER_THREAD_ARTIFACT),
      `${JSON.stringify({
        agent: "codex",
        thread_id: CODEX_THREAD_ID,
        source: ".gnhf/runs/implement-github-iss-e6510c/iteration-1.jsonl",
      })}\n`,
    );
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "new-window" && args.includes("coder")) {
          return { status: 1, stdout: "", stderr: "duplicate window" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(exec(deps, ["activate-coder", "-n", "o-r-7"])).rejects.toThrow(
      /tmux failed to start coder: duplicate window/,
    );

    expect(calls).not.toContainEqual(["tmux", "kill-window", "-t", "combo-chen-o-r-7:coder"]);
  });
});

// -/ 1/1
