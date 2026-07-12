/**
 * @overview Tier-1 verdict artifact: schema-versioned verdict-<round>.json per
 *   local review round (PRD s3/s5). The filename carries the round; the file
 *   carries the reviewed sha, so round attribution never depends on mtimes.
 *   ~230 lines, write-then-rename completeness, fingerprint identity for the
 *   W5b no-progress guard.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at VerdictFile            <- the whole schema in one type.
 *   2. Then readVerdictFile           <- defensive validation of LLM-written JSON.
 *   3. Then findingFingerprints       <- cross-round finding identity semantics.
 *   4. writeVerdictFile is the config-snapshot tmp+rename convention.
 *
 *   MAIN FLOW
 *   ---------
 *   reviewer writes verdict-<round>.json.tmp -> rename -> capsule readVerdictFile
 *
 *   PUBLIC API
 *   ----------
 *   VERDICT_SCHEMA_VERSION   Contract artifact schema version (runtime-ledger precedent).
 *   LOCAL_REVIEW_CHECKLIST   Required review-discipline checklist contract (issue #276).
 *   VerdictFile              Complete verdict artifact shape.
 *   VerdictError             Thrown on missing, torn, or schema-invalid verdicts.
 *   verdictFileName/Path     Well-known fs-watchable location per round.
 *   writeVerdictFile         Atomic write-then-rename persistence.
 *   readVerdictFile          Validated read; throws VerdictError with the defect named.
 *   missingChecklistIds      Contract checklist ids absent from a verdict.
 *   findingFingerprints      Identity keys for one finding (id + location channels).
 *   sameFinding              Two findings are the same if any identity key matches.
 *   normalizeFindingTitle    Title canonicalization used by the location channel.
 *
 *   INTERNALS
 *   ---------
 *   requireString, requireArray, parseFinding, parseChecklistItem,
 *   parseFollowUp, parseAttackRow
 *
 * @exports VERDICT_SCHEMA_VERSION, LOCAL_REVIEW_CHECKLIST, VerdictCode, FindingSeverity, ChecklistStatus, ProducingIdentity, VerdictChecklistItem, VerdictFinding, VerdictFollowUp, VerdictAttackRow, VerdictFile, VerdictError, verdictFileName, verdictFilePath, writeVerdictFile, readVerdictFile, missingChecklistIds, findingFingerprints, sameFinding, normalizeFindingTitle
 * @deps node:{fs,path,process}, ./guards
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pid } from "node:process";

import { isRecord } from "./guards.js";

// -- 1/4 CORE · schema types + checklist contract <- START HERE --
export class VerdictError extends Error {}

/** Contract artifact schema version, following the runtime-ledger precedent. */
export const VERDICT_SCHEMA_VERSION = 1;

export type VerdictCode = 0 | 1 | 2 | 3;
export type FindingSeverity = "blocker" | "major" | "minor" | "note";
export type ChecklistStatus = "pass" | "fail" | "n_a";

/** PRD s4: every artifact declares the identity that produced it. */
export interface ProducingIdentity {
  model: string;
  runtime: string;
}

export interface VerdictChecklistItem {
  id: string;
  status: ChecklistStatus;
  /** Required free text when status is fail: which finding or why n_a. */
  note?: string;
}

export interface VerdictFinding {
  /** Reviewer-assigned stable slug, carried verbatim across rounds. */
  id: string;
  severity: FindingSeverity;
  file: string;
  line?: number;
  title: string;
  body: string;
  /** Critical surface the finding touches, when calibration forced its code. */
  criticalSurface?: string;
}

/** PRD s3: real-but-deferable findings ship here, never prose-only. */
export interface VerdictFollowUp {
  title: string;
  body?: string;
  findingId?: string;
}

export interface VerdictAttackRow {
  attack: string;
  result: "clean" | "finding" | "not_verified";
  findingId?: string;
  note?: string;
}

export interface VerdictFile {
  schemaVersion: typeof VERDICT_SCHEMA_VERSION;
  round: number;
  code: VerdictCode;
  reviewed: { sha: string };
  identity: ProducingIdentity;
  checklist: VerdictChecklistItem[];
  findings: VerdictFinding[];
  followUps: VerdictFollowUp[];
  attackTable?: VerdictAttackRow[];
  notVerified?: string[];
}

/**
 * The review-discipline checklist a verdict must embed (issue #276: a
 * checklist-free verdict is indistinguishable from a diligent one, so it is
 * malformed). Items mirror the repo's standing review discipline.
 */
export const LOCAL_REVIEW_CHECKLIST = [
  { id: "tdd-first", requirement: "Behavior changes carry tests written to fail first." },
  {
    id: "config-discipline",
    requirement: "No new hardcoded operational value without an env or TOML path.",
  },
  {
    id: "surface-budget",
    requirement: "No duplicate helpers; the repo surface was searched before adding any helper.",
  },
  {
    id: "role-boundaries",
    requirement: "No role gains publishing, merging, or another role's authority.",
  },
  {
    id: "journal-integrity",
    requirement: "Journal writes stay append-only and schema-valid; no event rewriting.",
  },
  { id: "compat-debt", requirement: "Compatibility or legacy paths carry a removal issue or date." },
  { id: "docs-headers", requirement: "Sherpa headers and marker maps are current in touched files." },
  {
    id: "tests-contracts",
    requirement: "Assertions pin contracts and behavior, not internal script strings.",
  },
] as const satisfies ReadonlyArray<{ id: string; requirement: string }>;

export function missingChecklistIds(verdict: Pick<VerdictFile, "checklist">): string[] {
  const present = new Set(verdict.checklist.map((item) => item.id));
  return LOCAL_REVIEW_CHECKLIST.map((item) => item.id).filter((id) => !present.has(id));
}
// -/ 1/4

// -- 2/4 CORE · write-then-rename persistence --
export function verdictFileName(round: number): string {
  return `verdict-${round}.json`;
}

export function verdictFilePath(runDir: string, round: number): string {
  return join(runDir, verdictFileName(round));
}

export function writeVerdictFile(runDir: string, verdict: VerdictFile): void {
  const path = verdictFilePath(runDir, verdict.round);
  const tempPath = `${path}.tmp-${pid}-${Date.now()}`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(verdict, null, 2)}\n`);
    renameSync(tempPath, path);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}
// -/ 2/4

// -- 3/4 CORE · validated read --
function fail(defect: string): never {
  throw new VerdictError(`invalid verdict artifact: ${defect}`);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${field} must be a non-empty string`);
  return value;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

function parseChecklistItem(value: unknown, field: string): VerdictChecklistItem {
  if (!isRecord(value)) fail(`${field} must be an object`);
  const status = value["status"];
  if (status !== "pass" && status !== "fail" && status !== "n_a") {
    fail(`${field}.status must be pass, fail, or n_a`);
  }
  const note = optionalString(value["note"], `${field}.note`);
  return {
    id: requireString(value["id"], `${field}.id`),
    status,
    ...(note === undefined ? {} : { note }),
  };
}

function parseFinding(value: unknown, field: string): VerdictFinding {
  if (!isRecord(value)) fail(`${field} must be an object`);
  const severity = value["severity"];
  if (severity !== "blocker" && severity !== "major" && severity !== "minor" && severity !== "note") {
    fail(`${field}.severity must be blocker, major, minor, or note`);
  }
  const line = value["line"];
  if (line !== undefined && (typeof line !== "number" || !Number.isInteger(line) || line < 1)) {
    fail(`${field}.line must be a positive integer`);
  }
  const criticalSurface = optionalString(value["criticalSurface"], `${field}.criticalSurface`);
  return {
    id: requireString(value["id"], `${field}.id`),
    severity,
    file: requireString(value["file"], `${field}.file`),
    ...(line === undefined ? {} : { line }),
    title: requireString(value["title"], `${field}.title`),
    body: requireString(value["body"], `${field}.body`),
    ...(criticalSurface === undefined ? {} : { criticalSurface }),
  };
}

function parseFollowUp(value: unknown, field: string): VerdictFollowUp {
  if (!isRecord(value)) fail(`${field} must be an object`);
  const body = optionalString(value["body"], `${field}.body`);
  const findingId = optionalString(value["findingId"], `${field}.findingId`);
  return {
    title: requireString(value["title"], `${field}.title`),
    ...(body === undefined ? {} : { body }),
    ...(findingId === undefined ? {} : { findingId }),
  };
}

function parseAttackRow(value: unknown, field: string): VerdictAttackRow {
  if (!isRecord(value)) fail(`${field} must be an object`);
  const result = value["result"];
  if (result !== "clean" && result !== "finding" && result !== "not_verified") {
    fail(`${field}.result must be clean, finding, or not_verified`);
  }
  const findingId = optionalString(value["findingId"], `${field}.findingId`);
  const note = optionalString(value["note"], `${field}.note`);
  return {
    attack: requireString(value["attack"], `${field}.attack`),
    result,
    ...(findingId === undefined ? {} : { findingId }),
    ...(note === undefined ? {} : { note }),
  };
}

export function readVerdictFile(runDir: string, round: number): VerdictFile {
  const path = verdictFilePath(runDir, round);
  if (!existsSync(path)) fail(`missing ${verdictFileName(round)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`torn or non-JSON ${verdictFileName(round)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) fail("verdict must be a JSON object");
  if (parsed["schemaVersion"] !== VERDICT_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${VERDICT_SCHEMA_VERSION}`);
  }
  const roundValue = parsed["round"];
  if (typeof roundValue !== "number" || !Number.isInteger(roundValue) || roundValue < 1) {
    fail("round must be a positive integer");
  }
  const code = parsed["code"];
  if (code !== 0 && code !== 1 && code !== 2 && code !== 3) fail("code must be 0, 1, 2, or 3");
  const reviewed = parsed["reviewed"];
  if (!isRecord(reviewed)) fail("reviewed must be an object");
  const identity = parsed["identity"];
  if (!isRecord(identity)) fail("identity must be an object");
  const checklist = requireArray(parsed["checklist"], "checklist").map((item, i) =>
    parseChecklistItem(item, `checklist[${i}]`),
  );
  if (checklist.length === 0) fail("checklist must not be empty (issue #276 contract)");
  const findings = requireArray(parsed["findings"], "findings").map((item, i) =>
    parseFinding(item, `findings[${i}]`),
  );
  const followUps = requireArray(parsed["followUps"], "followUps").map((item, i) =>
    parseFollowUp(item, `followUps[${i}]`),
  );
  const attackTable =
    parsed["attackTable"] === undefined
      ? undefined
      : requireArray(parsed["attackTable"], "attackTable").map((item, i) =>
          parseAttackRow(item, `attackTable[${i}]`),
        );
  const notVerified =
    parsed["notVerified"] === undefined
      ? undefined
      : requireArray(parsed["notVerified"], "notVerified").map((item, i) =>
          requireString(item, `notVerified[${i}]`),
        );
  return {
    schemaVersion: VERDICT_SCHEMA_VERSION,
    round: roundValue,
    code,
    reviewed: { sha: requireString(reviewed["sha"], "reviewed.sha") },
    identity: {
      model: requireString(identity["model"], "identity.model"),
      runtime: requireString(identity["runtime"], "identity.runtime"),
    },
    checklist,
    findings,
    followUps,
    ...(attackTable === undefined ? {} : { attackTable }),
    ...(notVerified === undefined ? {} : { notVerified }),
  };
}
// -/ 3/4

// -- 4/4 CORE · finding fingerprints for the W5b no-progress guard --
/**
 * Canonicalizes a finding title for the location identity channel: lowercase,
 * drop "line NN" references (they drift as the coder edits), collapse
 * punctuation. Digits inside identifiers survive.
 */
export function normalizeFindingTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\b(?:line|lines)\s+\d+(?:\s*[-–]\s*\d+)?\b/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Identity keys for one finding, one per channel: the reviewer-assigned
 * stable id, and file + normalized title as a fallback. Line numbers are
 * deliberately excluded; they drift while the finding survives.
 */
export function findingFingerprints(finding: Pick<VerdictFinding, "id" | "file" | "title">): string[] {
  const prints: string[] = [];
  const id = finding.id.trim();
  if (id !== "") prints.push(`id:${id}`);
  prints.push(`loc:${finding.file}#${normalizeFindingTitle(finding.title)}`);
  return prints;
}

/**
 * Two findings are the same finding when any identity key matches: the id
 * channel survives file moves and retitles, the location channel survives
 * reviewer id churn. The W5b no-progress guard keys on this.
 */
export function sameFinding(
  a: Pick<VerdictFinding, "id" | "file" | "title">,
  b: Pick<VerdictFinding, "id" | "file" | "title">,
): boolean {
  const keys = new Set(findingFingerprints(a));
  return findingFingerprints(b).some((key) => keys.has(key));
}
// -/ 4/4
