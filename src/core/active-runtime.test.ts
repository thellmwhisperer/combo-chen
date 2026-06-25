/**
 * @overview Unit tests for read-only active combo runtime detection. ~140 lines,
 *   covering active, idle, stale, and malformed persisted runtime state.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at describe("detectActiveComboRuntime") <- detector contract.
 *   2. Fixtures are small combo home/run builders.
 *
 *   MAIN FLOW
 *   ---------
 *   temp combo home -> persisted combo state -> detectActiveComboRuntime -> structured result
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   home, combo, writeRun
 *
 * @exports none
 * @deps vitest, node:{fs,os,path}, ./active-runtime, ./events, ./runtime-ledger, ./state
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { detectActiveComboRuntime } from "./active-runtime.js";
import { appendEvent, journalPath } from "./events.js";
import { RUNTIME_LEDGER_FILE } from "./runtime-ledger.js";
import { runDirFor, writeCombo, type ComboRecord } from "./state.js";

// -- 1/2 HELPER · Fixtures --
function home(): string {
  return mkdtempSync(join(tmpdir(), "combo-chen-active-runtime-"));
}

function combo(overrides: Partial<ComboRecord> = {}): ComboRecord {
  return {
    id: "o-r-7",
    issueUrl: "https://github.com/o/r/issues/7",
    repoDir: "/repo/r",
    worktree: "/repo/r/.worktrees/issue-7",
    branch: "combo/issue-7",
    tmuxSession: "combo-chen-o-r-7",
    createdAt: "2026-06-25T10:00:00.000Z",
    ...overrides,
  };
}

function writeRun(base: string, record: ComboRecord = combo()): string {
  const runDir = runDirFor(base, record.id);
  writeCombo(runDir, record);
  return runDir;
}
// -/ 1/2

// -- 2/2 CORE · detectActiveComboRuntime <- START HERE --
describe("detectActiveComboRuntime", () => {
  it("reports idle when no combo work is active", () => {
    const result = detectActiveComboRuntime({ home: home() });

    expect(result).toMatchObject({
      status: "idle",
      activeCombos: [],
      staleCombos: [],
      errors: [],
    });
  });

  it("reports active combos from journal phase without mutating persisted state", () => {
    const base = home();
    const runDir = writeRun(base);
    appendEvent(runDir, "combo_created", { issue_url: "https://github.com/o/r/issues/7" });
    appendEvent(runDir, "coder_started", {});
    const journalBefore = readFileSync(journalPath(runDir), "utf8");
    const ledgerPath = join(runDir, RUNTIME_LEDGER_FILE);

    const result = detectActiveComboRuntime({ home: base, cli: "node /repo/dist/cli.mjs" });

    expect(result.status).toBe("active");
    expect(result.activeCombos).toEqual([
      expect.objectContaining({
        comboId: "o-r-7",
        phase: "CODING",
        runDir,
        branch: "combo/issue-7",
        worktree: "/repo/r/.worktrees/issue-7",
        tmuxSession: "combo-chen-o-r-7",
      }),
    ]);
    expect(result.staleCombos).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(existsSync(ledgerPath)).toBe(false);
    expect(readFileSync(journalPath(runDir), "utf8")).toBe(journalBefore);
  });

  it("treats stopped combos as idle", () => {
    const base = home();
    const runDir = writeRun(base);
    appendEvent(runDir, "combo_created", { issue_url: "https://github.com/o/r/issues/7" });
    appendEvent(runDir, "coder_started", {});
    appendEvent(runDir, "combo_closed", {});

    const result = detectActiveComboRuntime({ home: base });

    expect(result.status).toBe("idle");
    expect(result.activeCombos).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("reports persisted run dirs with unknown journal state as stale", () => {
    const base = home();
    const runDir = writeRun(base);

    const result = detectActiveComboRuntime({ home: base });

    expect(result.status).toBe("stale");
    expect(result.staleCombos).toEqual([
      expect.objectContaining({
        comboId: "o-r-7",
        runDir,
        reason: "missing_journal_activity",
      }),
    ]);
    expect(result.activeCombos).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("returns detection errors for malformed combo records instead of throwing", () => {
    const base = home();
    const runDir = join(base, "runs", "broken");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "combo.json"), "{not json");

    const result = detectActiveComboRuntime({ home: base });

    expect(result.status).toBe("error");
    expect(result.activeCombos).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({
        comboId: "broken",
        runDir,
        reason: "malformed_combo_record",
      }),
    ]);
  });

  it("reports active status when one run dir is active and another has errors", () => {
    const base = home();

    const activeRunDir = writeRun(base, combo({ id: "good-combo" }));
    appendEvent(activeRunDir, "combo_created", { issue_url: "https://github.com/o/r/issues/7" });
    appendEvent(activeRunDir, "gate_started", {});

    const brokenRunDir = join(base, "runs", "bad-combo");
    mkdirSync(brokenRunDir, { recursive: true });
    writeFileSync(join(brokenRunDir, "combo.json"), "{not json");

    const result = detectActiveComboRuntime({ home: base });

    expect(result.status).toBe("active");
    expect(result.active).toBe(true);
    expect(result.activeCombos).toEqual([
      expect.objectContaining({
        comboId: "good-combo",
        phase: "GATING",
        runDir: activeRunDir,
      }),
    ]);
    expect(result.errors).toEqual([
      expect.objectContaining({
        comboId: "bad-combo",
        runDir: brokenRunDir,
        reason: "malformed_combo_record",
      }),
    ]);
  });

  it("returns detection errors for malformed runtime ledgers instead of trusting partial state", () => {
    const base = home();
    const runDir = writeRun(base);
    appendEvent(runDir, "combo_created", { issue_url: "https://github.com/o/r/issues/7" });
    appendEvent(runDir, "gate_started", {});
    writeFileSync(
      join(runDir, RUNTIME_LEDGER_FILE),
      JSON.stringify({
        schemaVersion: 1,
        comboId: "o-r-7",
        repoDir: "/repo/r",
        branch: "combo/issue-7",
        worktree: "/repo/r/.worktrees/issue-7",
        runDir,
        tmuxSession: "combo-chen-o-r-7",
        logs: {},
        commands: {},
        workItem: { sourceType: "github_issue" },
        createdAt: "2026-06-25T10:00:00.000Z",
        updatedAt: "2026-06-25T10:00:00.000Z",
      }) + "\n",
    );

    const result = detectActiveComboRuntime({ home: base });

    expect(result.status).toBe("error");
    expect(result.activeCombos).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({
        comboId: "o-r-7",
        runDir,
        reason: "runtime_state_unreadable",
      }),
    ]);
    expect(result.errors[0]?.message).toContain("runtime ledger missing field roleWindows");
  });
});
// -/ 2/2
