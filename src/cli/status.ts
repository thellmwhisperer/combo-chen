/**
 * @overview Status helpers for local combo rows plus downstream no-mistakes/GitHub facts.
 *   ~239 lines, 8 exports, parsers for deep recovery status.
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
 *   PR_READY_FOR_REVIEWER       Downstream phrase for review-ready PRs.
 *   NO_MISTAKES_RUNNING         Downstream phrase prefix for active no-mistakes.
 *   AWAITING_REVIEW_GATE        Downstream phrase prefix for no-mistakes gates.
 *   CommandResult                 Process result shape for injected command runners.
 *   NoMistakesAxiStatus           Parsed subset of no-mistakes status output.
 *   parseNoMistakesAxiStatus      Extract branch, run state, active step, gate IDs, respond command.
 *   deepNoMistakesStatus          Run no-mistakes and return a concise downstream status string.
 *   deepComboStatus               Prefer live no-mistakes state, otherwise summarize GitHub PR readiness.
 *
 *   INTERNALS
 *   ---------
 *   summarizeNoMistakesStatus, deepGithubPrStatus, cleanScalar, unquote, firstLine
 *
 * @exports PR_READY_FOR_REVIEWER, NO_MISTAKES_RUNNING, AWAITING_REVIEW_GATE, CommandResult, NoMistakesAxiStatus, parseNoMistakesAxiStatus, deepNoMistakesStatus, deepComboStatus
 * @deps ../core/events, ../core/state, ./checks, ./github
 */
import { latestPrUrlFromEvents, type ComboEvent } from "../core/events.js";
import type { ComboRecord } from "../core/state.js";
import { checkRollupSucceeded, requiredChecksSucceeded } from "./checks.js";
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
interface DeepGithubStatusOptions {
  requiredCheckNames?: string[];
  ambientCheckNames?: string[];
  reviewerLogins?: string[];
}

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

    const outcome = /^\s*outcome:\s*(.+)\s*$/.exec(line);
    if (outcome?.[1] !== undefined) {
      facts.outcome = cleanScalar(outcome[1]).toLowerCase();
      continue;
    }

    const nextStep = /^\s*next_step:\s*(.+)\s*$/.exec(line);
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

  const awaitingCount = /\b(\d+)\s+await/i.exec(facts.findingsSummary ?? "")?.[1];
  const hasAwaitingSummary = awaitingCount !== undefined && Number(awaitingCount) > 0;
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
function shaMatchesHead(candidate: string | undefined, headSha: string): boolean {
  if (candidate === undefined) return false;
  const pin = candidate.trim().toLowerCase();
  const head = headSha.trim().toLowerCase();
  return pin.length >= 7 && (pin === head || head.startsWith(pin));
}

function deepGithubPrStatus(prUrl: string | undefined, gh: GhRunner, options: DeepGithubStatusOptions = {}): string | undefined {
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

  if (
    pr.state !== "OPEN" ||
    !checkRollupSucceeded(pr.statusCheckRollup, { requiredCheckNames: options.requiredCheckNames, ambientCheckNames: options.ambientCheckNames }) ||
    !requiredChecksSucceeded(pr.statusCheckRollup, options.requiredCheckNames ?? [])
  ) {
    return undefined;
  }

  let reviewerPin: string | undefined;
  try {
    reviewerPin = latestGitHubLgtmSha(gh, prUrl, undefined, {
      allowedAuthors: options.reviewerLogins,
    });
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
  options: DeepGithubStatusOptions = {},
): string | undefined {
  const noMistakes = deepNoMistakesStatus(combo, run);
  if (noMistakes !== undefined && !noMistakes.startsWith("no-mistakes unavailable:")) {
    return noMistakes;
  }
  return deepGithubPrStatus(latestPrUrlFromEvents(events), gh, options) ?? noMistakes;
}
// -/ 4/4
