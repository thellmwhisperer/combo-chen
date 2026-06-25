/**
 * @overview Read-only active combo runtime detector for updater safety slices.
 *   ~190 lines, 8 exports, classifies persisted combo runs without mutation.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at detectActiveComboRuntime <- home/runs scan -> structured status.
 *   2. Then activeComboFromState         <- combo+journal+ledger -> active row.
 *   3. Types document the #72-B/#72-C policy boundary.
 *
 *   MAIN FLOW
 *   ---------
 *   combo home -> runs/* -> combo.json + journal + runtime-ledger fallback -> idle/active/stale/error
 *
 *   PUBLIC API
 *   ----------
 *   ActiveComboRuntimeDetectionStatus  Top-level detector status.
 *   ActiveComboRuntimeDetectorInput    Scan input for a combo home.
 *   ActiveComboRuntimeDetection        Structured detector result.
 *   DetectedActiveComboRuntime         Non-terminal combo facts.
 *   StaleComboRuntimeState             Unknown/stale persisted run facts.
 *   ActiveComboRuntimeDetectionError   Data error, never thrown to callers.
 *   ActiveRuntimeStaleReason           Stale classification reasons.
 *   detectActiveComboRuntime           Read-only detector entry point.
 *
 *   INTERNALS
 *   ---------
 *   inspectRunDir, activeComboFromState, statusFor, detectionError, errorMessage
 *
 * @exports ActiveComboRuntimeDetectionStatus, ActiveComboRuntimeDetectorInput, ActiveComboRuntimeDetection, DetectedActiveComboRuntime, StaleComboRuntimeState, ActiveComboRuntimeDetectionError, ActiveRuntimeStaleReason, detectActiveComboRuntime
 * @deps node:{fs,path}, ./combo, ./events, ./runtime-ledger, ./state
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { deriveStatus, type ComboStatus, type Phase } from "./combo.js";
import { readEvents, type ComboEvent } from "./events.js";
import { readRuntimeLedger, type RuntimeRoleWindows } from "./runtime-ledger.js";
import { readCombo, type ComboRecord } from "./state.js";

// -- 1/3 HELPER · Types and result shape --
export type ActiveComboRuntimeDetectionStatus = "idle" | "active" | "stale" | "error";

export type ActiveRuntimeStaleReason = "missing_combo_record" | "missing_journal_activity";

export interface ActiveComboRuntimeDetectorInput {
  /** comboHome() value to scan. Kept explicit so update policy tests can inject temp homes. */
  home: string;
  /** CLI command used only to synthesize legacy runtime-ledger command facts. */
  cli?: string;
}

export interface DetectedActiveComboRuntime {
  comboId: string;
  runDir: string;
  phase: Phase;
  needsHuman: boolean;
  branch: string;
  worktree: string;
  tmuxSession: string;
  repoDir: string;
  roleWindows: RuntimeRoleWindows;
  createdAt: string;
  updatedAt: string;
  reason?: string;
  prUrl?: string;
  lastEvent?: ComboEvent["event"];
}

export interface StaleComboRuntimeState {
  comboId: string;
  runDir: string;
  reason: ActiveRuntimeStaleReason;
  message: string;
}

export interface ActiveComboRuntimeDetectionError {
  comboId?: string;
  runDir?: string;
  reason: "runs_dir_unreadable" | "malformed_combo_record" | "runtime_state_unreadable";
  message: string;
}

export interface ActiveComboRuntimeDetection {
  status: ActiveComboRuntimeDetectionStatus;
  /** Compatibility summary for the earlier U0 ActiveComboState placeholder. */
  active: boolean;
  /** Active combo ids only; stale/error ids remain in their dedicated arrays. */
  comboIds: string[];
  inspectedRunDirs: string[];
  activeCombos: DetectedActiveComboRuntime[];
  staleCombos: StaleComboRuntimeState[];
  errors: ActiveComboRuntimeDetectionError[];
}

interface MutableDetectionState {
  inspectedRunDirs: string[];
  activeCombos: DetectedActiveComboRuntime[];
  staleCombos: StaleComboRuntimeState[];
  errors: ActiveComboRuntimeDetectionError[];
}
// -/ 1/3

// -- 2/3 CORE · detectActiveComboRuntime <- START HERE --
const COMBO_RECORD_FILE = "combo.json";

export function detectActiveComboRuntime(input: ActiveComboRuntimeDetectorInput): ActiveComboRuntimeDetection {
  const state: MutableDetectionState = {
    inspectedRunDirs: [],
    activeCombos: [],
    staleCombos: [],
    errors: [],
  };
  const runsDir = join(input.home, "runs");
  if (!existsSync(runsDir)) return finish(state);

  let entries;
  try {
    entries = readdirSync(runsDir, { withFileTypes: true });
  } catch (error) {
    state.errors.push(detectionError("runs_dir_unreadable", error, { runDir: runsDir }));
    return finish(state);
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    inspectRunDir({
      state,
      runDir: join(runsDir, entry.name),
      entryName: entry.name,
      cli: input.cli,
    });
  }

  return finish(state);
}

function inspectRunDir(input: {
  state: MutableDetectionState;
  runDir: string;
  entryName: string;
  cli?: string;
}): void {
  const { state, runDir, entryName, cli } = input;
  state.inspectedRunDirs.push(runDir);

  if (!existsSync(join(runDir, COMBO_RECORD_FILE))) {
    state.staleCombos.push({
      comboId: entryName,
      runDir,
      reason: "missing_combo_record",
      message: `run directory has no ${COMBO_RECORD_FILE}`,
    });
    return;
  }

  let combo: ComboRecord;
  try {
    combo = readCombo(runDir);
  } catch (error) {
    state.errors.push(detectionError("malformed_combo_record", error, { comboId: entryName, runDir }));
    return;
  }

  let events: ComboEvent[];
  try {
    events = readEvents(runDir);
  } catch (error) {
    state.errors.push(detectionError("runtime_state_unreadable", error, { comboId: combo.id, runDir }));
    return;
  }

  if (events.length === 0) {
    state.staleCombos.push({
      comboId: combo.id,
      runDir,
      reason: "missing_journal_activity",
      message: "combo record exists but journal has no events",
    });
    return;
  }

  const status = deriveStatus(events);
  if (status.phase === "STOPPED") return;

  try {
    state.activeCombos.push(activeComboFromState({ combo, runDir, status, cli }));
  } catch (error) {
    state.errors.push(detectionError("runtime_state_unreadable", error, { comboId: combo.id, runDir }));
  }
}
// -/ 2/3

// -- 3/3 HELPER · Result assembly --
function activeComboFromState(input: {
  combo: ComboRecord;
  runDir: string;
  status: ComboStatus;
  cli?: string;
}): DetectedActiveComboRuntime {
  const { combo, runDir, status, cli } = input;
  const ledger = readRuntimeLedger(runDir, { cli });
  assertRuntimeLedgerFields(ledger);
  const prUrl = status.pr ?? ledger.prUrl;
  return {
    comboId: combo.id,
    runDir,
    phase: status.phase,
    needsHuman: status.needsHuman,
    branch: combo.branch,
    worktree: combo.worktree,
    tmuxSession: combo.tmuxSession,
    repoDir: combo.repoDir,
    roleWindows: ledger.roleWindows,
    createdAt: ledger.createdAt,
    updatedAt: ledger.updatedAt,
    ...(status.reason !== undefined ? { reason: status.reason } : {}),
    ...(prUrl !== undefined ? { prUrl } : {}),
    ...(status.lastEvent !== undefined ? { lastEvent: status.lastEvent.event } : {}),
  };
}

function finish(state: MutableDetectionState): ActiveComboRuntimeDetection {
  const comboIds = state.activeCombos.map((combo) => combo.comboId);
  return {
    status: statusFor(state),
    active: comboIds.length > 0,
    comboIds,
    inspectedRunDirs: state.inspectedRunDirs,
    activeCombos: state.activeCombos,
    staleCombos: state.staleCombos,
    errors: state.errors,
  };
}

function statusFor(state: MutableDetectionState): ActiveComboRuntimeDetectionStatus {
  if (state.activeCombos.length > 0) return "active";
  if (state.errors.length > 0) return "error";
  if (state.staleCombos.length > 0) return "stale";
  return "idle";
}

function assertRuntimeLedgerFields(ledger: unknown): asserts ledger is ReturnType<typeof readRuntimeLedger> {
  if (ledger === null || typeof ledger !== "object" || Array.isArray(ledger)) {
    throw new Error("runtime ledger must be an object");
  }
  const record = ledger as Record<string, unknown>;
  for (const field of ["comboId", "repoDir", "branch", "worktree", "runDir", "tmuxSession", "createdAt", "updatedAt"]) {
    if (typeof record[field] !== "string") {
      throw new Error(`runtime ledger missing field ${field}`);
    }
  }
  if (record["roleWindows"] === null || typeof record["roleWindows"] !== "object" || Array.isArray(record["roleWindows"])) {
    throw new Error("runtime ledger missing field roleWindows");
  }
}

function detectionError(
  reason: ActiveComboRuntimeDetectionError["reason"],
  error: unknown,
  context: Pick<ActiveComboRuntimeDetectionError, "comboId" | "runDir">,
): ActiveComboRuntimeDetectionError {
  return {
    ...context,
    reason,
    message: errorMessage(error),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
// -/ 3/3
