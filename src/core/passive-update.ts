/**
 * @overview Quiet passive update-check contract with cache, TTL, and env disable handling.
 *   ~230 lines, 9 exports, reuses the read-only release resolver without writing to stdout/stderr.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at checkPassiveUpdate       <- passive disable/cache/lookup orchestration.
 *   2. Then isPassiveUpdateCacheFresh    <- cache TTL eligibility.
 *   3. Then passiveSummaryFromPlan       <- resolver result to cache summary.
 *
 *   MAIN FLOW
 *   ---------
 *   env + cache + current build -> optional release lookup -> resolveReadOnlyUpdatePlan -> quiet summary/cache entry
 *
 *   PUBLIC API
 *   ----------
 *   PASSIVE_UPDATE_DISABLE_ENV          Env knob that fully disables passive checks.
 *   DEFAULT_PASSIVE_UPDATE_CACHE_TTL_MS Default freshness window for passive cache entries.
 *   PassiveUpdatePlanStatus             Re-exported read-only plan resolution status union.
 *   PassiveUpdateCacheEntry             Persistable passive result summary.
 *   PassiveUpdateCheckInput             Injectable passive-check boundary.
 *   PassiveUpdateCheckResult            Quiet result returned to callers.
 *   isPassiveUpdateDisabled             Env parsing helper.
 *   isPassiveUpdateCacheFresh           TTL/current-version cache predicate.
 *   checkPassiveUpdate                  Passive check implementation.
 *
 *   INTERNALS
 *   ---------
 *   passiveSummaryFromPlan, cachedSummary, errorMessage.
 *
 * @exports PASSIVE_UPDATE_DISABLE_ENV, DEFAULT_PASSIVE_UPDATE_CACHE_TTL_MS, PassiveUpdatePlanStatus,
 *   PassiveUpdateCacheEntry, PassiveUpdateCheckInput, PassiveUpdateCheckResult,
 *   isPassiveUpdateDisabled, isPassiveUpdateCacheFresh, checkPassiveUpdate
 * @deps ./update-contract, ./update-resolver
 */
import { errorMessage } from "./guards.js";
import type { CurrentBuildMetadata } from "./update-contract.js";
import {
  resolveReadOnlyUpdatePlan,
  type GitHubReleaseMetadata,
  type ReadOnlyUpdatePlanResolution,
  type UpdateReleaseResolverMode,
} from "./update-resolver.js";

// -- 1/3 HELPER · Passive check types and constants --
export const PASSIVE_UPDATE_DISABLE_ENV = "COMBO_CHEN_DISABLE_PASSIVE_UPDATE_CHECKS";
export const DEFAULT_PASSIVE_UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type PassiveUpdatePlanStatus = ReadOnlyUpdatePlanResolution["status"];

export interface PassiveUpdateCacheEntry {
  schemaVersion: 1;
  checkedAt: string;
  mode: UpdateReleaseResolverMode;
  planStatus: PassiveUpdatePlanStatus;
  currentVersion: string;
  latestTagName?: string;
  latestVersion?: string;
  updateAvailable: boolean;
  reason?: string;
}

export interface PassiveUpdateCheckInput {
  current: CurrentBuildMetadata;
  mode?: UpdateReleaseResolverMode;
  ttlMs?: number;
  env?: Record<string, string | undefined>;
  now?: Date;
  readCache: () => PassiveUpdateCacheEntry | undefined | null;
  writeCache: (entry: PassiveUpdateCacheEntry) => Promise<void> | void;
  fetchReleases: () => Promise<readonly GitHubReleaseMetadata[]> | readonly GitHubReleaseMetadata[];
}

export type PassiveUpdateCheckResult =
  | {
      status: "disabled";
      quiet: true;
      reason: string;
    }
  | {
      status: "cache_hit";
      quiet: true;
      summary: PassiveUpdateCacheEntry;
    }
  | {
      status: "checked";
      quiet: true;
      summary: PassiveUpdateCacheEntry;
      cacheWriteFailed?: boolean;
      reason?: string;
    }
  | {
      status: "lookup_failed";
      quiet: true;
      reason: string;
      summary?: PassiveUpdateCacheEntry;
    };
// -/ 1/3

// -- 2/3 CORE · checkPassiveUpdate <- START HERE --
/** Run a passive update check without throwing or producing process output. */
export async function checkPassiveUpdate(input: PassiveUpdateCheckInput): Promise<PassiveUpdateCheckResult> {
  const env = input.env ?? process.env;
  if (isPassiveUpdateDisabled(env)) {
    return {
      status: "disabled",
      quiet: true,
      reason: `${PASSIVE_UPDATE_DISABLE_ENV} is set`,
    };
  }

  const mode = input.mode ?? "stable";
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? DEFAULT_PASSIVE_UPDATE_CACHE_TTL_MS;
  const cached = readPassiveCache(input.readCache);

  if (
    cached !== undefined &&
    isPassiveUpdateCacheFresh({
      entry: cached,
      current: input.current,
      mode,
      now,
      ttlMs,
    })
  ) {
    return { status: "cache_hit", quiet: true, summary: cachedSummary(cached) };
  }

  let releases: readonly GitHubReleaseMetadata[];
  try {
    releases = await input.fetchReleases();
  } catch (error) {
    return {
      status: "lookup_failed",
      quiet: true,
      reason: errorMessage(error),
      ...(cached !== undefined ? { summary: cachedSummary(cached) } : {}),
    };
  }

  const summary = passiveSummaryFromPlan(
    resolveReadOnlyUpdatePlan({
      current: input.current,
      releases,
      mode,
    }),
    now,
  );

  try {
    await input.writeCache(summary);
    return { status: "checked", quiet: true, summary };
  } catch (error) {
    return {
      status: "checked",
      quiet: true,
      summary,
      cacheWriteFailed: true,
      reason: errorMessage(error),
    };
  }
}
// -/ 2/3

// -- 3/3 HELPER · Disable, TTL, summary, and quiet error adapters --
/** Parse the passive-update disable knob. Empty, 0, false, off, and no keep checks enabled. */
export function isPassiveUpdateDisabled(env: Record<string, string | undefined>): boolean {
  const raw = env[PASSIVE_UPDATE_DISABLE_ENV];
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "off" && normalized !== "no";
}

/** True only when a cache entry is for the same current build, mode, and unexpired TTL window. */
export function isPassiveUpdateCacheFresh(input: {
  entry: PassiveUpdateCacheEntry;
  current: CurrentBuildMetadata;
  mode: UpdateReleaseResolverMode;
  now: Date;
  ttlMs: number;
}): boolean {
  if (input.ttlMs <= 0) return false;
  if (input.entry.schemaVersion !== 1) return false;
  if (input.entry.mode !== input.mode) return false;
  if (input.entry.currentVersion !== input.current.version) return false;

  const checkedAtMs = Date.parse(input.entry.checkedAt);
  const nowMs = input.now.getTime();
  if (!Number.isFinite(checkedAtMs) || !Number.isFinite(nowMs)) return false;

  const ageMs = nowMs - checkedAtMs;
  return ageMs >= 0 && ageMs < input.ttlMs;
}

function readPassiveCache(
  readCache: PassiveUpdateCheckInput["readCache"],
): PassiveUpdateCacheEntry | undefined {
  try {
    return readCache() ?? undefined;
  } catch {
    return undefined;
  }
}

function passiveSummaryFromPlan(
  plan: ReadOnlyUpdatePlanResolution,
  now: Date,
): PassiveUpdateCacheEntry {
  const candidate = "candidate" in plan ? plan.candidate : undefined;
  const reason = "reason" in plan ? plan.reason : undefined;
  return {
    schemaVersion: 1,
    checkedAt: now.toISOString(),
    mode: plan.mode,
    planStatus: plan.status,
    currentVersion: plan.current.version,
    ...(candidate !== undefined
      ? {
          latestTagName: candidate.tagName,
          latestVersion: candidate.normalized.version,
        }
      : {}),
    updateAvailable: plan.status === "update_available",
    ...(reason !== undefined ? { reason } : {}),
  };
}

function cachedSummary(entry: PassiveUpdateCacheEntry): PassiveUpdateCacheEntry {
  return { ...entry };
}

// -/ 3/3
