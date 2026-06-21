/**
 * @overview Unit tests for CLI-facing gate lease actions.
 *   Pins how shell scripts surface shared no-mistakes lease states.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at describe("gate lease CLI actions") <- queued-state contract.
 *
 *   MAIN FLOW
 *   ---------
 *   hidden gate-lease command -> acquireGateLeaseForCombo -> journal/status code
 *
 * @exports none
 * @deps vitest, node:{fs,os,path}, ../core/{events,gate-lease,state}, ./gate-lease
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readEvents } from "../core/events.js";
import { acquireGateLease, readGateLease } from "../core/gate-lease.js";
import { runDirFor, writeCombo } from "../core/state.js";
import {
  acquireGateLeaseForCombo,
  GATE_LEASE_BUSY_EXIT_CODE,
} from "./gate-lease.js";

function home(): string {
  return mkdtempSync(join(tmpdir(), "combo-chen-gate-lease-cli-"));
}

// -- 1/1 CORE · gate lease CLI actions <- START HERE --
describe("gate lease CLI actions", () => {
  it("records a deterministic queued status when another combo owns the lease", () => {
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

    const queuedRunDir = runDirFor(h, "o-r-8");
    writeCombo(queuedRunDir, {
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

    expect(result).toEqual({ state: "busy", exitCode: GATE_LEASE_BUSY_EXIT_CODE });
    expect(readGateLease(h)?.comboId).toBe("o-r-7");
    expect(readEvents(queuedRunDir)).toEqual([
      expect.objectContaining({
        event: "gate_status",
        state: "queued",
        head_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        lease_combo_id: "o-r-7",
        lease_branch: "combo/issue-7",
        lease_worktree: "/repos/r/.worktrees/issue-7",
        lease_run_dir: currentRunDir,
      }),
    ]);
  });
});
// -/ 1/1
