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
 * @deps ../../cli/main.test-harness
 */

import {
  CODER_THREAD_ARTIFACT,
  CODEX_THREAD_ID,
  ISSUE,
  appendEvent,
  describe,
  exec,
  expect,
  fakeDeps,
  home,
  it,
  join,
  mkdtempSync,
  readEvents,
  runDirFor,
  tmpdir,
  writeCoderThreadArtifact,
  writeCombo,
  writeFileSync,
} from "../../cli/main.test-harness.js";

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
      '[limits]\nbabysit_poll_seconds = 7\n\n[rower.codex]\nresume_command = "codex --profile sitter --no-alt-screen resume {thread_id}"\n\n[thread_sitter]\nwindow_name = "sitter"\nwatch_window_name = "sitter-watch"\n',
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
    expect(newWindows[0]).toContain("sitter");
    expect(newWindows[0]?.at(-1)).toBe(`codex --profile sitter --no-alt-screen resume '${CODEX_THREAD_ID}'`);
    expect(calls.some((call) => call[0] === "git")).toBe(false);
    expect(calls.some((call) => call[0] === "gh")).toBe(false);
  });

  it("reports resumed coder startup failures", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      '[thread_sitter]\nwindow_name = "sitter"\nwatch_window_name = "sitter-watch"\n',
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
        if (args[0] === "new-window" && args.includes("sitter")) {
          return { status: 1, stdout: "", stderr: "duplicate window" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(exec(deps, ["activate-coder", "-n", "o-r-7"])).rejects.toThrow(
      /tmux failed to start sitter: duplicate window/,
    );

    expect(calls).not.toContainEqual(["tmux", "kill-window", "-t", "combo-chen-o-r-7:sitter"]);
  });
});

describe("nudge-review-comments", () => {
  it("syncs a stale no-mistakes mirror from origin before routing comments", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const originSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const mirrorSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "remote") {
          return { status: 0, stdout: "/home/user/.no-mistakes/repos/o-r.git\n", stderr: "" };
        }
        if (args[0] === "fetch") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "rev-parse") {
          return { status: 0, stdout: `${originSha}\n`, stderr: "" };
        }
        if (args[0] === "ls-remote") {
          return {
            status: 0,
            stdout: `${mirrorSha}\trefs/heads/combo/issue-7\n`,
            stderr: "",
          };
        }
        if (args[0] === "push") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
      },
    });

    await exec(deps, ["nudge-review-comments", "-n", "o-r-7"]);

    expect(calls).toContainEqual([
      "git",
      `cwd=${worktree}`,
      "push",
      "no-mistakes",
      `--force-with-lease=refs/heads/combo/issue-7:${mirrorSha}`,
      "refs/remotes/origin/combo/issue-7:refs/heads/combo/issue-7",
    ]);
    const pushIndex = calls.findIndex((call) => call[0] === "git" && call[2] === "push");
    const firstGhIndex = calls.findIndex((call) => call[0] === "gh");
    expect(pushIndex).toBeGreaterThan(-1);
    expect(firstGhIndex).toBeGreaterThan(pushIndex);
  });

  it("reconciles a divergent mirror with a lease against the observed mirror SHA", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const originSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const mirrorSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const expectedLease = `--force-with-lease=refs/heads/combo/issue-7:${mirrorSha}`;
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "remote") {
          return { status: 0, stdout: "/home/user/.no-mistakes/repos/o-r.git\n", stderr: "" };
        }
        if (args[0] === "fetch") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "rev-parse") {
          return { status: 0, stdout: `${originSha}\n`, stderr: "" };
        }
        if (args[0] === "ls-remote") {
          return {
            status: 0,
            stdout: `${mirrorSha}\trefs/heads/combo/issue-7\n`,
            stderr: "",
          };
        }
        if (args[0] === "push" && args.includes(expectedLease)) {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "push") {
          return { status: 1, stdout: "", stderr: "! [rejected] non-fast-forward" };
        }
        return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
      },
    });

    await exec(deps, ["nudge-review-comments", "-n", "o-r-7"]);

    expect(calls).toContainEqual([
      "git",
      `cwd=${worktree}`,
      "push",
      "no-mistakes",
      expectedLease,
      "refs/remotes/origin/combo/issue-7:refs/heads/combo/issue-7",
    ]);
  });

  it("recovers from a force-pushed origin branch before syncing the mirror", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const originSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const mirrorSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const otherMirrorSha = "cccccccccccccccccccccccccccccccccccccccc";
    const expectedLease = `--force-with-lease=refs/heads/combo/issue-7:${mirrorSha}`;
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "remote") {
          return { status: 0, stdout: "/home/user/.no-mistakes/repos/o-r.git\n", stderr: "" };
        }
        if (args[0] === "fetch") {
          return args[2] === "+combo/issue-7:refs/remotes/origin/combo/issue-7"
            ? { status: 0, stdout: "", stderr: "" }
            : { status: 1, stdout: "", stderr: "non-fast-forward" };
        }
        if (args[0] === "rev-parse") {
          return { status: 0, stdout: `${originSha}\n`, stderr: "" };
        }
        if (args[0] === "ls-remote") {
          return {
            status: 0,
            stdout:
              `${otherMirrorSha}\trefs/heads/aaa/combo/issue-7\n` +
              `${mirrorSha}\trefs/heads/combo/issue-7\n`,
            stderr: "",
          };
        }
        if (args[0] === "push" && args.includes(expectedLease)) {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "push") {
          return { status: 1, stdout: "", stderr: "wrong lease" };
        }
        return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
      },
    });

    await exec(deps, ["nudge-review-comments", "-n", "o-r-7"]);

    expect(calls).toContainEqual([
      "git",
      `cwd=${worktree}`,
      "fetch",
      "origin",
      "+combo/issue-7:refs/remotes/origin/combo/issue-7",
    ]);
    expect(calls).toContainEqual([
      "git",
      `cwd=${worktree}`,
      "push",
      "no-mistakes",
      expectedLease,
      "refs/remotes/origin/combo/issue-7:refs/heads/combo/issue-7",
    ]);
  });

  it("routes a fetched PR comment once and skips repo writes when no mirror remote exists", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      '[thread_sitter]\nreview_nudge_prompt = "Please address {url}"\nwindow_name = "sitter"\n',
    );
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-owned-session",
      createdAt: new Date().toISOString(),
    });
    writeCoderThreadArtifact(dir);
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        calls.push(["gh", ...args]);
        const endpoint = args.at(-1);
        if (endpoint === "repos/o/r/issues/7/comments") {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                html_url: "https://github.com/o/r/pull/7#issuecomment-1",
                user: { login: "external-reviewer" },
                body: "Please handle this.",
              },
            ]),
            stderr: "",
          };
        }
        return { status: 0, stdout: "[]", stderr: "" };
      },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "remote" && args[1] === "get-url" && args[2] === "no-mistakes") {
          return { status: 2, stdout: "", stderr: "No such remote 'no-mistakes'" };
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return { status: 0, stdout: "abc123\n", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
      },
    });

    await exec(deps, ["nudge-review-comments", "-n", "o-r-7"]);
    await exec(deps, ["nudge-review-comments", "-n", "o-r-7"]);

    const events = readEvents(dir).filter((event) => event.event === "review_comment");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      author: "external-reviewer",
      kind: "pr_comment",
      url: "https://github.com/o/r/pull/7#issuecomment-1",
      head_sha: "abc123",
    });

    const tmuxCalls = calls.filter((call) => call[0] === "tmux");
    expect(tmuxCalls).toEqual([
      ["tmux", "list-windows", "-t", "combo-chen-owned-session", "-F", "#{window_name}"],
      [
        "tmux",
        "new-window",
        "-t",
        "combo-chen-owned-session",
        "-n",
        "sitter",
        `codex resume '${CODEX_THREAD_ID}'`,
      ],
      [
        "tmux",
        "set-buffer",
        "-b",
        "combo-chen-nudge-combo-chen-owned-session-sitter",
        "Please address 'https://github.com/o/r/pull/7#issuecomment-1'",
      ],
      [
        "tmux",
        "paste-buffer",
        "-d",
        "-b",
        "combo-chen-nudge-combo-chen-owned-session-sitter",
        "-t",
        "combo-chen-owned-session:sitter",
      ],
      ["tmux", "send-keys", "-t", "combo-chen-owned-session:sitter", "C-m"],
    ]);
    expect(calls.filter((call) => call[0] === "git")).toEqual([
      ["git", `cwd=${worktree}`, "remote", "get-url", "no-mistakes"],
      ["git", `cwd=${worktree}`, "rev-parse", "HEAD"],
      ["git", `cwd=${worktree}`, "remote", "get-url", "no-mistakes"],
    ]);
    const ghCalls = calls.filter((call) => call[0] === "gh");
    expect(ghCalls).not.toHaveLength(0);
    expect(ghCalls.every((call) => call[1] === "api" && !call.includes("--method"))).toBe(true);
  });

  it("routes a fetched PR comment even when mirror git commands fail", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      '[thread_sitter]\nreview_nudge_prompt = "Please address {url}"\nwindow_name = "sitter"\n',
    );
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-owned-session",
      createdAt: new Date().toISOString(),
    });
    writeCoderThreadArtifact(dir);
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        calls.push(["gh", ...args]);
        const endpoint = args.at(-1);
        if (endpoint === "repos/o/r/issues/7/comments") {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                html_url: "https://github.com/o/r/pull/7#issuecomment-1",
                user: { login: "external-reviewer" },
                body: "Please handle this.",
              },
            ]),
            stderr: "",
          };
        }
        return { status: 0, stdout: "[]", stderr: "" };
      },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "remote") {
          return { status: 0, stdout: "/home/user/.no-mistakes/repos/o-r.git\n", stderr: "" };
        }
        if (args[0] === "fetch") {
          return { status: 128, stdout: "", stderr: "network down" };
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return { status: 0, stdout: "abc123\n", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
      },
    });

    await exec(deps, ["nudge-review-comments", "-n", "o-r-7"]);

    const events = readEvents(dir).filter((event) => event.event === "review_comment");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      author: "external-reviewer",
      kind: "pr_comment",
      url: "https://github.com/o/r/pull/7#issuecomment-1",
      head_sha: "abc123",
    });
    expect(out.some((line) => line.includes("mirror sync failed"))).toBe(true);
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "paste-buffer")).toBe(true);
    expect(calls.some((call) => call[0] === "gh")).toBe(true);
  });

  it("skips the mirror push when origin and mirror SHAs match (no-op)", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const sameSha = "cccccccccccccccccccccccccccccccccccccccc";
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "remote") {
          return { status: 0, stdout: "/home/user/.no-mistakes/repos/o-r.git\n", stderr: "" };
        }
        if (args[0] === "fetch") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "rev-parse") {
          return { status: 0, stdout: `${sameSha}\n`, stderr: "" };
        }
        if (args[0] === "ls-remote") {
          return { status: 0, stdout: `${sameSha}\trefs/heads/combo/issue-7\n`, stderr: "" };
        }
        if (args[0] === "push") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
      },
    });

    await exec(deps, ["nudge-review-comments", "-n", "o-r-7"]);

    const gitCalls = calls.filter((call) => call[0] === "git");
    expect(gitCalls.some((call) => call[2] === "push")).toBe(false);
    const ghCalls = calls.filter((call) => call[0] === "gh");
    expect(ghCalls).not.toHaveLength(0);
  });

  it("pushes to create the mirror branch when it does not exist yet", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const originSha = "dddddddddddddddddddddddddddddddddddddddd";
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "remote") {
          return { status: 0, stdout: "/home/user/.no-mistakes/repos/o-r.git\n", stderr: "" };
        }
        if (args[0] === "fetch") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "rev-parse") {
          return { status: 0, stdout: `${originSha}\n`, stderr: "" };
        }
        if (args[0] === "ls-remote") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "push") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
      },
    });

    await exec(deps, ["nudge-review-comments", "-n", "o-r-7"]);

    expect(calls).toContainEqual([
      "git",
      `cwd=${worktree}`,
      "push",
      "no-mistakes",
      "refs/remotes/origin/combo/issue-7:refs/heads/combo/issue-7",
    ]);
  });

  it("skips the mirror push when the gate has a CI fix in flight", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(dir, "gate_status", {
      state: "fix_inflight",
      head_sha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    });

    const originSha = "ffffffffffffffffffffffffffffffffffffffff";
    const mirrorSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "remote") {
          return { status: 0, stdout: "/home/user/.no-mistakes/repos/o-r.git\n", stderr: "" };
        }
        if (args[0] === "fetch") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "rev-parse") {
          return { status: 0, stdout: `${originSha}\n`, stderr: "" };
        }
        if (args[0] === "ls-remote") {
          return { status: 0, stdout: `${mirrorSha}\trefs/heads/combo/issue-7\n`, stderr: "" };
        }
        if (args[0] === "push") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
      },
    });

    await exec(deps, ["nudge-review-comments", "-n", "o-r-7"]);

    const gitCalls = calls.filter((call) => call[0] === "git");
    expect(gitCalls.some((call) => call[2] === "push")).toBe(false);
    expect(out.some((line) => line.includes("gatekeeper fix in flight"))).toBe(true);
    const ghCalls = calls.filter((call) => call[0] === "gh");
    expect(ghCalls).not.toHaveLength(0);
  });
});
// -/ 1/1
