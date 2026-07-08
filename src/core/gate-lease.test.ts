/**
 * @overview Unit tests for the branch-scoped no-mistakes gate lease contract.
 *   Covers free, parallel-branch, stale, same-branch, and release lease states.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at describe("gate lease") <- pins the lease state machine.
 *
 *   MAIN FLOW
 *   ---------
 *   combo gate owner -> acquireGateLease -> branch-scoped persisted lease or conflict state
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
  heartbeatGateLease,
  releaseGateLease,
  readGateLease,
  readGateLeases,
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

  it("allows a different active branch to acquire its own lease", () => {
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

    expect(second.state).toBe("acquired");
    expect(second.lease).toMatchObject({
      comboId: "o-r-8",
      branch: "combo/issue-8",
    });
    expect(
      readGateLeases(dir)
        .map((lease) => lease.comboId)
        .sort(),
    ).toEqual(["o-r-7", "o-r-8"]);
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
      branch: "combo/issue-7",
      acquiredAt: NOW.toISOString(),
    });
    expect(readGateLease(dir)).toEqual(result.lease);
  });

  it("reports a same-branch conflict without replacing the owner", () => {
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

  it("releases only the current owning combo lease", () => {
    const dir = home();
    const currentOwner = owner();
    const acquired = acquireGateLease({
      home: dir,
      owner: currentOwner,
      now: NOW,
      staleAfterMs: STALE_AFTER_MS,
    });

    expect(
      releaseGateLease({
        home: dir,
        owner: owner({
          comboId: "o-r-8",
          branch: "combo/issue-8",
          worktree: "/repo/.worktrees/issue-8",
        }),
      }),
    ).toEqual({ state: "not_owner", lease: acquired.lease });
    expect(readGateLease(dir)).toEqual(acquired.lease);

    expect(releaseGateLease({ home: dir, owner: currentOwner })).toEqual({ state: "released" });
    expect(readGateLease(dir)).toBeUndefined();
    expect(releaseGateLease({ home: dir, owner: currentOwner })).toEqual({ state: "missing" });
  });

  it("releases only one branch lease while other branch leases remain active", () => {
    const dir = home();
    const firstOwner = owner();
    const secondOwner = owner({
      comboId: "o-r-8",
      branch: "combo/issue-8",
      worktree: "/repo/.worktrees/issue-8",
    });
    acquireGateLease({
      home: dir,
      owner: firstOwner,
      now: NOW,
      staleAfterMs: STALE_AFTER_MS,
    });
    acquireGateLease({
      home: dir,
      owner: secondOwner,
      now: new Date(NOW.getTime() + 60_000),
      staleAfterMs: STALE_AFTER_MS,
    });

    expect(releaseGateLease({ home: dir, owner: firstOwner })).toEqual({ state: "released" });

    expect(readGateLeases(dir).map((lease) => lease.comboId)).toEqual(["o-r-8"]);
    expect(readGateLease(dir)?.comboId).toBe("o-r-8");
  });

  it("updates heartbeatAt for the owning combo", () => {
    const dir = home();
    acquireGateLease({
      home: dir,
      owner: owner(),
      now: NOW,
      staleAfterMs: STALE_AFTER_MS,
    });

    const later = new Date(NOW.getTime() + 600_000);
    const result = heartbeatGateLease({
      home: dir,
      owner: { comboId: "o-r-7" },
      now: later,
    });

    expect(result).toEqual({ state: "ok" });
    const lease = readGateLease(dir);
    expect(lease?.heartbeatAt).toBe(later.toISOString());
    expect(lease?.acquiredAt).toBe(NOW.toISOString());
  });

  it("refuses heartbeat for a missing lease", () => {
    const result = heartbeatGateLease({
      home: home(),
      owner: { comboId: "o-r-7" },
    });

    expect(result).toEqual({ state: "missing" });
  });

  it("refuses heartbeat for a non-owning combo", () => {
    const dir = home();
    acquireGateLease({
      home: dir,
      owner: owner(),
      now: NOW,
      staleAfterMs: STALE_AFTER_MS,
    });

    const result = heartbeatGateLease({
      home: dir,
      owner: { comboId: "o-r-8" },
      now: NOW,
    });

    expect(result.state).toBe("not_owner");
    if (result.state !== "not_owner") throw new Error("expected not_owner");
    expect(result.lease.comboId).toBe("o-r-7");
  });

  it("heartbeat prevents a lease from being seen as stale", () => {
    const dir = home();
    const justBeforeStale = new Date(NOW.getTime() - STALE_AFTER_MS + 60_000);
    acquireGateLease({
      home: dir,
      owner: owner(),
      now: justBeforeStale,
      staleAfterMs: STALE_AFTER_MS,
    });

    const later = new Date(justBeforeStale.getTime() + 30_000);
    heartbeatGateLease({
      home: dir,
      owner: { comboId: "o-r-7" },
      now: later,
    });

    const atStaleWindow = new Date(justBeforeStale.getTime() + STALE_AFTER_MS);
    const result = acquireGateLease({
      home: dir,
      owner: owner({
        comboId: "o-r-8",
      }),
      now: atStaleWindow,
      staleAfterMs: STALE_AFTER_MS,
    });

    expect(result.state).toBe("same_branch_conflict");
  });
});
// -/ 1/1
