/**
 * @overview Shared no-mistakes gate lease persistence.
 *   Models one global gate owner so parallel combos can serialize gate work.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at acquireGateLease <- atomic acquisition and stale recovery.
 *   2. Then readGateLease        <- status/dashboard-facing visibility.
 *
 *   MAIN FLOW
 *   ---------
 *   combo gate owner -> acquireGateLease -> gate-lease.lock/lease.json
 *
 *   PUBLIC API
 *   ----------
 *   GateLeaseOwner, GateLeaseRecord, GateLeaseAcquireResult, GateLeaseReleaseResult
 *   DEFAULT_GATE_LEASE_STALE_MS, gateLeaseDir, readGateLease, acquireGateLease, releaseGateLease
 *
 * @exports GateLeaseOwner, GateLeaseRecord, GateLeaseAcquireResult, GateLeaseReleaseResult, DEFAULT_GATE_LEASE_STALE_MS, gateLeaseDir, readGateLease, acquireGateLease, releaseGateLease
 * @deps node:{fs,path}
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// -- 1/2 HELPER · types and paths --
export interface GateLeaseOwner {
  comboId: string;
  branch: string;
  worktree: string;
  runDir?: string;
  headSha?: string;
}

export interface GateLeaseRecord extends GateLeaseOwner {
  acquiredAt: string;
  heartbeatAt: string;
}

export type GateLeaseAcquireResult =
  | { state: "acquired"; lease: GateLeaseRecord }
  | { state: "busy"; lease: GateLeaseRecord }
  | { state: "recovered"; lease: GateLeaseRecord; staleLease: GateLeaseRecord }
  | { state: "same_branch_conflict"; lease: GateLeaseRecord };

export type GateLeaseReleaseResult =
  | { state: "released" }
  | { state: "missing" }
  | { state: "not_owner"; lease: GateLeaseRecord };

export const DEFAULT_GATE_LEASE_STALE_MS = 30 * 60 * 1000;

const GATE_LEASE_DIR = "gate-lease.lock";
const GATE_LEASE_RECORD = "lease.json";

export function gateLeaseDir(home: string): string {
  return join(home, GATE_LEASE_DIR);
}

function gateLeaseRecordPath(home: string): string {
  return join(gateLeaseDir(home), GATE_LEASE_RECORD);
}

function leaseRecord(owner: GateLeaseOwner, now: Date): GateLeaseRecord {
  const timestamp = now.toISOString();
  return {
    comboId: owner.comboId,
    branch: owner.branch,
    worktree: owner.worktree,
    ...(owner.runDir !== undefined ? { runDir: owner.runDir } : {}),
    ...(owner.headSha !== undefined ? { headSha: owner.headSha } : {}),
    acquiredAt: timestamp,
    heartbeatAt: timestamp,
  };
}
// -/ 1/2

// -- 2/2 CORE · read and acquire gate leases <- START HERE --
export function readGateLease(home: string): GateLeaseRecord | undefined {
  const path = gateLeaseRecordPath(home);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as GateLeaseRecord;
}

export function acquireGateLease(options: {
  home: string;
  owner: GateLeaseOwner;
  now?: Date;
  staleAfterMs?: number;
}): GateLeaseAcquireResult {
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_GATE_LEASE_STALE_MS;
  const leaseDir = gateLeaseDir(options.home);

  while (true) {
    mkdirSync(options.home, { recursive: true });
    try {
      mkdirSync(leaseDir);
      const lease = leaseRecord(options.owner, now);
      writeFileSync(gateLeaseRecordPath(options.home), `${JSON.stringify(lease, null, 2)}\n`);
      return { state: "acquired", lease };
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
      const current = readGateLease(options.home);
      if (current === undefined) throw error;

      if (isStaleLease(current, now, staleAfterMs)) {
        rmSync(leaseDir, { recursive: true, force: true });
        const recovered = leaseRecord(options.owner, now);
        try {
          mkdirSync(leaseDir);
          writeFileSync(gateLeaseRecordPath(options.home), `${JSON.stringify(recovered, null, 2)}\n`);
          return { state: "recovered", lease: recovered, staleLease: current };
        } catch (retryError) {
          if (isErrnoException(retryError) && retryError.code === "EEXIST") continue;
          throw retryError;
        }
      }

      if (current.comboId === options.owner.comboId) return { state: "acquired", lease: current };
      if (current.branch === options.owner.branch) return { state: "same_branch_conflict", lease: current };
      return { state: "busy", lease: current };
    }
  }
}

export function releaseGateLease(options: {
  home: string;
  owner: Pick<GateLeaseOwner, "comboId">;
}): GateLeaseReleaseResult {
  const current = readGateLease(options.home);
  if (current === undefined) return { state: "missing" };
  if (current.comboId !== options.owner.comboId) return { state: "not_owner", lease: current };
  rmSync(gateLeaseDir(options.home), { recursive: true, force: true });
  return { state: "released" };
}

function isStaleLease(lease: GateLeaseRecord, now: Date, staleAfterMs: number): boolean {
  const heartbeatMs = Date.parse(lease.heartbeatAt);
  if (!Number.isFinite(heartbeatMs)) return false;
  return now.getTime() - heartbeatMs > staleAfterMs;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
// -/ 2/2
