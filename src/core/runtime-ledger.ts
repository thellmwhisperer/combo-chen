/**
 * @overview Runtime ledger persistence for a combo capsule. ~240 lines,
 *   10 exports, writes and updates the machine-readable resource artifact.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at buildRuntimeLedger     <- ComboRecord + run dir -> artifact shape.
 *   2. Then readRuntimeLedger          <- ledger-or-legacy fallback reader.
 *   3. Then updateRuntimeLedger        <- merge newly discovered resources.
 *   4. Constants/types are support     <- stable filename and schema fields.
 *
 *   MAIN FLOW
 *   ---------
 *   launch builds ledger -> write/read/update helpers keep runtime-ledger.json current
 *
 *   PUBLIC API
 *   ----------
 *   RUNTIME_LEDGER_FILE  Stable runtime ledger artifact filename.
 *   RuntimeLedger        Machine-readable capsule resources.
 *   RuntimeLedgerInput   Inputs for launch-time ledger construction.
 *   RuntimeLedgerReadOptions Inputs for legacy fallback construction.
 *   RuntimeLedgerUpdate  Patch of newly discovered runtime resources.
 *   RuntimeRoleWindows   Role window names recorded in the ledger.
 *   buildRuntimeLedger   Build a ledger from combo launch facts.
 *   readRuntimeLedger    Read ledger or synthesize one from combo.json + journal.
 *   updateRuntimeLedger  Merge resource updates and persist the ledger.
 *   writeRuntimeLedger   Persist the ledger under the run directory.
 *
 *   INTERNALS
 *   ---------
 *   runtimeLedgerPath, readPersistedLedger, synthesizeRuntimeLedger,
 *   hydratePrUrlFromJournal, commandSet, workItemFacts, timestamp, cleanRecord
 *
 * @exports RUNTIME_LEDGER_FILE, RuntimeLedger, RuntimeLedgerInput, RuntimeLedgerReadOptions, RuntimeLedgerUpdate, RuntimeRoleWindows, buildRuntimeLedger, readRuntimeLedger, updateRuntimeLedger, writeRuntimeLedger
 * @deps node:{fs,path}, ./combo, ./events, ./state
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { shellQuote } from "./combo.js";
import { latestPrUrlFromEvents, readEvents } from "./events.js";
import { cleanOptional, readCombo, type ComboRecord } from "./state.js";

// -- 1/2 HELPER · Types and constants --
export const RUNTIME_LEDGER_FILE = "runtime-ledger.json";

export interface RuntimeRoleWindows {
  coder?: string;
  journal?: string;
  director?: string;
  gatekeeper?: string;
  gateRunner?: string;
  reviewer?: string;
  reviewerWatch?: string;
  directorWatch?: string;
}

export interface RuntimeLedgerInput {
  combo: ComboRecord;
  runDir: string;
  cli: string;
  roleWindows?: RuntimeRoleWindows;
  promptTargets?: Record<string, string>;
  prUrl?: string;
  now?: () => string;
}

export interface RuntimeLedgerReadOptions {
  cli?: string;
  roleWindows?: RuntimeRoleWindows;
  promptTargets?: Record<string, string>;
  now?: () => string;
}

export interface RuntimeLedgerUpdate extends RuntimeLedgerReadOptions {
  prUrl?: string;
}

export interface RuntimeLedger {
  schemaVersion: 1;
  comboId: string;
  repoDir: string;
  branch: string;
  worktree: string;
  runDir: string;
  tmuxSession: string;
  roleWindows: RuntimeRoleWindows;
  logs: Record<"rebase" | "coder" | "gatekeeper" | "autoclose", string>;
  commands: {
    attach: string;
    eventsFollow: string;
    resume: string;
    closure: string;
  };
  workItem: {
    sourceType: string;
    sourceReference?: string;
    title?: string;
    issueUrl?: string;
  };
  promptTargets?: Record<string, string>;
  prUrl?: string;
  createdAt: string;
  updatedAt: string;
}
// -/ 1/2

// -- 2/2 CORE · build/read/update/write runtime ledger <- START HERE --
export function buildRuntimeLedger(input: RuntimeLedgerInput): RuntimeLedger {
  const { combo, runDir } = input;
  const timestamp = input.now?.() ?? combo.createdAt;
  const ledger: RuntimeLedger = {
    schemaVersion: 1,
    comboId: combo.id,
    repoDir: combo.repoDir,
    branch: combo.branch,
    worktree: combo.worktree,
    runDir,
    tmuxSession: combo.tmuxSession,
    roleWindows: cleanRecord(input.roleWindows ?? {}),
    logs: {
      rebase: join(runDir, "rebase.log"),
      coder: join(runDir, "coder.log"),
      gatekeeper: join(runDir, "gatekeeper.log"),
      autoclose: join(runDir, "autoclose.log"),
    },
    commands: commandSet(input.cli, combo.id),
    workItem: workItemFacts(combo),
    ...(input.promptTargets !== undefined ? { promptTargets: cleanRecord(input.promptTargets) } : {}),
    ...(input.prUrl !== undefined ? { prUrl: input.prUrl } : {}),
    createdAt: combo.createdAt,
    updatedAt: timestamp,
  };
  return ledger;
}

export function writeRuntimeLedger(runDir: string, ledger: RuntimeLedger): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(runtimeLedgerPath(runDir), `${JSON.stringify(ledger, null, 2)}\n`);
}

export function readRuntimeLedger(runDir: string, options: RuntimeLedgerReadOptions = {}): RuntimeLedger {
  const path = runtimeLedgerPath(runDir);
  if (existsSync(path)) {
    const persisted = readPersistedLedger(path);
    if (persisted !== undefined) return hydratePrUrlFromJournal(runDir, persisted);
  }
  return synthesizeRuntimeLedger(runDir, options);
}

function synthesizeRuntimeLedger(runDir: string, options: RuntimeLedgerReadOptions): RuntimeLedger {
  const combo = readCombo(runDir);
  return buildRuntimeLedger({
    combo,
    runDir,
    cli: options.cli ?? "combo-chen",
    roleWindows: options.roleWindows,
    promptTargets: options.promptTargets,
    prUrl: latestPrUrlFromEvents(readEvents(runDir)),
    now: options.now,
  });
}

function readPersistedLedger(path: string): RuntimeLedger | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isRuntimeLedger(parsed)) return parsed;
  } catch {
    return undefined;
  }
  return undefined;
}

function hydratePrUrlFromJournal(runDir: string, ledger: RuntimeLedger): RuntimeLedger {
  if (ledger.prUrl !== undefined) return ledger;
  const prUrl = latestPrUrlFromEvents(readEvents(runDir));
  if (prUrl === undefined) return ledger;
  return { ...ledger, prUrl };
}

function isRuntimeLedger(value: unknown): value is RuntimeLedger {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { schemaVersion?: unknown; comboId?: unknown };
  return candidate.schemaVersion === 1 && typeof candidate.comboId === "string";
}

export function updateRuntimeLedger(runDir: string, update: RuntimeLedgerUpdate): RuntimeLedger {
  const current = readRuntimeLedger(runDir, update);
  const updated: RuntimeLedger = {
    ...current,
    roleWindows: cleanRecord({ ...current.roleWindows, ...update.roleWindows }),
    ...(update.promptTargets !== undefined
      ? { promptTargets: cleanRecord({ ...(current.promptTargets ?? {}), ...update.promptTargets }) }
      : {}),
    ...(update.prUrl !== undefined ? { prUrl: update.prUrl } : {}),
    updatedAt: timestamp(update.now),
  };
  writeRuntimeLedger(runDir, updated);
  return updated;
}

function runtimeLedgerPath(runDir: string): string {
  return join(runDir, RUNTIME_LEDGER_FILE);
}

function commandSet(cli: string, comboId: string): RuntimeLedger["commands"] {
  const quotedId = shellQuote(comboId);
  return {
    attach: `${cli} attach -n ${quotedId}`,
    eventsFollow: `${cli} events --follow -n ${quotedId}`,
    resume: `${cli} resume -n ${quotedId}`,
    closure: `${cli} closure -n ${quotedId}`,
  };
}

function workItemFacts(combo: ComboRecord): RuntimeLedger["workItem"] {
  const issueUrl = cleanOptional(combo.issueUrl);
  const sourceType = combo.workItemSourceType ?? (issueUrl === undefined ? "unknown" : "github_issue");
  const sourceReference = cleanOptional(combo.workItemSourceReference) ?? issueUrl;
  const title = cleanOptional(combo.workItemTitle);
  return {
    sourceType,
    ...(sourceReference !== undefined ? { sourceReference } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(issueUrl !== undefined ? { issueUrl } : {}),
  };
}

function timestamp(now: (() => string) | undefined): string {
  return now?.() ?? new Date().toISOString();
}

function cleanRecord(record: object): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}
// -/ 2/2
