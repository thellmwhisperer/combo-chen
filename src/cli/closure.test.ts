/**
 * @overview Unit tests for deterministic merged-combo closure. ~355 lines,
 *   command-level post-merge convergence.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at closeMergedCombo tests <- merged happy path and refusal.
 *   2. Test harness helpers            <- temp home, combo fixture, fake deps.
 *
 *   MAIN FLOW
 *   ---------
 *   combo fixture -> closeMergedCombo -> terminal journal events + treehouse teardown
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   home, writeTestCombo, fakeDeps, ledgerOnlyClosureCases
 *
 * @exports none
 * @deps vitest, node:{fs,os,path}, ../core/{events,runtime-ledger,state}, ./closure
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appendEvent, readEvents } from "../core/events.js";
import { buildRuntimeLedger, writeRuntimeLedger } from "../core/runtime-ledger.js";
import { runDirFor, writeCombo, type ComboRecord } from "../core/state.js";
import { closeMergedCombo, type ClosureDeps } from "./closure.js";

// -- 1/2 HELPER · Test harness --
function home(): string {
  return mkdtempSync(join(tmpdir(), "combo-chen-closure-"));
}

function writeTestCombo(
  h: string,
  options: { combo?: Partial<ComboRecord>; prEvent?: boolean } = {},
): { combo: ComboRecord; repoDir: string; runDir: string; worktree: string } {
  const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
  const comboId = options.combo?.id ?? "o-r-7";
  const runDir = runDirFor(h, comboId);
  const worktree = join(repoDir, ".worktrees", "issue-7");
  const combo: ComboRecord = {
    id: comboId,
    issueUrl: "https://github.com/o/r/issues/7",
    repoDir,
    worktree,
    branch: "combo/issue-7",
    tmuxSession: `combo-chen-${comboId}`,
    createdAt: new Date().toISOString(),
    ...options.combo,
  };
  writeCombo(runDir, combo);
  if (options.prEvent !== false) {
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
  }
  return { combo, repoDir, runDir, worktree: combo.worktree };
}

function fakeDeps(overrides: Partial<ClosureDeps> = {}): { deps: ClosureDeps; calls: string[][]; out: string[] } {
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
          stdout: JSON.stringify({
            headRefOid: "head777",
            baseRefName: "main",
            mergeCommit: { oid: "merge777" },
            state: "MERGED",
            mergedAt: "2026-06-11T10:12:00.000Z",
            mergedBy: { login: "maintainer" },
          }),
          stderr: "",
        };
      },
      sleep: (ms) => {
        calls.push(["sleep", String(ms)]);
        return Promise.resolve();
      },
      noMistakes: (args, cwd) => {
        calls.push(["no-mistakes", `cwd=${cwd}`, ...args]);
        return { status: 1, stdout: "", stderr: "No active run." };
      },
      treehouse: (args, cwd) => {
        calls.push(["treehouse", `cwd=${cwd}`, ...args]);
        return { status: 0, stdout: "", stderr: "" };
      },
      ...overrides,
    },
  };
}

const ledgerOnlyClosureCases: Array<[string, Partial<ComboRecord>]> = [
  ["issue-backed", {}],
  [
    "plan-backed",
    {
      id: "plan-ledger-1234abcd",
      issueUrl: "",
      workItemSourceType: "local_file",
      workItemSourceReference: "plans/ledger.md",
      workItemTitle: "Ledger rollout",
      branch: "combo/plan-ledger",
      worktree: "/repo/r/.worktrees/plan-ledger",
    },
  ],
];
// -/ 1/2

// -- 2/2 CORE · closeMergedCombo tests <- START HERE --
describe("closeMergedCombo", () => {
  it.each(ledgerOnlyClosureCases)(
    "uses runtime-ledger PR URL for %s combo records without a pr_opened journal event",
    async (_label, comboOverrides) => {
      const h = home();
      const { combo, runDir } = writeTestCombo(h, { combo: comboOverrides, prEvent: false });
      writeRuntimeLedger(
        runDir,
        buildRuntimeLedger({
          combo,
          runDir,
          cli: "combo-chen",
          prUrl: "https://github.com/o/r/pull/70",
          now: () => "2026-06-21T17:03:00.000Z",
        }),
      );
      const { deps, calls, out } = fakeDeps();

      await closeMergedCombo({ deps, home: h, comboId: combo.id });

      expect(readEvents(runDir)).toMatchObject([
        { event: "merged", sha: "merge777", by: "maintainer", source: "closure" },
        { event: "combo_closed", source: "closure" },
      ]);
      expect(calls).toContainEqual([
        "gh",
        "pr",
        "view",
        "https://github.com/o/r/pull/70",
        "--json",
        "headRefOid,state,mergedAt,mergedBy,baseRefName,mergeCommit",
      ]);
      expect(out).toEqual([`closure: ${combo.id} closed merged PR merge777 by maintainer; teardown complete`]);
    },
  );

  it("closes a merged combo and reports already-converged events on a second run", async () => {
    const h = home();
    const { repoDir, runDir, worktree } = writeTestCombo(h);
    const { deps, calls, out } = fakeDeps();

    await closeMergedCombo({ deps, home: h, comboId: "o-r-7" });

    expect(readEvents(runDir)).toMatchObject([
      { event: "pr_opened", url: "https://github.com/o/r/pull/7" },
      {
        event: "merged",
        sha: "merge777",
        by: "maintainer",
        mergedAt: "2026-06-11T10:12:00.000Z",
        source: "closure",
      },
      { event: "combo_closed", source: "closure" },
    ]);
    expect(calls).toContainEqual([
      "gh",
      "pr",
      "view",
      "https://github.com/o/r/pull/7",
      "--json",
      "headRefOid,state,mergedAt,mergedBy,baseRefName,mergeCommit",
    ]);
    expect(calls).toContainEqual(["git", `cwd=${repoDir}`, "fetch", "origin", "main"]);
    expect(calls).toContainEqual(["treehouse", `cwd=${repoDir}`, "return", "--force", worktree]);
    expect(calls).toContainEqual(["git", `cwd=${repoDir}`, "branch", "-D", "combo/issue-7"]);
    expect(calls).toContainEqual(["tmux", "kill-session", "-t", "combo-chen-o-r-7"]);
    expect(out).toEqual(["closure: o-r-7 closed merged PR merge777 by maintainer; teardown complete"]);

    calls.length = 0;
    out.length = 0;

    await closeMergedCombo({ deps, home: h, comboId: "o-r-7" });

    expect(readEvents(runDir).filter((event) => event.event === "merged")).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(out).toEqual(["closure: o-r-7 already closed"]);
  });

  it("closes a merged combo when local resources are already gone", async () => {
    const h = home();
    const { runDir, worktree } = writeTestCombo(h);
    const { deps, calls, out } = fakeDeps({
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "branch") {
          return { status: 1, stdout: "", stderr: "error: branch 'combo/issue-7' not found." };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      treehouse: (args, cwd) => {
        calls.push(["treehouse", `cwd=${cwd}`, ...args]);
        return { status: 1, stdout: "", stderr: `fatal: '${worktree}' is not a working tree` };
      },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        return { status: 1, stdout: "", stderr: "can't find session: combo-chen-o-r-7" };
      },
    });

    await closeMergedCombo({ deps, home: h, comboId: "o-r-7" });

    expect(readEvents(runDir)).toMatchObject([
      { event: "pr_opened" },
      { event: "merged", sha: "merge777", by: "maintainer", source: "closure" },
      { event: "combo_closed", source: "closure" },
    ]);
    expect(calls).toContainEqual(["treehouse", expect.any(String), "return", "--force", worktree]);
    expect(calls).toContainEqual(["git", expect.any(String), "branch", "-D", "combo/issue-7"]);
    expect(calls).toContainEqual(["tmux", "kill-session", "-t", "combo-chen-o-r-7"]);
    expect(out).toEqual([
      "closure: o-r-7 closed merged PR merge777 by maintainer; already converged: worktree already removed, branch already deleted, tmux session already gone",
    ]);
  });

  it("refuses teardown when GitHub does not report MERGED", async () => {
    const h = home();
    const { runDir } = writeTestCombo(h);
    const { deps, calls, out } = fakeDeps({
      gh: (args) => {
        calls.push(["gh", ...args]);
        return {
          status: 0,
          stdout: JSON.stringify({
            headRefOid: "head777",
            state: "OPEN",
            mergedBy: null,
          }),
          stderr: "",
        };
      },
    });

    await closeMergedCombo({ deps, home: h, comboId: "o-r-7" });

    expect(readEvents(runDir).map((event) => event.event)).toEqual(["pr_opened"]);
    expect(calls.some((call) => call[0] === "git")).toBe(false);
    expect(calls.some((call) => call[0] === "tmux")).toBe(false);
    expect(out).toEqual(["closure: o-r-7 refused: GitHub PR state is OPEN (expected MERGED)"]);
  });

  it("refuses resource teardown while no-mistakes still has an active run for the combo branch", async () => {
    const h = home();
    const { runDir, worktree } = writeTestCombo(h);
    mkdirSync(worktree, { recursive: true });
    const { deps, calls, out } = fakeDeps({
      noMistakes: (args, cwd) => {
        calls.push(["no-mistakes", `cwd=${cwd}`, ...args]);
        return {
          status: 0,
          stdout: [
            "run:",
            "  branch: combo/issue-7",
            "  status: running",
            "  steps[1]{step,status,findings,duration_ms}:",
            "    test,running,0,0",
          ].join("\n"),
          stderr: "",
        };
      },
    });

    await closeMergedCombo({ deps, home: h, comboId: "o-r-7" });

    expect(readEvents(runDir)).toMatchObject([
      { event: "pr_opened" },
      { event: "merged", sha: "merge777", by: "maintainer", source: "closure" },
    ]);
    expect(readEvents(runDir).some((event) => event.event === "combo_closed")).toBe(false);
    expect(calls).toContainEqual(["no-mistakes", `cwd=${worktree}`, "axi", "status"]);
    expect(calls.some((call) => call[0] === "git")).toBe(false);
    expect(calls.some((call) => call[0] === "tmux")).toBe(false);
    expect(out).toEqual([
      "closure: o-r-7 refused: no-mistakes active run remains for combo/issue-7 (no-mistakes running test)",
    ]);
  });

  it("reports teardown pending on transient git failure and does not crash", async () => {
    const h = home();
    const { runDir } = writeTestCombo(h);
    const { deps, calls, out } = fakeDeps({
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        return { status: 128, stdout: "", stderr: "fatal: unable to fetch from origin" };
      },
    });

    await closeMergedCombo({ deps, home: h, comboId: "o-r-7" });

    expect(readEvents(runDir)).toMatchObject([
      { event: "pr_opened" },
      { event: "merged", sha: "merge777", by: "maintainer", source: "closure" },
    ]);
    expect(readEvents(runDir).some((event) => event.event === "combo_closed")).toBe(false);
    expect(out).toEqual([
      "closure: o-r-7 teardown pending: git fetch base branch failed: fatal: unable to fetch from origin",
    ]);
  });

  it("completes closure with logged session kill failure when tmux kill fails", async () => {
    const h = home();
    const { runDir } = writeTestCombo(h);
    const { deps, calls, out } = fakeDeps({
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        return { status: 1, stdout: "", stderr: "tmux: server unavailable" };
      },
    });

    await closeMergedCombo({ deps, home: h, comboId: "o-r-7" });

    expect(readEvents(runDir)).toMatchObject([
      { event: "pr_opened" },
      { event: "merged", sha: "merge777", by: "maintainer", source: "closure" },
      { event: "combo_closed", source: "closure" },
    ]);
    expect(out).toEqual([
      "closure: o-r-7 session kill failed: tmux kill-session failed for \"combo-chen-o-r-7\": tmux: server unavailable",
      "closure: o-r-7 closed merged PR merge777 by maintainer; already converged: tmux session already gone",
    ]);
  });
});
// -/ 2/2
