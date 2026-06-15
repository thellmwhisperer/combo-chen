/**
 * @overview Unit tests for reconcile command helpers. ~145 lines, frozen journal repair.
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
 * @deps vitest, node:{fs,os,path}, ../core/{events,state}, ./reconcile
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appendEvent, readEvents } from "../core/events.js";
import { runDirFor, writeCombo } from "../core/state.js";
import { reconcileCombos, type ReconcileDeps } from "./reconcile.js";

// -- 1/2 HELPER · Test harness --
function home(): string {
  return mkdtempSync(join(tmpdir(), "combo-chen-reconcile-"));
}

function fakeDeps(): { deps: ReconcileDeps; calls: string[][]; out: string[] } {
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
            '{"headRefOid":"head456","baseRefName":"main","mergeCommit":{"oid":"squash789"},"state":"MERGED","mergedBy":{"login":"javi"}}',
          stderr: "",
        };
      },
      sleep: (ms) => {
        calls.push(["sleep", String(ms)]);
        return Promise.resolve();
      },
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
    expect(out).toEqual(["reconcile: o-r-7 would append merged squash789 by javi and tear down"]);
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
      { event: "merged", sha: "squash789", by: "javi", source: "reconcile" },
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
    expect(out.join("\n")).toContain("reconcile: o-r-7 merged squash789 by javi");

    calls.length = 0;
    out.length = 0;

    await reconcileCombos({ deps, home: h, apply: true });

    expect(readEvents(runDir).filter((event) => event.event === "merged")).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(out).toEqual(["reconcile: no changes"]);
  });
});
// -/ 2/2
