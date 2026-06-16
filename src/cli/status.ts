/**
 * @overview Status helpers for local combo rows plus downstream no-mistakes/GitHub facts.
 *   ~250 lines, 5 exports, parsers for deep recovery status.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at deepComboStatus            <- CLI-facing downstream probe orchestration.
 *   2. parseNoMistakesAxiStatus            <- tolerant TOON-ish parser.
 *   3. deepGithubPrStatus                  <- PR/check/reviewer summary.
 *
 *   MAIN FLOW
 *   ---------
 *   status --deep -> deepComboStatus -> no-mistakes/GitHub probes -> downstream phrase
 *
 *   PUBLIC API
 *   ----------
 *   CommandResult                 Process result shape for injected command runners.
 *   NoMistakesAxiStatus           Parsed subset of no-mistakes status output.
 *   parseNoMistakesAxiStatus      Extract branch, run state, active step, gate IDs, respond command.
 *   deepNoMistakesStatus          Run no-mistakes and return a concise downstream status string.
 *   deepComboStatus               Prefer live no-mistakes state, otherwise summarize GitHub PR readiness.
 *
 *   INTERNALS
 *   ---------
 *   summarizeNoMistakesStatus, deepGithubPrStatus, check helpers, cleanScalar, unquote, firstLine
 *
 * @exports CommandResult, NoMistakesAxiStatus, parseNoMistakesAxiStatus, deepNoMistakesStatus, deepComboStatus
 * @deps ../core/events, ../core/state, ./github
 */
import { latestPrUrlFromEvents, type ComboEvent } from "../core/events.js";
import type { ComboRecord } from "../core/state.js";
import { latestGitHubLgtmSha, parsePrView, type GhRunner } from "./github.js";

export const PR_READY_FOR_REVIEWER = "PR ready for reviewer";
export const NO_MISTAKES_RUNNING = "no-mistakes running";
export const AWAITING_REVIEW_GATE = "awaiting review gate";

// -- 1/4 HELPER · Types + scalar parsing --
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
// -/ 1/4

// -- 2/4 CORE · parseNoMistakesAxiStatus --
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
// -/ 2/4

// -- 3/4 CORE · deepNoMistakesStatus --
function summarizeNoMistakesStatus(facts: NoMistakesAxiStatus, branch: string): string | undefined {
  if (facts.branch !== undefined && facts.branch !== branch) return undefined;

  const hasAwaitingSummary = facts.findingsSummary?.toLowerCase().includes("await") ?? false;
  if (facts.outcome === "awaiting_approval" || hasAwaitingSummary || facts.awaitingFindingIds.length > 0) {
    const ids = facts.awaitingFindingIds.length > 0 ? `: ${facts.awaitingFindingIds.join(", ")}` : "";
    const respond = facts.nextStep !== undefined ? `; respond: ${facts.nextStep}` : "";
    return `${AWAITING_REVIEW_GATE}${ids}${respond}`;
  }

  if (facts.runStatus !== undefined && ACTIVE_STATUSES.has(facts.runStatus)) {
    return facts.activeStep === undefined
      ? NO_MISTAKES_RUNNING
      : `${NO_MISTAKES_RUNNING} ${facts.activeStep}`;
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
// -/ 3/4

// -- 4/4 CORE · deepComboStatus <- START HERE --
const SUCCESSFUL_CHECK_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const SUCCESSFUL_STATUS_STATES = new Set(["SUCCESS", "COMPLETED"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function upperString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim().toUpperCase() : undefined;
}

function checkName(item: unknown): string {
  if (!isRecord(item)) return "";
  const parts = [item["name"], item["context"], item["workflowName"]];
  const app = item["app"];
  if (isRecord(app)) parts.push(app["name"], app["slug"]);
  return parts.filter((part): part is string => typeof part === "string").join(" ");
}

function isCodeRabbitCheck(item: unknown): boolean {
  return checkName(item).toLowerCase().includes("coderabbit");
}

function checkSignalSucceeded(item: unknown): boolean {
  if (!isRecord(item)) return false;
  const conclusion = upperString(item["conclusion"]);
  if (conclusion !== undefined) return SUCCESSFUL_CHECK_CONCLUSIONS.has(conclusion);
  const state = upperString(item["state"] ?? item["status"]);
  if (state !== undefined) return SUCCESSFUL_STATUS_STATES.has(state);
  return false;
}

function nonCodeRabbitChecksSucceeded(rollup: unknown[] | undefined): boolean {
  if (rollup === undefined) return false;
  const checks = rollup.filter((item) => !isCodeRabbitCheck(item));
  return checks.length > 0 && checks.every(checkSignalSucceeded);
}

function shaMatchesHead(candidate: string | undefined, headSha: string): boolean {
  if (candidate === undefined) return false;
  const pin = candidate.trim().toLowerCase();
  const head = headSha.trim().toLowerCase();
  return pin.length >= 7 && (pin === head || head.startsWith(pin));
}

function deepGithubPrStatus(prUrl: string | undefined, gh: GhRunner): string | undefined {
  if (prUrl === undefined) return undefined;

  const result = gh(["pr", "view", prUrl, "--json", "headRefOid,state,statusCheckRollup"]);
  if (result.status !== 0) {
    const detail = firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.status}`;
    return `GitHub unavailable: ${detail}`;
  }

  let pr;
  try {
    pr = parsePrView(result.stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `GitHub unavailable: ${firstLine(detail)}`;
  }

  if (pr.state !== "OPEN" || !nonCodeRabbitChecksSucceeded(pr.statusCheckRollup)) return undefined;

  let reviewerPin: string | undefined;
  try {
    reviewerPin = latestGitHubLgtmSha(gh, prUrl);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `GitHub review unavailable: ${firstLine(detail)}`;
  }
  return shaMatchesHead(reviewerPin, pr.headSha) ? undefined : PR_READY_FOR_REVIEWER;
}

export function deepComboStatus(
  combo: Pick<ComboRecord, "branch" | "worktree">,
  events: ComboEvent[],
  run: NoMistakesRunner,
  gh: GhRunner,
): string | undefined {
  const noMistakes = deepNoMistakesStatus(combo, run);
  if (noMistakes !== undefined && !noMistakes.startsWith("no-mistakes unavailable:")) {
    return noMistakes;
  }
  return deepGithubPrStatus(latestPrUrlFromEvents(events), gh) ?? noMistakes;
}
// -/ 4/4
