/**
 * @overview Unit tests for merged-combo lifecycle cleanup. ~110 lines, teardown order and idempotence.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at teardownMergedCombo tests <- merge verification before destructive cleanup.
 *   2. combo helper                       <- fixture shape.
 *
 *   MAIN FLOW
 *   ---------
 *   fake combo -> teardownMergedCombo -> merge verification -> treehouse return -> branch delete
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   combo
 *
 * @exports none
 * @deps vitest, node:{os,path}, ../core/state, ./lifecycle
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { teardownMergedCombo } from "./lifecycle.js";
import type { ComboRecord } from "../core/state.js";

// -- 1/2 HELPER · combo fixture --
function combo(overrides: Partial<ComboRecord> = {}): ComboRecord {
  return {
    id: "o-r-7",
    issueUrl: "https://github.com/o/r/issues/7",
    repoDir: join(tmpdir(), "combo-chen-repo"),
    worktree: join(tmpdir(), "combo-chen-worktree"),
    branch: "combo/issue-7",
    tmuxSession: "combo-chen-o-r-7",
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}
// -/ 1/2

// -- 2/2 CORE · teardownMergedCombo tests <- START HERE --
describe("teardownMergedCombo", () => {
  it("verifies the merge before removing the worktree and branch", async () => {
    const calls: string[][] = [];
    const record = combo();

    await teardownMergedCombo({
      deps: {
        git: (args, cwd) => {
          calls.push([cwd, ...args]);
          return { status: 0, stdout: "", stderr: "" };
        },
        treehouse: (args, cwd) => {
          calls.push([cwd, "treehouse", ...args]);
          return { status: 0, stdout: "", stderr: "" };
        },
        sleep: async (ms) => {
          calls.push(["sleep", String(ms)]);
        },
      },
      combo: record,
      mergeSha: "merge123",
      baseRefName: "main",
      retries: 0,
      backoffSeconds: 1,
    });

    expect(calls).toEqual([
      [record.repoDir, "fetch", "origin", "main"],
      [record.repoDir, "merge-base", "--is-ancestor", "merge123", "origin/main"],
      [record.repoDir, "treehouse", "return", "--force", record.worktree],
      [record.repoDir, "branch", "-D", record.branch],
    ]);
  });

  it("treats an already-removed worktree and missing local branch as success", async () => {
    const calls: string[][] = [];
    const record = combo();

    await teardownMergedCombo({
      deps: {
        git: (args, cwd) => {
          calls.push([cwd, ...args]);
          if (args[0] === "branch") {
            return { status: 1, stdout: "", stderr: `error: branch '${record.branch}' not found.` };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
        treehouse: (args, cwd) => {
          calls.push([cwd, "treehouse", ...args]);
          return { status: 1, stdout: "", stderr: `fatal: '${record.worktree}' is not a working tree` };
        },
        sleep: async (ms) => {
          calls.push(["sleep", String(ms)]);
        },
      },
      combo: record,
      mergeSha: "merge123",
      baseRefName: "main",
      retries: 2,
      backoffSeconds: 1,
    });

    expect(calls).toEqual([
      [record.repoDir, "fetch", "origin", "main"],
      [record.repoDir, "merge-base", "--is-ancestor", "merge123", "origin/main"],
      [record.repoDir, "treehouse", "return", "--force", record.worktree],
      [record.repoDir, "branch", "-D", record.branch],
    ]);
  });

  it("treats Treehouse 'not managed by treehouse' as already-removed worktree", async () => {
    const calls: string[][] = [];
    const record = combo();

    await teardownMergedCombo({
      deps: {
        git: (args, cwd) => {
          calls.push([cwd, ...args]);
          if (args[0] === "branch") {
            return { status: 1, stdout: "", stderr: `error: branch '${record.branch}' not found.` };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
        treehouse: (args, cwd) => {
          calls.push([cwd, "treehouse", ...args]);
          return {
            status: 1,
            stdout: "",
            stderr: `worktree ${record.worktree} is not managed by treehouse`,
          };
        },
        sleep: async (ms) => {
          calls.push(["sleep", String(ms)]);
        },
      },
      combo: record,
      mergeSha: "merge123",
      baseRefName: "main",
      retries: 2,
      backoffSeconds: 1,
    });

    expect(calls).toEqual([
      [record.repoDir, "fetch", "origin", "main"],
      [record.repoDir, "merge-base", "--is-ancestor", "merge123", "origin/main"],
      [record.repoDir, "treehouse", "return", "--force", record.worktree],
      [record.repoDir, "branch", "-D", record.branch],
    ]);
  });

  it("treats Treehouse 'is being destroyed' as already-removed worktree", async () => {
    const calls: string[][] = [];
    const record = combo();

    await teardownMergedCombo({
      deps: {
        git: (args, cwd) => {
          calls.push([cwd, ...args]);
          if (args[0] === "branch") {
            return { status: 1, stdout: "", stderr: `error: branch '${record.branch}' not found.` };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
        treehouse: (args, cwd) => {
          calls.push([cwd, "treehouse", ...args]);
          return {
            status: 1,
            stdout: "",
            stderr: `worktree ${record.worktree} is being destroyed`,
          };
        },
        sleep: async (ms) => {
          calls.push(["sleep", String(ms)]);
        },
      },
      combo: record,
      mergeSha: "merge123",
      baseRefName: "main",
      retries: 2,
      backoffSeconds: 1,
    });

    expect(calls).toEqual([
      [record.repoDir, "fetch", "origin", "main"],
      [record.repoDir, "merge-base", "--is-ancestor", "merge123", "origin/main"],
      [record.repoDir, "treehouse", "return", "--force", record.worktree],
      [record.repoDir, "branch", "-D", record.branch],
    ]);
  });

  it("surfaces command context when Treehouse fails without output", async () => {
    const record = combo();

    await expect(
      teardownMergedCombo({
        deps: {
          git: () => ({ status: 0, stdout: "", stderr: "" }),
          treehouse: () => ({ status: 1, stdout: "", stderr: "" }),
          sleep: async () => {},
        },
        combo: record,
        mergeSha: "merge123",
        baseRefName: "main",
        retries: 0,
        backoffSeconds: 1,
      }),
    ).rejects.toThrow(
      `treehouse return ${record.worktree} failed: no output (exit 1; cwd ${record.repoDir}; command return --force ${record.worktree})`,
    );
  });
});
// -/ 2/2
