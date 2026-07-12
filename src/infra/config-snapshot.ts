/**
 * @overview Per-run config snapshot persistence. ~110 lines, 5 exports,
 *   writes, reads, migrates, and resolves the frozen ComboConfig artifact used by a combo.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at writeConfigSnapshot  <- persists launch-time config.
 *   2. Then loadRuntimeConfig        <- prefers the frozen artifact for runtime commands.
 *   3. Then readConfigSnapshot       <- loads the frozen run artifact (engine-migrated).
 *   4. Then migrateConfigSnapshotEngine <- rewrites a legacy artifact to the capsule engine.
 *
 *   MAIN FLOW
 *   ---------
 *   cli/main.ts run -> writeConfigSnapshot -> later commands loadRuntimeConfig
 *
 *   PUBLIC API
 *   ----------
 *   CONFIG_SNAPSHOT_FILE  Stable artifact filename in each run directory.
 *   CONFIG_SNAPSHOT_SCHEMA_VERSION  Snapshot schema version; legacy reads are stamped on read.
 *   ConfigSnapshot        ComboConfig plus its stamped schemaVersion.
 *   writeConfigSnapshot   Write resolved ComboConfig as formatted JSON.
 *   readConfigSnapshot    Read resolved ComboConfig from the run directory.
 *   migrateConfigSnapshotEngine  Deterministically rewrite a legacy engine to capsule.
 *   loadRuntimeConfig     Read the snapshot, falling back for legacy runs only.
 *
 *   INTERNALS
 *   ---------
 *   migratedRunEngine  Legacy (v0/missing) engines migrate to capsule; unknown engines fail closed.
 *
 * @exports CONFIG_SNAPSHOT_FILE, CONFIG_SNAPSHOT_SCHEMA_VERSION, ConfigSnapshot, writeConfigSnapshot, readConfigSnapshot, migrateConfigSnapshotEngine, loadRuntimeConfig
 * @deps node:{fs,path,process}, ./config
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pid } from "node:process";

import { DEFAULT_REVIEW_SETTINGS, loadConfig, type ComboConfig } from "./config.js";

// -- 1/1 CORE · config snapshot artifact <- START HERE --
export const CONFIG_SNAPSHOT_FILE = "config.snapshot.json";

/** Contract artifact schema version; absent on legacy snapshots, which are stamped on read. */
export const CONFIG_SNAPSHOT_SCHEMA_VERSION = 1;

export interface ConfigSnapshot extends ComboConfig {
  schemaVersion: number;
}

export function writeConfigSnapshot(runDir: string, config: ComboConfig & { schemaVersion?: number }): void {
  mkdirSync(runDir, { recursive: true });
  const snapshotPath = join(runDir, CONFIG_SNAPSHOT_FILE);
  const tempPath = `${snapshotPath}.tmp-${pid}-${Date.now()}`;
  // A snapshot is frozen at launch: re-persisting keeps its original version.
  const { schemaVersion, ...rest } = config;
  const snapshot: ConfigSnapshot = {
    schemaVersion: schemaVersion ?? CONFIG_SNAPSHOT_SCHEMA_VERSION,
    ...rest,
  };
  try {
    writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    renameSync(tempPath, snapshotPath);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

/**
 * Deterministic engine migration for frozen artifacts: the retired v0 shell
 * engine (and pre-engine snapshots that carry no runEngine at all) resolve
 * as the capsule engine. Any other value is from a future or unknown version
 * and fails closed instead of half-launching.
 */
function migratedRunEngine(runDir: string, engine: unknown): "capsule" {
  if (engine === undefined || engine === "v0" || engine === "capsule") return "capsule";
  throw new Error(
    `${join(runDir, CONFIG_SNAPSHOT_FILE)}: frozen run engine ${JSON.stringify(engine)} is not supported ` +
      `by this combo-chen version; expected "capsule" (v0 snapshots migrate automatically)`,
  );
}

export function readConfigSnapshot(runDir: string): ConfigSnapshot {
  const parsed = JSON.parse(readFileSync(join(runDir, CONFIG_SNAPSHOT_FILE), "utf8")) as ComboConfig & {
    schemaVersion?: number;
  };
  // Pre-W5b snapshots predate the [review] loop bounds; missing fields read
  // as the documented defaults so an older frozen run never loses the round
  // cap or the agent turn timeouts (undefined would disable both).
  return {
    ...parsed,
    schemaVersion: parsed.schemaVersion ?? CONFIG_SNAPSHOT_SCHEMA_VERSION,
    runEngine: migratedRunEngine(runDir, parsed.runEngine),
    reviewMaxRounds: parsed.reviewMaxRounds ?? DEFAULT_REVIEW_SETTINGS.maxRounds,
    reviewerTurnTimeoutMinutes:
      parsed.reviewerTurnTimeoutMinutes ?? DEFAULT_REVIEW_SETTINGS.reviewerTurnTimeoutMinutes,
    fixTurnTimeoutMinutes: parsed.fixTurnTimeoutMinutes ?? DEFAULT_REVIEW_SETTINGS.fixTurnTimeoutMinutes,
    reviewVerdictWaitMs: parsed.reviewVerdictWaitMs ?? DEFAULT_REVIEW_SETTINGS.verdictWaitMs,
  };
}

/**
 * Rewrite a frozen legacy-engine artifact (v0 or missing runEngine) to the
 * capsule engine, preserving every other frozen field including the schema
 * version. Returns true when the artifact changed. Unknown engines fail
 * closed with the same explicit incompatibility error as the read path.
 */
export function migrateConfigSnapshotEngine(runDir: string): boolean {
  if (!existsSync(join(runDir, CONFIG_SNAPSHOT_FILE))) return false;
  const parsed = JSON.parse(readFileSync(join(runDir, CONFIG_SNAPSHOT_FILE), "utf8")) as ComboConfig & {
    schemaVersion?: number;
  };
  migratedRunEngine(runDir, parsed.runEngine);
  if (parsed.runEngine === "capsule") return false;
  writeConfigSnapshot(runDir, { ...parsed, runEngine: "capsule" });
  return true;
}

export function loadRuntimeConfig(
  runDir: string,
  fallback: { repoDir: string; env?: Record<string, string | undefined> },
): ComboConfig {
  if (existsSync(join(runDir, CONFIG_SNAPSHOT_FILE))) {
    return readConfigSnapshot(runDir);
  }
  return loadConfig(fallback);
}
// -/ 1/1
