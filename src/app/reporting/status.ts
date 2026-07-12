/**
 * @overview Status helpers for local combo rows plus downstream no-mistakes/GitHub facts.
 *   ~285 lines, 10 exports, parsers for deep recovery status and gate lease visibility.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at deepComboStatus            <- CLI-facing downstream probe orchestration.
 *   2. formatGateLeaseStatus               <- branch-scoped gate owner table cell.
 *   3. parseNoMistakesAxiStatus            <- tolerant TOON-ish parser.
 *   4. deepGithubPrStatus                  <- PR/check/reviewer summary.
 *
 *   MAIN FLOW
 *   ---------
 *   status -> gate lease cells; status --deep -> deepComboStatus -> downstream phrase
 *
 *   PUBLIC API
 *   ----------
 *   PR_READY_FOR_REVIEWER       Downstream phrase for review-ready PRs.
 *   NO_MISTAKES_RUNNING         Downstream phrase prefix for active no-mistakes.
 *   AWAITING_REVIEW_GATE        Downstream phrase prefix for no-mistakes gates.
 *   CommandResult                 Process result shape for injected command runners.
 *   NoMistakesAxiStatus           Parsed subset of no-mistakes status output.
 *   formatGateLeaseStatus         Compact branch-scoped gate lease owner display.
 *   parseNoMistakesAxiStatus      Extract branch, run state, active step, gate IDs, respond command.
 *   noMistakesAxiStatusActive     True when parsed no-mistakes facts prove an active gate.
 *   deepNoMistakesStatus          Run no-mistakes and return a concise downstream status string.
 *   deepComboStatus               Prefer live no-mistakes state, otherwise summarize GitHub PR readiness.
 *
 *   INTERNALS
 *   ---------
 *   PR_CONFLICT_REBASE_REQUIRED, summarizeNoMistakesStatus, deepGithubPrStatus, cleanScalar, unquote, firstLine, shortSha, prHeadDriftStatus
 *
 * @exports PR_READY_FOR_REVIEWER, NO_MISTAKES_RUNNING, AWAITING_REVIEW_GATE, CommandResult, NoMistakesAxiStatus, formatGateLeaseStatus, parseNoMistakesAxiStatus, noMistakesAxiStatusActive, deepNoMistakesStatus, deepComboStatus
 * @deps ../../core/events, ../../core/gate-lease, ../../core/state, ../gate/gate, ../github/checks, ../github/github
 */
import { latestPrUrlFromEvents, type ComboEvent } from "../../core/events.js";
import type { GateLeaseRecord } from "../../core/gate-lease.js";
import type { ComboRecord } from "../../core/state.js";
import { checkRollupSucceeded, requiredChecksSucceeded } from "../github/checks.js";
import { shaMatchesHead } from "../gate/gate.js";
import { blockingReadyMergeState, parsePrView, type GhRunner } from "../github/github.js";

export const PR_READY_FOR_REVIEWER = "PR ready for reviewer";
const PR_CONFLICT_REBASE_REQUIRED = "PR conflict: rebase required";
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
  prUrl?: string;
  localHeadSha?: string;
  requiredCheckNames?: string[];
  ambientCheckNames?: string[];
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
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

function shortSha(sha: string): string {
  return sha.trim().slice(0, 7);
}

function prHeadDriftStatus(
  localHeadSha: string | undefined,
  prHeadSha: string | undefined,
): string | undefined {
  if (localHeadSha === undefined || prHeadSha === undefined || shaMatchesHead(localHeadSha, prHeadSha)) {
    return undefined;
  }
  return `PR head drift: local ${shortSha(localHeadSha)} differs from PR ${shortSha(prHeadSha)}; fetch PR head for review or sync combo worktree`;
}

export function formatGateLeaseStatus(
  lease: GateLeaseRecord | readonly GateLeaseRecord[] | undefined,
): string {
  if (lease === undefined) return "—";
  const leases = Array.isArray(lease) ? lease : [lease];
  if (leases.length === 0) return "—";
  return leases.map((record) => `${record.comboId}@${record.branch}`).join(", ");
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

    if (table === undefined) {
      const branch = /^\s*branch:\s*(.+)\s*$/.exec(line);
      if (branch?.[1] !== undefined) {
        facts.branch = cleanScalar(branch[1]);
        continue;
      }

      const status = /^\s*status:\s*(.+)\s*$/.exec(line);
      if (status?.[1] !== undefined) {
        facts.runStatus = cleanScalar(status[1]).toLowerCase();
        continue;
      }

      const findings = /^\s*findings:\s*(.+)\s*$/.exec(line);
      if (findings?.[1] !== undefined) {
        facts.findingsSummary = cleanScalar(findings[1]);
        continue;
      }
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
function hasAwaitingFindingsSummary(facts: NoMistakesAxiStatus): boolean {
  const awaitingCount = /\b(\d+)\s+await/i.exec(facts.findingsSummary ?? "")?.[1];
  return awaitingCount !== undefined && Number(awaitingCount) > 0;
}

export function noMistakesAxiStatusActive(facts: NoMistakesAxiStatus): boolean {
  return (
    facts.outcome === "awaiting_approval" ||
    hasAwaitingFindingsSummary(facts) ||
    facts.awaitingFindingIds.length > 0 ||
    (facts.runStatus !== undefined && ACTIVE_STATUSES.has(facts.runStatus))
  );
}

function summarizeNoMistakesStatus(facts: NoMistakesAxiStatus, branch: string): string | undefined {
  if (facts.branch !== undefined && facts.branch !== branch) return undefined;

  if (
    facts.outcome === "awaiting_approval" ||
    hasAwaitingFindingsSummary(facts) ||
    facts.awaitingFindingIds.length > 0
  ) {
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

export function deepNoMistakesStatus(
  combo: Pick<ComboRecord, "branch" | "worktree">,
  run: NoMistakesRunner,
): string | undefined {
  const result = run(["axi", "status"], combo.worktree);
  if (result.status !== 0) {
    const detail = firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.status}`;
    return `no-mistakes unavailable: ${detail}`;
  }
  return summarizeNoMistakesStatus(parseNoMistakesAxiStatus(result.stdout), combo.branch);
}
// -/ 3/4

// -- 4/4 CORE · deepComboStatus <- START HERE --
function deepGithubPrStatus(
  prUrl: string | undefined,
  gh: GhRunner,
  options: DeepGithubStatusOptions = {},
): string | undefined {
  if (prUrl === undefined) return undefined;

  const result = gh([
    "pr",
    "view",
    prUrl,
    "--json",
    "headRefOid,state,mergeStateStatus,mergeable,statusCheckRollup",
  ]);
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

  if (pr.state !== "OPEN") {
    return undefined;
  }

  const drift = prHeadDriftStatus(options.localHeadSha, pr.headSha);
  if (drift !== undefined) return drift;

  const blockingMergeState = blockingReadyMergeState(pr);
  if (blockingMergeState !== undefined) return `${PR_CONFLICT_REBASE_REQUIRED} (${blockingMergeState})`;

  if (
    !checkRollupSucceeded(pr.statusCheckRollup, {
      requiredCheckNames: options.requiredCheckNames,
      ambientCheckNames: options.ambientCheckNames,
    }) ||
    !requiredChecksSucceeded(pr.statusCheckRollup, options.requiredCheckNames ?? [])
  ) {
    return undefined;
  }

  return undefined;
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
  return deepGithubPrStatus(options.prUrl ?? latestPrUrlFromEvents(events), gh, options) ?? noMistakes;
}
// -/ 4/4
