/**
 * @overview Unit tests for the passive update CLI cache adapter and command hook policy.
 *   ~120 lines, no exports, pins local cache JSON behavior outside the pure core.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at passive cache tests <- filesystem adapter contract.
 *   2. Then command policy tests    <- which CLI actions get quiet checks.
 *
 *   MAIN FLOW
 *   ---------
 *   combo home + cache JSON -> adapter -> checkPassiveUpdate-compatible cache boundary
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   entry.
 *
 * @exports none
 * @deps ./passive, node:fs, node:os, node:path, vitest
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PASSIVE_UPDATE_LOOKUP_TIMEOUT_MS,
  PASSIVE_UPDATE_CACHE_FILE,
  PASSIVE_UPDATE_LOOKUP_TIMEOUT_ENV,
  defaultPassiveUpdateCommandDeps,
  passiveUpdateCachePath,
  readPassiveUpdateCache,
  runPassiveUpdateCheck,
  shouldRunPassiveUpdateForCommand,
  writePassiveUpdateCache,
  type PassiveUpdateCliCacheEntry,
} from "./passive.js";

// -- 1/1 CORE · passive update CLI adapter <- START HERE --
function entry(): PassiveUpdateCliCacheEntry {
  return {
    schemaVersion: 1,
    checkedAt: "2026-06-25T12:00:00.000Z",
    mode: "stable",
    planStatus: "update_available",
    currentVersion: "1.0.0",
    latestTagName: "v1.1.0",
    latestVersion: "1.1.0",
    updateAvailable: true,
  };
}

describe("passive update CLI cache", () => {
  it("stores the passive update cache directly under combo home", () => {
    expect(passiveUpdateCachePath("/home/javi/.combo-chen")).toBe(
      join("/home/javi/.combo-chen", PASSIVE_UPDATE_CACHE_FILE),
    );
  });

  it("writes and reads a validated local cache entry", () => {
    const root = mkdtempSync(join(tmpdir(), "combo-chen-passive-cache-"));
    const path = passiveUpdateCachePath(join(root, "nested-home"));
    const cacheEntry = entry();

    writePassiveUpdateCache(path, cacheEntry);

    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(cacheEntry);
    expect(readPassiveUpdateCache(path)).toEqual(cacheEntry);
  });

  it("treats malformed or wrong-shape cache files as misses", () => {
    const root = mkdtempSync(join(tmpdir(), "combo-chen-passive-cache-"));
    const path = passiveUpdateCachePath(root);

    writeFileSync(path, "{not json");
    expect(readPassiveUpdateCache(path)).toBeUndefined();

    writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, checkedAt: 42 })}\n`);
    expect(readPassiveUpdateCache(path)).toBeUndefined();
  });

  it("passes a bounded timeout to passive cache-miss release lookups", async () => {
    const calls: unknown[] = [];
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });

    const result = await runPassiveUpdateCheck({
      env: {},
      current: { version: "1.0.0", commit: "abc1234", date: "2026-06-25T12:00:00.000Z" },
      cachePath: "/combo/passive-update-cache.json",
      lookupTimeoutMs: 1234,
      readFile: () => {
        throw missing;
      },
      writeFile: () => {},
      mkdir: () => {},
      gh: (args, options) => {
        calls.push({ args, options });
        return { status: 1, stdout: "", stderr: "timed out" };
      },
    });

    expect(result).toMatchObject({
      status: "lookup_failed",
      quiet: true,
      reason: "gh release query failed: timed out",
    });
    expect(calls).toEqual([
      {
        args: ["api", "repos/thellmwhisperer/combo-chen/releases?per_page=100"],
        options: { timeoutMs: 1234 },
      },
    ]);
  });

  it("loads the passive lookup timeout from env with the default fallback", () => {
    const configured = defaultPassiveUpdateCommandDeps({
      env: { [PASSIVE_UPDATE_LOOKUP_TIMEOUT_ENV]: "2500" },
      gh: () => ({ status: 0, stdout: "[]", stderr: "" }),
    });
    const fallback = defaultPassiveUpdateCommandDeps({
      env: { [PASSIVE_UPDATE_LOOKUP_TIMEOUT_ENV]: "0" },
      gh: () => ({ status: 0, stdout: "[]", stderr: "" }),
    });

    expect(configured.lookupTimeoutMs).toBe(2500);
    expect(fallback.lookupTimeoutMs).toBe(DEFAULT_PASSIVE_UPDATE_LOOKUP_TIMEOUT_MS);
  });
});

describe("passive update command policy", () => {
  it("runs for public inspection commands but skips active update and generated worker commands", () => {
    expect(shouldRunPassiveUpdateForCommand("status")).toBe(true);
    expect(shouldRunPassiveUpdateForCommand("events")).toBe(true);
    expect(shouldRunPassiveUpdateForCommand("update")).toBe(false);
    expect(shouldRunPassiveUpdateForCommand("emit")).toBe(false);
    expect(shouldRunPassiveUpdateForCommand("director-watch")).toBe(false);
  });
});
// -/ 1/1
