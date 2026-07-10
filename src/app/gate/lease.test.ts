/**
 * @overview Unit tests for CLI-facing gate lease actions.
 *   Pins how shell scripts surface branch-scoped no-mistakes lease states.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at describe("gate lease CLI actions") <- branch ownership contract.
 *
 *   MAIN FLOW
 *   ---------
 *   hidden gate-lease command -> acquireGateLeaseForCombo -> journal/status code
 *
 * @exports none
 * @deps ../../core/events, ../../core/gate-lease, ../../core/state, ./lease, node:fs, node:os, node:path, vitest
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readEvents } from "../../core/events.js";
import { acquireGateLease, readGateLease } from "../../core/gate-lease.js";
import { ComboStateError, runDirFor, writeCombo } from "../../core/state.js";
import {
  acquireGateLeaseForCombo,
  GATE_LEASE_CONFLICT_EXIT_CODE,
  releaseGateLeaseForCombo,
} from "./lease.js";

function home(): string {
  return mkdtempSync(join(tmpdir(), "combo-chen-gate-lease-cli-"));
}

// -- 1/1 CORE · gate lease CLI actions <- START HERE --
describe("gate lease CLI actions", () => {
  it("records a deterministic conflict when another combo owns the same branch lease", () => {
    const h = home();
    const currentRunDir = runDirFor(h, "o-r-7");
    acquireGateLease({
      home: h,
      owner: {
        comboId: "o-r-7",
        branch: "combo/issue-7",
        worktree: "/repos/r/.worktrees/issue-7",
        runDir: currentRunDir,
        headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });

    const conflictRunDir = runDirFor(h, "o-r-8");
    writeCombo(conflictRunDir, {
      id: "o-r-8",
      issueUrl: "https://github.com/o/r/issues/8",
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7-other",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-8",
      createdAt: new Date().toISOString(),
    });

    const result = acquireGateLeaseForCombo({
      home: h,
      comboId: "o-r-8",
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      out: () => undefined,
    });

    expect(result.state).toBe("same_branch_conflict");
    expect(result.exitCode).toBe(GATE_LEASE_CONFLICT_EXIT_CODE);
    expect(readGateLease(h)?.comboId).toBe("o-r-7");
    expect(readEvents(conflictRunDir)).toEqual([
      expect.objectContaining({
        event: "needs_human",
        reason: "gate_lease_conflict",
        lease_combo_id: "o-r-7",
        lease_branch: "combo/issue-7",
        lease_worktree: "/repos/r/.worktrees/issue-7",
        lease_run_dir: currentRunDir,
      }),
    ]);
  });

  it("acquires independently when another combo owns a different branch lease", () => {
    const h = home();
    const currentRunDir = runDirFor(h, "o-r-7");
    acquireGateLease({
      home: h,
      owner: {
        comboId: "o-r-7",
        branch: "combo/issue-7",
        worktree: "/repos/r/.worktrees/issue-7",
        runDir: currentRunDir,
        headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });

    const secondRunDir = runDirFor(h, "o-r-8");
    writeCombo(secondRunDir, {
      id: "o-r-8",
      issueUrl: "https://github.com/o/r/issues/8",
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-8",
      branch: "combo/issue-8",
      tmuxSession: "combo-chen-o-r-8",
      createdAt: new Date().toISOString(),
    });

    const result = acquireGateLeaseForCombo({
      home: h,
      comboId: "o-r-8",
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      out: () => undefined,
    });

    expect(result).toEqual({ state: "acquired", exitCode: 0 });
    expect(readEvents(secondRunDir)).toEqual([]);
  });

  it("releases a lease owned by the calling combo", () => {
    const h = home();
    const runDir = runDirFor(h, "o-r-7");
    writeCombo(runDir, {
      id: "o-r-7",
      issueUrl: "https://github.com/o/r/issues/7",
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    acquireGateLease({
      home: h,
      owner: {
        comboId: "o-r-7",
        branch: "combo/issue-7",
        worktree: "/repos/r/.worktrees/issue-7",
        runDir,
        headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });

    const result = releaseGateLeaseForCombo({
      home: h,
      comboId: "o-r-7",
      out: () => undefined,
    });

    expect(result).toEqual({ state: "released", exitCode: 0 });
    expect(readGateLease(h)).toBeUndefined();
  });

  it("handles a missing lease without error", () => {
    const h = home();

    const result = releaseGateLeaseForCombo({
      home: h,
      comboId: "o-r-7",
      out: () => undefined,
    });

    expect(result).toEqual({ state: "missing", exitCode: 0 });
  });

  it("reports not-owner when another combo owns the lease", () => {
    const h = home();
    const ownerDir = runDirFor(h, "o-r-1");
    writeCombo(ownerDir, {
      id: "o-r-1",
      issueUrl: "https://github.com/o/r/issues/1",
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-1",
      branch: "combo/issue-1",
      tmuxSession: "combo-chen-o-r-1",
      createdAt: new Date().toISOString(),
    });
    acquireGateLease({
      home: h,
      owner: {
        comboId: "o-r-1",
        branch: "combo/issue-1",
        worktree: "/repos/r/.worktrees/issue-1",
        runDir: ownerDir,
        headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });

    const notOwnerDir = runDirFor(h, "o-r-7");
    writeCombo(notOwnerDir, {
      id: "o-r-7",
      issueUrl: "https://github.com/o/r/issues/7",
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    const result = releaseGateLeaseForCombo({
      home: h,
      comboId: "o-r-7",
      out: () => undefined,
    });

    expect(result.state).toBe("not_owner");
    expect(result.exitCode).toBe(0);
    expect(readGateLease(h)?.comboId).toBe("o-r-1");
  });

  it("releases the lease even when the combo record is absent", () => {
    const h = home();
    acquireGateLease({
      home: h,
      owner: {
        comboId: "o-r-7",
        branch: "combo/issue-7",
        worktree: "/repos/r/.worktrees/issue-7",
        runDir: runDirFor(h, "o-r-7"),
        headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });

    try {
      readEvents(runDirFor(h, "o-r-7"));
    } catch (error) {
      expect(error).toBeInstanceOf(ComboStateError);
    }

    const result = releaseGateLeaseForCombo({
      home: h,
      comboId: "o-r-7",
      out: () => undefined,
    });

    expect(result).toEqual({ state: "released", exitCode: 0 });
    expect(readGateLease(h)).toBeUndefined();
  });

  it("handles not-owner release when combo record is absent", () => {
    const h = home();
    acquireGateLease({
      home: h,
      owner: {
        comboId: "o-r-1",
        branch: "combo/issue-1",
        worktree: "/repos/r/.worktrees/issue-1",
        runDir: runDirFor(h, "o-r-1"),
        headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });

    const result = releaseGateLeaseForCombo({
      home: h,
      comboId: "o-r-7",
      out: () => undefined,
    });

    expect(result.state).toBe("not_owner");
    expect(readGateLease(h)?.comboId).toBe("o-r-1");
  });
});
// -/ 1/1
