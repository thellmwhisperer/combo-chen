/**
 * @overview Lifecycle application handler integration tests: remaining command contracts.
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
  shellQuote,
  tmpdir,
  writeCombo,
  writeConfigSnapshot,
  writeFileSync,
} from "../../testing/cli-harness.js";
import { deriveStatus } from "../../core/combo.js";

// -- 1/1 CORE · command contracts <- START HERE --
describe("closure", () => {
  it("closes the named combo through the CLI command", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
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
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        calls.push(["gh", ...args]);
        return {
          status: 0,
          stdout: JSON.stringify({
            headRefOid: "head777",
            state: "MERGED",
            baseRefName: "main",
            mergeCommit: { oid: "merge777" },
            mergedBy: { login: "maintainer" },
          }),
          stderr: "",
        };
      },
    });

    await exec(deps, ["closure", "-n", "o-r-7"]);

    expect(readEvents(runDir)).toMatchObject([
      { event: "pr_opened" },
      { event: "merged", sha: "merge777", by: "maintainer", source: "closure" },
      { event: "combo_closed", source: "closure" },
    ]);
    expect(calls).toContainEqual(["tmux", "kill-session", "-t", "combo-chen-o-r-7"]);
    expect(out).toHaveLength(3);
    expect(out[0]).toContain("# Combo closed: o-r-7");
    expect(out[1]).toBe("");
    expect(out[2]).toBe("closure: o-r-7 closed merged PR merge777 by maintainer; teardown complete");
  });
});

describe("reconcile", () => {
  it("scopes -n repairs to one combo", async () => {
    const h = home();
    const targetRepo = mkdtempSync(join(tmpdir(), "combo-chen-repo-target-"));
    const otherRepo = mkdtempSync(join(tmpdir(), "combo-chen-repo-other-"));
    const targetDir = runDirFor(h, "o-r-7");
    const otherDir = runDirFor(h, "o-r-8");
    writeCombo(targetDir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: targetRepo,
      worktree: join(targetRepo, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    writeCombo(otherDir, {
      id: "o-r-8",
      issueUrl: "https://github.com/o/r/issues/8",
      repoDir: otherRepo,
      worktree: join(otherRepo, ".worktrees", "issue-8"),
      branch: "combo/issue-8",
      tmuxSession: "combo-chen-o-r-8",
      createdAt: new Date().toISOString(),
    });
    appendEvent(targetDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(otherDir, "pr_opened", { url: "https://github.com/o/r/pull/8" });
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        calls.push(["gh", ...args]);
        return {
          status: 0,
          stdout: JSON.stringify({
            headRefOid: "head777",
            state: "MERGED",
            baseRefName: "main",
            mergeCommit: { oid: "merge777" },
            mergedBy: { login: "maintainer" },
          }),
          stderr: "",
        };
      },
    });

    await exec(deps, ["reconcile", "-n", "o-r-7", "--apply"]);

    expect(readEvents(targetDir)).toMatchObject([
      { event: "pr_opened" },
      { event: "merged", sha: "merge777", by: "maintainer", source: "reconcile" },
      { event: "combo_closed", source: "reconcile" },
    ]);
    expect(readEvents(otherDir).map((event) => event.event)).toEqual(["pr_opened"]);
    expect(calls.some((call) => call.includes("https://github.com/o/r/pull/8"))).toBe(false);
    expect(calls.some((call) => call.includes(`cwd=${otherRepo}`))).toBe(false);
    expect(out).toEqual(["reconcile: o-r-7 merged merge777 by maintainer; teardown complete"]);
  });
});

describe("stop", () => {
  it("kills the tmux session and journals who stopped it", async () => {
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

    const { deps, calls } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });
    await exec(deps, ["stop", "-n", "o-r-7"]);

    expect(calls.some((c) => c[0] === "tmux" && c[1] === "kill-session")).toBe(true);
    const events = readEvents(dir);
    expect(events.at(-1)?.event).toBe("stopped");
  });

  it("does not journal stopped when the tmux kill fails (the journal never lies)", async () => {
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

    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) =>
        args[0] === "kill-session"
          ? { status: 1, stdout: "", stderr: "no server running" }
          : { status: 0, stdout: "", stderr: "" },
    });

    await expect(exec(deps, ["stop", "-n", "o-r-7"])).rejects.toThrow(/kill/i);
    expect(readEvents(dir)).toEqual([]);
  });
});

describe("decide", () => {
  function seedEscalatedCombo(h: string): string {
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
    return dir;
  }

  it("records a decision against the latest pending needs_human and clears it", async () => {
    const h = home();
    const dir = seedEscalatedCombo(h);
    const escalation = appendEvent(dir, "needs_human", { reason: "review_no_progress", round: 2 });
    const { deps, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["decide", "-n", "o-r-7", "retry", "--note", "flaky reviewer, run it again"]);

    const events = readEvents(dir);
    expect(events.at(-1)).toMatchObject({
      event: "decision",
      needs_human_ref: escalation.t,
      verb: "retry",
      note: "flaky reviewer, run it again",
      by: "human",
    });
    expect(deriveStatus(events).needsHuman).toBe(false);
    expect(out.join("\n")).toContain("retry");
    expect(out.join("\n")).toContain("review_no_progress");
  });

  it("normalizes take-over spelling and rejects unknown verbs", async () => {
    const h = home();
    const dir = seedEscalatedCombo(h);
    appendEvent(dir, "needs_human", { reason: "review_fix_noop" });
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["decide", "-n", "o-r-7", "take-over"]);
    expect(readEvents(dir).at(-1)).toMatchObject({ event: "decision", verb: "take_over" });

    await expect(exec(deps, ["decide", "-n", "o-r-7", "nuke"])).rejects.toThrow(/verb/);
  });

  it("refuses when no pending needs_human escalation exists", async () => {
    const h = home();
    const dir = seedEscalatedCombo(h);
    const escalation = appendEvent(dir, "needs_human", { reason: "review_max_rounds" });
    appendEvent(dir, "decision", { needs_human_ref: escalation.t, verb: "skip" });
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await expect(exec(deps, ["decide", "-n", "o-r-7", "retry"])).rejects.toThrow(/no pending/i);
  });

  it("answers an explicit --ref while leaving other pending escalations open", async () => {
    const h = home();
    const dir = seedEscalatedCombo(h);
    const first = appendEvent(dir, "needs_human", { reason: "review_no_progress" });
    const second = appendEvent(dir, "needs_human", { reason: "review_fix_noop" });
    // appendEvent allocates unique timestamps, so even same-millisecond
    // escalations carry distinct decision identities.
    expect(first.t).not.toBe(second.t);
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["decide", "-n", "o-r-7", "ignore", "--ref", first.t]);
    expect(readEvents(dir).at(-1)).toMatchObject({
      event: "decision",
      needs_human_ref: first.t,
      verb: "ignore",
    });

    // The second escalation is still pending; a bare decide answers it.
    await exec(deps, ["decide", "-n", "o-r-7", "retry"]);
    expect(readEvents(dir).at(-1)).toMatchObject({
      event: "decision",
      needs_human_ref: second.t,
      verb: "retry",
    });

    // Nothing pending is left.
    await expect(exec(deps, ["decide", "-n", "o-r-7", "retry"])).rejects.toThrow(/no pending/i);
  });
});

describe("park", () => {
  it("uses the launch config snapshot for handoff downstream status after repo TOML changes", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(join(repoDir, "combo-chen.toml"), '[reviewer]\nambient = ["launch-bot"]\n');
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
    writeConfigSnapshot(dir, loadConfig({ repoDir, env: {} }));
    writeFileSync(join(repoDir, "combo-chen.toml"), '[reviewer]\nambient = ["drift-bot"]\n');
    const prUrl = "https://github.com/o/r/pull/7";
    appendEvent(dir, "pr_opened", { url: prUrl });

    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              state: "OPEN",
              statusCheckRollup: [
                { name: "launch-bot", conclusion: "FAILURE" },
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

    await exec(deps, ["park", "-n", "o-r-7", "--by", "maintainer"]);

    const summaryPath = readEvents(dir).at(-1)?.summary_path;
    expect(typeof summaryPath).toBe("string");
    const summary = readFileSync(summaryPath as string, "utf8");
    expect(summary).toContain("downstream: PR ready for reviewer");
  });

  it("writes a resumable handoff summary and stops tmux without terminally stopping the combo", async () => {
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
    appendEvent(dir, "coder_started", {});
    appendEvent(dir, "coder_failed", { exit_code: 124, has_new_commits: true });

    const { deps, calls, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["park", "-n", "o-r-7", "--by", "maintainer"]);

    expect(calls.some((c) => c[0] === "tmux" && c[1] === "kill-session")).toBe(true);
    const events = readEvents(dir);
    expect(events.at(-1)?.event).toBe("parked");
    expect(events.some((event) => event.event === "stopped")).toBe(false);
    expect(events.at(-1)).toMatchObject({ by: "maintainer" });
    const summaryPath = events.at(-1)?.summary_path;
    expect(typeof summaryPath).toBe("string");
    const summary = readFileSync(summaryPath as string, "utf8");
    expect(summary).toContain("# Parked combo o-r-7");
    expect(summary).toContain("branch: combo/issue-7");
    expect(summary).toContain("phase: STALLED");
    expect(summary).toContain(`COMBO_CHEN_HOME=${shellQuote(h)}`);
    expect(summary).toContain(`resume -n ${shellQuote("o-r-7")}`);
    expect(summary).toContain("status --deep");
    expect(out).toEqual([`parked o-r-7 (handoff ${summaryPath}; resume with combo-chen resume -n o-r-7)`]);
  });

  it("still writes a resumable handoff when the tmux session is already gone", async () => {
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
    appendEvent(dir, "coder_started", {});

    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        if (args[0] === "kill-session" || args[0] === "has-session") {
          return { status: 1, stdout: "", stderr: "can't find session: combo-chen-o-r-7" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["park", "-n", "o-r-7", "--by", "reboot"]);

    const events = readEvents(dir);
    expect(events.at(-1)).toMatchObject({ event: "parked", by: "reboot" });
    const summaryPath = events.at(-1)?.summary_path;
    expect(typeof summaryPath).toBe("string");
    expect(readFileSync(summaryPath as string, "utf8")).toContain("last event: coder_started");
    expect(out.at(-1)).toContain("parked o-r-7");
  });
});
// -/ 1/1
