/**
 * @overview Lifecycle application handler integration tests: session attachment and resumption.
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
  GATEKEEPER_WINDOW,
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
  mkdirSync,
  mkdtempSync,
  readEvents,
  readFileSync,
  runDirFor,
  shellQuote,
  spawnSync,
  tmpdir,
  writeCombo,
  writeConfigSnapshot,
  writeFileSync,
} from "../../testing/cli-harness.js";

// -- 1/1 CORE · command contracts <- START HERE --
describe("attach", () => {
  function seedCombo(homeDir: string, id: string, createdAt: string): void {
    const issueNumber = id.split("-").at(-1) ?? "7";
    writeCombo(runDirFor(homeDir, id), {
      id,
      issueUrl: `https://github.com/o/r/issues/${issueNumber}`,
      repoDir: "/repos/r",
      worktree: `/repos/r/.worktrees/issue-${issueNumber}`,
      branch: `combo/issue-${issueNumber}`,
      tmuxSession: `combo-chen-${id}`,
      createdAt,
    });
  }

  it("resolves the only running combo without --name and attaches to its session", async () => {
    const h = home();
    seedCombo(h, "stale-o-r-6", "2026-06-10T10:00:00.000Z");
    seedCombo(h, "o-r-7", "2026-06-10T11:00:00.000Z");
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "has-session") {
          return {
            status: args.at(-1) === "combo-chen-o-r-7" ? 0 : 1,
            stdout: "",
            stderr: "no such session",
          };
        }
        if (args[0] === "list-panes") return { status: 0, stdout: "0\n1\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["attach"]);

    expect(calls).toContainEqual(["tmux", "attach", "-t", "combo-chen-o-r-7"]);
    expect(calls.some((call) => call[1] === "split-window")).toBe(false);
  });

  it("requires --name when several combos are running", async () => {
    const h = home();
    seedCombo(h, "o-r-7", "2026-06-10T10:00:00.000Z");
    seedCombo(h, "o-r-8", "2026-06-10T11:00:00.000Z");
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "has-session") return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(exec(deps, ["attach"])).rejects.toThrow(/--name/);

    expect(calls.some((call) => call[1] === "attach")).toBe(false);
  });

  it("uses a friendly error when the named combo's tmux session is gone", async () => {
    const h = home();
    seedCombo(h, "o-r-7", "2026-06-10T10:00:00.000Z");
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "has-session") {
          return { status: 1, stdout: "", stderr: "can't find session: combo-chen-o-r-7" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    let message = "";
    try {
      await exec(deps, ["attach", "--name", "o-r-7"]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/Combo "o-r-7" is not running/);
    expect(message).toContain('tmux session "combo-chen-o-r-7" does not exist');
    expect(message).not.toContain("can't find session");
    expect(calls.some((call) => call[1] === "attach")).toBe(false);
  });

  it("recreates a missing journal window before attaching", async () => {
    const h = home();
    seedCombo(h, "o-r-7", "2026-06-10T10:00:00.000Z");
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "has-session") return { status: 0, stdout: "", stderr: "" };
        if (args[0] === "list-windows") return { status: 0, stdout: "coder\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["attach", "--name", "o-r-7"]);

    const journalIndex = calls.findIndex(
      (call) => call[1] === "new-window" && call[call.indexOf("-n") + 1] === "journal",
    );
    const attachIndex = calls.findIndex((call) => call[1] === "attach");
    expect(calls[journalIndex]).toEqual([
      "tmux",
      "new-window",
      "-t",
      "combo-chen-o-r-7",
      "-n",
      "journal",
      expect.stringContaining("events --follow -n 'o-r-7'"),
    ]);
    expect(calls[attachIndex]).toEqual(["tmux", "attach", "-t", "combo-chen-o-r-7"]);
    expect(journalIndex).toBeLessThan(attachIndex);
    expect(calls.some((call) => call[1] === "select-pane")).toBe(false);
  });
});

describe("resume", () => {
  it("uses the launch config snapshot for gatekeeper attach timing after repo TOML changes", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    mkdirSync(worktree, { recursive: true });
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
    appendEvent(dir, "gate_started", {});
    appendEvent(dir, "gate_failed", { exit_code: 1 });

    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: () => ({
        status: 0,
        stdout: [
          "run:",
          "  branch: combo/issue-7",
          "  status: running",
          "  steps[1]{step,status,findings,duration_ms}:",
          "    ci,running,0,0",
        ].join("\n"),
        stderr: "",
      }),
    });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    const gatekeeperCommand =
      calls
        .find((call) => call[0] === "tmux" && call[1] === "new-window" && call.includes("gatekeeper"))
        ?.at(-1) ?? "";
    expect(gatekeeperCommand).toContain("timed out after 42 seconds");
    expect(gatekeeperCommand).toContain("attach_max_attempts=7");
    expect(gatekeeperCommand).toContain("sleep 6");
    expect(gatekeeperCommand).not.toContain("timed out after 3 seconds");
  });

  it("starts reviewer and director monitoring for an existing reviewer-ready PR without a fresh run", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const prUrl = "https://github.com/o/r/pull/7";
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
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
    appendEvent(dir, "pr_opened", { url: prUrl });
    appendEvent(dir, "gate_failed", { exit_code: 1 });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: () => ({
        status: 0,
        stdout: ["run:", "  branch: combo/issue-7", "  status: completed"].join("\n"),
        stderr: "",
      }),
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: headSha,
              state: "OPEN",
              statusCheckRollup: [
                { name: "test", conclusion: "SUCCESS" },
                { name: "CodeRabbit", conclusion: "SUCCESS" },
              ],
            }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(
      false,
    );
    const newWindows = calls.filter((call) => call[0] === "tmux" && call[1] === "new-window");
    expect(newWindows.some((call) => call.includes("reviewer"))).toBe(true);
    expect(newWindows.some((call) => call.includes("director-watch"))).toBe(true);
    expect(out.join("\n")).toContain("resume: PR ready for reviewer");
  });

  it("resumes a capsule engine combo by ensuring the capsule window instead of director-watch", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(repoDir, "combo-chen.toml"), '[run]\nengine = "capsule"\n');
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
    appendEvent(dir, "coder_started", {});
    appendEvent(dir, "coder_done", {});
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const { deps, calls, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    const newWindows = calls.filter((call) => call[0] === "tmux" && call[1] === "new-window");
    const capsuleWindow = newWindows.find((call) => call[call.indexOf("-n") + 1] === "capsule");
    expect(capsuleWindow?.at(-1)).toContain(`capsule ${shellQuote(dir)}`);
    expect(newWindows.some((call) => call.includes("director-watch"))).toBe(false);
    expect(out.join("\n")).toContain("capsule engine (supervise)");
    expect(out.join("\n")).not.toContain("salvage");
  });

  it("treats a capsule coder_done without a PR as the gate resume phase, not salvage", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(repoDir, "combo-chen.toml"), '[run]\nengine = "capsule"\n');
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
    appendEvent(dir, "coder_started", {});
    appendEvent(dir, "coder_done", {});

    const { deps, calls, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    const newWindows = calls.filter((call) => call[0] === "tmux" && call[1] === "new-window");
    expect(newWindows.some((call) => call[call.indexOf("-n") + 1] === "capsule")).toBe(true);
    expect(out.join("\n")).toContain("capsule engine (gate)");
    expect(out.join("\n")).not.toContain("salvage");
  });

  it("does not resume a capsule combo whose journal is already combo_closed", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(repoDir, "combo-chen.toml"), '[run]\nengine = "capsule"\n');
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
    appendEvent(dir, "combo_closed", {});

    const { deps, calls, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-session")).toBe(false);
    expect(out.join("\n")).toContain("already combo_closed");
  });

  it("monitors a live no-mistakes run instead of relaunching gatekeeper work", async () => {
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
    appendEvent(dir, "gate_started", {});
    appendEvent(dir, "gate_failed", { exit_code: 1 });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: () => ({
        status: 0,
        stdout: [
          "run:",
          "  branch: combo/issue-7",
          "  status: running",
          "  steps[2]{step,status,findings,duration_ms}:",
          "    review,completed,0,1",
          "    ci,running,0,0",
        ].join("\n"),
        stderr: "",
      }),
    });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(
      false,
    );
    const recreatedSession = calls.find((call) => call[0] === "tmux" && call[1] === "new-session");
    expect(recreatedSession).toEqual([
      "tmux",
      "new-session",
      "-d",
      "-s",
      "combo-chen-o-r-7",
      "-n",
      "journal",
      expect.stringContaining("events --follow -n 'o-r-7'"),
    ]);
    expect(recreatedSession).not.toContain("coder");
    expect(
      calls.some((call) => call[0] === "tmux" && call[1] === "new-window" && call.includes("gatekeeper")),
    ).toBe(true);
    const gatekeeperCommand =
      calls
        .find((call) => call[0] === "tmux" && call[1] === "new-window" && call.includes("gatekeeper"))
        ?.at(-1) ?? "";
    expect(gatekeeperCommand).toContain("no-mistakes attach");
    expect(gatekeeperCommand).not.toContain("axi run");
    expect(out.join("\n")).toContain("resume: no-mistakes running ci");
  });

  it("journals a discovered PR and starts reviewer monitoring while no-mistakes is already in CI", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const prUrl = "https://github.com/o/r/pull/7";
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
    appendEvent(dir, "gate_started", {});
    appendEvent(dir, "gate_status", {
      state: "fix_inflight",
      head_sha: "ffffffffffffffffffffffffffffffffffffffff",
    });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: () => ({
        status: 0,
        stdout: [
          "run:",
          "  branch: combo/issue-7",
          "  status: running",
          "  steps[2]{step,status,findings,duration_ms}:",
          "    review,completed,0,1",
          "    ci,running,0,0",
        ].join("\n"),
        stderr: "",
      }),
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "list") {
          return { status: 0, stdout: `${prUrl}\n`, stderr: "" };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    expect(readEvents(dir).at(-1)).toMatchObject({ event: "pr_opened", url: prUrl });
    const newWindows = calls.filter((call) => call[0] === "tmux" && call[1] === "new-window");
    expect(newWindows.some((call) => call.includes("gatekeeper"))).toBe(true);
    expect(newWindows.some((call) => call.includes("reviewer"))).toBe(true);
    expect(newWindows.some((call) => call.includes("director-watch"))).toBe(true);
    expect(out.join("\n")).toContain("resume: no-mistakes running ci");
    expect(out.join("\n")).toContain("reviewer/director monitoring ensured");
  });

  it("starts reviewer monitoring for an existing PR even when the worktree is gone", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const prUrl = "https://github.com/o/r/pull/7";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "missing-issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: prUrl });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return { status: 128, stdout: "", stderr: "not a git repository" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
              state: "OPEN",
              statusCheckRollup: [],
            }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 0, stdout: "[]", stderr: "" };
      },
    });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    const newWindows = calls.filter((call) => call[0] === "tmux" && call[1] === "new-window");
    expect(newWindows.some((call) => call.includes("reviewer"))).toBe(true);
    expect(newWindows.some((call) => call.includes("director-watch"))).toBe(true);
    expect(out.join("\n")).toContain(`resume: PR exists at ${prUrl}; reviewer/director monitoring ensured`);
  });

  it("deterministically relaunches the initial gate after coder finished but no PR was opened", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const headSha = "cccccccccccccccccccccccccccccccccccccccc";
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
    appendEvent(dir, "coder_done", {});
    appendEvent(dir, "gate_started", {});
    appendEvent(dir, "gate_status", { state: "failed", head_sha: headSha });
    appendEvent(dir, "gate_failed", { exit_code: 1 });

    const gitCalls: string[][] = [];
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        gitCalls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return { status: 0, stdout: `${headSha}\n`, stderr: "" };
        }
        if (args[0] === "status" && args[1] === "--porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      noMistakes: () => ({
        status: 0,
        stdout: ["run:", "  branch: combo/issue-7", "  status: cancelled", "outcome: failed"].join("\n"),
        stderr: "",
      }),
    });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    expect(gitCalls.some((call) => call.includes("worktree") && call.includes("add"))).toBe(false);
    expect(gitCalls.some((call) => call.includes("rev-parse") && call.includes("HEAD"))).toBe(true);
    expect(gitCalls.some((call) => call.includes("status") && call.includes("--porcelain"))).toBe(true);

    const gatekeeperWindow = calls
      .filter((call) => call[0] === "tmux" && call[1] === "new-window" && call.includes(GATEKEEPER_WINDOW))
      .at(-1);
    expect(gatekeeperWindow).toBeDefined();
    const command = gatekeeperWindow?.at(-1) ?? "";
    expect(command).toContain("gatekeeper-initial-cccccccccccc.sh");
    expect(command).not.toContain("activate-coder");

    const scriptPath = join(dir, "gatekeeper-initial-cccccccccccc.sh");
    const script = readFileSync(scriptPath, "utf8");
    expect(script).toContain("no-mistakes daemon start");
    expect(script).toContain('git push -o "$mirror_intent" no-mistakes');
    expect(script).toContain("mirror_intent='no-mistakes.intent=");
    expect(script).toContain("no-mistakes axi run --intent");
    expect(script).toContain('no-mistakes axi status > "$status_probe_log" 2>&1');
    expect(script).toContain("exec no-mistakes attach");
    expect(script).toContain(`"$gatekeeper_run_branch" = 'combo/issue-7'`);
    expect(script).toContain("pr_autoclose_failed");
    expect(script).toContain("emit -n 'o-r-7' --skip-gate-window-recovery pr_opened");
    expect(script).not.toContain("activate-coder");
    expect(script).toContain("activate-reviewer -n 'o-r-7'");
    expect(spawnSync("sh", ["-n", scriptPath], { encoding: "utf8" }).status).toBe(0);
    expect(out.join("\n")).toContain(`resume: initial gate relaunched for o-r-7 at ${headSha}`);
  });

  it("does not start a second gate when the journal still records an in-flight gate", async () => {
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
    appendEvent(dir, "coder_done", {});
    appendEvent(dir, "gate_started", {});
    appendEvent(dir, "gate_status", {
      state: "fix_inflight",
      head_sha: "dddddddddddddddddddddddddddddddddddddddd",
    });

    const { deps, calls, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-window")).toBe(false);
    expect(out.join("\n")).toContain("resume: gate journal is fix_inflight for o-r-7");
  });

  it("does not start a second gate when the in-flight gate SHA is abbreviated", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const headSha = "dddddddddddddddddddddddddddddddddddddddd";
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
    appendEvent(dir, "coder_done", {});
    appendEvent(dir, "gate_started", {});
    appendEvent(dir, "gate_status", { state: "fix_inflight", head_sha: headSha.slice(0, 8) });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args) => {
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return { status: 0, stdout: `${headSha}\n`, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-window")).toBe(false);
    expect(out.join("\n")).toContain("resume: gate journal is fix_inflight for o-r-7");
  });

  it("relaunches the initial gate when the recorded in-flight gate is stale", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const oldSha = "dddddddddddddddddddddddddddddddddddddddd";
    const newSha = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
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
    appendEvent(dir, "coder_done", {});
    appendEvent(dir, "gate_started", {});
    appendEvent(dir, "gate_status", { state: "fix_inflight", head_sha: oldSha });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args) => {
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return { status: 0, stdout: `${newSha}\n`, stderr: "" };
        }
        if (args[0] === "status" && args[1] === "--porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      noMistakes: () => ({
        status: 0,
        stdout: ["run:", "  branch: combo/issue-7", "  status: cancelled", "outcome: cancelled"].join("\n"),
        stderr: "",
      }),
    });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    const gatekeeperWindow = calls.find(
      (call) => call[0] === "tmux" && call[1] === "new-window" && call.includes(GATEKEEPER_WINDOW),
    );
    expect(gatekeeperWindow).toBeDefined();
    const script = readFileSync(join(dir, "gatekeeper-initial-eeeeeeeeeeee.sh"), "utf8");
    expect(script).toContain('git push -o "$mirror_intent" no-mistakes');
    expect(script).toContain("no-mistakes axi run --intent");
    expect(out.join("\n")).toContain(`resume: initial gate relaunched for o-r-7 at ${newSha}`);
  });

  it("does not retry the initial gate when gate_failed exhaustion has been journaled", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const headSha = "dddddddddddddddddddddddddddddddddddddddd";
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
    appendEvent(dir, "coder_done", {});
    appendEvent(dir, "gate_started", {});
    appendEvent(dir, "gate_status", { state: "failed", head_sha: headSha });
    appendEvent(dir, "gate_failed", { exit_code: 1 });
    appendEvent(dir, "needs_human", { reason: "gate_failed" });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args) => {
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return { status: 0, stdout: `${headSha}\n`, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      noMistakes: () => ({
        status: 0,
        stdout: ["run:", "  branch: combo/issue-7", "  status: cancelled", "outcome: failed"].join("\n"),
        stderr: "",
      }),
    });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    const gatekeeperWindow = calls.find(
      (call) => call[0] === "tmux" && call[1] === "new-window" && call.includes("gatekeeper"),
    );
    expect(gatekeeperWindow).toBeUndefined();
    expect(out.join("\n")).toContain("resume: salvage required");
  });

  it("ensures reviewer and director monitoring when a PR already exists", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const prUrl = "https://github.com/o/r/pull/7";
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
    appendEvent(dir, "pr_opened", { url: prUrl });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
              state: "OPEN",
              statusCheckRollup: [],
            }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 0, stdout: "[]", stderr: "" };
      },
    });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    const newWindows = calls.filter((call) => call[0] === "tmux" && call[1] === "new-window");
    expect(newWindows.some((call) => call.includes("reviewer"))).toBe(true);
    expect(newWindows.some((call) => call.includes("director-watch"))).toBe(true);
    expect(out.join("\n")).toContain(`resume: PR exists at ${prUrl}; reviewer/director monitoring ensured`);
  });

  it("recreates missing persistent role windows on resume without fabricating journal state", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const prUrl = "https://github.com/o/r/pull/7";
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
    appendEvent(dir, "pr_opened", { url: prUrl });
    const initialEvents = readEvents(dir);
    const tmuxCalls: string[][] = [];
    const windows = new Set(["coder"]);

    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        tmuxCalls.push(args);
        if (args[0] === "has-session") return { status: 0, stdout: "", stderr: "" };
        if (args[0] === "list-windows") {
          return { status: 0, stdout: `${Array.from(windows).join("\n")}\n`, stderr: "" };
        }
        if (args[0] === "new-window") {
          const windowName = args[4];
          if (windowName !== undefined) windows.add(windowName);
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "kill-window") {
          const target = args.at(-1) ?? "";
          windows.delete(target.split(":").at(-1) ?? target);
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
              state: "OPEN",
              statusCheckRollup: [],
            }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 0, stdout: "[]", stderr: "" };
      },
    });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    expect(tmuxCalls.some((call) => call[0] === "new-session")).toBe(false);
    const newWindowNames = tmuxCalls.filter((call) => call[0] === "new-window").map((call) => call[4]);
    expect(newWindowNames).toEqual(
      expect.arrayContaining(["journal", "director", "gatekeeper", "reviewer", "director-watch"]),
    );
    expect(readEvents(dir)).toEqual(initialEvents);
    expect(out.join("\n")).toContain(`resume: PR exists at ${prUrl}; reviewer/director monitoring ensured`);
  });

  it("runs closure instead of reviewer monitoring when the existing PR is already merged", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const prUrl = "https://github.com/o/r/pull/7";
    const runDir = runDirFor(h, "o-r-7");
    writeCombo(runDir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(runDir, "pr_opened", { url: prUrl });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        calls.push(["gh", ...args]);
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return {
          status: 0,
          stdout: JSON.stringify({
            headRefOid: "head777",
            state: "MERGED",
            baseRefName: "main",
            mergeCommit: { oid: "merge777" },
            mergedBy: { login: "maintainer" },
            statusCheckRollup: [],
          }),
          stderr: "",
        };
      },
    });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-window")).toBe(false);
    expect(calls).toContainEqual([
      "treehouse",
      `cwd=${repoDir}`,
      "return",
      "--force",
      join(repoDir, ".worktrees", "issue-7"),
    ]);
    expect(calls).toContainEqual(["git", `cwd=${repoDir}`, "branch", "-D", "combo/issue-7"]);
    expect(readEvents(runDir)).toMatchObject([
      { event: "pr_opened" },
      { event: "merged", sha: "merge777", by: "maintainer", source: "closure" },
      { event: "combo_closed", source: "closure" },
    ]);
    expect(out.join("\n")).toContain("resume: closure pending for o-r-7 (github); running closure");
    expect(out.join("\n")).toContain(
      "closure: o-r-7 closed merged PR merge777 by maintainer; teardown complete",
    );
  });

  it("surfaces exact no-mistakes gate findings and the respond command", async () => {
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
    appendEvent(dir, "gate_started", {});
    appendEvent(dir, "needs_human", { reason: "gate_waiting" });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: () => ({
        status: 0,
        stdout: [
          "run:",
          '  id: "01KV-GATE"',
          "  branch: combo/issue-7",
          "  status: waiting",
          '  findings: "2 awaiting"',
          "findings[2]{id,status,title}:",
          '  NM-1,awaiting,"missing test"',
          '  NM-2,awaiting,"needs docs"',
          "outcome: awaiting_approval",
          'next_step: "no-mistakes axi respond --run 01KV-GATE --finding NM-1 --yes"',
        ].join("\n"),
        stderr: "",
      }),
    });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    const text = out.join("\n");
    expect(text).toContain("resume: awaiting review gate: NM-1, NM-2");
    expect(text).toContain("respond: no-mistakes axi respond --run 01KV-GATE --finding NM-1 --yes");
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-window")).toBe(false);
  });

  it("marks a stopped coder before handoff as salvage-required with exact commands", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const baseSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
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
    appendEvent(dir, "coder_started", {});
    appendEvent(dir, "coder_failed", {
      exit_code: 124,
      has_new_commits: true,
      base_sha: baseSha,
      head_sha: headSha,
      new_commit_count: 42,
    });

    const { deps, calls, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    const text = out.join("\n");
    expect(text).toContain("resume: salvage required for o-r-7; coder stopped before handoff");
    expect(text).toContain("coder failed with exit 124 after 42 new commits");
    expect(text).toContain(`cd ${shellQuote(worktree)}`);
    expect(text).toContain("git status --short");
    expect(text).toContain(`git log --oneline ${shellQuote(`${baseSha}..${headSha}`)}`);
    expect(text).toContain(`COMBO_CHEN_HOME=${shellQuote(h)}`);
    expect(text).toContain(" status --deep");
    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(
      false,
    );
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-window")).toBe(false);
  });
});
// -/ 1/1
