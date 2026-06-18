/**
 * @overview Unit tests for per-run config snapshot artifacts. ~35 lines,
 *   testing JSON persistence for resolved ComboConfig values.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at describe("config snapshots") <- artifact round-trip contract.
 *   2. Test helpers are inline              <- tiny tmpdir setup.
 *
 *   MAIN FLOW
 *   ---------
 *   loadConfig -> writeConfigSnapshot -> readConfigSnapshot -> identical config
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   none
 *
 * @exports none
 * @deps vitest, node:{fs,os,path}, ./config, ./config-snapshot
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";
import { CONFIG_SNAPSHOT_FILE, readConfigSnapshot, writeConfigSnapshot } from "./config-snapshot.js";

// -- 1/1 CORE · config snapshots <- START HERE --
describe("config snapshots", () => {
  it("persists the resolved launch config as auditable JSON", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const runDir = mkdtempSync(join(tmpdir(), "combo-chen-run-"));
    const config = loadConfig({ repoDir, userConfigPath: join(repoDir, "missing.toml"), env: {} });

    writeConfigSnapshot(runDir, config);

    expect(JSON.parse(readFileSync(join(runDir, CONFIG_SNAPSHOT_FILE), "utf8"))).toEqual(config);
    expect(readConfigSnapshot(runDir)).toEqual(config);
  });
});
// -/ 1/1
