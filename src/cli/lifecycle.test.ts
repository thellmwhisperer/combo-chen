/**
 * @overview Unit tests for merged-combo lifecycle cleanup. ~75 lines, teardown order.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at teardownMergedCombo tests <- merge verification before destructive cleanup.
 *   2. combo helper                       <- fixture shape.
 *
 *   MAIN FLOW
 *   ---------
 *   fake combo -> teardownMergedCombo -> ordered git calls
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
      [record.repoDir, "worktree", "remove", "--force", record.worktree],
      [record.repoDir, "branch", "-D", record.branch],
    ]);
  });
});
// -/ 2/2
