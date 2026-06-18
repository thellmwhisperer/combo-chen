/**
 * @overview Per-run config snapshot persistence. ~65 lines, 4 exports,
 *   writes, reads, and resolves the frozen ComboConfig artifact used by a combo.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at writeConfigSnapshot  <- persists launch-time config.
 *   2. Then loadRuntimeConfig        <- prefers the frozen artifact for runtime commands.
 *   3. Then readConfigSnapshot       <- loads the frozen run artifact.
 *
 *   MAIN FLOW
 *   ---------
 *   cli/main.ts run -> writeConfigSnapshot -> later commands loadRuntimeConfig
 *
 *   PUBLIC API
 *   ----------
 *   CONFIG_SNAPSHOT_FILE  Stable artifact filename in each run directory.
 *   writeConfigSnapshot   Write resolved ComboConfig as formatted JSON.
 *   readConfigSnapshot    Read resolved ComboConfig from the run directory.
 *   loadRuntimeConfig     Read the snapshot, falling back for legacy runs only.
 *
 *   INTERNALS
 *   ---------
 *   none
 *
 * @exports CONFIG_SNAPSHOT_FILE, writeConfigSnapshot, readConfigSnapshot, loadRuntimeConfig
 * @deps node:{fs,path,process}, ./config
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pid } from "node:process";

import { loadConfig, type ComboConfig } from "./config.js";

// -- 1/1 CORE · config snapshot artifact <- START HERE --
export const CONFIG_SNAPSHOT_FILE = "config.snapshot.json";

export function writeConfigSnapshot(runDir: string, config: ComboConfig): void {
  mkdirSync(runDir, { recursive: true });
  const snapshotPath = join(runDir, CONFIG_SNAPSHOT_FILE);
  const tempPath = `${snapshotPath}.tmp-${pid}-${Date.now()}`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`);
    renameSync(tempPath, snapshotPath);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

export function readConfigSnapshot(runDir: string): ComboConfig {
  return JSON.parse(readFileSync(join(runDir, CONFIG_SNAPSHOT_FILE), "utf8")) as ComboConfig;
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
