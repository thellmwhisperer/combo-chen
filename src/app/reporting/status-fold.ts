/**
 * @overview Pure folds for status surfaces and time-bounded recap digests.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at deriveStatusSurface <- combo, journal, probes to one status row.
 *   2. Then deriveRecap             <- journal interval to operator digest.
 *   3. Use renderRecap              <- non-TTY plain-text serialization.
 *
 *   MAIN FLOW
 *   ---------
 *   persisted facts + injected liveness -> pure folds -> status/TUI/recap models
 *
 *   PUBLIC API
 *   ----------
 *   StatusSurfaceInput, StatusSurfaceRow, deriveStatusSurface
 *   RecapInput, Recap, RecapVerdict, deriveRecap, renderRecap
 *
 *   INTERNALS
 *   ---------
 *   phaseChanges, verdictSummary, severityCounts, eventSummary, recapBoundary
 *
 * @exports StatusSurfaceInput, StatusSurfaceRow, RecapInput, Recap, RecapVerdict, deriveStatusSurface, deriveRecap, renderRecap
 * @deps ../../core/combo, ../../core/events, ../../core/guards, ../../core/state
 */
import { deriveStatus, type ComboStatus, type Phase } from "../../core/combo.js";
import type { CanonicalEventName, ComboEvent } from "../../core/events.js";
import { isRecord } from "../../core/guards.js";
import { describeWorkItem, type ComboRecord, type WorkItemDescriptor } from "../../core/state.js";

// -- 1/3 CORE · deriveStatusSurface <- START HERE --
export const LOCAL_REVIEW_REQUESTED_EVENT = "local_review_requested" satisfies CanonicalEventName;
export const LOCAL_VERDICT_EVENT = "local_verdict" satisfies CanonicalEventName;
export const DECISION_EVENT = "decision" satisfies CanonicalEventName;
export const FOLLOW_UPS_EVENT = "follow_ups" satisfies CanonicalEventName;

export interface JournalFact {
  t: string;
  event: string;
  [key: string]: unknown;
}

export interface StatusSurfaceInput {
  combo: ComboRecord;
  events: readonly JournalFact[];
  runtimePrUrl?: string;
  probes?: { sessionExists?: boolean };
}

export interface StatusSurfaceRow {
  combo: ComboRecord;
  events: readonly JournalFact[];
  status: ComboStatus;
  workItem: WorkItemDescriptor;
  prUrl?: string;
  processRepair?: { event: "needs_human"; reason: "tmux_missing" };
}

export function deriveStatusSurface(input: StatusSurfaceInput): StatusSurfaceRow {
  const persistedStatus = statusFrom(input.events);
  const parked = input.events.some((event) => event.event === "parked");
  const processMissing =
    input.probes?.sessionExists === false &&
    !parked &&
    persistedStatus.phase !== "STOPPED" &&
    !persistedStatus.needsHuman;
  const status: ComboStatus = processMissing
    ? { ...persistedStatus, needsHuman: true, reason: "tmux_missing" }
    : persistedStatus;
  const prUrl = status.pr ?? input.runtimePrUrl;
  return {
    combo: input.combo,
    events: input.events,
    status,
    workItem: describeWorkItem(input.combo),
    ...(prUrl !== undefined ? { prUrl } : {}),
    ...(processMissing
      ? { processRepair: { event: "needs_human" as const, reason: "tmux_missing" as const } }
      : {}),
  };
}
// -/ 1/3

// -- 2/3 CORE · deriveRecap --
export interface RecapInput {
  combo: ComboRecord;
  events: readonly JournalFact[];
  since?: string;
}

export interface RecapEntry {
  at: string;
  summary: string;
}

export interface RecapVerdict extends RecapEntry {
  round?: number;
  total: number;
  severities: Record<string, number>;
  trend?: number;
}

export interface Recap {
  comboId: string;
  workItem: WorkItemDescriptor;
  since: string;
  phaseChanges: Array<RecapEntry & { phase: Phase }>;
  reviewRequests: RecapEntry[];
  verdicts: RecapVerdict[];
  escalations: RecapEntry[];
  decisions: RecapEntry[];
  followUps: RecapEntry[];
  merges: RecapEntry[];
}

export function deriveRecap(input: RecapInput): Recap {
  const since = input.since ?? recapBoundary(input.combo, input.events);
  const cutoff = Date.parse(since);
  if (!Number.isFinite(cutoff)) throw new Error(`Invalid recap timestamp: ${since}`);
  const selected = input.events.filter((event) => Date.parse(event.t) > cutoff);
  const verdicts: RecapVerdict[] = [];
  let previousTotal: number | undefined;
  for (const event of selected.filter((candidate) => candidate.event === LOCAL_VERDICT_EVENT)) {
    const verdict = verdictSummary(event, previousTotal);
    verdicts.push(verdict);
    previousTotal = verdict.total;
  }
  return {
    comboId: input.combo.id,
    workItem: describeWorkItem(input.combo),
    since,
    phaseChanges: phaseChanges(input.events, cutoff),
    reviewRequests: entries(selected, LOCAL_REVIEW_REQUESTED_EVENT),
    verdicts,
    escalations: entries(selected, "needs_human", "reason"),
    decisions: entries(selected, DECISION_EVENT, "verb"),
    followUps: entries(selected, FOLLOW_UPS_EVENT, "items"),
    merges: entries(selected, "merged", "sha"),
  };
}

function phaseChanges(events: readonly JournalFact[], cutoff: number): Recap["phaseChanges"] {
  const changes: Recap["phaseChanges"] = [];
  let prior: Phase | undefined;
  events.forEach((event, index) => {
    const phase = statusFrom(events.slice(0, index + 1)).phase;
    if (phase !== prior && Date.parse(event.t) > cutoff) {
      changes.push({ at: event.t, phase, summary: phase });
    }
    prior = phase;
  });
  return changes;
}

function verdictSummary(event: JournalFact, previousTotal: number | undefined): RecapVerdict {
  const severities = severityCounts(event);
  const declaredTotal = numberField(event, "finding_count") ?? numberField(event, "findings_count");
  const total = declaredTotal ?? Object.values(severities).reduce((sum, count) => sum + count, 0);
  const round = numberField(event, "round");
  return {
    at: event.t,
    summary: eventSummary(event),
    ...(round !== undefined ? { round } : {}),
    total,
    severities,
    ...(previousTotal !== undefined ? { trend: total - previousTotal } : {}),
  };
}

function severityCounts(event: JournalFact): Record<string, number> {
  const declared = event["severity_counts"];
  if (isRecord(declared) && !Array.isArray(declared)) {
    return Object.fromEntries(
      Object.entries(declared).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
    );
  }
  const counts: Record<string, number> = {};
  if (!Array.isArray(event["findings"])) return counts;
  for (const finding of event["findings"]) {
    if (!isRecord(finding) || typeof finding["severity"] !== "string") continue;
    counts[finding["severity"]] = (counts[finding["severity"]] ?? 0) + 1;
  }
  return counts;
}
// -/ 2/3

// -- 3/3 CORE · renderRecap and helpers --
export function renderRecap(recaps: readonly Recap[]): string {
  if (recaps.length === 0) return "no combos to recap";
  return recaps
    .map((recap) => {
      const lines = [`${recap.comboId}  since ${recap.since}  ${recap.workItem.label}`];
      for (const change of recap.phaseChanges) lines.push(`  ${change.at} phase ${change.phase}`);
      for (const request of recap.reviewRequests) lines.push(`  ${request.at} review requested`);
      for (const verdict of recap.verdicts) {
        const direction = formatTrend(verdict.trend);
        const severity = Object.entries(verdict.severities)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, count]) => `${name}=${count}`)
          .join(" ");
        lines.push(
          `  ${verdict.at} verdict${verdict.round === undefined ? "" : ` round ${verdict.round}`}: findings ${verdict.total}${direction}${severity === "" ? "" : ` [${severity}]`}`,
        );
      }
      for (const event of recap.escalations) lines.push(`  ${event.at} escalation: ${event.summary}`);
      for (const event of recap.decisions) lines.push(`  ${event.at} decision: ${event.summary}`);
      for (const event of recap.followUps) lines.push(`  ${event.at} follow-ups: ${event.summary}`);
      for (const event of recap.merges) lines.push(`  ${event.at} merged: ${event.summary}`);
      if (lines.length === 1) lines.push("  no changes");
      return lines.join("\n");
    })
    .join("\n\n");
}

function entries(events: readonly JournalFact[], eventName: string, preferredField?: string): RecapEntry[] {
  return events
    .filter((event) => event.event === eventName)
    .map((event) => ({ at: event.t, summary: eventSummary(event, preferredField) }));
}

function formatTrend(trend: number | undefined): string {
  if (trend === undefined || trend === 0) return "";
  if (trend < 0) return ` (down ${Math.abs(trend)})`;
  return ` (up ${trend})`;
}

function eventSummary(event: JournalFact, preferredField?: string): string {
  const value = preferredField === undefined ? undefined : event[preferredField];
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return event.event;
}

function recapBoundary(combo: ComboRecord, events: readonly JournalFact[]): string {
  return events.filter((event) => event.event === "parked").at(-1)?.t ?? combo.createdAt;
}

function numberField(event: JournalFact, field: string): number | undefined {
  return typeof event[field] === "number" ? event[field] : undefined;
}

function statusFrom(events: readonly JournalFact[]): ComboStatus {
  return deriveStatus(events as ComboEvent[]);
}
// -/ 3/3
