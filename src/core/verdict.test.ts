/**
 * @overview Contract tests for the tier-1 verdict artifact.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at write/read round-trip     <- completeness convention + schema.
 *   2. Then validation rejections         <- malformed verdicts throw VerdictError.
 *   3. Finish at fingerprints             <- stable identity across rounds.
 *
 *   MAIN FLOW
 *   ---------
 *   fixture verdict -> writeVerdictFile -> readVerdictFile -> assertions
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   fixtureVerdict, runDirFixture
 *
 * @exports none
 * @deps node:{fs,os,path}, vitest, ./verdict
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  LOCAL_REVIEW_CHECKLIST,
  VERDICT_SCHEMA_VERSION,
  VerdictError,
  findingFingerprints,
  missingChecklistIds,
  normalizeFindingTitle,
  readVerdictFile,
  sameFinding,
  verdictFileName,
  verdictFilePath,
  writeVerdictFile,
  type VerdictFile,
  type VerdictFinding,
} from "./verdict.js";

// -- 1/2 HELPER · fixtures --
function runDirFixture(): string {
  return mkdtempSync(join(tmpdir(), "combo-chen-verdict-"));
}

function fixtureVerdict(overrides: Partial<VerdictFile> = {}): VerdictFile {
  return {
    schemaVersion: VERDICT_SCHEMA_VERSION,
    round: 1,
    code: 1,
    reviewed: { sha: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0" },
    identity: { model: "claude-fable-5", runtime: "claude" },
    checklist: LOCAL_REVIEW_CHECKLIST.map((item) => ({ id: item.id, status: "pass" as const })),
    findings: [
      {
        id: "journal-lock-leak",
        severity: "blocker",
        file: "src/core/events.ts",
        line: 187,
        title: "Append lock leaks on rename failure",
        body: "The lock dir is not removed when rename throws.",
      },
    ],
    followUps: [{ title: "Add fs.watch variant of followEvents" }],
    ...overrides,
  };
}
// -/ 1/2

// -- 2/2 CORE · verdict artifact contracts <- START HERE --
describe("verdict artifact", () => {
  it("permanently certifies artifact-driven inter-agent waits", () => {
    expect(LOCAL_REVIEW_CHECKLIST).toContainEqual({
      id: "artifact-driven-waits",
      requirement:
        "Every new or touched inter-agent wait triggers on its artifact and has an end-to-end producer-that-never-exits variant.",
    });
  });

  it("round-trips a schema-versioned verdict through write-then-rename", () => {
    const runDir = runDirFixture();
    const verdict = fixtureVerdict();

    writeVerdictFile(runDir, verdict);

    expect(verdictFileName(1)).toBe("verdict-1.json");
    expect(readdirSync(runDir)).toEqual(["verdict-1.json"]);
    expect(readVerdictFile(runDir, 1)).toEqual(verdict);
    const raw = JSON.parse(readFileSync(verdictFilePath(runDir, 1), "utf8")) as Record<string, unknown>;
    expect(raw["schemaVersion"]).toBe(VERDICT_SCHEMA_VERSION);
  });

  it("preserves optional attack table and not-verified blocks", () => {
    const runDir = runDirFixture();
    const verdict = fixtureVerdict({
      attackTable: [
        { attack: "torn journal line", result: "finding", findingId: "journal-lock-leak" },
        { attack: "concurrent append", result: "clean" },
        { attack: "network volume rename", result: "not_verified", note: "no fixture" },
      ],
      notVerified: ["behavior on network volumes"],
    });

    writeVerdictFile(runDir, verdict);

    expect(readVerdictFile(runDir, 1)).toEqual(verdict);
  });

  it("rejects a verdict without the embedded checklist", () => {
    const runDir = runDirFixture();
    writeFileSync(verdictFilePath(runDir, 1), `${JSON.stringify({ ...fixtureVerdict(), checklist: [] })}\n`);

    expect(() => readVerdictFile(runDir, 1)).toThrow(VerdictError);
    expect(() => readVerdictFile(runDir, 1)).toThrow(/checklist/);
  });

  it("rejects unknown verdict codes, bad severities, and bad checklist statuses", () => {
    const runDir = runDirFixture();
    const cases: Array<Partial<Record<string, unknown>>> = [
      { code: 4 },
      { code: "0" },
      { round: 0 },
      { schemaVersion: 2 },
      { reviewed: { sha: "" } },
      { identity: { model: "", runtime: "claude" } },
      { findings: [{ ...fixtureVerdict().findings[0], severity: "catastrophic" }] },
      {
        checklist: [{ id: "tdd-first", status: "maybe" }],
      },
      { followUps: [{ title: "" }] },
    ];
    for (const broken of cases) {
      writeFileSync(verdictFilePath(runDir, 1), `${JSON.stringify({ ...fixtureVerdict(), ...broken })}\n`);
      expect(() => readVerdictFile(runDir, 1), JSON.stringify(broken)).toThrow(VerdictError);
    }
  });

  it("throws VerdictError when the verdict file is absent or torn", () => {
    const runDir = runDirFixture();

    expect(() => readVerdictFile(runDir, 1)).toThrow(VerdictError);
    writeFileSync(verdictFilePath(runDir, 1), '{"schemaVersion": 1, "round"');
    expect(() => readVerdictFile(runDir, 1)).toThrow(VerdictError);
  });

  it("reports checklist items missing from the required contract set", () => {
    const complete = fixtureVerdict();
    expect(missingChecklistIds(complete)).toEqual([]);

    const partial = fixtureVerdict({
      checklist: [{ id: "tdd-first", status: "pass" }],
    });
    const missing = missingChecklistIds(partial);
    expect(missing).toContain("config-discipline");
    expect(missing).not.toContain("tdd-first");
    expect(missing).toHaveLength(LOCAL_REVIEW_CHECKLIST.length - 1);
  });
});

describe("finding fingerprints", () => {
  const base: VerdictFinding = {
    id: "gate-lease-race",
    severity: "major",
    file: "src/core/gate-lease.ts",
    line: 40,
    title: "Stale lease reclaim races on line 40",
    body: "…",
  };

  it("carries the reviewer-assigned id and a file+normalized-title fallback", () => {
    const prints = findingFingerprints(base);
    expect(prints).toContain("id:gate-lease-race");
    expect(prints.some((p) => p.startsWith("loc:src/core/gate-lease.ts#"))).toBe(true);
  });

  it("stays stable while line numbers drift between rounds", () => {
    const drifted: VerdictFinding = {
      ...base,
      line: 97,
      title: "Stale lease reclaim races on line 97",
    };
    expect(sameFinding(base, drifted)).toBe(true);
  });

  it("matches on the location fallback when the reviewer re-assigns ids", () => {
    const renamed: VerdictFinding = { ...base, id: "lease-reclaim-race" };
    expect(sameFinding(base, renamed)).toBe(true);
  });

  it("does not match findings differing in both id and location identity", () => {
    const other: VerdictFinding = {
      ...base,
      id: "other-bug",
      file: "src/core/state.ts",
      title: "Combo id corruption check bypassed",
    };
    expect(sameFinding(base, other)).toBe(false);
  });

  it("normalizes titles case-, punctuation-, and line-reference-insensitively", () => {
    expect(normalizeFindingTitle("Stale `lease` reclaim, races on line 40!")).toBe(
      normalizeFindingTitle("stale lease reclaim races on line 97"),
    );
    expect(normalizeFindingTitle("A")).not.toBe(normalizeFindingTitle("B"));
  });
});
// -/ 2/2
