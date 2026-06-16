/**
 * @overview Status helpers for local combo rows plus downstream no-mistakes facts.
 *   ~120 lines, 4 exports, one parser for `no-mistakes axi status`.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at deepNoMistakesStatus       <- CLI-facing probe + summary.
 *   2. parseNoMistakesAxiStatus            <- tolerant TOON-ish parser.
 *   3. summarizeNoMistakesStatus           <- user-facing downstream phrase.
 *
 *   MAIN FLOW
 *   ---------
 *   status --deep -> deepNoMistakesStatus -> no-mistakes axi status -> parser -> summary
 *
 *   PUBLIC API
 *   ----------
 *   CommandResult                 Process result shape for injected command runners.
 *   NoMistakesAxiStatus           Parsed subset of no-mistakes status output.
 *   parseNoMistakesAxiStatus      Extract branch, run state, active step, gate IDs, respond command.
 *   deepNoMistakesStatus          Run no-mistakes and return a concise downstream status string.
 *
 *   INTERNALS
 *   ---------
 *   summarizeNoMistakesStatus, cleanScalar, unquote, firstLine
 *
 * @exports CommandResult, NoMistakesAxiStatus, parseNoMistakesAxiStatus, deepNoMistakesStatus
 * @deps ../core/state
 */
import type { ComboRecord } from "../core/state.js";

// -- 1/3 HELPER · Types + scalar parsing --
export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface NoMistakesAxiStatus {
  branch?: string;
  runStatus?: string;
  activeStep?: string;
  outcome?: string;
  findingsSummary?: string;
  awaitingFindingIds: string[];
  nextStep?: string;
}

type NoMistakesRunner = (args: string[], cwd: string) => CommandResult;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function cleanScalar(value: string): string {
  return unquote(value).trim();
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/)[0]?.trim() ?? "";
}
// -/ 1/3

// -- 2/3 CORE · parseNoMistakesAxiStatus --
const ACTIVE_STATUSES = new Set(["active", "in_progress", "running"]);

export function parseNoMistakesAxiStatus(raw: string): NoMistakesAxiStatus {
  const facts: NoMistakesAxiStatus = { awaitingFindingIds: [] };
  let table: "steps" | "findings" | undefined;

  for (const line of raw.split(/\r?\n/)) {
    if (/^steps\[\d+\]\{/.test(line.trim())) {
      table = "steps";
      continue;
    }
    if (/^findings\[\d+\]\{/.test(line.trim())) {
      table = "findings";
      continue;
    }
    if (/^\S/.test(line) && !/^[-\w]+:/.test(line.trim())) table = undefined;

    const branch = /^\s{2}branch:\s*(.+)\s*$/.exec(line);
    if (branch?.[1] !== undefined) {
      facts.branch = cleanScalar(branch[1]);
      continue;
    }

    const status = /^\s{2}status:\s*(.+)\s*$/.exec(line);
    if (status?.[1] !== undefined) {
      facts.runStatus = cleanScalar(status[1]).toLowerCase();
      continue;
    }

    const findings = /^\s{2}findings:\s*(.+)\s*$/.exec(line);
    if (findings?.[1] !== undefined) {
      facts.findingsSummary = cleanScalar(findings[1]);
      continue;
    }

    const outcome = /^outcome:\s*(.+)\s*$/.exec(line);
    if (outcome?.[1] !== undefined) {
      facts.outcome = cleanScalar(outcome[1]).toLowerCase();
      continue;
    }

    const nextStep = /^next_step:\s*(.+)\s*$/.exec(line);
    if (nextStep?.[1] !== undefined) {
      facts.nextStep = cleanScalar(nextStep[1]);
      continue;
    }

    const row = /^\s+([^,\s]+)\s*,\s*([^,\s]+)\s*,?/.exec(line);
    if (row?.[1] === undefined || row[2] === undefined) continue;
    const first = row[1].trim();
    const rowStatus = row[2].trim().toLowerCase();
    if (table === "steps" && facts.activeStep === undefined && ACTIVE_STATUSES.has(rowStatus)) {
      facts.activeStep = first.toLowerCase();
    }
    if (table === "findings" && rowStatus.includes("await")) {
      facts.awaitingFindingIds.push(first);
    }
  }

  return facts;
}
// -/ 2/3

// -- 3/3 CORE · deepNoMistakesStatus <- START HERE --
function summarizeNoMistakesStatus(facts: NoMistakesAxiStatus, branch: string): string | undefined {
  if (facts.branch !== undefined && facts.branch !== branch) return undefined;

  const hasAwaitingSummary = facts.findingsSummary?.toLowerCase().includes("await") ?? false;
  if (facts.outcome === "awaiting_approval" || hasAwaitingSummary || facts.awaitingFindingIds.length > 0) {
    const ids = facts.awaitingFindingIds.length > 0 ? `: ${facts.awaitingFindingIds.join(", ")}` : "";
    const respond = facts.nextStep !== undefined ? `; respond: ${facts.nextStep}` : "";
    return `awaiting review gate${ids}${respond}`;
  }

  if (facts.runStatus !== undefined && ACTIVE_STATUSES.has(facts.runStatus)) {
    return facts.activeStep === undefined
      ? "no-mistakes running"
      : `no-mistakes running ${facts.activeStep}`;
  }

  return undefined;
}

export function deepNoMistakesStatus(combo: Pick<ComboRecord, "branch" | "worktree">, run: NoMistakesRunner): string | undefined {
  const result = run(["axi", "status"], combo.worktree);
  if (result.status !== 0) {
    const detail = firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.status}`;
    return `no-mistakes unavailable: ${detail}`;
  }
  return summarizeNoMistakesStatus(parseNoMistakesAxiStatus(result.stdout), combo.branch);
}
// -/ 3/3
