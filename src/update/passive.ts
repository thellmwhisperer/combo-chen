/**
 * @overview Quiet passive update check service with cache and command policy.
 *   ~200 lines, 11 exports, owns local cache I/O, bounded lookup, and command hook policy.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at runPassiveUpdateCheck          <- CLI-facing check orchestration.
 *   2. Then defaultPassiveUpdateCommandDeps    <- production cache/network adapters.
 *   3. Then shouldRunPassiveUpdateForCommand   <- command hook policy.
 *
 *   MAIN FLOW
 *   ---------
 *   command hook -> cache file + gh releases -> checkPassiveUpdate -> quiet discarded result
 *
 *   PUBLIC API
 *   ----------
 *   PASSIVE_UPDATE_CACHE_FILE          Cache artifact name under COMBO_CHEN_HOME.
 *   PASSIVE_UPDATE_LOOKUP_TIMEOUT_ENV  Env knob for bounding passive gh release lookups.
 *   DEFAULT_PASSIVE_UPDATE_LOOKUP_TIMEOUT_MS Default passive gh lookup timeout.
 *   PassiveUpdateCliCacheEntry         Re-exported cache entry shape for CLI tests.
 *   PassiveUpdateCliDeps               Injectable CLI passive-check boundary.
 *   passiveUpdateCachePath             Resolve the cache file path.
 *   defaultPassiveUpdateCommandDeps    Build production adapters.
 *   readPassiveUpdateCache             Read and validate cache JSON.
 *   writePassiveUpdateCache            Persist cache JSON.
 *   shouldRunPassiveUpdateForCommand   Decide whether a command gets passive checks.
 *   runPassiveUpdateCheck              Run one quiet passive check.
 *
 *   INTERNALS
 *   ---------
 *   passiveUpdateLookupTimeoutMs, isPassiveUpdateCacheEntry, isPlainRecord, optionalStringField, nodeErrorCode.
 *
 * @exports PASSIVE_UPDATE_CACHE_FILE, PASSIVE_UPDATE_LOOKUP_TIMEOUT_ENV, DEFAULT_PASSIVE_UPDATE_LOOKUP_TIMEOUT_MS,
 *   PassiveUpdateCliCacheEntry, PassiveUpdateCliDeps, passiveUpdateCachePath, defaultPassiveUpdateCommandDeps,
 *   readPassiveUpdateCache, writePassiveUpdateCache, shouldRunPassiveUpdateForCommand, runPassiveUpdateCheck
 * @deps ../core/passive-update, ../core/state, ../core/update-contract, ../infra/release-metadata, ./command, node:fs, node:path
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  checkPassiveUpdate,
  type PassiveUpdateCacheEntry,
  type PassiveUpdateCheckInput,
  type PassiveUpdateCheckResult,
} from "../core/passive-update.js";
import { comboHome } from "../core/state.js";
import type { CurrentBuildMetadata } from "../core/update-contract.js";
import { releaseMetadata } from "../infra/release-metadata.js";
import { fetchGitHubReleases, type UpdateCommandDeps } from "./command.js";

// -- 1/3 HELPER · CLI cache/dependency contract --
export const PASSIVE_UPDATE_CACHE_FILE = "passive-update-cache.json";
export const PASSIVE_UPDATE_LOOKUP_TIMEOUT_ENV = "COMBO_CHEN_PASSIVE_UPDATE_LOOKUP_TIMEOUT_MS";
export const DEFAULT_PASSIVE_UPDATE_LOOKUP_TIMEOUT_MS = 60_000;

export type PassiveUpdateCliCacheEntry = PassiveUpdateCacheEntry;

export interface PassiveUpdateCliDeps {
  env: Record<string, string | undefined>;
  gh: UpdateCommandDeps["gh"];
  current: CurrentBuildMetadata;
  cachePath: string;
  lookupTimeoutMs: number;
  now?: Date;
  ttlMs?: number;
  readFile: (path: string) => string;
  writeFile: (path: string, data: string) => void;
  mkdir: (path: string) => void;
}

export function passiveUpdateCachePath(home: string): string {
  return join(home, PASSIVE_UPDATE_CACHE_FILE);
}

export function defaultPassiveUpdateCommandDeps(input: {
  env: Record<string, string | undefined>;
  gh: PassiveUpdateCliDeps["gh"];
}): PassiveUpdateCliDeps {
  return {
    env: input.env,
    gh: input.gh,
    current: releaseMetadata,
    cachePath: passiveUpdateCachePath(comboHome(input.env)),
    lookupTimeoutMs: passiveUpdateLookupTimeoutMs(input.env),
    readFile: (path) => readFileSync(path, "utf8"),
    writeFile: (path, data) => writeFileSync(path, data),
    mkdir: (path) => mkdirSync(path, { recursive: true }),
  };
}
// -/ 1/3

// -- 2/3 CORE · runPassiveUpdateCheck <- START HERE --
export async function runPassiveUpdateCheck(deps: PassiveUpdateCliDeps): Promise<PassiveUpdateCheckResult> {
  const input: PassiveUpdateCheckInput = {
    current: deps.current,
    env: deps.env,
    readCache: () => readPassiveUpdateCache(deps.cachePath, deps.readFile),
    writeCache: (entry) =>
      writePassiveUpdateCache(deps.cachePath, entry, {
        mkdir: deps.mkdir,
        writeFile: deps.writeFile,
      }),
    fetchReleases: () => fetchGitHubReleases(deps.gh, { timeoutMs: deps.lookupTimeoutMs }),
  };
  if (deps.now !== undefined) input.now = deps.now;
  if (deps.ttlMs !== undefined) input.ttlMs = deps.ttlMs;
  return checkPassiveUpdate(input);
}

const PASSIVE_UPDATE_SKIPPED_COMMANDS = new Set([
  "activate-coder",
  "activate-reviewer",
  "director-tick",
  "director-watch",
  "emit",
  "ensure-pr-autoclose",
  "gate-lease",
  "nudge-review-comments",
  "reviewer-tick",
  "update",
]);

export function shouldRunPassiveUpdateForCommand(commandName: string): boolean {
  return !PASSIVE_UPDATE_SKIPPED_COMMANDS.has(commandName);
}
// -/ 2/3

// -- 3/3 HELPER · Cache file JSON adapter and validation --
export function readPassiveUpdateCache(
  path: string,
  readFile: (path: string) => string = (filePath) => readFileSync(filePath, "utf8"),
): PassiveUpdateCliCacheEntry | undefined {
  let raw: string;
  try {
    raw = readFile(path);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return isPassiveUpdateCacheEntry(parsed) ? parsed : undefined;
}

export function writePassiveUpdateCache(
  path: string,
  entry: PassiveUpdateCliCacheEntry,
  deps: {
    mkdir: (path: string) => void;
    writeFile: (path: string, data: string) => void;
  } = {
    mkdir: (dir) => mkdirSync(dir, { recursive: true }),
    writeFile: (filePath, data) => writeFileSync(filePath, data),
  },
): void {
  deps.mkdir(dirname(path));
  deps.writeFile(path, `${JSON.stringify(entry, null, 2)}\n`);
}

function passiveUpdateLookupTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = env[PASSIVE_UPDATE_LOOKUP_TIMEOUT_ENV];
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_PASSIVE_UPDATE_LOOKUP_TIMEOUT_MS;
}

function isPassiveUpdateCacheEntry(value: unknown): value is PassiveUpdateCliCacheEntry {
  if (!isPlainRecord(value)) return false;
  return (
    value["schemaVersion"] === 1 &&
    typeof value["checkedAt"] === "string" &&
    (value["mode"] === "stable" || value["mode"] === "beta") &&
    typeof value["planStatus"] === "string" &&
    typeof value["currentVersion"] === "string" &&
    typeof value["updateAvailable"] === "boolean" &&
    optionalStringField(value, "latestTagName") &&
    optionalStringField(value, "latestVersion") &&
    optionalStringField(value, "reason")
  );
}

function optionalStringField(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || typeof record[key] === "string";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nodeErrorCode(error: unknown): string | undefined {
  return isPlainRecord(error) && typeof error["code"] === "string" ? error["code"] : undefined;
}
// -/ 3/3
