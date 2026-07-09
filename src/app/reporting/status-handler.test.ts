/**
 * @overview Status dashboard application handler integration tests.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at the describe block  <- command contracts and their effects.
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
 *   Command-specific fixtures live inside the describe block.
 *
 * @exports none
 * @deps ../../cli/main.test-harness
 */

import {
  ISSUE,
  acquireGateLease,
  appendEvent,
  buildRuntimeLedger,
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
  writeCombo,
  writeRuntimeLedger,
} from "../../cli/main.test-harness.js";

// -- 1/1 CORE · command contracts <- START HERE --
describe("status", () => {
  it("prints one line per combo with phase and needs-human flag", async () => {
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
    appendEvent(dir, "needs_human", { reason: "gate_decision" });

    const { deps, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });
    await exec(deps, ["status"]);

    const text = out.join("\n");
    expect(text).toContain("CAPSULE");
    expect(text).toContain("o-r-7");
    expect(text).toContain("CODING");
    expect(text).toContain("gate_decision");
  });

  it("prints plan work item source and title", async () => {
    const h = home();
    const id = "plan-let-plans-launch-combos-12345678";
    const planPath = "/plans/issue-134.md";
    const dir = runDirFor(h, id);
    writeCombo(dir, {
      id,
      issueUrl: "",
      workItemSourceType: "local_file",
      workItemSourceReference: planPath,
      workItemTitle: "Let plans launch combos",
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/plan-let-plans-launch-combos-12345678",
      branch: "combo/plan-let-plans-launch-combos-12345678",
      tmuxSession: `combo-chen-${id}`,
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "coder_started", {});
    appendEvent(dir, "needs_human", { reason: "gate_decision" });

    const { deps, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });
    await exec(deps, ["status"]);

    const text = out.join("\n");
    expect(text).toContain("WORK ITEM");
    expect(text).toContain("Let plans launch combos");
    expect(text).toContain(`local_file:${planPath}`);
  });

  it("prints the PR URL from the runtime ledger when the journal lacks pr_opened", async () => {
    const h = home();
    const prUrl = "https://github.com/o/r/pull/7";
    const dir = runDirFor(h, "o-r-7");
    const combo = {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    };
    writeCombo(dir, combo);
    writeRuntimeLedger(dir, buildRuntimeLedger({ combo, runDir: dir, cli: "combo-chen", prUrl }));
    appendEvent(dir, "gate_started", {});
    appendEvent(dir, "gate_failed", { exit_code: 1 });

    const { deps, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });
    await exec(deps, ["status"]);

    const text = out.join("\n");
    expect(text).toContain("o-r-7");
    expect(text).toContain("STALLED");
    expect(text).toContain(prUrl);
  });

  it("prints active branch-scoped gate lease ownership", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    const worktree = "/repos/r/.worktrees/issue-7";
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "coder_started", {});
    appendEvent(dir, "needs_human", { reason: "gate_decision" });
    acquireGateLease({
      home: h,
      owner: {
        comboId: "o-r-7",
        branch: "combo/issue-7",
        worktree,
        runDir: dir,
        headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });

    const { deps, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });
    await exec(deps, ["status"]);

    const text = out.join("\n");
    expect(text).toContain("GATE-LEASE");
    expect(text).toContain("o-r-7@combo/issue-7");
  });

  it("prints all active branch-scoped gate leases when no combos are actionable", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    const worktree = "/repos/r/.worktrees/issue-7";
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "combo_closed", {});
    acquireGateLease({
      home: h,
      owner: {
        comboId: "o-r-7",
        branch: "combo/issue-7",
        worktree,
        runDir: dir,
        headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });
    acquireGateLease({
      home: h,
      owner: {
        comboId: "o-r-8",
        branch: "combo/issue-8",
        worktree: "/repos/r/.worktrees/issue-8",
        runDir: runDirFor(h, "o-r-8"),
        headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    });

    const { deps, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });
    await exec(deps, ["status"]);

    const text = out.join("\n");
    expect(text).toContain("active gate leases: o-r-7@combo/issue-7, o-r-8@combo/issue-8");
    expect(text).toContain("no actionable combos. show history: combo-chen status --all");
  });

  it("hides terminal historical combos by default and preserves them with --all", async () => {
    const h = home();
    const liveDir = runDirFor(h, "o-r-live");
    writeCombo(liveDir, {
      id: "o-r-live",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-live",
      branch: "combo/issue-live",
      tmuxSession: "combo-chen-o-r-live",
      createdAt: new Date().toISOString(),
    });
    appendEvent(liveDir, "coder_started", {});

    const historicalDir = runDirFor(h, "o-r-merged");
    writeCombo(historicalDir, {
      id: "o-r-merged",
      issueUrl: "https://github.com/o/r/issues/8",
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-8",
      branch: "combo/issue-8",
      tmuxSession: "combo-chen-o-r-8",
      createdAt: new Date().toISOString(),
    });
    appendEvent(historicalDir, "pr_opened", { url: "https://github.com/o/r/pull/8" });
    appendEvent(historicalDir, "merged", { sha: "abc1234", by: "maintainer" });
    appendEvent(historicalDir, "combo_closed", {});

    const { deps, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });
    await exec(deps, ["status"]);

    const defaultText = out.join("\n");
    expect(defaultText).toContain("o-r-live");
    expect(defaultText).not.toContain("o-r-merged");

    out.length = 0;
    await exec(deps, ["status", "--all"]);

    const allText = out.join("\n");
    expect(allText).toContain("o-r-live");
    expect(allText).toContain("o-r-merged");
    expect(allText).toContain("STOPPED");
  });

  it("prints a history hint when default status has no actionable combos", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-stopped");
    writeCombo(dir, {
      id: "o-r-stopped",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "stopped", { by: "operator" });

    const { deps, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });
    await exec(deps, ["status"]);

    expect(out).toEqual(["no actionable combos. show history: combo-chen status --all"]);
  });

  it("reports merged PRs as closure pending while preserving closed-PR salvage", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const mergedDir = runDirFor(h, "o-r-merged");
    writeCombo(mergedDir, {
      id: "o-r-merged",
      issueUrl: "https://github.com/o/r/issues/8",
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-8"),
      branch: "combo/issue-8",
      tmuxSession: "combo-chen-o-r-merged",
      createdAt: new Date().toISOString(),
    });
    appendEvent(mergedDir, "pr_opened", { url: "https://github.com/o/r/pull/8" });

    const closedDir = runDirFor(h, "o-r-closed");
    writeCombo(closedDir, {
      id: "o-r-closed",
      issueUrl: "https://github.com/o/r/issues/9",
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-9"),
      branch: "combo/issue-9",
      tmuxSession: "combo-chen-o-r-closed",
      createdAt: new Date().toISOString(),
    });
    appendEvent(closedDir, "pr_opened", { url: "https://github.com/o/r/pull/9" });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        calls.push(["gh", ...args]);
        if (args[0] === "pr" && args[1] === "view" && args[2] === "https://github.com/o/r/pull/8") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: "head888",
              state: "MERGED",
              baseRefName: "main",
              mergeCommit: { oid: "merge888" },
              mergedBy: { login: "maintainer" },
            }),
            stderr: "",
          };
        }
        if (args[0] === "pr" && args[1] === "view" && args[2] === "https://github.com/o/r/pull/9") {
          return {
            status: 0,
            stdout: JSON.stringify({ headRefOid: "head999", state: "CLOSED", mergedBy: null }),
            stderr: "",
          };
        }
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["status"]);

    const text = out.join("\n");
    expect(text).toContain("CAPSULE");
    expect(text).toContain("o-r-merged");
    expect(text).toContain("STALLED");
    expect(text).toContain("closure_pending");
    expect(text).not.toContain("o-r-closed");
    expect(readEvents(mergedDir)).toMatchObject([
      { event: "pr_opened", url: "https://github.com/o/r/pull/8" },
      { event: "merged", sha: "merge888", by: "maintainer", source: "reconcile" },
    ]);
    expect(readEvents(mergedDir).some((event) => event.event === "combo_closed")).toBe(false);
    expect(readEvents(closedDir)).toMatchObject([
      { event: "pr_opened", url: "https://github.com/o/r/pull/9" },
      { event: "needs_human", reason: "pr_closed", source: "reconcile" },
      { event: "combo_closed", source: "reconcile" },
    ]);
    expect(calls).not.toContainEqual(["tmux", "kill-session", "-t", "combo-chen-o-r-merged"]);
    expect(calls).toContainEqual(["tmux", "kill-session", "-t", "combo-chen-o-r-closed"]);
    expect(calls).not.toContainEqual([
      "git",
      `cwd=${repoDir}`,
      "worktree",
      "remove",
      "--force",
      join(repoDir, ".worktrees", "issue-8"),
    ]);
    expect(
      calls.some(
        (call) =>
          call[0] === "git" && call[2] === "branch" && call[3] === "-D" && call[4] === "combo/issue-8",
      ),
    ).toBe(false);
    expect(
      calls.some((call) => call[0] === "git" && call.includes(join(repoDir, ".worktrees", "issue-9"))),
    ).toBe(false);
    expect(
      calls.some(
        (call) =>
          call[0] === "git" && call[2] === "branch" && call[3] === "-D" && call[4] === "combo/issue-9",
      ),
    ).toBe(false);
  });

  it("marks non-terminal combos with missing tmux sessions as needing human attention", async () => {
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
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "has-session") return { status: 1, stdout: "", stderr: "no such session" };
        return { status: 0, stdout: "", stderr: "" };
      },
      gh: (args) => {
        calls.push(["gh", ...args]);
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({ headRefOid: "head777", state: "OPEN", mergedBy: null }),
            stderr: "",
          };
        }
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["status"]);

    expect(out.join("\n")).toContain("tmux_missing");
    expect(readEvents(dir)).toMatchObject([
      { event: "coder_started" },
      { event: "pr_opened", url: "https://github.com/o/r/pull/7" },
      { event: "needs_human", reason: "tmux_missing", source: "status" },
    ]);
    expect(calls).toContainEqual(["tmux", "has-session", "-t", "combo-chen-o-r-7"]);
  });

  it("does not mark parked combos as tmux_missing", async () => {
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
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(dir, "parked", {
      by: "operator",
      summary_path: "/repos/r/.worktrees/issue-7/park-handoff.md",
    });
    const before = readEvents(dir);

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "has-session") return { status: 1, stdout: "", stderr: "no such session" };
        return { status: 0, stdout: "", stderr: "" };
      },
      gh: (args) => {
        calls.push(["gh", ...args]);
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({ headRefOid: "head777", state: "OPEN", mergedBy: null }),
            stderr: "",
          };
        }
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["status"]);

    expect(out.join("\n")).toContain("o-r-7");
    expect(out.join("\n")).not.toContain("tmux_missing");
    expect(readEvents(dir)).toEqual(before);
    expect(calls).not.toContainEqual(["tmux", "has-session", "-t", "combo-chen-o-r-7"]);
  });
});
// -/ 1/1
