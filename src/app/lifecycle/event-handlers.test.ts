/**
 * @overview Lifecycle application handler integration tests: event emission and rendering.
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
  appendEvent,
  describe,
  exec,
  expect,
  fakeDeps,
  home,
  it,
  join,
  loadConfig,
  mkdtempSync,
  readEvents,
  readFileSync,
  runDirFor,
  seedCodexGnhfRun,
  tmpdir,
  vi,
  writeCombo,
  writeConfigSnapshot,
  writeFileSync,
} from "../../testing/cli-harness.js";

// -- 1/1 CORE · command contracts <- START HERE --
describe("emit", () => {
  it("appends a validated event to the combo journal", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, [
      "emit",
      "-n",
      "o-r-7",
      "coder_failed",
      "--field",
      "exit_code=3",
      "--field",
      "has_new_commits=true",
    ]);

    const events = readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("coder_failed");
    expect(events[0]?.["exit_code"]).toBe(3);
    expect(events[0]?.["has_new_commits"]).toBe(true);
  });

  it("accepts gate_status from the CLI with its current state", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, [
      "emit",
      "-n",
      "o-r-7",
      "gate_status",
      "--field",
      "state=fix_inflight",
      "--field",
      "head_sha=0123456789abcdef0123456789abcdef01234567",
    ]);

    const events = readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "gate_status",
      state: "fix_inflight",
      head_sha: "0123456789abcdef0123456789abcdef01234567",
    });
  });

  it("accepts post-PR event vocabulary with its required fields", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, [
      "emit",
      "-n",
      "o-r-7",
      "review_comment",
      "--field",
      "author=gordon",
      "--field",
      "kind=judge",
      "--field",
      "url=https://github.com/o/r/pull/7#discussion_r1",
    ]);
    await exec(deps, ["emit", "-n", "o-r-7", "lgtm", "--field", "sha=abc123"]);
    await exec(deps, [
      "emit",
      "-n",
      "o-r-7",
      "lgtm_stale",
      "--field",
      "old_sha=abc123",
      "--field",
      "new_sha=def456",
    ]);
    await exec(deps, ["emit", "-n", "o-r-7", "merged", "--field", "sha=def456", "--field", "by=maintainer"]);
    await exec(deps, ["emit", "-n", "o-r-7", "combo_closed"]);
    await exec(deps, ["emit", "-n", "o-r-7", "coder_retry"]);

    expect(readEvents(dir).map((event) => event.event)).toEqual([
      "review_comment",
      "lgtm",
      "lgtm_stale",
      "merged",
      "combo_closed",
      "coder_retry",
    ]);
  });

  it("records the opened PR URL in the runtime ledger", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: "2026-06-21T17:00:00.000Z",
    });
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["emit", "-n", "o-r-7", "pr_opened", "--field", "url=https://github.com/o/r/pull/7"]);

    const ledger = JSON.parse(readFileSync(join(dir, "runtime-ledger.json"), "utf8")) as {
      comboId: string;
      prUrl?: string;
      commands: Record<string, string>;
    };
    expect(ledger.comboId).toBe("o-r-7");
    expect(ledger.prUrl).toBe("https://github.com/o/r/pull/7");
    expect(ledger.commands.closure).toContain("closure -n 'o-r-7'");
  });

  it("surfaces emitting to a combo that was never created (caller bug)", async () => {
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: home() } });
    await expect(exec(deps, ["emit", "-n", "ghost", "coder_started"])).rejects.toThrow(/ENOENT/);
  });

  for (const doneEvent of ["coder_done", "rower_done"] as const) {
    it(`persists the codex thread artifact when ${doneEvent} is emitted`, async () => {
      const h = home();
      const worktree = mkdtempSync(join(tmpdir(), "combo-chen-worktree-"));
      seedCodexGnhfRun(worktree);
      const dir = runDirFor(h, "o-r-7");
      writeCombo(dir, {
        id: "o-r-7",
        issueUrl: ISSUE,
        repoDir: "/repos/r",
        worktree,
        branch: "combo/issue-7",
        tmuxSession: "combo-chen-o-r-7",
        createdAt: new Date().toISOString(),
      });
      const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

      await exec(deps, [
        "emit",
        "-n",
        "o-r-7",
        doneEvent,
        "--field",
        "gnhf_iteration_jsonl=.gnhf/runs/implement-github-iss-e6510c/iteration-1.jsonl",
      ]);

      expect(JSON.parse(readFileSync(join(dir, CODER_THREAD_ARTIFACT), "utf8"))).toEqual({
        agent: "codex",
        thread_id: CODEX_THREAD_ID,
        source: ".gnhf/runs/implement-github-iss-e6510c/iteration-1.jsonl",
      });
      const events = readEvents(dir);
      expect(events.map((event) => event.event)).toEqual(["coder_done"]);
      expect(events[0]).toMatchObject({
        gnhf_iteration_jsonl: ".gnhf/runs/implement-github-iss-e6510c/iteration-1.jsonl",
      });
    });
  }

  it("recreates the gatekeeper tmux window when gate_started is emitted", async () => {
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
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "list-windows") return { status: 0, stdout: "coder\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["emit", "-n", "o-r-7", "gate_started"]);

    const gatekeeperWindow = calls.find(
      (call) => call[0] === "tmux" && call[1] === "new-window" && call.includes("gatekeeper"),
    );
    expect(gatekeeperWindow).toEqual([
      "tmux",
      "new-window",
      "-t",
      "combo-chen-o-r-7",
      "-n",
      "gatekeeper",
      expect.stringContaining("no-mistakes attach"),
    ]);
    expect(gatekeeperWindow?.at(-1)).toContain(worktree);
    expect(readEvents(dir).map((event) => event.event)).toEqual(["gate_started"]);
  });

  it("uses the launch config snapshot for gate_started window recovery after repo TOML changes", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      "[gatekeeper]\nattach_timeout_seconds = 42\nattach_retry_interval_seconds = 6\n",
    );
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
    writeConfigSnapshot(dir, loadConfig({ repoDir, env: {} }));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      "[gatekeeper]\nattach_timeout_seconds = 3\nattach_retry_interval_seconds = 1\n",
    );
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "list-windows") return { status: 0, stdout: "coder\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["emit", "-n", "o-r-7", "gate_started"]);

    const gatekeeperCommand =
      calls
        .find((call) => call[0] === "tmux" && call[1] === "new-window" && call.includes("gatekeeper"))
        ?.at(-1) ?? "";
    expect(gatekeeperCommand).toContain("timed out after 42 seconds");
    expect(gatekeeperCommand).toContain("attach_max_attempts=7");
    expect(gatekeeperCommand).toContain("sleep 6");
    expect(gatekeeperCommand).not.toContain("timed out after 3 seconds");
  });

  it("refreshes the existing gatekeeper tmux window in place when gate_started is emitted", async () => {
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
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "list-windows") return { status: 0, stdout: "gatekeeper\ncoder\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["emit", "-n", "o-r-7", "gate_started"]);

    expect(calls.some((call) => call[0] === "tmux" && call[1] === "kill-window")).toBe(false);
    expect(
      calls.some((call) => call[0] === "tmux" && call[1] === "new-window" && call.includes("gatekeeper")),
    ).toBe(false);
    const gatekeeperBuffer = calls.find(
      (call) =>
        call[0] === "tmux" &&
        call[1] === "set-buffer" &&
        call.includes("combo-chen-nudge-combo-chen-o-r-7-gatekeeper"),
    );
    expect(gatekeeperBuffer).toBeDefined();
    expect(gatekeeperBuffer?.at(-1)).toContain("no-mistakes attach");
    expect(gatekeeperBuffer?.at(-1)).toContain(worktree);
    expect(calls).toContainEqual(["tmux", "send-keys", "-t", "combo-chen-o-r-7:gatekeeper", "C-c"]);
    expect(calls).toContainEqual(["tmux", "send-keys", "-t", "combo-chen-o-r-7:gatekeeper", "C-m"]);
    expect(readEvents(dir).map((event) => event.event)).toEqual(["gate_started"]);
  });

  it("keeps the gate_started journal event when window recovery cannot inspect tmux", async () => {
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
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "list-windows") return { status: 1, stdout: "", stderr: "boom" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await exec(deps, ["emit", "-n", "o-r-7", "hodor_started"]);
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('tmux failed to list windows in "combo-chen-o-r-7": boom'),
      );
    } finally {
      stderr.mockRestore();
    }

    expect(readEvents(dir).map((event) => event.event)).toEqual(["gate_started"]);
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-window")).toBe(false);
  });
});

describe("events", () => {
  it("renders post-PR events through --follow", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "merged", { sha: "def456", by: "maintainer" });

    const stop = new Error("observed followed event");
    const out: string[] = [];
    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h, COMBO_CHEN_POLL_MS: "1" },
      out: (line) => {
        out.push(line);
        if (line.includes('"event":"merged"')) throw stop;
      },
    });

    await expect(exec(deps, ["events", "-n", "o-r-7", "--follow"])).rejects.toBe(stop);
    expect(JSON.parse(out[0] ?? "{}")).toMatchObject({
      event: "merged",
      sha: "def456",
      by: "maintainer",
    });
  });
});
// -/ 1/1
