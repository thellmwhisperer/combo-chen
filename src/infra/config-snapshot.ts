/**
 * @overview Per-run config snapshot persistence. ~35 lines, 3 exports,
 *   writes and reads the resolved ComboConfig artifact used by a combo.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at writeConfigSnapshot  <- persists launch-time config.
 *   2. Then readConfigSnapshot       <- loads the frozen run artifact.
 *
 *   MAIN FLOW
 *   ---------
 *   cli/main.ts run -> writeConfigSnapshot -> later commands readConfigSnapshot
 *
 *   PUBLIC API
 *   ----------
 *   CONFIG_SNAPSHOT_FILE  Stable artifact filename in each run directory.
 *   writeConfigSnapshot   Write resolved ComboConfig as formatted JSON.
 *   readConfigSnapshot    Read resolved ComboConfig from the run directory.
 *
 *   INTERNALS
 *   ---------
 *   none
 *
 * @exports CONFIG_SNAPSHOT_FILE, writeConfigSnapshot, readConfigSnapshot
 * @deps node:{fs,path}, ./config
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ComboConfig } from "./config.js";

// -- 1/1 CORE · config snapshot artifact <- START HERE --
export const CONFIG_SNAPSHOT_FILE = "config.snapshot.json";

export function writeConfigSnapshot(runDir: string, config: ComboConfig): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, CONFIG_SNAPSHOT_FILE), `${JSON.stringify(config, null, 2)}\n`);
}

export function readConfigSnapshot(runDir: string): ComboConfig {
  return JSON.parse(readFileSync(join(runDir, CONFIG_SNAPSHOT_FILE), "utf8")) as ComboConfig;
}
// -/ 1/1
