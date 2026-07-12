/**
 * @overview Contract tests for the permanent exit summary renderer.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at renderExitSummary tests  <- the fold over events + verdicts.
 *   2. Then durationHuman tests          <- time formatting.
 *
 *   MAIN FLOW
 *   ---------
 *   fixture events + verdicts -> renderExitSummary -> markdown assertions
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   tempRunDir, writeTestVerdict
 *
 * @exports none
 * @deps vitest, ./exit-summary, ./verdict, ./events
 */
import { mkdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { exitSummaryPath, renderExitSummary } from "./exit-summary.js";
import { VERDICT_SCHEMA_VERSION, writeVerdictFile, type VerdictFile } from "./verdict.js";

// -- 1/2 HELPER · fixtures --
function tempRunDir(): string {
  const base = mkdtempSync(join(tmpdir(), "combo-chen-exit-"));
  return join(base, "o-r-7");
}

function testVerdict(round: number, findingsCount = 2): VerdictFile {
  const SHA = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";
  const findings = Array.from({ length: findingsCount }, (_, i) => ({
    id: `finding-${i + 1}`,
    severity: "blocker" as const,
    file: `src/app/x${i + 1}.ts`,
    line: i + 1,
    title: `Finding ${i + 1} title`,
    body: `Finding ${i + 1} body`,
  }));
  return {
    schemaVersion: VERDICT_SCHEMA_VERSION,
    round,
    code: 0,
    reviewed: { sha: SHA },
    identity: { model: "claude-fable-5", runtime: "claude" },
    checklist: [
      { id: "tdd-first", status: "pass" },
      { id: "config-discipline", status: "pass" },
      { id: "compat-debt", status: "n_a" },
      { id: "surface-budget", status: "pass" },
      { id: "role-boundaries", status: "pass" },
      { id: "journal-integrity", status: "pass" },
      { id: "docs-headers", status: "pass" },
      { id: "tests-contracts", status: "pass" },
    ],
    findings,
    followUps: [],
    notVerified: [],
  };
}

function writeCombo(runDir: string, _id: string): string {
  mkdirSync(runDir, { recursive: true });
  return runDir;
}

// -- 1/2
// -/ 1/2

// -- 2/2 CORE · exit summary contract <- START HERE --
describe("exitSummaryPath", () => {
  it("resolves the well-known run-dir location", () => {
    expect(exitSummaryPath("/runs/o-r-7")).toBe("/runs/o-r-7/exit-summary.md");
  });
});

describe("renderExitSummary", () => {
  it("renders a merged combo summary with PR url and merge details", () => {
    const runDir = tempRunDir();
    writeCombo(runDir, "o-r-7");

    const result = renderExitSummary({
      comboId: "o-r-7",
      prUrl: "https://github.com/o/r/pull/7",
      mergedSha: "a1b2c3d4e5f6789012345678901234567890abcd",
      mergedBy: "maintainer",
      mergedAt: "2026-06-11T10:12:00.000Z",
      createdAt: "2026-06-11T09:00:00.000Z",
      runDir,
      events: [],
    });

    expect(result).toContain("# Combo closed: o-r-7");
    expect(result).toContain("**PR**: https://github.com/o/r/pull/7");
    expect(result).toContain("**Merged**: a1b2c3d4e5f6 by maintainer at 2026-06-11T10:12:00.000Z");
    expect(result).toContain("## Summary");
    expect(result).toContain("Total rounds: 0");

    rmSync(runDir, { recursive: true, force: true });
  });

  it("includes the issue URL when present", () => {
    const runDir = tempRunDir();
    writeCombo(runDir, "o-r-7");

    const result = renderExitSummary({
      comboId: "o-r-7",
      issueUrl: "https://github.com/o/r/issues/7",
      prUrl: "https://github.com/o/r/pull/7",
      mergedSha: "abc123",
      mergedBy: "bot",
      createdAt: "2026-01-01T00:00:00.000Z",
      runDir,
      events: [],
    });

    expect(result).toContain("**Issue**: https://github.com/o/r/issues/7");

    rmSync(runDir, { recursive: true, force: true });
  });

  it("omits the issue URL line when empty", () => {
    const runDir = tempRunDir();
    writeCombo(runDir, "o-r-7");

    const result = renderExitSummary({
      comboId: "o-r-7",
      issueUrl: "",
      prUrl: "https://github.com/o/r/pull/7",
      mergedSha: "abc123",
      mergedBy: "bot",
      createdAt: "2026-01-01T00:00:00.000Z",
      runDir,
      events: [],
    });

    expect(result).not.toContain("**Issue**:");

    rmSync(runDir, { recursive: true, force: true });
  });

  it("renders local review rounds from verdict files", () => {
    const runDir = tempRunDir();
    writeCombo(runDir, "o-r-7");
    writeVerdictFile(runDir, testVerdict(1, 2));
    writeVerdictFile(runDir, testVerdict(2, 1));

    const result = renderExitSummary({
      comboId: "o-r-7",
      prUrl: "https://github.com/o/r/pull/7",
      mergedSha: "abc123",
      mergedBy: "bot",
      createdAt: "2026-01-01T00:00:00.000Z",
      runDir,
      events: [],
    });

    expect(result).toContain("## Rounds");
    expect(result).toContain("Round 1: code 0, reviewed by claude-fable-5, 2 findings");
    expect(result).toContain("Round 2: code 0, reviewed by claude-fable-5, 1 finding");
    expect(result).toContain("Total rounds: 2");
    expect(result).toContain("Total findings: 3");
    expect(result).toContain("Local reviewer: 3");

    rmSync(runDir, { recursive: true, force: true });
  });

  it("reports no rounds when no verdict files exist", () => {
    const runDir = tempRunDir();
    writeCombo(runDir, "o-r-7");

    const result = renderExitSummary({
      comboId: "o-r-7",
      prUrl: "https://github.com/o/r/pull/7",
      mergedSha: "abc123",
      mergedBy: "bot",
      createdAt: "2026-01-01T00:00:00.000Z",
      runDir,
      events: [],
    });

    expect(result).toContain("No local review rounds recorded.");

    rmSync(runDir, { recursive: true, force: true });
  });

  it("renders duration in hours and minutes", () => {
    const runDir = tempRunDir();
    writeCombo(runDir, "o-r-7");

    const result = renderExitSummary({
      comboId: "o-r-7",
      prUrl: "https://github.com/o/r/pull/7",
      mergedSha: "abc123",
      mergedBy: "bot",
      mergedAt: "2026-01-01T02:30:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      runDir,
      events: [],
    });

    expect(result).toContain("**Duration**: 2h 30m");

    rmSync(runDir, { recursive: true, force: true });
  });

  it("renders duration in minutes and seconds when under one hour", () => {
    const runDir = tempRunDir();
    writeCombo(runDir, "o-r-7");

    const result = renderExitSummary({
      comboId: "o-r-7",
      prUrl: "https://github.com/o/r/pull/7",
      mergedSha: "abc123",
      mergedBy: "bot",
      mergedAt: "2026-01-01T00:07:30.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      runDir,
      events: [],
    });

    expect(result).toContain("**Duration**: 7m 30s");

    rmSync(runDir, { recursive: true, force: true });
  });

  it("renders duration in seconds when under one minute", () => {
    const runDir = tempRunDir();
    writeCombo(runDir, "o-r-7");

    const result = renderExitSummary({
      comboId: "o-r-7",
      prUrl: "https://github.com/o/r/pull/7",
      mergedSha: "abc123",
      mergedBy: "bot",
      mergedAt: "2026-01-01T00:00:30.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      runDir,
      events: [],
    });

    expect(result).toContain("**Duration**: 30s");

    rmSync(runDir, { recursive: true, force: true });
  });

  it("uses now when mergedAt is missing", () => {
    const runDir = tempRunDir();
    writeCombo(runDir, "o-r-7");

    const result = renderExitSummary({
      comboId: "o-r-7",
      prUrl: "https://github.com/o/r/pull/7",
      mergedSha: "abc123",
      mergedBy: "bot",
      createdAt: "2026-01-01T00:00:00.000Z",
      runDir,
      events: [],
    });

    expect(result).toContain("**Duration**:");

    rmSync(runDir, { recursive: true, force: true });
  });

  it("tolerates a missing mergedAt gracefully", () => {
    const runDir = tempRunDir();
    writeCombo(runDir, "o-r-7");

    const result = renderExitSummary({
      comboId: "o-r-7",
      prUrl: "https://github.com/o/r/pull/7",
      mergedSha: "abc123",
      mergedBy: "bot",
      createdAt: "2026-01-01T00:00:00.000Z",
      runDir,
      events: [],
    });

    // Just verify it doesn't crash.
    expect(result).toContain("**Merged**: abc123 by bot");
    // No "at" suffix
    expect(result).not.toContain("at ");

    rmSync(runDir, { recursive: true, force: true });
  });
});
// -/ 2/2
