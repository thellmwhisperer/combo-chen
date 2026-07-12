/**
 * @overview Unit tests for per-run config snapshot artifacts. ~100 lines,
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
import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "./config.js";
import {
  CONFIG_SNAPSHOT_FILE,
  loadRuntimeConfig,
  migrateConfigSnapshotEngine,
  readConfigSnapshot,
  writeConfigSnapshot,
} from "./config-snapshot.js";

// -- 1/1 CORE · config snapshots <- START HERE --
describe("config snapshots", () => {
  it("persists the resolved launch config as auditable JSON", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const runDir = mkdtempSync(join(tmpdir(), "combo-chen-run-"));
    const config = loadConfig({ repoDir, userConfigPath: join(repoDir, "missing.toml"), env: {} });

    writeConfigSnapshot(runDir, config);

    expect(JSON.parse(readFileSync(join(runDir, CONFIG_SNAPSHOT_FILE), "utf8"))).toEqual({
      schemaVersion: 1,
      ...config,
    });
    expect(readConfigSnapshot(runDir)).toEqual({ schemaVersion: 1, ...config });
  });

  it("stamps schema_version 1 on a legacy snapshot without one", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const runDir = mkdtempSync(join(tmpdir(), "combo-chen-run-"));
    const config = loadConfig({ repoDir, userConfigPath: join(repoDir, "missing.toml"), env: {} });
    writeFileSync(join(runDir, CONFIG_SNAPSHOT_FILE), `${JSON.stringify(config, null, 2)}\n`);

    expect(readConfigSnapshot(runDir).schemaVersion).toBe(1);
  });

  it("migrates a frozen v0 run engine to capsule on read", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const runDir = mkdtempSync(join(tmpdir(), "combo-chen-run-"));
    const config = loadConfig({ repoDir, userConfigPath: join(repoDir, "missing.toml"), env: {} });
    writeFileSync(
      join(runDir, CONFIG_SNAPSHOT_FILE),
      `${JSON.stringify({ ...config, runEngine: "v0" }, null, 2)}\n`,
    );

    expect(readConfigSnapshot(runDir).runEngine).toBe("capsule");
  });

  it("migrates a frozen snapshot without a run engine to capsule on read", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const runDir = mkdtempSync(join(tmpdir(), "combo-chen-run-"));
    const { runEngine: _engine, ...preEngine } = loadConfig({
      repoDir,
      userConfigPath: join(repoDir, "missing.toml"),
      env: {},
    });
    writeFileSync(join(runDir, CONFIG_SNAPSHOT_FILE), `${JSON.stringify(preEngine, null, 2)}\n`);

    expect(readConfigSnapshot(runDir).runEngine).toBe("capsule");
  });

  it("fails closed on an unknown frozen run engine", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const runDir = mkdtempSync(join(tmpdir(), "combo-chen-run-"));
    const config = loadConfig({ repoDir, userConfigPath: join(repoDir, "missing.toml"), env: {} });
    writeFileSync(
      join(runDir, CONFIG_SNAPSHOT_FILE),
      `${JSON.stringify({ ...config, runEngine: "v2-future" }, null, 2)}\n`,
    );

    expect(() => readConfigSnapshot(runDir)).toThrow(/run engine "v2-future" is not supported/);
    expect(() => migrateConfigSnapshotEngine(runDir)).toThrow(/run engine "v2-future" is not supported/);
  });

  it("rewrites a frozen v0 artifact to capsule and preserves its schema version", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const runDir = mkdtempSync(join(tmpdir(), "combo-chen-run-"));
    const config = loadConfig({ repoDir, userConfigPath: join(repoDir, "missing.toml"), env: {} });
    writeFileSync(
      join(runDir, CONFIG_SNAPSHOT_FILE),
      `${JSON.stringify({ ...config, schemaVersion: 2, runEngine: "v0" }, null, 2)}\n`,
    );

    expect(migrateConfigSnapshotEngine(runDir)).toBe(true);

    const raw = JSON.parse(readFileSync(join(runDir, CONFIG_SNAPSHOT_FILE), "utf8")) as {
      runEngine?: string;
      schemaVersion?: number;
    };
    expect(raw.runEngine).toBe("capsule");
    expect(raw.schemaVersion).toBe(2);
  });

  it("does not rewrite an already-capsule artifact or a missing snapshot", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const runDir = mkdtempSync(join(tmpdir(), "combo-chen-run-"));
    const emptyRunDir = mkdtempSync(join(tmpdir(), "combo-chen-run-"));
    const config = loadConfig({ repoDir, userConfigPath: join(repoDir, "missing.toml"), env: {} });
    writeConfigSnapshot(runDir, config);
    const frozen = readFileSync(join(runDir, CONFIG_SNAPSHOT_FILE), "utf8");

    expect(migrateConfigSnapshotEngine(runDir)).toBe(false);
    expect(readFileSync(join(runDir, CONFIG_SNAPSHOT_FILE), "utf8")).toBe(frozen);
    expect(migrateConfigSnapshotEngine(emptyRunDir)).toBe(false);
  });

  it("backfills review settings missing from pre-W5b snapshots with the documented defaults", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const runDir = mkdtempSync(join(tmpdir(), "combo-chen-run-"));
    const {
      reviewMaxRounds: _rounds,
      reviewerTurnTimeoutMinutes: _reviewerTimeout,
      fixTurnTimeoutMinutes: _fixTimeout,
      reviewVerdictWaitMs: _wait,
      ...preW5b
    } = loadConfig({ repoDir, userConfigPath: join(repoDir, "missing.toml"), env: {} });
    writeFileSync(
      join(runDir, CONFIG_SNAPSHOT_FILE),
      `${JSON.stringify({ schemaVersion: 1, ...preW5b }, null, 2)}\n`,
    );

    const snapshot = readConfigSnapshot(runDir);
    // A frozen pre-W5b run must never lose the review loop's bounds: the
    // round cap and turn timeouts read as the documented defaults.
    expect(snapshot.reviewMaxRounds).toBe(3);
    expect(snapshot.reviewerTurnTimeoutMinutes).toBe(60);
    expect(snapshot.fixTurnTimeoutMinutes).toBe(120);
    expect(snapshot.reviewVerdictWaitMs).toBe(5000);
  });

  it("preserves the frozen snapshot schema_version when re-persisting", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const runDir = mkdtempSync(join(tmpdir(), "combo-chen-run-"));
    const config = loadConfig({ repoDir, userConfigPath: join(repoDir, "missing.toml"), env: {} });

    writeConfigSnapshot(runDir, { ...config, schemaVersion: 2 });

    expect(readConfigSnapshot(runDir).schemaVersion).toBe(2);
  });

  it("writes through a same-directory temp file before renaming into place", async () => {
    vi.resetModules();
    const writes: string[] = [];
    const renames: Array<[string, string]> = [];
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        writeFileSync: vi.fn((...args: Parameters<typeof actual.writeFileSync>) => {
          writes.push(String(args[0]));
          return actual.writeFileSync(...args);
        }),
        renameSync: vi.fn((...args: Parameters<typeof actual.renameSync>) => {
          renames.push([String(args[0]), String(args[1])]);
          return actual.renameSync(...args);
        }),
      };
    });

    try {
      const snapshot = await import("./config-snapshot.js");
      const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
      const runDir = mkdtempSync(join(tmpdir(), "combo-chen-run-"));
      const config = loadConfig({ repoDir, userConfigPath: join(repoDir, "missing.toml"), env: {} });
      const snapshotPath = join(runDir, snapshot.CONFIG_SNAPSHOT_FILE);

      snapshot.writeConfigSnapshot(runDir, config);

      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatch(new RegExp(`^${snapshotPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.tmp-`));
      expect(renames).toEqual([[writes[0]!, snapshotPath]]);
      expect(snapshot.readConfigSnapshot(runDir)).toEqual({ schemaVersion: 1, ...config });
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
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
