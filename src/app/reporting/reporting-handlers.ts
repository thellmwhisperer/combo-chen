/**
 * @overview Application handlers for status, recap, needs-human metrics, and forensics reports.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at showStatus           <- live capsule dashboard.
 *   2. Then showRecap                <- since-you-left journal digest.
 *   3. Then showForensics            <- evidence-rich outcome reports.
 *   4. Use reportNeedsHuman          <- aggregate intervention metrics.
 *
 *   MAIN FLOW
 *   ---------
 *   persisted combos -> journal/runtime probes -> report model -> operator output
 *
 *   PUBLIC API
 *   ----------
 *   showStatus, showRecap, showForensics, reportNeedsHuman
 *
 *   INTERNALS
 *   ---------
 *   needs-human aggregation; forensics parsing/recording; tmux and local-head probes.
 *
 * @exports showStatus, showRecap, showForensics, reportNeedsHuman
 * @deps ../../core/events, ../../core/gate-lease, ../../core/guards, ../../core/runtime-ledger, ../../core/state, ../../infra/config-snapshot, ../../infra/tmux, ../deps, ../github/github, ../lifecycle/reconcile, ./forensics, ./status, ./status-fold
 */
import { appendEvent, latestPrUrlFromEvents, readEvents, type ComboEvent } from "../../core/events.js";
import { readGateLeases } from "../../core/gate-lease.js";
import { errorMessage } from "../../core/guards.js";
import { readRuntimeLedger } from "../../core/runtime-ledger.js";
import {
  comboHome,
  describeWorkItem,
  listCombos,
  parseIssueUrl,
  runDirFor,
  type ComboRecord,
} from "../../core/state.js";
import { loadRuntimeConfig } from "../../infra/config-snapshot.js";
import { hasSessionArgs, listWindowsArgs } from "../../infra/tmux.js";
import {
  analyzeForensicsCombo,
  renderForensicsMarkdown,
  renderForensicsOutcomeMarkdown,
} from "./forensics.js";
import { fetchForensicsGithubFacts } from "../github/github.js";
import { reconcileCombos } from "../lifecycle/reconcile.js";
import { deepComboStatus, formatGateLeaseStatus } from "./status.js";
import { deriveRecap, deriveStatusSurface, renderRecap } from "./status-fold.js";
import type { AppDeps } from "../deps.js";

// -- 1/4 CORE · showStatus <- START HERE --
export async function showStatus(
  deps: AppDeps,
  options: { deep?: boolean; all?: boolean },
  cli: string,
): Promise<void> {
  const home = comboHome(deps.env);
  await reconcileCombos({ deps, home, apply: true, quiet: true, mergedTeardown: false });
  const gateLeases = readGateLeases(home);
  const combos = listCombos(home, (id, error) => deps.out("skipped " + id + ": " + errorMessage(error)));
  if (combos.length === 0) {
    if (gateLeases.length > 0) deps.out("active gate leases: " + formatGateLeaseStatus(gateLeases));
    deps.out("no combos. start one: combo-chen run --issue <url> (or --plan <file>)");
    return;
  }
  const rows = combos.map((combo) => {
    const runDir = runDirFor(home, combo.id);
    const ledger = readRuntimeLedger(runDir, { cli });
    let events = readEvents(runDir);
    let row = deriveStatusSurface({ combo, events, runtimePrUrl: ledger.prUrl });
    if (!isParked(events) && row.status.phase !== "STOPPED" && !row.status.needsHuman) {
      row = deriveStatusSurface({
        combo,
        events,
        runtimePrUrl: ledger.prUrl,
        probes: { sessionExists: deps.tmux(hasSessionArgs(combo.tmuxSession)).status === 0 },
      });
      if (row.processRepair !== undefined) {
        appendEvent(runDir, row.processRepair.event, {
          reason: row.processRepair.reason,
          source: "status",
        });
        events = readEvents(runDir);
        row = deriveStatusSurface({ combo, events, runtimePrUrl: ledger.prUrl });
      }
    }
    return { combo, events, status: row.status, runtimePrUrl: row.prUrl };
  });
  const visibleRows = options.all === true ? rows : rows.filter(({ status }) => status.phase !== "STOPPED");
  if (visibleRows.length === 0) {
    if (gateLeases.length > 0) deps.out("active gate leases: " + formatGateLeaseStatus(gateLeases));
    deps.out("no actionable combos. show history: combo-chen status --all");
    return;
  }
  const deep = options.deep === true;
  const header =
    "CAPSULE".padEnd(30) +
    " " +
    "PHASE".padEnd(9) +
    " " +
    "NEEDS-HUMAN".padEnd(16) +
    " " +
    "WORK ITEM".padEnd(40) +
    " " +
    "GATE-LEASE".padEnd(28) +
    " PR";
  deps.out(deep ? header + " DOWNSTREAM" : header);
  for (const { combo, events, status, runtimePrUrl } of visibleRows) {
    const needs = status.needsHuman ? (status.reason ?? "yes") : "—";
    const prUrl = status.pr ?? runtimePrUrl;
    const pr = prUrl ?? "—";
    const workItem = describeWorkItem(combo).label;
    const lease = formatGateLeaseStatus(gateLeases.find((record) => record.branch === combo.branch));
    const line =
      combo.id.padEnd(30) +
      " " +
      status.phase.padEnd(9) +
      " " +
      needs.padEnd(16) +
      " " +
      workItem.padEnd(40) +
      " " +
      lease.padEnd(28) +
      " " +
      pr;
    if (!deep) {
      deps.out(line);
      continue;
    }
    const runDir = runDirFor(home, combo.id);
    const config = loadRuntimeConfig(runDir, { repoDir: combo.repoDir, env: deps.env });
    const downstream = deepComboStatus(combo, events, deps.noMistakes, deps.gh, {
      prUrl,
      localHeadSha: collectLocalWorktreeHeadSha(deps, combo),
      requiredCheckNames: config.readyRequiredChecks,
      ambientCheckNames: config.externalCommentAgents,
      reviewerLogins: config.reviewerLogins,
    });
    deps.out(line + " " + (downstream ?? "—"));
  }
}
// -/ 1/4

// -- 2/4 CORE · showRecap --
export function showRecap(
  deps: Pick<AppDeps, "env" | "out">,
  options: { name?: string; since?: string },
): void {
  if (options.since !== undefined && !Number.isFinite(Date.parse(options.since))) {
    throw new Error(`Invalid --since timestamp: ${options.since}`);
  }
  const home = comboHome(deps.env);
  const combos = listCombos(home, (id, error) =>
    deps.out("skipped " + id + ": " + errorMessage(error)),
  ).filter((combo) => options.name === undefined || combo.id === options.name);
  deps.out(
    renderRecap(
      combos.map((combo) =>
        deriveRecap({
          combo,
          events: readEvents(runDirFor(home, combo.id)),
          ...(options.since !== undefined ? { since: options.since } : {}),
        }),
      ),
    ),
  );
}
// -/ 2/4

// -- 3/4 CORE · showForensics --
export async function showForensics(
  deps: AppDeps,
  options: { issues?: string; name?: string; format: string; recordOutcome?: boolean },
): Promise<void> {
  const home = comboHome(deps.env);
  const issueFilter = parseForensicsIssueFilter(options.issues);
  const format = parseForensicsFormat(options.format);
  if (options.recordOutcome && format === "json") {
    throw new Error("--record-outcome cannot be combined with --format json");
  }
  const combos = listCombos(home, (id, error) =>
    deps.out("skipped " + id + ": " + errorMessage(error)),
  ).filter((combo) => {
    if (options.name !== undefined && combo.id !== options.name) return false;
    if (issueFilter === undefined) return true;
    try {
      return issueFilter.has(parseIssueUrl(combo.issueUrl).number);
    } catch {
      return false;
    }
  });
  const reports = combos.map((combo) => {
    const runDir = runDirFor(home, combo.id);
    const events = readEvents(runDir);
    const config = loadRuntimeConfig(runDir, { repoDir: combo.repoDir, env: deps.env });
    return analyzeForensicsCombo({
      combo,
      events,
      local: { worktreeHeadSha: collectLocalWorktreeHeadSha(deps, combo) },
      github: fetchForensicsGithubFacts(
        deps.gh,
        combo.issueUrl.trim() === "" ? undefined : combo.issueUrl,
        latestPrUrlFromEvents(events),
        undefined,
        {
          requiredCheckNames: config.readyRequiredChecks,
          ambientCheckNames: config.externalCommentAgents,
          reviewerLogins: config.reviewerLogins,
        },
      ),
      tmux: collectForensicsTmuxFacts(deps, combo),
    });
  });

  if (format === "json") {
    deps.out(JSON.stringify({ reports }, null, 2));
    return;
  }
  if (reports.length === 0) {
    deps.out(renderForensicsMarkdown(reports) + "\n\n" + formatForensicsNoMatches(options.name, issueFilter));
    return;
  }
  if (options.recordOutcome) {
    recordForensicsOutcomes(deps, reports);
  }
  deps.out(renderForensicsMarkdown(reports));
}
// -/ 3/4

// -- 4/4 CORE · reportNeedsHuman and report helpers --
export function reportNeedsHuman(deps: Pick<AppDeps, "env" | "out">): void {
  const home = comboHome(deps.env);
  const counts = new Map<string, number>();
  let total = 0;
  let workerStalledTotal = 0;
  let workerStalledCompletedWithoutHuman = 0;
  const combos = listCombos(home, (id, error) => deps.out("skipped " + id + ": " + errorMessage(error)));
  for (const combo of combos) {
    try {
      const events = readEvents(runDirFor(home, combo.id));
      const stalledCompletion = workerStalledNormalCompletionCount(events);
      workerStalledTotal += stalledCompletion.total;
      workerStalledCompletedWithoutHuman += stalledCompletion.completedWithoutHuman;
      for (const event of events) {
        if (event.event !== "needs_human") continue;
        const reason = needsHumanReason(event) ?? "unknown";
        counts.set(reason, (counts.get(reason) ?? 0) + 1);
        total += 1;
      }
    } catch (error) {
      deps.out("skipped " + combo.id + ": " + errorMessage(error));
    }
  }
  deps.out("needs_human total: " + total);
  for (const [reason, count] of Array.from(counts).sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )) {
    deps.out(reason + ": " + count);
  }
  if (workerStalledTotal > 0) {
    deps.out(
      "worker_stalled followed by normal completion without human action: " +
        workerStalledCompletedWithoutHuman +
        "/" +
        workerStalledTotal,
    );
  }
}

type ForensicsFormat = "markdown" | "json";
const NORMAL_COMPLETION_EVENTS = new Set<ComboEvent["event"]>(["ready_for_merge", "merged", "combo_closed"]);

function isParked(events: ComboEvent[]): boolean {
  return events.at(-1)?.event === "parked";
}

function needsHumanReason(event: ComboEvent): string | undefined {
  if (event.event !== "needs_human") return undefined;
  return typeof event["reason"] === "string" ? event["reason"] : "unknown";
}

function workerStalledNormalCompletionCount(events: ComboEvent[]): {
  total: number;
  completedWithoutHuman: number;
} {
  let total = 0;
  let completedWithoutHuman = 0;
  for (let index = 0; index < events.length; index += 1) {
    if (needsHumanReason(events[index]!) !== "worker_stalled") continue;
    total += 1;
    if (hasNormalCompletionBeforeNextHumanRequest(events, index + 1)) {
      completedWithoutHuman += 1;
    }
  }
  return { total, completedWithoutHuman };
}

function hasNormalCompletionBeforeNextHumanRequest(events: ComboEvent[], startIndex: number): boolean {
  for (const event of events.slice(startIndex)) {
    if (NORMAL_COMPLETION_EVENTS.has(event.event)) return true;
    if (event.event === "needs_human") return false;
  }
  return false;
}

function parseForensicsFormat(value: string): ForensicsFormat {
  if (value === "markdown" || value === "json") return value;
  throw new Error('--format must be "markdown" or "json"');
}

function parseForensicsIssueFilter(value: string | undefined): Set<number> | undefined {
  if (value === undefined) return undefined;
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) throw new Error("--issues must include at least one issue number");
  const numbers = new Set<number>();
  for (const part of parts) {
    const number = Number(part);
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error("Invalid issue number in --issues: " + part);
    }
    numbers.add(number);
  }
  return numbers;
}

function formatForensicsNoMatches(name: string | undefined, issueFilter: Set<number> | undefined): string {
  if (name !== undefined) {
    return "No matching combo for -n " + name + " in this COMBO_CHEN_HOME.";
  }
  if (issueFilter !== undefined) {
    const issues = Array.from(issueFilter)
      .sort((left, right) => left - right)
      .join(",");
    return [
      "No matching issue-backed combos for --issues " + issues + " in this COMBO_CHEN_HOME.",
      "Use -n <combo-id> for plan-backed runs or rerun after launch.",
    ].join("\n");
  }
  return "No combos found in this COMBO_CHEN_HOME.";
}

function recordForensicsOutcomes(
  deps: Pick<AppDeps, "gh" | "out">,
  reports: ReturnType<typeof analyzeForensicsCombo>[],
): void {
  const failures: string[] = [];
  const recorded: string[] = [];
  for (const report of reports) {
    try {
      if (report.issueUrl.trim() === "") {
        throw new Error("combo has no GitHub issue URL");
      }
      const missing = missingOutcomeEvidence(report);
      if (missing.length > 0) {
        throw new Error("missing " + missing.join(" and "));
      }
      const body = renderForensicsOutcomeMarkdown(report);
      const result = deps.gh(["issue", "comment", report.issueUrl, "--body", body]);
      if (result.status !== 0) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || "gh issue comment failed");
      }
      recorded.push(report.id);
      deps.out("forensics: recorded outcome for " + report.id + " on " + report.issueUrl);
    } catch (error) {
      failures.push(report.id + ": " + errorMessage(error));
    }
  }
  if (failures.length > 0) {
    const recordedSummary = recorded.length === 0 ? "" : "\nRecorded outcome(s): " + recorded.join(", ");
    throw new Error("Failed to record forensics outcome(s):\n" + failures.join("\n") + recordedSummary);
  }
}

function missingOutcomeEvidence(report: ReturnType<typeof analyzeForensicsCombo>): string[] {
  const missing: string[] = [];
  if (report.prUrl === undefined) missing.push("PR link");
  if (report.gates.reviewer.headSha === undefined) missing.push("head SHA");
  return missing;
}

function collectForensicsTmuxFacts(
  deps: AppDeps,
  combo: ComboRecord,
): { sessionExists: boolean; windows?: string[] } | undefined {
  try {
    const sessionExists = deps.tmux(hasSessionArgs(combo.tmuxSession)).status === 0;
    if (!sessionExists) return { sessionExists: false, windows: [] };
    const listed = deps.tmux(listWindowsArgs(combo.tmuxSession));
    if (listed.status !== 0) return { sessionExists: true };
    return {
      sessionExists: true,
      windows: listed.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    };
  } catch {
    return undefined;
  }
}

function collectLocalWorktreeHeadSha(
  deps: Pick<AppDeps, "git">,
  combo: Pick<ComboRecord, "worktree">,
): string | undefined {
  try {
    const result = deps.git(["rev-parse", "HEAD"], combo.worktree);
    if (result.status !== 0) return undefined;
    const head = result.stdout.trim().split(/\r?\n/)[0]?.trim();
    return head === undefined || head === "" ? undefined : head;
  } catch {
    return undefined;
  }
}
// -/ 4/4
