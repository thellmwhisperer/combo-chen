/**
 * @overview Run identity and persistence: one directory per combo under the
 *   combo home, holding combo.json (the record) and journal.jsonl (the spine).
 *   ~78 lines, 9 exports.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at parseIssueUrl           ← URL → owner/repo/number
 *   2. comboHome / runDirFor            ← filesystem layout
 *   3. writeCombo / readCombo           ← persist + load
 *   4. listCombos                       ← enumerate all runs
 *
 *   MAIN FLOW
 *   ─────────
 *   cli/main.ts → parseIssueUrl → comboIdFromIssueUrl → comboHome → runDirFor
 *     → writeCombo(record) → readCombo reads it back for status/attach/etc.
 *
 *   ┌─ PUBLIC API ─────────────────────────────────────────────────────┐
 *   │ parseIssueUrl        Parse GitHub issue URL → {owner,repo,number} │
 *   │ comboIdFromIssueUrl  Derive combo id from issue URL              │
 *   │ comboHome            Resolve COMBO_CHEN_HOME dir (env or ~)      │
 *   │ runDirFor            Resolve run dir for a combo id             │
 *   │ writeCombo           Persist a ComboRecord to disk              │
 *   │ readCombo            Load a ComboRecord from disk               │
 *   │ listCombos           Enumerate all persisted combos             │
 *   │ ComboRecord          Identity + filesystem shape of a combo     │
 *   │ ComboStateError      Thrown on malformed URLs, missing records  │
 *   ├─ INTERNALS ──────────────────────────────────────────────────────┤
 *   │ IssueRef, ISSUE_URL                                             │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * @exports ComboStateError, IssueRef, ComboRecord, parseIssueUrl, comboIdFromIssueUrl, comboHome, runDirFor, writeCombo, readCombo, listCombos
 * @deps node:fs, node:os, node:path
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// -- 1/2 CORE · Identity + persistence ← START HERE --
export class ComboStateError extends Error {}

export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
}

export interface ComboRecord {
  id: string;
  issueUrl: string;
  repoDir: string;
  worktree: string;
  branch: string;
  tmuxSession: string;
  createdAt: string;
}

const ISSUE_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)$/;

export function parseIssueUrl(url: string): IssueRef {
  const match = ISSUE_URL.exec(url.trim());
  if (!match) {
    throw new ComboStateError(
      `Not a GitHub issue URL: "${url}" (expected https://github.com/<owner>/<repo>/issues/<n>)`,
    );
  }
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]!) };
}

export function comboIdFromIssueUrl(url: string): string {
  const issue = parseIssueUrl(url);
  return `${issue.owner}-${issue.repo}-${issue.number}`;
}

export function comboHome(env: Record<string, string | undefined> = process.env): string {
  return env["COMBO_CHEN_HOME"] ?? join(homedir(), ".combo-chen");
}

export function runDirFor(home: string, comboId: string): string {
  return join(home, "runs", comboId);
}
// -/ 1/2

// -- 2/2 CORE · Persistence (writeCombo, readCombo, listCombos) --
const RECORD = "combo.json";

export function writeCombo(runDir: string, combo: ComboRecord): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, RECORD), `${JSON.stringify(combo, null, 2)}\n`);
}

export function readCombo(runDir: string): ComboRecord {
  const path = join(runDir, RECORD);
  if (!existsSync(path)) {
    throw new ComboStateError(`No combo record at ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as ComboRecord;
}

export function listCombos(home: string): ComboRecord[] {
  const runsDir = join(home, "runs");
  if (!existsSync(runsDir)) return [];
  const combos: ComboRecord[] = [];
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(runsDir, entry.name);
    if (!existsSync(join(dir, RECORD))) continue;
    combos.push(readCombo(dir));
  }
  return combos.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
// -/ 2/2
