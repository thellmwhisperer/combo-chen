/**
 * @overview Unit tests for runtime ledger persistence. ~120 lines, fallback and update contracts.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at readRuntimeLedger tests     <- legacy combo fallback behavior.
 *   2. Then updateRuntimeLedger tests       <- merge resource updates into persisted ledgers.
 *   3. Helpers are fixture builders         <- temp run dirs and combo records.
 *
 *   MAIN FLOW
 *   ---------
 *   combo.json + journal/runtime-ledger.json -> read/update helper -> RuntimeLedger facts
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   tempRunDir, combo
 *
 * @exports none
 * @deps vitest, node:{fs,os,path}, ./events, ./runtime-ledger, ./state
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appendEvent } from "./events.js";
import {
  RUNTIME_LEDGER_FILE,
  buildRuntimeLedger,
  readRuntimeLedger,
  updateRuntimeLedger,
  writeRuntimeLedger,
} from "./runtime-ledger.js";
import { writeCombo, type ComboRecord } from "./state.js";

// -- 1/3 HELPER · Fixtures --
function tempRunDir(): string {
  return mkdtempSync(join(tmpdir(), "combo-chen-ledger-"));
}

function combo(overrides: Partial<ComboRecord> = {}): ComboRecord {
  return {
    id: "o-r-7",
    issueUrl: "https://github.com/o/r/issues/7",
    repoDir: "/repo/r",
    worktree: "/repo/r/.worktrees/issue-7",
    branch: "combo/issue-7",
    tmuxSession: "combo-chen-o-r-7",
    createdAt: "2026-06-21T17:00:00.000Z",
    ...overrides,
  };
}
// -/ 1/3

// -- 2/3 CORE · readRuntimeLedger fallback <- START HERE --
describe("readRuntimeLedger", () => {
  it("falls back to combo.json plus journal facts when runtime-ledger.json is absent", () => {
    const runDir = tempRunDir();
    writeCombo(runDir, combo());
    appendEvent(runDir, "combo_created", { issue_url: "https://github.com/o/r/issues/7" });
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const ledger = readRuntimeLedger(runDir, {
      cli: "node /repo/dist/cli.mjs",
      roleWindows: { coder: "coder", gatekeeper: "gatekeeper" },
    });

    expect(existsSync(join(runDir, RUNTIME_LEDGER_FILE))).toBe(false);
    expect(ledger).toMatchObject({
      schemaVersion: 1,
      comboId: "o-r-7",
      repoDir: "/repo/r",
      runDir,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      roleWindows: {
        coder: "coder",
        gatekeeper: "gatekeeper",
      },
      prUrl: "https://github.com/o/r/pull/7",
    });
    expect(ledger.commands.resume).toContain("resume -n 'o-r-7'");
    expect(ledger.logs.coder).toBe(join(runDir, "coder.log"));
  });
});
// -/ 2/3

// -- 3/3 CORE · updateRuntimeLedger --
describe("updateRuntimeLedger", () => {
  it("merges new runtime resources while preserving launch-time ledger facts", () => {
    const runDir = tempRunDir();
    const record = combo();
    const launchLedger = buildRuntimeLedger({
      combo: record,
      runDir,
      cli: "node /repo/dist/cli.mjs",
      roleWindows: { coder: "coder", gatekeeper: "gatekeeper" },
      now: () => "2026-06-21T17:01:00.000Z",
    });
    writeRuntimeLedger(runDir, launchLedger);

    const updated = updateRuntimeLedger(runDir, {
      prUrl: "https://github.com/o/r/pull/7",
      roleWindows: { reviewer: "reviewer", directorWatch: "director-watch" },
      now: () => "2026-06-21T17:02:00.000Z",
    });

    expect(updated).toMatchObject({
      comboId: "o-r-7",
      repoDir: "/repo/r",
      branch: "combo/issue-7",
      prUrl: "https://github.com/o/r/pull/7",
      roleWindows: {
        coder: "coder",
        gatekeeper: "gatekeeper",
        reviewer: "reviewer",
        directorWatch: "director-watch",
      },
      createdAt: "2026-06-21T17:00:00.000Z",
      updatedAt: "2026-06-21T17:02:00.000Z",
    });
    expect(JSON.parse(readFileSync(join(runDir, RUNTIME_LEDGER_FILE), "utf8"))).toEqual(updated);
  });
});
// -/ 3/3
