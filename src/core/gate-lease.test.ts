/**
 * @overview Unit tests for the shared no-mistakes gate lease contract.
 *   Covers free, busy, stale, and same-branch lease states.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at describe("gate lease") <- pins the lease state machine.
 *
 *   MAIN FLOW
 *   ---------
 *   combo gate owner -> acquireGateLease -> persisted lease or queued/conflict state
 *
 * @exports none
 * @deps vitest, node:{fs,os,path}, ./gate-lease
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  acquireGateLease,
  readGateLease,
  type GateLeaseOwner,
} from "./gate-lease.js";

function home(): string {
  return mkdtempSync(join(tmpdir(), "combo-chen-gate-lease-"));
}

function owner(overrides: Partial<GateLeaseOwner> = {}): GateLeaseOwner {
  return {
    comboId: "o-r-7",
    branch: "combo/issue-7",
    worktree: "/repo/.worktrees/issue-7",
    runDir: "/home/.combo-chen/runs/o-r-7",
    headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ...overrides,
  };
}

const NOW = new Date("2026-06-21T10:00:00.000Z");
const STALE_AFTER_MS = 30 * 60 * 1000;

// -- 1/1 CORE · gate lease state machine <- START HERE --
describe("gate lease", () => {
  it("acquires and persists a free lease", () => {
    const dir = home();
    const result = acquireGateLease({
      home: dir,
      owner: owner(),
      now: NOW,
      staleAfterMs: STALE_AFTER_MS,
    });

    expect(result.state).toBe("acquired");
    expect(result.lease).toMatchObject({
      comboId: "o-r-7",
      branch: "combo/issue-7",
      acquiredAt: NOW.toISOString(),
      heartbeatAt: NOW.toISOString(),
    });
    expect(readGateLease(dir)).toEqual(result.lease);
  });

  it("reports a busy lease for a different active branch without replacing it", () => {
    const dir = home();
    const first = acquireGateLease({
      home: dir,
      owner: owner(),
      now: NOW,
      staleAfterMs: STALE_AFTER_MS,
    });

    const second = acquireGateLease({
      home: dir,
      owner: owner({
        comboId: "o-r-8",
        branch: "combo/issue-8",
        worktree: "/repo/.worktrees/issue-8",
        runDir: "/home/.combo-chen/runs/o-r-8",
      }),
      now: new Date(NOW.getTime() + 60_000),
      staleAfterMs: STALE_AFTER_MS,
    });

    expect(second.state).toBe("busy");
    expect(second.lease).toEqual(first.lease);
    expect(readGateLease(dir)).toEqual(first.lease);
  });

  it("recovers a stale lease and records the previous owner in the result", () => {
    const dir = home();
    const staleOwner = owner();
    acquireGateLease({
      home: dir,
      owner: staleOwner,
      now: new Date(NOW.getTime() - STALE_AFTER_MS - 1000),
      staleAfterMs: STALE_AFTER_MS,
    });

    const result = acquireGateLease({
      home: dir,
      owner: owner({
        comboId: "o-r-8",
        branch: "combo/issue-8",
        worktree: "/repo/.worktrees/issue-8",
        runDir: "/home/.combo-chen/runs/o-r-8",
        headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
      now: NOW,
      staleAfterMs: STALE_AFTER_MS,
    });

    expect(result.state).toBe("recovered");
    if (result.state !== "recovered") throw new Error(`expected recovered lease, got ${result.state}`);
    expect(result.staleLease).toMatchObject({
      comboId: "o-r-7",
      branch: "combo/issue-7",
    });
    expect(result.lease).toMatchObject({
      comboId: "o-r-8",
      branch: "combo/issue-8",
      acquiredAt: NOW.toISOString(),
    });
    expect(readGateLease(dir)).toEqual(result.lease);
  });

  it("reports a same-branch conflict separately from a queued busy lease", () => {
    const dir = home();
    const first = acquireGateLease({
      home: dir,
      owner: owner(),
      now: NOW,
      staleAfterMs: STALE_AFTER_MS,
    });

    const second = acquireGateLease({
      home: dir,
      owner: owner({
        comboId: "other-owner",
        worktree: "/repo/.worktrees/other",
        runDir: "/home/.combo-chen/runs/other-owner",
      }),
      now: new Date(NOW.getTime() + 60_000),
      staleAfterMs: STALE_AFTER_MS,
    });

    expect(second.state).toBe("same_branch_conflict");
    expect(second.lease).toEqual(first.lease);
    expect(readGateLease(dir)).toEqual(first.lease);
  });
});
// -/ 1/1
