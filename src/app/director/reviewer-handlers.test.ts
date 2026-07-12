/**
 * @overview Director application handler integration tests: reviewer activation and ticks.
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
  runDirFor,
  tmpdir,
  writeCombo,
  writeConfigSnapshot,
  writeFileSync,
} from "../../testing/cli-harness.js";

// -- 1/1 CORE · command contracts <- START HERE --
describe("activate-reviewer", () => {
  it("does not create a director-watch window for capsule engine combos", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(join(repoDir, "combo-chen.toml"), '[run]\nengine = "capsule"\n');
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
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "list-windows") {
          return {
            status: 0,
            stdout: "capsule\njournal\ndirector\ncoder\ngatekeeper\nreviewer\n",
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["activate-reviewer", "-n", "o-r-7"]);

    expect(calls.some((c) => c[0] === "tmux" && c[1] === "new-window" && c.includes("director-watch"))).toBe(
      false,
    );
    expect(
      calls.some(
        (c) => c[0] === "tmux" && c[1] === "set-buffer" && String(c.at(-1)).includes("director-tick"),
      ),
    ).toBe(false);
  });

  it("refuses activation before the combo has an opened PR in the journal", async () => {
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
    await expect(exec(deps, ["activate-reviewer", "-n", "o-r-7"])).rejects.toThrow(/pr_opened/);
  });

  it("removes legacy reviewer-watch without prompting the GitHub reviewer window", async () => {
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
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "list-windows") {
          return { status: 0, stdout: "coder\nreviewer\nreviewer-watch\ndirector-watch\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["activate-reviewer", "-n", "o-r-7"]);

    const listIndex = calls.findIndex((c) => c[1] === "list-windows");
    const killReviewerWatchIndex = calls.findIndex(
      (c) => c.join(" ") === "tmux kill-window -t combo-chen-o-r-7:reviewer-watch",
    );
    expect(listIndex).toBeGreaterThan(-1);
    expect(killReviewerWatchIndex).toBeGreaterThan(listIndex);
    expect(calls.some((c) => c[1] === "set-buffer" && c.includes("reviewer"))).toBe(false);
    expect(calls.some((c) => c.join(" ") === "tmux kill-window -t combo-chen-o-r-7:reviewer")).toBe(false);
    expect(calls.some((c) => c[1] === "new-window" && c.includes("reviewer"))).toBe(false);
  });
});

describe("reviewer-tick", () => {
  it("marks gh pr view failures as transient for director-watch backoff", async () => {
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
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: () => ({ status: 1, stdout: "", stderr: "API rate limit exceeded" }),
    });

    await exec(deps, ["reviewer-tick", "-n", "o-r-7"]);

    expect(out.join("\n")).toContain("reviewer: transient_failure:");
    expect(out.join("\n")).toContain("gh pr view failed");
    expect(out.join("\n")).toContain("API rate limit exceeded");
    expect(readEvents(dir).map((event) => event.event)).toEqual(["pr_opened"]);
  });

  it("marks invalid gh pr view JSON as transient for director-watch backoff", async () => {
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
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: () => ({ status: 0, stdout: "not json", stderr: "" }),
    });

    await exec(deps, ["reviewer-tick", "-n", "o-r-7"]);

    expect(out.join("\n")).toContain("reviewer: transient_failure:");
    expect(out.join("\n")).toContain("failed to parse PR data");
    expect(readEvents(dir).map((event) => event.event)).toEqual(["pr_opened"]);
  });

  it("journals a merged PR as closure pending and leaves cleanup to closure", async () => {
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
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        return { status: 0, stdout: "", stderr: "" };
      },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        return { status: 0, stdout: "", stderr: "" };
      },
      gh: (args) => {
        calls.push(["gh", ...args]);
        return {
          status: 0,
          stdout: JSON.stringify({
            headRefOid: "head456",
            mergeCommit: { oid: "squash789" },
            state: "MERGED",
            mergedAt: "2026-06-11T11:20:00.000Z",
            mergedBy: { login: "maintainer" },
          }),
          stderr: "",
        };
      },
    });

    await exec(deps, ["reviewer-tick", "-n", "o-r-7"]);

    expect(readEvents(dir).map((event) => event.event)).toEqual(["pr_opened", "merged"]);
    expect(readEvents(dir).slice(-1)).toMatchObject([
      {
        event: "merged",
        sha: "squash789",
        by: "maintainer",
        mergedAt: "2026-06-11T11:20:00.000Z",
        source: "reviewer",
      },
    ]);
    expect(readEvents(dir).some((event) => event.event === "combo_closed")).toBe(false);
    expect(calls.some((c) => c[0] === "tmux")).toBe(false);
    expect(calls.some((c) => c[0] === "git")).toBe(false);

    const prView = calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "view");
    expect(prView).toContain("--json");
    expect(prView).toContain("headRefOid,state,mergedAt,mergedBy,mergeCommit");
    expect(out).toEqual([
      "reviewer: merged squash789 by maintainer; closure pending: combo-chen closure -n o-r-7",
    ]);
  });

  it("keeps already journaled merged PRs closure-pending without duplicate terminal close", async () => {
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
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(dir, "merged", { sha: "squash789", by: "maintainer" });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        calls.push(["gh", ...args]);
        return {
          status: 0,
          stdout:
            '{"headRefOid":"head456","baseRefName":"main","mergeCommit":{"oid":"squash789"},"state":"MERGED","mergedBy":{"login":"maintainer"}}',
          stderr: "",
        };
      },
    });

    await exec(deps, ["reviewer-tick", "-n", "o-r-7"]);

    expect(readEvents(dir).map((event) => event.event)).toEqual(["pr_opened", "merged"]);
    expect(readEvents(dir).filter((event) => event.event === "merged")).toHaveLength(1);
    expect(calls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "view")).toBe(true);
    expect(calls.some((c) => c[0] === "tmux" && c[1] === "kill-session")).toBe(false);
    expect(out.join("\n")).toContain("closure pending: combo-chen closure -n o-r-7");
    expect(out.join("\n")).not.toContain("already terminal");
  });

  it("does not duplicate a legacy merged event that used the PR head sha", async () => {
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
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(dir, "merged", { sha: "head456", by: "maintainer" });

    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: () => ({
        status: 0,
        stdout:
          '{"headRefOid":"head456","baseRefName":"main","mergeCommit":{"oid":"squash789"},"state":"MERGED","mergedBy":{"login":"maintainer"}}',
        stderr: "",
      }),
    });

    await exec(deps, ["reviewer-tick", "-n", "o-r-7"]);

    expect(readEvents(dir).map((event) => event.event)).toEqual(["pr_opened", "merged"]);
    expect(readEvents(dir).filter((event) => event.event === "merged")).toHaveLength(1);
  });

  it("journals a closed PR for human salvage, stops the combo, and keeps local work", async () => {
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
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        calls.push(["gh", ...args]);
        return {
          status: 0,
          stdout: '{"headRefOid":"def456","state":"CLOSED","mergedBy":null}',
          stderr: "",
        };
      },
    });

    await exec(deps, ["reviewer-tick", "-n", "o-r-7"]);

    expect(readEvents(dir).slice(-2)).toMatchObject([
      { event: "needs_human", reason: "pr_closed" },
      { event: "combo_closed" },
    ]);

    const killSession = calls.find((c) => c[0] === "tmux" && c[1] === "kill-session");
    expect(killSession).toEqual(["tmux", "kill-session", "-t", "combo-chen-o-r-7"]);
    expect(calls.some((c) => c[0] === "git")).toBe(false);
    expect(out.join("\n")).toContain("closed");
  });
});
// -/ 1/1
