/**
 * @overview Unit tests for quiet passive update checks.
 *   ~220 lines, no exports, pins disable, cache TTL, refresh, and failure fallback behavior.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at checkPassiveUpdate tests <- passive cache/lookup contract.
 *   2. Helpers build tiny GitHub release fixtures for resolver reuse.
 *
 *   MAIN FLOW
 *   ---------
 *   mocked cache + mocked release lookup -> checkPassiveUpdate -> quiet cache/update/fallback result
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   current, release, cachedUpdate.
 *
 * @exports none
 * @deps vitest, ./passive-update, ./update-resolver
 */
import { describe, expect, it, vi } from "vitest";

import {
  checkPassiveUpdate,
  DEFAULT_PASSIVE_UPDATE_CACHE_TTL_MS,
  PASSIVE_UPDATE_DISABLE_ENV,
  type PassiveUpdateCacheEntry,
} from "./passive-update.js";
import type { GitHubReleaseMetadata } from "./update-resolver.js";

// -- 1/1 CORE · checkPassiveUpdate passive contract <- START HERE --
const current = {
  version: "1.0.0",
  commit: "abc1234",
  date: "2026-06-25T09:00:00.000Z",
};

function release(tagName: string, prerelease = false): GitHubReleaseMetadata {
  return {
    tagName,
    prerelease,
    name: tagName,
    publishedAt: "2026-06-25T10:00:00.000Z",
    assets: [],
  };
}

function cachedUpdate(checkedAt: string): PassiveUpdateCacheEntry {
  return {
    schemaVersion: 1,
    checkedAt,
    mode: "stable",
    planStatus: "update_available",
    currentVersion: "1.0.0",
    latestTagName: "v1.1.0",
    latestVersion: "1.1.0",
    updateAvailable: true,
  };
}

describe("checkPassiveUpdate", () => {
  it("fully disables passive lookups when the env knob is set", async () => {
    const readCache = vi.fn();
    const writeCache = vi.fn();
    const fetchReleases = vi.fn();

    const result = await checkPassiveUpdate({
      env: { [PASSIVE_UPDATE_DISABLE_ENV]: "1" },
      current,
      now: new Date("2026-06-25T12:00:00.000Z"),
      readCache,
      writeCache,
      fetchReleases,
    });

    expect(result).toMatchObject({ status: "disabled", quiet: true });
    expect(readCache).not.toHaveBeenCalled();
    expect(fetchReleases).not.toHaveBeenCalled();
    expect(writeCache).not.toHaveBeenCalled();
  });

  it("uses a fresh cache entry without touching the release lookup", async () => {
    const readCache = vi.fn(() => cachedUpdate("2026-06-25T10:00:00.000Z"));
    const writeCache = vi.fn();
    const fetchReleases = vi.fn();

    const result = await checkPassiveUpdate({
      current,
      now: new Date("2026-06-25T12:00:00.000Z"),
      ttlMs: DEFAULT_PASSIVE_UPDATE_CACHE_TTL_MS,
      readCache,
      writeCache,
      fetchReleases,
    });

    expect(result).toMatchObject({
      status: "cache_hit",
      quiet: true,
      summary: {
        planStatus: "update_available",
        latestVersion: "1.1.0",
        updateAvailable: true,
      },
    });
    expect(fetchReleases).not.toHaveBeenCalled();
    expect(writeCache).not.toHaveBeenCalled();
  });

  it("looks up releases and writes a cache entry when no cache exists", async () => {
    const writeCache = vi.fn();

    const result = await checkPassiveUpdate({
      current,
      now: new Date("2026-06-25T12:00:00.000Z"),
      readCache: () => undefined,
      writeCache,
      fetchReleases: () => [release("v1.1.0"), release("v1.2.0")],
    });

    expect(result).toMatchObject({
      status: "checked",
      quiet: true,
      summary: {
        checkedAt: "2026-06-25T12:00:00.000Z",
        planStatus: "update_available",
        currentVersion: "1.0.0",
        latestTagName: "v1.2.0",
        latestVersion: "1.2.0",
        updateAvailable: true,
      },
    });
    expect(writeCache).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: 1,
        checkedAt: "2026-06-25T12:00:00.000Z",
        planStatus: "update_available",
        latestVersion: "1.2.0",
      }),
    );
  });

  it("refreshes an expired cache entry", async () => {
    const writeCache = vi.fn();

    const result = await checkPassiveUpdate({
      current,
      now: new Date("2026-06-25T12:00:00.000Z"),
      ttlMs: 60_000,
      readCache: () => cachedUpdate("2026-06-25T11:58:00.000Z"),
      writeCache,
      fetchReleases: () => [release("v1.0.0")],
    });

    expect(result).toMatchObject({
      status: "checked",
      quiet: true,
      summary: {
        planStatus: "current",
        latestVersion: "1.0.0",
        updateAvailable: false,
      },
    });
    expect(writeCache).toHaveBeenCalledOnce();
  });

  it("returns a quiet lookup failure with stale cache fallback when the network path fails", async () => {
    const stale = cachedUpdate("2026-06-24T12:00:00.000Z");
    const writeCache = vi.fn();

    const result = await checkPassiveUpdate({
      current,
      now: new Date("2026-06-25T12:00:00.000Z"),
      ttlMs: 60_000,
      readCache: () => stale,
      writeCache,
      fetchReleases: () => {
        throw new Error("offline");
      },
    });

    expect(result).toMatchObject({
      status: "lookup_failed",
      quiet: true,
      reason: "offline",
      summary: {
        planStatus: "update_available",
        latestVersion: "1.1.0",
      },
    });
    expect(writeCache).not.toHaveBeenCalled();
  });

  it("keeps a checked result quiet when cache writing fails", async () => {
    const result = await checkPassiveUpdate({
      current,
      now: new Date("2026-06-25T12:00:00.000Z"),
      readCache: () => undefined,
      writeCache: () => {
        throw new Error("read-only cache directory");
      },
      fetchReleases: () => [release("v1.1.0")],
    });

    expect(result).toMatchObject({
      status: "checked",
      quiet: true,
      cacheWriteFailed: true,
      reason: "read-only cache directory",
      summary: {
        planStatus: "update_available",
        latestVersion: "1.1.0",
        updateAvailable: true,
      },
    });
  });
});
// -/ 1/1
