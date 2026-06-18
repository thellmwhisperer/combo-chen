/**
 * @overview Unit tests for per-run config snapshot artifacts. ~70 lines,
 *   testing JSON persistence and runtime snapshot preference.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at describe("config snapshots") <- artifact and runtime contract.
 *   2. Test helpers are inline               <- tiny tmpdir setup.
 *
 *   MAIN FLOW
 *   ---------
 *   loadConfig -> writeConfigSnapshot -> loadRuntimeConfig -> frozen config
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
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";
import { CONFIG_SNAPSHOT_FILE, loadRuntimeConfig, readConfigSnapshot, writeConfigSnapshot } from "./config-snapshot.js";

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

  it("prefers the frozen run config over later repo TOML changes", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const runDir = mkdtempSync(join(tmpdir(), "combo-chen-run-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      '[limits]\nbabysit_poll_seconds = 5\n\n[reviewer.claude]\ncommand = "claude-launch {prompt}"\n',
    );
    const config = loadConfig({ repoDir, userConfigPath: join(repoDir, "missing.toml"), env: {} });

    writeConfigSnapshot(runDir, config);
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      '[limits]\nbabysit_poll_seconds = 999\n\n[reviewer.claude]\ncommand = "claude-mutated {prompt}"\n',
    );

    expect(loadRuntimeConfig(runDir, { repoDir, env: {} })).toMatchObject({
      limits: { babysitPollSeconds: 5 },
      reviewerCommand: "claude-launch {prompt}",
    });
  });
});
// -/ 1/1
