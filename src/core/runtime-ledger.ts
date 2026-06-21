/**
 * @overview Runtime ledger persistence for a combo capsule. ~125 lines,
 *   6 exports, writes the machine-readable launch/resource artifact.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at buildRuntimeLedger     <- ComboRecord + run dir -> artifact shape.
 *   2. Then writeRuntimeLedger         <- filesystem persistence.
 *   3. Constants/types are support     <- stable filename and schema fields.
 *
 *   MAIN FLOW
 *   ---------
 *   cli/main.ts run -> buildRuntimeLedger -> writeRuntimeLedger -> runtime-ledger.json
 *
 *   PUBLIC API
 *   ----------
 *   RUNTIME_LEDGER_FILE  Stable runtime ledger artifact filename.
 *   RuntimeLedger        Machine-readable capsule resources.
 *   RuntimeLedgerInput   Inputs for launch-time ledger construction.
 *   RuntimeRoleWindows   Role window names recorded in the ledger.
 *   buildRuntimeLedger   Build a ledger from combo launch facts.
 *   writeRuntimeLedger   Persist the ledger under the run directory.
 *
 *   INTERNALS
 *   ---------
 *   runtimeLedgerPath, commandSet, workItemFacts, cleanRecord
 *
 * @exports RUNTIME_LEDGER_FILE, RuntimeLedger, RuntimeLedgerInput, RuntimeRoleWindows, buildRuntimeLedger, writeRuntimeLedger
 * @deps node:{fs,path}, ./combo, ./state
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { shellQuote } from "./combo.js";
import { cleanOptional, type ComboRecord } from "./state.js";

// -- 1/2 HELPER · Types and constants --
export const RUNTIME_LEDGER_FILE = "runtime-ledger.json";

export interface RuntimeRoleWindows {
  coder?: string;
  gatekeeper?: string;
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

// -- 2/2 CORE · buildRuntimeLedger + writeRuntimeLedger <- START HERE --
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

function cleanRecord(record: object): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}
// -/ 2/2
