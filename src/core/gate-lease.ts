/**
 * @overview Shared no-mistakes gate lease persistence.
 *   Models one gate owner per branch so parallel combos do not serialize across
 *   independent no-mistakes runs.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at acquireGateLease  <- atomic branch acquisition and stale recovery.
 *   2. Then readGateLeases        <- status/dashboard-facing visibility.
 *
 *   MAIN FLOW
 *   ---------
 *   combo gate owner -> acquireGateLease -> gate-leases.lock/<branch>/lease.json
 *
 *   PUBLIC API
 *   ----------
 *   GateLeaseOwner, GateLeaseRecord, GateLeaseAcquireResult, GateLeaseReleaseResult
 *   DEFAULT_GATE_LEASE_STALE_MS, gateLeaseDir, readGateLease, readGateLeases, acquireGateLease, releaseGateLease
 *
 * @exports GateLeaseOwner, GateLeaseRecord, GateLeaseAcquireResult, GateLeaseReleaseResult, GateLeaseHeartbeatResult, DEFAULT_GATE_LEASE_STALE_MS, gateLeaseDir, readGateLease, readGateLeases, acquireGateLease, releaseGateLease, heartbeatGateLease
 * @deps node:{fs,path}
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const GATE_LEASE_DIR = "gate-leases.lock";
const LEGACY_GATE_LEASE_DIR = "gate-lease.lock";
const GATE_LEASE_RECORD = "lease.json";

export function gateLeaseDir(home: string, branch?: string): string {
  if (branch === undefined) return join(home, GATE_LEASE_DIR);
  return join(home, GATE_LEASE_DIR, encodeURIComponent(branch));
}

function legacyGateLeaseDir(home: string): string {
  return join(home, LEGACY_GATE_LEASE_DIR);
}

function gateLeaseRecordPath(home: string, branch: string): string {
  return join(gateLeaseDir(home, branch), GATE_LEASE_RECORD);
}

function legacyGateLeaseRecordPath(home: string): string {
  return join(legacyGateLeaseDir(home), GATE_LEASE_RECORD);
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

// -- 2/2 CORE · read and acquire branch leases <- START HERE --
interface GateLeaseEntry {
  lease: GateLeaseRecord;
  dir: string;
  path: string;
}

function readGateLeaseEntry(path: string, dir: string): GateLeaseEntry | undefined {
  if (!existsSync(path)) return undefined;
  return {
    lease: JSON.parse(readFileSync(path, "utf8")) as GateLeaseRecord,
    dir,
    path,
  };
}

function readGateLeaseEntries(home: string): GateLeaseEntry[] {
  const entries: GateLeaseEntry[] = [];
  const root = gateLeaseDir(home);
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      const lease = readGateLeaseEntry(join(dir, GATE_LEASE_RECORD), dir);
      if (lease !== undefined) entries.push(lease);
    }
  }

  const legacy = readGateLeaseEntry(legacyGateLeaseRecordPath(home), legacyGateLeaseDir(home));
  if (
    legacy !== undefined &&
    !entries.some(
      (entry) =>
        entry.lease.comboId === legacy.lease.comboId ||
        entry.lease.branch === legacy.lease.branch,
    )
  ) {
    entries.push(legacy);
  }

  return entries.sort((a, b) => {
    const acquired = Date.parse(a.lease.acquiredAt) - Date.parse(b.lease.acquiredAt);
    if (acquired !== 0) return acquired;
    return a.lease.comboId.localeCompare(b.lease.comboId);
  });
}

function readGateLeaseEntryForBranch(home: string, branch: string): GateLeaseEntry | undefined {
  const current = readGateLeaseEntry(gateLeaseRecordPath(home, branch), gateLeaseDir(home, branch));
  if (current !== undefined) return current;
  const legacy = readGateLeaseEntry(legacyGateLeaseRecordPath(home), legacyGateLeaseDir(home));
  return legacy?.lease.branch === branch ? legacy : undefined;
}

function readGateLeaseEntryForCombo(home: string, comboId: string): GateLeaseEntry | undefined {
  return readGateLeaseEntries(home).find((entry) => entry.lease.comboId === comboId);
}

export function readGateLeases(home: string): GateLeaseRecord[] {
  return readGateLeaseEntries(home).map((entry) => entry.lease);
}

export function readGateLease(home: string): GateLeaseRecord | undefined {
  return readGateLeases(home)[0];
}

export function acquireGateLease(options: {
  home: string;
  owner: GateLeaseOwner;
  now?: Date;
  staleAfterMs?: number;
}): GateLeaseAcquireResult {
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_GATE_LEASE_STALE_MS;
  const leaseDir = gateLeaseDir(options.home, options.owner.branch);
  const leasePath = gateLeaseRecordPath(options.home, options.owner.branch);

  while (true) {
    mkdirSync(options.home, { recursive: true });
    mkdirSync(gateLeaseDir(options.home), { recursive: true });

    const legacyCurrent = readGateLeaseEntryForBranch(options.home, options.owner.branch);
    if (legacyCurrent !== undefined && legacyCurrent.dir === legacyGateLeaseDir(options.home)) {
      if (isStaleLease(legacyCurrent.lease, now, staleAfterMs)) {
        rmSync(legacyCurrent.dir, { recursive: true, force: true });
      } else if (legacyCurrent.lease.comboId === options.owner.comboId) {
        return { state: "acquired", lease: legacyCurrent.lease };
      } else {
        return { state: "same_branch_conflict", lease: legacyCurrent.lease };
      }
    }

    try {
      mkdirSync(leaseDir);
      const lease = leaseRecord(options.owner, now);
      writeFileSync(leasePath, `${JSON.stringify(lease, null, 2)}\n`);
      return { state: "acquired", lease };
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
      const current = readGateLeaseEntryForBranch(options.home, options.owner.branch);
      if (current === undefined) throw error;

      if (isStaleLease(current.lease, now, staleAfterMs)) {
        rmSync(current.dir, { recursive: true, force: true });
        const recovered = leaseRecord(options.owner, now);
        try {
          mkdirSync(leaseDir);
          writeFileSync(leasePath, `${JSON.stringify(recovered, null, 2)}\n`);
          return { state: "recovered", lease: recovered, staleLease: current.lease };
        } catch (retryError) {
          if (isErrnoException(retryError) && retryError.code === "EEXIST") continue;
          throw retryError;
        }
      }

      if (current.lease.comboId === options.owner.comboId) return { state: "acquired", lease: current.lease };
      return { state: "same_branch_conflict", lease: current.lease };
    }
  }
}

export function releaseGateLease(options: {
  home: string;
  owner: Pick<GateLeaseOwner, "comboId">;
}): GateLeaseReleaseResult {
  const current = readGateLeaseEntryForCombo(options.home, options.owner.comboId);
  if (current !== undefined) {
    rmSync(current.dir, { recursive: true, force: true });
    return { state: "released" };
  }
  const active = readGateLease(options.home);
  if (active !== undefined) return { state: "not_owner", lease: active };
  return { state: "missing" };
}

function writeGateLeaseEntry(entry: GateLeaseEntry, lease: GateLeaseRecord): void {
  writeFileSync(entry.path, `${JSON.stringify(lease, null, 2)}\n`);
}

export type GateLeaseHeartbeatResult =
  | { state: "ok" }
  | { state: "missing" }
  | { state: "not_owner"; lease: GateLeaseRecord };

export function heartbeatGateLease(options: {
  home: string;
  owner: Pick<GateLeaseOwner, "comboId">;
  now?: Date;
}): GateLeaseHeartbeatResult {
  const current = readGateLeaseEntryForCombo(options.home, options.owner.comboId);
  if (current === undefined) {
    const active = readGateLease(options.home);
    if (active !== undefined) return { state: "not_owner", lease: active };
    return { state: "missing" };
  }
  const updated: GateLeaseRecord = {
    ...current.lease,
    heartbeatAt: (options.now ?? new Date()).toISOString(),
  };
  writeGateLeaseEntry(current, updated);
  return { state: "ok" };
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
