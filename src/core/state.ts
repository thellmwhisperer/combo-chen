/**
 * @overview Run identity and persistence: one directory per combo under the
 *   combo home, holding combo.json (the record) and journal.jsonl (the spine).
 *   ~205 lines, 14 exports.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at parseIssueUrl           ← URL → owner/repo/number
 *   2. comboHome / runDirFor            ← filesystem layout
 *   3. writeCombo / readCombo           ← persist + load
 *   4. listCombos                       ← enumerate all runs
 *   5. describeWorkItem                 ← source/title display facts
 *
 *   MAIN FLOW
 *   ─────────
 *   cli/main.ts → parseIssueUrl → comboIdFromIssueUrl → comboHome → runDirFor
 *     → writeCombo(record) → readCombo/listCombos validate the id/run-dir contract.
 *
 *   ┌─ PUBLIC API ─────────────────────────────────────────────────────┐
 *   │ parseIssueUrl        Parse GitHub issue URL → {owner,repo,number} │
 *   │ comboIdFromIssueUrl  Derive combo id from issue URL              │
 *   │ comboIdFromWorkPlanSource Derive combo id from a generic plan    │
 *   │ comboHome            Resolve COMBO_CHEN_HOME dir (env or ~)      │
 *   │ runDirFor            Resolve run dir for a combo id             │
 *   │ writeCombo           Persist a ComboRecord to disk              │
 *   │ readCombo            Load a ComboRecord from disk               │
 *   │ listCombos           Enumerate persisted combos; validates      │
 *   │                        combo.id === directory name; optional     │
 *   │                        onCorrupt(err) sinks corruption errors    │
 *   │ describeWorkItem     Derive stable source/title display facts   │
 *   │ ComboRecord          Identity + filesystem shape of a combo     │
 *   │ WorkItemDescriptor   Display-safe work item source/title shape  │
 *   │ cleanOptional        Trim optional strings to undefined          │
 *   │ IssueRef             Parsed GitHub issue owner/repo/number       │
 *   │ ComboStateError      Thrown on malformed URLs, missing/corrupt  │
 *   │                        records, or id/directory mismatches       │
 *   ├─ INTERNALS ──────────────────────────────────────────────────────┤
 *   │ ISSUE_URL, slugForComboId, shortSourceHash, parseComboRecord     │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * @exports ComboStateError, IssueRef, ComboRecord, WorkItemDescriptor, parseIssueUrl, comboIdFromIssueUrl, comboIdFromWorkPlanSource, comboHome, runDirFor, writeCombo, readCombo, listCombos, describeWorkItem, cleanOptional
 * @deps node:crypto, node:fs, node:os, node:path, ./work-plan
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { WorkPlanSource, WorkPlanSourceType } from "./work-plan.js";

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
  workItemSourceType?: WorkPlanSourceType;
  workItemSourceReference?: string;
  workItemTitle?: string;
  repoDir: string;
  worktree: string;
  worktreeProvider?: "treehouse";
  treehouseLeaseHolder?: string;
  branch: string;
  tmuxSession: string;
  createdAt: string;
}

export interface WorkItemDescriptor {
  sourceType: string;
  sourceReference?: string;
  title?: string;
  label: string;
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

export function comboIdFromWorkPlanSource(source: WorkPlanSource, title: string): string {
  return `plan-${slugForComboId(title || source.reference)}-${shortSourceHash(source)}`;
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

function slugForComboId(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug === "" ? "work-plan" : slug;
}

function shortSourceHash(source: WorkPlanSource): string {
  return createHash("sha1").update(`${source.type}:${source.reference}`).digest("hex").slice(0, 8);
}

export function writeCombo(runDir: string, combo: ComboRecord): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, RECORD), `${JSON.stringify(combo, null, 2)}\n`);
}

export function readCombo(runDir: string): ComboRecord {
  const path = join(runDir, RECORD);
  if (!existsSync(path)) {
    throw new ComboStateError(`No combo record at ${path}`);
  }
  return parseComboRecord(path);
}

export function listCombos(home: string, onCorrupt?: (id: string, error: unknown) => void): ComboRecord[] {
  const runsDir = join(home, "runs");
  if (!existsSync(runsDir)) return [];
  const combos: ComboRecord[] = [];
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(runsDir, entry.name);
    if (!existsSync(join(dir, RECORD))) continue;
    try {
      const combo = readCombo(dir);
      // Consumers rebuild the run dir from combo.id, so an id that does not
      // match its directory silently points them at the wrong run.
      if (combo.id !== entry.name) {
        throw new ComboStateError(`combo record at ${dir} has mismatched id "${combo.id}"`);
      }
      combos.push(combo);
    } catch (error) {
      if (!onCorrupt) throw error;
      onCorrupt(entry.name, error);
    }
  }
  return combos.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function parseComboRecord(path: string): ComboRecord {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    value === null ||
    typeof value !== "object" ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    value.id === "" ||
    !("issueUrl" in value) ||
    typeof value.issueUrl !== "string" ||
    !("repoDir" in value) ||
    typeof value.repoDir !== "string" ||
    value.repoDir.trim() === "" ||
    !("worktree" in value) ||
    typeof value.worktree !== "string" ||
    value.worktree.trim() === "" ||
    !("branch" in value) ||
    typeof value.branch !== "string" ||
    value.branch.trim() === "" ||
    !("tmuxSession" in value) ||
    typeof value.tmuxSession !== "string" ||
    value.tmuxSession.trim() === "" ||
    !("createdAt" in value) ||
    typeof value.createdAt !== "string"
  ) {
    throw new ComboStateError(
      `combo record at ${path} is missing id, issueUrl, repoDir, worktree, branch, tmuxSession, or createdAt`,
    );
  }
  return value as ComboRecord;
}

export function describeWorkItem(
  combo: Pick<ComboRecord, "issueUrl" | "workItemSourceType" | "workItemSourceReference" | "workItemTitle">,
): WorkItemDescriptor {
  const issueUrl = cleanOptional(combo.issueUrl);
  const sourceType = combo.workItemSourceType ?? (issueUrl === undefined ? "unknown" : "github_issue");
  const sourceReference = cleanOptional(combo.workItemSourceReference) ?? issueUrl;
  const title = cleanOptional(combo.workItemTitle);
  const sourceLabel = sourceReference === undefined ? sourceType : `${sourceType}:${sourceReference}`;
  return {
    sourceType,
    ...(sourceReference !== undefined ? { sourceReference } : {}),
    ...(title !== undefined ? { title } : {}),
    label: title === undefined ? sourceLabel : `${title} (${sourceLabel})`,
  };
}

export function cleanOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
// -/ 2/2
