/**
 * @overview Contract tests for the tier-2 review dossier renderer.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at single-home facts        <- findings stated once, referenced elsewhere.
 *   2. Then exceptions-only rendering    <- clean rows cost zero visible lines.
 *
 *   MAIN FLOW
 *   ---------
 *   fixture verdict -> renderReviewDossier -> string assertions
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   verdict fixture
 *
 * @exports none
 * @deps vitest, ./review-dossier, ./verdict
 */
import { describe, expect, it } from "vitest";

import { renderReviewDossier, reviewDossierFileName } from "./review-dossier.js";
import { LOCAL_REVIEW_CHECKLIST, VERDICT_SCHEMA_VERSION, type VerdictFile } from "./verdict.js";

// -- 1/2 HELPER · fixture --
const SHA = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";

function verdict(overrides: Partial<VerdictFile> = {}): VerdictFile {
  return {
    schemaVersion: VERDICT_SCHEMA_VERSION,
    round: 2,
    code: 1,
    reviewed: { sha: SHA },
    identity: { model: "claude-fable-5", runtime: "claude" },
    checklist: [
      { id: "tdd-first", status: "pass" },
      { id: "config-discipline", status: "fail", note: "see finding hardcoded-timeout" },
      { id: "compat-debt", status: "n_a", note: "no compatibility paths touched" },
    ],
    findings: [
      {
        id: "hardcoded-timeout",
        severity: "blocker",
        file: "src/app/x.ts",
        line: 12,
        title: "New timeout constant without env path",
        body: "GATE_WAIT_MS is a bare literal; wire env/TOML.",
        criticalSurface: "publishing",
      },
      {
        id: "missing-test",
        severity: "minor",
        file: "src/app/y.ts",
        title: "Edge case untested",
        body: "Empty-array branch has no test.",
      },
    ],
    followUps: [{ title: "Consider fs.watch for verdict detection", findingId: "missing-test" }],
    attackTable: [
      { attack: "kill reviewer mid-write", result: "finding", findingId: "hardcoded-timeout" },
      { attack: "concurrent gate lease", result: "clean" },
      { attack: "torn journal line", result: "clean" },
      { attack: "network volume rename", result: "not_verified", note: "no fixture available" },
    ],
    notVerified: ["network volume rename semantics"],
    ...overrides,
  };
}
// -/ 1/2

// -- 2/2 CORE · dossier style contract <- START HERE --
describe("reviewDossierFileName", () => {
  it("carries round and the short reviewed sha", () => {
    expect(reviewDossierFileName(2, SHA)).toBe("review-2-a1b2c3d4e5f6.md");
  });
});

describe("renderReviewDossier", () => {
  it("states each finding exactly once and references it everywhere else", () => {
    const dossier = renderReviewDossier(verdict());

    expect(dossier.match(/New timeout constant without env path/g)).toHaveLength(1);
    expect(dossier.match(/GATE_WAIT_MS is a bare literal/g)).toHaveLength(1);
    // Attack table and checklist reference the finding by id, never restate it.
    expect(dossier).toContain("see hardcoded-timeout");
    expect(dossier).toContain("src/app/x.ts:12");
    expect(dossier).toContain("blocker");
    expect(dossier).toContain("critical surface: publishing");
  });

  it("renders clean rows as zero visible lines with a one-line rollup", () => {
    const dossier = renderReviewDossier(verdict());

    expect(dossier).not.toContain("concurrent gate lease");
    expect(dossier).not.toContain("torn journal line");
    expect(dossier).toContain("2 attacks clean");
    expect(dossier).not.toMatch(/tdd-first.*pass/);
    expect(dossier).toContain("1 checklist item passed");
  });

  it("keeps the summary exceptions-only", () => {
    const dossier = renderReviewDossier(verdict());

    expect(dossier).toContain("round 2");
    expect(dossier).toContain(SHA);
    expect(dossier).toContain("verdict code 1");
    expect(dossier).toContain("claude-fable-5");
    expect(dossier).toContain("network volume rename semantics");
    expect(dossier).toContain("Consider fs.watch for verdict detection");
  });

  it("renders a clean code-0 verdict without findings, attack, or checklist noise", () => {
    const clean = verdict({
      code: 0,
      findings: [],
      followUps: [],
      checklist: LOCAL_REVIEW_CHECKLIST.map((item) => ({ id: item.id, status: "pass" as const })),
      attackTable: [
        { attack: "kill reviewer mid-write", result: "clean" },
        { attack: "concurrent gate lease", result: "clean" },
      ],
      notVerified: [],
    });
    const dossier = renderReviewDossier(clean);

    expect(dossier).toContain("No findings.");
    expect(dossier).toContain("2 attacks clean");
    expect(dossier).toContain(`${LOCAL_REVIEW_CHECKLIST.length} checklist items passed`);
    expect(dossier).not.toContain("## Findings");
    expect(dossier).not.toContain("kill reviewer mid-write");
  });
});
// -/ 2/2
