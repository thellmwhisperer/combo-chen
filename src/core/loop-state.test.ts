/**
 * @overview Contract tests for the tier-1 loop-state.json artifact.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at the pure fold tests   <- round recording and survival map.
 *   2. Then guard transitions         <- iterating/cleared/escalated.
 *   3. Finish at persistence          <- write-then-rename and validated read.
 *
 *   MAIN FLOW
 *   ---------
 *   initialLoopState -> recordLoopRound/withLoopGuard -> write/read round trip
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   finding and verdict fixture helpers
 *
 * @exports none
 * @deps node:{fs,os,path}, vitest, ./loop-state, ./verdict
 */
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  LOOP_STATE_SCHEMA_VERSION,
  LoopStateError,
  findingsSurvivingRound,
  initialLoopState,
  loopStateFileName,
  loopStatePath,
  readLoopState,
  recordLoopRound,
  withLoopGuard,
  writeLoopState,
} from "./loop-state.js";
import {
  LOCAL_REVIEW_CHECKLIST,
  VERDICT_SCHEMA_VERSION,
  type VerdictFile,
  type VerdictFinding,
} from "./verdict.js";

// -- 1/2 HELPER · fixtures --
function finding(overrides: Partial<VerdictFinding> = {}): VerdictFinding {
  return {
    id: "hardcoded-timeout",
    severity: "blocker",
    file: "src/app/x.ts",
    line: 12,
    title: "New timeout constant without env path",
    body: "Wire env/TOML.",
    ...overrides,
  };
}

function verdict(overrides: Partial<VerdictFile> = {}): VerdictFile {
  return {
    schemaVersion: VERDICT_SCHEMA_VERSION,
    round: 1,
    code: 1,
    reviewed: { sha: "coded" },
    identity: { model: "claude-fable-5", runtime: "claude" },
    checklist: LOCAL_REVIEW_CHECKLIST.map((item) => ({ id: item.id, status: "pass" as const })),
    findings: [finding()],
    followUps: [],
    ...overrides,
  };
}
// -/ 1/2

// -- 2/2 CORE · loop-state contracts <- START HERE --
describe("loop-state pure folds", () => {
  it("starts at round zero with an iterating guard and empty survival map", () => {
    expect(initialLoopState()).toEqual({
      schemaVersion: LOOP_STATE_SCHEMA_VERSION,
      currentRound: 0,
      rounds: [],
      fingerprintSurvival: {},
      guard: { state: "iterating" },
    });
  });

  it("records a round with verdict ref, finding ids, and fingerprint survival", () => {
    const state = recordLoopRound(initialLoopState(), verdict());

    expect(state.currentRound).toBe(1);
    expect(state.rounds).toEqual([
      {
        round: 1,
        sha: "coded",
        verdictPath: "verdict-1.json",
        code: 1,
        findingIds: ["hardcoded-timeout"],
      },
    ]);
    expect(state.fingerprintSurvival).toEqual({
      "id:hardcoded-timeout": [1],
      "loc:src/app/x.ts#new-timeout-constant-without-env-path": [1],
    });
  });

  it("merges survival rounds for a finding that reappears in a later round", () => {
    const afterRoundOne = recordLoopRound(initialLoopState(), verdict());
    const afterRoundTwo = recordLoopRound(
      afterRoundOne,
      verdict({ round: 2, reviewed: { sha: "fixed" }, findings: [finding({ line: 40 })] }),
    );

    expect(afterRoundTwo.currentRound).toBe(2);
    expect(afterRoundTwo.fingerprintSurvival["id:hardcoded-timeout"]).toEqual([1, 2]);
    // recordLoopRound is a pure fold: the round-one state is untouched.
    expect(afterRoundOne.currentRound).toBe(1);
    expect(afterRoundOne.fingerprintSurvival["id:hardcoded-timeout"]).toEqual([1]);
  });

  it("marks guard transitions without mutating the input state", () => {
    const iterating = recordLoopRound(initialLoopState(), verdict());
    const escalated = withLoopGuard(iterating, { state: "escalated", round: 2, reason: "no_progress" });

    expect(escalated.guard).toEqual({ state: "escalated", round: 2, reason: "no_progress" });
    expect(iterating.guard).toEqual({ state: "iterating" });
  });

  it("identifies survivors from the persisted survival map by id and by file+title channels", () => {
    // The guard reads the map, not in-memory verdicts, so it survives a
    // capsule restart between rounds.
    const state = recordLoopRound(
      initialLoopState(),
      verdict({
        findings: [
          finding(),
          finding({ id: "journal-order", file: "src/core/events.ts", title: "Events reordered" }),
        ],
      }),
    );
    const current = [
      // id channel survives a retitle and file move.
      finding({ file: "src/app/moved.ts", title: "Timeout constant still hardcoded" }),
      // loc channel survives reviewer id churn.
      finding({ id: "journal-order-v2", file: "src/core/events.ts", title: "Events reordered" }),
      // genuinely new finding is not a survivor.
      finding({ id: "fresh-finding", file: "src/app/new.ts", title: "Missing test" }),
    ];

    expect(findingsSurvivingRound(state, current, 1).map((survivor) => survivor.id)).toEqual([
      "hardcoded-timeout",
      "journal-order-v2",
    ]);
    // No findings were recorded at round 2, so nothing survives from it.
    expect(findingsSurvivingRound(state, current, 2)).toEqual([]);
  });
});

describe("loop-state persistence", () => {
  it("round-trips through write-then-rename leaving no temp files", () => {
    const runDir = mkdtempSync(join(tmpdir(), "combo-chen-loop-state-"));
    const state = withLoopGuard(recordLoopRound(initialLoopState(), verdict({ code: 0 })), {
      state: "cleared",
      round: 1,
    });

    writeLoopState(runDir, state);

    expect(readLoopState(runDir)).toEqual(state);
    expect(readdirSync(runDir)).toEqual([loopStateFileName()]);
  });

  it("returns undefined when no loop state exists yet", () => {
    const runDir = mkdtempSync(join(tmpdir(), "combo-chen-loop-state-"));

    expect(readLoopState(runDir)).toBeUndefined();
  });

  it("throws LoopStateError on torn JSON and on unknown schema versions", () => {
    const runDir = mkdtempSync(join(tmpdir(), "combo-chen-loop-state-"));
    writeFileSync(loopStatePath(runDir), "{ torn");
    expect(() => readLoopState(runDir)).toThrow(LoopStateError);

    writeFileSync(loopStatePath(runDir), `${JSON.stringify({ schemaVersion: 99 })}\n`);
    expect(() => readLoopState(runDir)).toThrow(/schemaVersion/);
  });

  it("throws LoopStateError when contract fields are malformed", () => {
    const runDir = mkdtempSync(join(tmpdir(), "combo-chen-loop-state-"));
    writeFileSync(
      loopStatePath(runDir),
      `${JSON.stringify({
        schemaVersion: LOOP_STATE_SCHEMA_VERSION,
        currentRound: 1,
        rounds: [{ round: 1 }],
        fingerprintSurvival: {},
        guard: { state: "iterating" },
      })}\n`,
    );

    expect(() => readLoopState(runDir)).toThrow(LoopStateError);
  });
});
// -/ 2/2
