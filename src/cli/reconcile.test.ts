/**
 * @overview Unit tests for reconcile command helpers. ~380 lines, frozen journal repair.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at reconcileCombos tests <- frozen merged journal fixture.
 *   2. Test harness helpers           <- temp home and fake deps.
 *
 *   MAIN FLOW
 *   ---------
 *   frozen journal fixture -> reconcileCombos --apply -> merged/source marker + teardown
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   home, fakeDeps
 *
 * @exports none
 * @deps vitest, node:{fs,os,path}, ../core/{events,state}, ../infra/{config,config-snapshot}, ./reconcile
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appendEvent, readEvents } from "../core/events.js";
import { runDirFor, writeCombo } from "../core/state.js";
import { loadConfig } from "../infra/config.js";
import { writeConfigSnapshot } from "../infra/config-snapshot.js";
import { reconcileCombos, type ReconcileDeps } from "./reconcile.js";

// -- 1/2 HELPER · Test harness --
function home(): string {
  return mkdtempSync(join(tmpdir(), "combo-chen-reconcile-"));
}

function fakeDeps(overrides: Partial<ReconcileDeps> = {}): { deps: ReconcileDeps; calls: string[][]; out: string[] } {
  const calls: string[][] = [];
  const out: string[] = [];
  return {
    calls,
    out,
    deps: {
      env: {},
      out: (line) => out.push(line),
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
          stdout:
            '{"headRefOid":"head456","baseRefName":"main","mergeCommit":{"oid":"squash789"},"state":"MERGED","mergedBy":{"login":"maintainer"}}',
          stderr: "",
        };
      },
      sleep: (ms) => {
        calls.push(["sleep", String(ms)]);
        return Promise.resolve();
      },
      ...overrides,
    },
  };
}
// -/ 1/2

// -- 2/2 CORE · reconcileCombos tests <- START HERE --
describe("reconcileCombos", () => {
  it("dry-runs by default so operators can inspect pending repairs before teardown", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const runDir = runDirFor(h, "o-r-7");
    writeCombo(runDir, {
      id: "o-r-7",
      issueUrl: "https://github.com/o/r/issues/7",
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    const { deps, calls, out } = fakeDeps();

    await reconcileCombos({ deps, home: h, apply: false });

    expect(readEvents(runDir).map((event) => event.event)).toEqual(["pr_opened"]);
    expect(calls.some((call) => call[0] === "git")).toBe(false);
    expect(calls.some((call) => call[0] === "tmux")).toBe(false);
    expect(out).toEqual(["reconcile: o-r-7 would append merged squash789 by maintainer and tear down"]);
  });

  it("repairs a frozen merged journal and leaves a second pass as a no-op", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const runDir = runDirFor(h, "o-r-7");
    writeCombo(runDir, {
      id: "o-r-7",
      issueUrl: "https://github.com/o/r/issues/7",
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    const { deps, calls, out } = fakeDeps();

    await reconcileCombos({ deps, home: h, apply: true });

    expect(readEvents(runDir)).toMatchObject([
      { event: "pr_opened", url: "https://github.com/o/r/pull/7" },
      { event: "merged", sha: "squash789", by: "maintainer", source: "reconcile" },
      { event: "combo_closed", source: "reconcile" },
    ]);
    expect(calls).toContainEqual([
      "gh",
      "pr",
      "view",
      "https://github.com/o/r/pull/7",
      "--json",
      "headRefOid,state,mergedBy,baseRefName,mergeCommit",
    ]);
    expect(calls).toContainEqual(["git", `cwd=${repoDir}`, "fetch", "origin", "main"]);
    expect(calls).toContainEqual([
      "git",
      `cwd=${repoDir}`,
      "worktree",
      "remove",
      "--force",
      join(repoDir, ".worktrees", "issue-7"),
    ]);
    expect(calls).toContainEqual(["git", `cwd=${repoDir}`, "branch", "-D", "combo/issue-7"]);
    expect(calls).toContainEqual(["tmux", "kill-session", "-t", "combo-chen-o-r-7"]);
    expect(out.join("\n")).toContain("reconcile: o-r-7 merged squash789 by maintainer");

    calls.length = 0;
    out.length = 0;

    await reconcileCombos({ deps, home: h, apply: true });

    expect(readEvents(runDir).filter((event) => event.event === "merged")).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(out).toEqual(["reconcile: no changes"]);
  });

  it("treats old partially-cleaned teardown as clean and continues global reconcile", async () => {
    const h = home();
    const oldRepo = mkdtempSync(join(tmpdir(), "combo-chen-repo-old-"));
    const nextRepo = mkdtempSync(join(tmpdir(), "combo-chen-repo-next-"));
    const oldDir = runDirFor(h, "o-r-7");
    const nextDir = runDirFor(h, "o-r-8");
    writeCombo(oldDir, {
      id: "o-r-7",
      issueUrl: "https://github.com/o/r/issues/7",
      repoDir: oldRepo,
      worktree: join(oldRepo, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    writeCombo(nextDir, {
      id: "o-r-8",
      issueUrl: "https://github.com/o/r/issues/8",
      repoDir: nextRepo,
      worktree: join(nextRepo, ".worktrees", "issue-8"),
      branch: "combo/issue-8",
      tmuxSession: "combo-chen-o-r-8",
      createdAt: new Date().toISOString(),
    });
    appendEvent(oldDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(nextDir, "pr_opened", { url: "https://github.com/o/r/pull/8" });
    const { deps, out } = fakeDeps({
      gh: (args) => ({
        status: 0,
        stdout:
          args[2] === "https://github.com/o/r/pull/7"
            ? '{"headRefOid":"head777","baseRefName":"main","mergeCommit":{"oid":"merge777"},"state":"MERGED","mergedBy":{"login":"maintainer"}}'
            : '{"headRefOid":"head888","baseRefName":"main","mergeCommit":{"oid":"merge888"},"state":"MERGED","mergedBy":{"login":"maintainer"}}',
        stderr: "",
      }),
      git: (args, cwd) => {
        if (cwd === oldRepo && args[0] === "worktree") {
          return { status: 128, stdout: "", stderr: `fatal: '${join(oldRepo, ".worktrees", "issue-7")}' is not a working tree` };
        }
        if (cwd === oldRepo && args[0] === "branch") {
          return { status: 1, stdout: "", stderr: "error: branch 'combo/issue-7' not found." };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      tmux: (args) => {
        if (args.at(-1) === "combo-chen-o-r-7") {
          return { status: 1, stdout: "", stderr: "can't find session: combo-chen-o-r-7" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await reconcileCombos({ deps, home: h, apply: true });

    expect(readEvents(oldDir)).toMatchObject([
      { event: "pr_opened" },
      { event: "merged", sha: "merge777", by: "maintainer", source: "reconcile" },
      { event: "combo_closed", source: "reconcile" },
    ]);
    expect(readEvents(nextDir)).toMatchObject([
      { event: "pr_opened" },
      { event: "merged", sha: "merge888", by: "maintainer", source: "reconcile" },
      { event: "combo_closed", source: "reconcile" },
    ]);
    expect(out.join("\n")).not.toContain("teardown pending");
    expect(out.join("\n")).not.toContain("session kill failed");
    expect(out.join("\n")).toContain("reconcile: o-r-8 merged merge888 by maintainer; teardown complete");
  });

  it("uses the launch config snapshot for merged teardown retries after repo TOML changes", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      "[limits]\nteardown_git_retries = 2\nteardown_git_backoff_seconds = 3\n",
    );
    const runDir = runDirFor(h, "o-r-7");
    writeCombo(runDir, {
      id: "o-r-7",
      issueUrl: "https://github.com/o/r/issues/7",
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    writeConfigSnapshot(runDir, loadConfig({ repoDir, env: {} }));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      "[limits]\nteardown_git_retries = 0\nteardown_git_backoff_seconds = 99\n",
    );
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    let fetchAttempts = 0;
    const { deps, calls, out } = fakeDeps({
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "fetch") {
          fetchAttempts += 1;
          if (fetchAttempts <= 2) return { status: 1, stdout: "", stderr: "transient fetch" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await reconcileCombos({ deps, home: h, apply: true });

    expect(readEvents(runDir).map((event) => event.event)).toEqual([
      "pr_opened",
      "merged",
      "combo_closed",
    ]);
    expect(calls).toContainEqual(["sleep", "3000"]);
    expect(calls).toContainEqual(["sleep", "6000"]);
    expect(calls).not.toContainEqual(["sleep", "99000"]);
    expect(out.join("\n")).toContain("reconcile: o-r-7 merged squash789 by maintainer; teardown complete");
  });

  it("skips teardown for parked combos with merged PRs, preserving worktrees", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const runDir = runDirFor(h, "o-r-7");
    writeCombo(runDir, {
      id: "o-r-7",
      issueUrl: "https://github.com/o/r/issues/7",
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(runDir, "parked", {
      by: "operator",
      summary_path: join(runDir, "park-handoff.md"),
    });
    const { deps, calls, out } = fakeDeps();

    await reconcileCombos({ deps, home: h, apply: true });

    expect(readEvents(runDir)).toMatchObject([
      { event: "pr_opened", url: "https://github.com/o/r/pull/7" },
      { event: "parked", by: "operator" },
      { event: "merged", sha: "squash789", by: "maintainer", source: "reconcile" },
      { event: "combo_closed", source: "reconcile" },
    ]);

    // tmux kill-session still runs (parked session may already be dead – best-effort)
    expect(calls).toContainEqual(["tmux", "kill-session", "-t", "combo-chen-o-r-7"]);
    // worktree is NOT removed
    expect(
      calls.some((call) => call[0] === "git" && call[2] === "worktree" && call[3] === "remove"),
    ).toBe(false);
    // branch is NOT deleted
    expect(
      calls.some((call) => call[0] === "git" && call[2] === "branch" && call[3] === "-D"),
    ).toBe(false);
    expect(out.join("\n")).toContain("reconcile: o-r-7 merged squash789 by maintainer; teardown skipped (parked)");
  });

  it("dry-runs parked merged combos reporting skip-teardown intent", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const runDir = runDirFor(h, "o-r-7");
    writeCombo(runDir, {
      id: "o-r-7",
      issueUrl: "https://github.com/o/r/issues/7",
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(runDir, "parked", {
      by: "operator",
      summary_path: join(runDir, "park-handoff.md"),
    });
    const { deps, calls, out } = fakeDeps();

    await reconcileCombos({ deps, home: h, apply: false });

    expect(readEvents(runDir).map((event) => event.event)).toEqual(["pr_opened", "parked"]);
    expect(calls.some((call) => call[0] === "git")).toBe(false);
    expect(calls.some((call) => call[0] === "tmux")).toBe(false);
    expect(out).toEqual([
      "reconcile: o-r-7 would append merged squash789 by maintainer and skip teardown (parked)",
    ]);
  });
  it("keeps quiet embedded reconciliation silent on GitHub read failures", async () => {
    for (const ghResult of [
      { status: 1, stdout: "", stderr: "API rate limit exceeded" },
      { status: 0, stdout: "not json", stderr: "" },
    ]) {
      const h = home();
      const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
      const runDir = runDirFor(h, "o-r-7");
      writeCombo(runDir, {
        id: "o-r-7",
        issueUrl: "https://github.com/o/r/issues/7",
        repoDir,
        worktree: join(repoDir, ".worktrees", "issue-7"),
        branch: "combo/issue-7",
        tmuxSession: "combo-chen-o-r-7",
        createdAt: new Date().toISOString(),
      });
      appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
      const { deps, out } = fakeDeps({
        gh: () => ghResult,
      });

      await reconcileCombos({ deps, home: h, apply: true, quiet: true });

      expect(readEvents(runDir).map((event) => event.event)).toEqual(["pr_opened"]);
      expect(out).toEqual([]);
    }
  });
});
// -/ 2/2
