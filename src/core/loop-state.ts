/**
 * @overview Tier-1 loop-state.json artifact: schema-versioned review-loop
 *   position for one combo run (PRD s3/s5). Records every verdict round, the
 *   finding-fingerprint survival map behind the W5b no-progress guard, and the
 *   guard resolution, so resume and the TUI dive-in can re-derive the loop
 *   without replaying agents. Pure folds; the capsule is the only writer.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at LoopState             <- the whole schema in one type.
 *   2. Then recordLoopRound           <- the fold the capsule applies per verdict.
 *   3. Then findingsSurvivingRound    <- the restart-safe no-progress guard predicate.
 *   4. write/readLoopState is the verdict-file tmp+rename convention.
 *
 *   MAIN FLOW
 *   ---------
 *   capsule: initialLoopState -> recordLoopRound per verdict
 *     -> withLoopGuard on resolution -> writeLoopState after every transition
 *
 *   PUBLIC API
 *   ----------
 *   LOOP_STATE_SCHEMA_VERSION  Contract artifact schema version.
 *   LoopState                  Complete loop-state artifact shape.
 *   LoopRoundRecord            One verdict round: sha, verdict ref, finding ids.
 *   LoopGuard                  iterating | cleared | escalated (+reason).
 *   LoopStateError             Thrown on torn or schema-invalid loop state.
 *   initialLoopState           Round-zero state with an iterating guard.
 *   recordLoopRound            Pure fold: append a verdict round + survival map.
 *   withLoopGuard              Pure fold: resolve the guard.
 *   findingsSurvivingRound     Findings already recorded at a prior round (restart-safe).
 *   loopStateFileName/Path     Well-known fs-watchable location.
 *   writeLoopState             Atomic write-then-rename persistence.
 *   readLoopState              Validated read; undefined when absent.
 *
 *   INTERNALS
 *   ---------
 *   fail, parseRoundRecord, parseGuard, parseSurvival
 *
 * @exports LOOP_STATE_SCHEMA_VERSION, LoopGuardState, LoopGuard, LoopRoundRecord, LoopState, LoopStateError, initialLoopState, recordLoopRound, withLoopGuard, findingsSurvivingRound, loopStateFileName, loopStatePath, writeLoopState, readLoopState
 * @deps node:{fs,path,process}, ./guards, ./verdict
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pid } from "node:process";

import { isRecord } from "./guards.js";
import {
  findingFingerprints,
  verdictFileName,
  type VerdictCode,
  type VerdictFile,
  type VerdictFinding,
} from "./verdict.js";

// -- 1/3 CORE · schema types + pure folds <- START HERE --
export class LoopStateError extends Error {}

/** Contract artifact schema version, following the runtime-ledger precedent. */
export const LOOP_STATE_SCHEMA_VERSION = 1;

export interface LoopRoundRecord {
  round: number;
  sha: string;
  /** Run-dir-relative verdict artifact name, e.g. verdict-2.json. */
  verdictPath: string;
  code: VerdictCode;
  findingIds: string[];
}

export type LoopGuardState = "iterating" | "cleared" | "escalated";

export interface LoopGuard {
  state: LoopGuardState;
  /** Round at which the guard resolved (cleared or escalated). */
  round?: number;
  /** Escalation reason, mirroring the needs_human journal reason. */
  reason?: string;
}

export interface LoopState {
  schemaVersion: typeof LOOP_STATE_SCHEMA_VERSION;
  currentRound: number;
  rounds: LoopRoundRecord[];
  /** Finding fingerprint -> rounds in which a matching finding appeared. */
  fingerprintSurvival: Record<string, number[]>;
  guard: LoopGuard;
}

export function initialLoopState(): LoopState {
  return {
    schemaVersion: LOOP_STATE_SCHEMA_VERSION,
    currentRound: 0,
    rounds: [],
    fingerprintSurvival: {},
    guard: { state: "iterating" },
  };
}

export function recordLoopRound(state: LoopState, verdict: VerdictFile): LoopState {
  const fingerprintSurvival = { ...state.fingerprintSurvival };
  for (const finding of verdict.findings) {
    for (const fingerprint of findingFingerprints(finding)) {
      fingerprintSurvival[fingerprint] = [...(fingerprintSurvival[fingerprint] ?? []), verdict.round];
    }
  }
  return {
    ...state,
    currentRound: verdict.round,
    rounds: [
      ...state.rounds,
      {
        round: verdict.round,
        sha: verdict.reviewed.sha,
        verdictPath: verdictFileName(verdict.round),
        code: verdict.code,
        findingIds: verdict.findings.map((finding) => finding.id),
      },
    ],
    fingerprintSurvival,
  };
}

export function withLoopGuard(state: LoopState, guard: LoopGuard): LoopState {
  return { ...state, guard };
}

/**
 * Findings that already appeared at priorRound per the persisted survival
 * map (any fingerprint channel matches). A non-empty result after a coder
 * fix turn means the fix did not land: the no-progress guard escalates. The
 * map, not in-memory verdicts, carries this so the guard survives restarts.
 */
export function findingsSurvivingRound<T extends Pick<VerdictFinding, "id" | "file" | "title">>(
  state: LoopState,
  findings: readonly T[],
  priorRound: number,
): T[] {
  return findings.filter((finding) =>
    findingFingerprints(finding).some((fingerprint) =>
      (state.fingerprintSurvival[fingerprint] ?? []).includes(priorRound),
    ),
  );
}
// -/ 1/3

// -- 2/3 CORE · write-then-rename persistence --
export function loopStateFileName(): string {
  return "loop-state.json";
}

export function loopStatePath(runDir: string): string {
  return join(runDir, loopStateFileName());
}

export function writeLoopState(runDir: string, state: LoopState): void {
  const path = loopStatePath(runDir);
  const tempPath = `${path}.tmp-${pid}-${Date.now()}`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tempPath, path);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}
// -/ 2/3

// -- 3/3 CORE · validated read --
function fail(defect: string): never {
  throw new LoopStateError(`invalid loop-state artifact: ${defect}`);
}

function parseRoundRecord(value: unknown, field: string): LoopRoundRecord {
  if (!isRecord(value)) fail(`${field} must be an object`);
  const round = value["round"];
  if (typeof round !== "number" || !Number.isInteger(round) || round < 1) {
    fail(`${field}.round must be a positive integer`);
  }
  const sha = value["sha"];
  if (typeof sha !== "string" || sha.trim() === "") fail(`${field}.sha must be a non-empty string`);
  const verdictPath = value["verdictPath"];
  if (typeof verdictPath !== "string" || verdictPath.trim() === "") {
    fail(`${field}.verdictPath must be a non-empty string`);
  }
  const code = value["code"];
  if (code !== 0 && code !== 1 && code !== 2 && code !== 3) fail(`${field}.code must be 0, 1, 2, or 3`);
  const findingIds = value["findingIds"];
  if (!Array.isArray(findingIds) || findingIds.some((id) => typeof id !== "string")) {
    fail(`${field}.findingIds must be an array of strings`);
  }
  return { round, sha, verdictPath, code, findingIds: findingIds as string[] };
}

function parseGuard(value: unknown): LoopGuard {
  if (!isRecord(value)) fail("guard must be an object");
  const state = value["state"];
  if (state !== "iterating" && state !== "cleared" && state !== "escalated") {
    fail("guard.state must be iterating, cleared, or escalated");
  }
  const round = value["round"];
  if (round !== undefined && (typeof round !== "number" || !Number.isInteger(round) || round < 1)) {
    fail("guard.round must be a positive integer");
  }
  const reason = value["reason"];
  if (reason !== undefined && (typeof reason !== "string" || reason.trim() === "")) {
    fail("guard.reason must be a non-empty string");
  }
  return {
    state,
    ...(round === undefined ? {} : { round }),
    ...(reason === undefined ? {} : { reason }),
  };
}

function parseSurvival(value: unknown): Record<string, number[]> {
  if (!isRecord(value)) fail("fingerprintSurvival must be an object");
  const survival: Record<string, number[]> = {};
  for (const [fingerprint, rounds] of Object.entries(value)) {
    if (!Array.isArray(rounds) || rounds.some((round) => typeof round !== "number")) {
      fail(`fingerprintSurvival["${fingerprint}"] must be an array of round numbers`);
    }
    survival[fingerprint] = rounds as number[];
  }
  return survival;
}

export function readLoopState(runDir: string): LoopState | undefined {
  const path = loopStatePath(runDir);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(
      `torn or non-JSON ${loopStateFileName()}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) fail("loop state must be a JSON object");
  if (parsed["schemaVersion"] !== LOOP_STATE_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${LOOP_STATE_SCHEMA_VERSION}`);
  }
  const currentRound = parsed["currentRound"];
  if (typeof currentRound !== "number" || !Number.isInteger(currentRound) || currentRound < 0) {
    fail("currentRound must be a non-negative integer");
  }
  const roundsValue = parsed["rounds"];
  if (!Array.isArray(roundsValue)) fail("rounds must be an array");
  const rounds = roundsValue.map((round, i) => parseRoundRecord(round, `rounds[${i}]`));
  return {
    schemaVersion: LOOP_STATE_SCHEMA_VERSION,
    currentRound,
    rounds,
    fingerprintSurvival: parseSurvival(parsed["fingerprintSurvival"]),
    guard: parseGuard(parsed["guard"]),
  };
}
// -/ 3/3
