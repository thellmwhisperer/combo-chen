/**
 * @overview Director-watch operator status line formatter. ~260 lines,
 *   pure timeline/checklist rendering for tmux panes.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at buildDirectorWatchStatusLine <- one concise per-tick line.
 *   2. Then readiness helpers              <- gate/reviewer/check facts.
 *   3. Finish with duration/worker helpers <- deterministic human text.
 *
 *   MAIN FLOW
 *   ---------
 *   director-watch tick facts -> deriveStatus/events -> tmux-friendly line
 *
 *   PUBLIC API
 *   ----------
 *   DirectorWatchPrSnapshot        Best-effort GitHub PR facts for display.
 *   DirectorWatchStatusLineInput   Pure formatter inputs.
 *   buildDirectorWatchStatusLine   Render one operator status line.
 *
 * @exports DirectorWatchPrSnapshot, DirectorWatchStatusLineInput, buildDirectorWatchStatusLine
 * @deps ../core/{combo,events}, ./checks, ./gate, ./reviewer
 */
import { deriveStatus, type ComboStatus } from "../core/combo.js";
import { latestPrUrlFromEvents, type ComboEvent } from "../core/events.js";
import { checkRollupSucceeded, requiredChecksSucceeded } from "./checks.js";
import { latestGateStatus, latestPublishedGateSha, shaMatchesHead } from "./gate.js";
import { livePinnedLgtmSha } from "./reviewer.js";

// -- 1/3 CORE · buildDirectorWatchStatusLine <- START HERE --
export interface DirectorWatchPrSnapshot {
  state: string;
  headSha?: string;
  statusCheckRollup?: unknown[];
  polledAt?: Date;
  error?: string;
}

export interface DirectorWatchStatusLineInput {
  comboId: string;
  cli: string;
  events: ComboEvent[];
  now: Date;
  pollSeconds: number;
  pr?: DirectorWatchPrSnapshot;
  workerSummaries?: string[];
  readyRequiredChecks?: string[];
  ambientCheckNames?: string[];
}

export function buildDirectorWatchStatusLine(input: DirectorWatchStatusLineInput): string {
  const status = deriveStatus(input.events);
  const readiness = readinessFacts(input);
  const fields = [
    `director: watch ${input.now.toISOString()}`,
    `combo=${input.comboId}`,
    `phase=${phaseLabel(status)} age=${phaseAge(input.events, input.now)}`,
    `pr=${formatPr(input.pr, latestPrUrlFromEvents(input.events))}`,
    `last=${formatLastEvent(input.events, input.now)}`,
    `gh=${formatGithubPoll(input.pr, input.pollSeconds, input.now)}`,
    `workers=${formatWorkerSummaries(input.workerSummaries ?? [], input.pollSeconds)}`,
    `gate=${formatGateStatus(input.events)}`,
    `reviewer=${formatReviewerStatus(input.events)}`,
    `ready=[${formatReadiness(readiness)}]`,
    `action="${pendingAction(input, status, readiness)}"`,
  ];
  return fields.join(" | ");
}
// -/ 1/3

// -- 2/3 HELPER · Readiness, phase, and action summaries --
interface ReadinessFacts {
  pr: "yes" | "no" | "unknown";
  gate: "yes" | "no" | "unknown";
  reviewer: "yes" | "no" | "unknown";
  checks: "yes" | "no" | "unknown";
  ci: "yes" | "no" | "unknown";
}

function phaseLabel(status: ComboStatus): string {
  if (status.needsHuman && status.reason !== undefined) return `${status.phase}/${status.reason}`;
  return status.phase;
}

function statusKey(status: ComboStatus): string {
  return `${status.phase}:${status.needsHuman ? status.reason ?? "" : ""}`;
}

function phaseAge(events: ComboEvent[], now: Date): string {
  if (events.length === 0) return "0s";
  const finalKey = statusKey(deriveStatus(events));
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const previousKey = statusKey(deriveStatus(events.slice(0, i)));
    if (previousKey !== finalKey) return ageSince(events[i]!.t, now);
  }
  return ageSince(events[0]!.t, now);
}

function formatPr(pr: DirectorWatchPrSnapshot | undefined, prUrl: string | undefined): string {
  if (pr !== undefined) {
    return pr.headSha === undefined ? pr.state : `${pr.state}@${shortSha(pr.headSha)}`;
  }
  return prUrl === undefined ? "none" : "unknown";
}

function formatLastEvent(events: ComboEvent[], now: Date): string {
  const last = events[events.length - 1];
  if (last === undefined) return "none";
  return `${last.event} age=${ageSince(last.t, now)}`;
}

function formatGithubPoll(
  pr: DirectorWatchPrSnapshot | undefined,
  pollSeconds: number,
  now: Date,
): string {
  const next = `next=${formatDuration(pollSeconds * 1000)}`;
  if (pr?.polledAt !== undefined) {
    const error = pr.error === undefined ? "" : ` error:${compact(pr.error)}`;
    return `${formatDuration(now.getTime() - pr.polledAt.getTime())} ago${error} ${next}`;
  }
  if (pr?.error !== undefined) return `error:${compact(pr.error)} ${next}`;
  return `not-polled ${next}`;
}

function formatGateStatus(events: ComboEvent[]): string {
  const status = latestGateStatus(events);
  if (status !== undefined) {
    const suffix = status.headSha === undefined ? "" : `@${shortSha(status.headSha)}`;
    return `${status.state}${suffix}`;
  }

  const sha = latestPublishedGateSha(events);
  if (sha !== undefined) return `validated@${shortSha(sha)}`;
  if (events.some((event) => event.event === "gate_started")) return "running";
  return "missing";
}

function formatReviewerStatus(events: ComboEvent[]): string {
  const sha = livePinnedLgtmSha(events);
  if (sha !== undefined) return `lgtm@${shortSha(sha)}`;
  if (events.some((event) => event.event === "review_comment")) return "comments";
  return "missing";
}

function readinessFacts(input: DirectorWatchStatusLineInput): ReadinessFacts {
  const prState = input.pr?.state.toUpperCase();
  const headSha = input.pr?.headSha;
  const rollup = input.pr?.statusCheckRollup;
  const requiredCheckNames = input.readyRequiredChecks ?? [];
  const ambientCheckNames = input.ambientCheckNames ?? [];

  return {
    pr: prReadyState(prState),
    gate: headSha === undefined ? "unknown" : gateReady(input.events, headSha) ? "yes" : "no",
    reviewer: headSha === undefined ? "unknown" : livePinnedLgtmSha(input.events) === headSha ? "yes" : "no",
    checks: rollup === undefined ? "unknown" : requiredChecksSucceeded(rollup, requiredCheckNames) ? "yes" : "no",
    ci: rollup === undefined
      ? "unknown"
      : checkRollupSucceeded(rollup, { requiredCheckNames, ambientCheckNames })
        ? "yes"
        : "no",
  };
}

function gateReady(events: ComboEvent[], headSha: string): boolean {
  const status = latestGateStatus(events);
  if (
    status?.state === "fix_inflight" ||
    status?.state === "failed" ||
    status?.state === "awaiting_approval"
  ) {
    return false;
  }
  return shaMatchesHead(latestPublishedGateSha(events), headSha);
}

function formatReadiness(readiness: ReadinessFacts): string {
  return [
    `pr:${readiness.pr}`,
    `gate:${readiness.gate}`,
    `reviewer:${readiness.reviewer}`,
    `checks:${readiness.checks}`,
    `ci:${readiness.ci}`,
  ].join(" ");
}

function pendingAction(
  input: DirectorWatchStatusLineInput,
  status: ComboStatus,
  readiness: ReadinessFacts,
): string {
  if (status.reason === "closure_pending") {
    return `closure pending: ${input.cli} closure -n ${input.comboId}`;
  }
  if (status.needsHuman) return `needs human: ${status.reason ?? "unknown"}`;
  if (status.phase === "READY") return "waiting for human merge";
  if (status.phase === "STOPPED") return "terminal";
  if (latestPrUrlFromEvents(input.events) === undefined) {
    if (status.phase === "CODING") return "waiting for coder";
    if (status.phase === "GATING") return "waiting for initial gate PR";
    return "waiting for PR";
  }
  if (input.pr !== undefined) {
    const prState = input.pr.state.toUpperCase();
    if (terminalPrState(prState)) {
      return `PR ${prState.toLowerCase()}; waiting for terminal journal`;
    }
    if (prState !== "OPEN") return "waiting for GitHub PR state";
  }
  if (readiness.gate !== "yes") return "waiting for current-head gate";
  if (readiness.reviewer !== "yes") return "waiting for reviewer LGTM";
  if (readiness.checks !== "yes" || readiness.ci !== "yes") return "waiting for checks";
  return "polling";
}
// -/ 2/3

// -- 3/3 HELPER · Deterministic formatting primitives --
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function terminalPrState(state: string): boolean {
  return state === "MERGED" || state === "CLOSED";
}

function prReadyState(state: string | undefined): ReadinessFacts["pr"] {
  if (state === undefined) return "unknown";
  if (state === "OPEN") return "yes";
  return terminalPrState(state) ? "no" : "unknown";
}

function compact(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function ageSince(timestamp: string, now: Date): string {
  const at = Date.parse(timestamp);
  if (!Number.isFinite(at)) return "unknown";
  return formatDuration(now.getTime() - at);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m${seconds}s`;
  }

  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) {
    return minutes === 0 ? `${totalHours}h` : `${totalHours}h${minutes}m`;
  }

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours === 0 ? `${days}d` : `${days}d${hours}h`;
}

function formatWorkerSummaries(summaries: string[], pollSeconds: number): string {
  if (summaries.length === 0) return "none";
  return summaries.map((summary) => formatWorkerSummary(summary, pollSeconds)).join(", ");
}

function formatWorkerSummary(summary: string, pollSeconds: number): string {
  const unchanged = /^worker ([^:]+): unchanged_ticks=(\d+)$/.exec(summary.trim());
  if (unchanged?.[1] !== undefined && unchanged[2] !== undefined) {
    const worker = unchanged[1];
    const ticks = Number(unchanged[2]);
    const tickLabel = ticks === 1 ? "tick" : "ticks";
    const approx = pollSeconds > 0 ? ` (~${formatDuration(ticks * pollSeconds * 1000)})` : "";
    return `${worker} unchanged ${ticks} ${tickLabel}${approx}`;
  }
  return summary.replace(/^worker\s+/, "");
}
// -/ 3/3
