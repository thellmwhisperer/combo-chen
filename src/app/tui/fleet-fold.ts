/**
 * @overview Fleet-view normalization layer: pure fold from journal events +
 *   combo record + injected liveness to render rows. The renderer (Ink) holds
 *   NO state the run dir cannot provide. Reuses deriveStatus (via status-fold)
 *   and maps the real journal schema to the PRD §8 fleet render vocabulary.
 *   Renders v0 journals correctly (no v1 events present).
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at deriveFleetRow        <- one combo + journal + liveness -> row.
 *   2. Then renderPhaseFrom           <- maps real phase + last event -> render.
 *   3. Then deriveFleetView           <- rows -> sorted/filtered/empty-state model.
 *
 *   MAIN FLOW
 *   ---------
 *   combo + journal + liveness -> deriveStatus -> renderPhase -> FleetRow
 *   FleetRow[] -> deriveFleetView -> sorted needs-you-first, tab-filtered
 *
 *   PUBLIC API
 *   ----------
 *   FleetRenderPhase  CODER|REVIEW|GATE|PR|READY|NEEDS_YOU|PARKED|CLOSED
 *   ActorLiveness     Injected process-liveness facts (coder/reviewer/gate active).
 *   deriveActorLiveness  Pure: journal phase + sessionAlive -> ActorLiveness.
 *   FleetRowInput     One combo's fold input (events + liveness + telemetry).
 *   FleetRow          One combo's render-ready row (detailLine + liveHint + telemetry).
 *   FleetTab          live|parked|closed.
 *   FleetView         Sorted, filtered, empty-state-aware fleet model.
 *   deriveFleetRow    Pure fold: combo + events + liveness + telemetry -> FleetRow.
 *   deriveFleetView   Pure fold: rows + tab -> FleetView.
 *
 *   INTERNALS
 *   ---------
 *   renderPhaseFrom, detailLineFrom, liveHintFrom, reviewRound, prUrlFrom,
 *   ageLabel, sortPriorityFor, emptyStateFor.
 *
 * @exports FleetRenderPhase, ActorLiveness, deriveActorLiveness, FleetRowInput, FleetRow, FleetTab, FleetView, deriveFleetRow, deriveFleetView
 * @deps ../../core/combo, ../../core/state, ../reporting/status-fold, ./live-telemetry
 */
import { deriveStatus } from "../../core/combo.js";
import { describeWorkItem, type ComboRecord } from "../../core/state.js";
import type { JournalFact } from "../reporting/status-fold.js";
import { formatCoderHint, formatGateStepBar, type LiveTelemetryFacts } from "./live-telemetry.js";

// -- 1/4 CORE · types <- START HERE --
export type FleetRenderPhase =
  "CODER" | "REVIEW" | "GATE" | "PR" | "READY" | "NEEDS_YOU" | "PARKED" | "CLOSED";

export interface ActorLiveness {
  readonly coder?: boolean;
  readonly reviewer?: boolean;
  readonly gate?: boolean;
}

export interface FleetRowInput {
  readonly combo: ComboRecord;
  readonly events: readonly JournalFact[];
  readonly liveness?: ActorLiveness;
  readonly telemetry?: LiveTelemetryFacts;
  readonly now?: number;
}

export interface FleetRow {
  readonly comboId: string;
  readonly workItemLabel: string;
  readonly renderPhase: FleetRenderPhase;
  readonly needsYou: boolean;
  readonly reason?: string;
  readonly detailLine: string;
  readonly liveHint?: string;
  readonly round: number;
  readonly prUrl?: string;
  readonly createdAt: string;
  readonly lastEventAt: string;
  readonly ageLabel: string;
  readonly lastActivityLabel: string;
  readonly sortPriority: number;
  readonly telemetry?: LiveTelemetryFacts;
}

export type FleetTab = "live" | "parked" | "closed";

export interface FleetView {
  readonly tab: FleetTab;
  readonly rows: readonly FleetRow[];
  readonly needsCount: number;
  readonly emptyState?: "onboarding" | "all-quiet";
}
// -/ 1/4

// -- 2/4 CORE · deriveFleetRow <-
export function deriveFleetRow(input: FleetRowInput): FleetRow {
  const now = input.now ?? Date.now();
  const events = input.events;
  const status = deriveStatus(events as Parameters<typeof deriveStatus>[0]);
  const lastEvent = events[events.length - 1];
  const renderPhase = renderPhaseFrom(status.phase, status.needsHuman, status.reason, lastEvent);
  const round = reviewRound(events);
  const prUrl = prUrlFrom(events, status.pr);
  const workItem = describeWorkItem(input.combo);
  const needsYou =
    renderPhase === "NEEDS_YOU" ||
    (status.needsHuman && renderPhase !== "CLOSED" && status.reason !== "closure_pending");
  const telemetry = input.telemetry;
  const detailLine = detailLineFrom(
    renderPhase,
    round,
    prUrl,
    needsYou,
    status.reason,
    input.liveness,
    telemetry,
  );
  const liveHint = liveHintFrom(renderPhase, round, input.liveness, telemetry);
  const createdAt = input.combo.createdAt;
  const lastEventAt = lastEvent?.t ?? createdAt;
  const row: FleetRow = {
    comboId: input.combo.id,
    workItemLabel: workItem.label,
    renderPhase,
    needsYou,
    detailLine,
    round,
    createdAt,
    lastEventAt,
    ageLabel: ageLabel(now - Date.parse(createdAt)),
    lastActivityLabel: ageLabel(now - Date.parse(lastEventAt)),
    sortPriority: sortPriorityFor(renderPhase),
    ...(liveHint !== undefined ? { liveHint } : {}),
    ...(prUrl !== undefined ? { prUrl } : {}),
    ...(telemetry !== undefined ? { telemetry } : {}),
    ...(status.reason !== undefined && needsYou ? { reason: status.reason } : {}),
  };
  return row;
}

function renderPhaseFrom(
  phase: ReturnType<typeof deriveStatus>["phase"],
  needsHuman: boolean,
  reason: string | undefined,
  lastEvent: JournalFact | undefined,
): FleetRenderPhase {
  const last = lastEvent?.event;
  if (last === "parked") return "PARKED";
  if (last === "combo_closed" || last === "stopped") return "CLOSED";
  if (last === "merged") return "CLOSED";
  if (needsHuman && reason !== "closure_pending") return "NEEDS_YOU";
  switch (phase) {
    case "SETUP":
    case "CODING":
      return "CODER";
    case "LOCAL_REVIEW":
      return "REVIEW";
    case "GATING":
      return "GATE";
    case "REVIEWING":
      return "PR";
    case "READY":
      return "READY";
    case "STOPPED":
      return "CLOSED";
    case "STALLED":
      return "NEEDS_YOU";
    default:
      return "CODER";
  }
}
// -/ 2/4

// -- 3/4 HELPER · detail line, round, pr, age, sort, actor liveness --
export function deriveActorLiveness(events: readonly JournalFact[], sessionAlive: boolean): ActorLiveness {
  if (!sessionAlive) return {};
  const status = deriveStatus(events as Parameters<typeof deriveStatus>[0]);
  switch (status.phase) {
    case "SETUP":
    case "CODING":
      return { coder: true };
    case "LOCAL_REVIEW": {
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i]!;
        if (event.event === "local_verdict") {
          return event["code"] === 1 ? { coder: true } : { reviewer: true };
        }
      }
      return { reviewer: true };
    }
    case "GATING":
      return { gate: true };
    default:
      return {};
  }
}

function detailLineFrom(
  phase: FleetRenderPhase,
  round: number,
  prUrl: string | undefined,
  needsYou: boolean,
  reason: string | undefined,
  liveness: ActorLiveness | undefined,
  telemetry: LiveTelemetryFacts | undefined,
): string {
  const roundSuffix = round > 0 ? ` · round ${round}` : "";
  switch (phase) {
    case "CODER": {
      const base = liveness?.coder ? "coder working · live" : "coder working";
      const hint = telemetry?.coder !== undefined ? formatCoderHint(telemetry.coder) : undefined;
      return hint !== undefined ? `${base} · ${hint}` : base;
    }
    case "REVIEW":
      if (liveness?.coder) return `coder fixing${roundSuffix}`;
      if (liveness?.reviewer) return `reviewer judging${roundSuffix}`;
      if (round > 0) return `review in progress${roundSuffix}`;
      return "awaiting review";
    case "GATE": {
      const bar = telemetry?.gate !== undefined ? formatGateStepBar(telemetry.gate) : undefined;
      return bar !== undefined ? `no-mistakes · ${bar}` : "no-mistakes validating";
    }
    case "PR":
      return prUrl !== undefined ? "PR · checks settling" : "checks settling";
    case "READY":
      return "ready for merge";
    case "NEEDS_YOU":
      return reason !== undefined ? `needs you: ${reason}` : "needs you";
    case "PARKED":
      return "parked · resumable";
    case "CLOSED":
      return "closed";
    default:
      return "";
  }
}

function liveHintFrom(
  phase: FleetRenderPhase,
  round: number,
  liveness: ActorLiveness | undefined,
  telemetry: LiveTelemetryFacts | undefined,
): string | undefined {
  const roundSuffix = round > 0 ? ` · round ${round}` : "";
  switch (phase) {
    case "CODER": {
      const hint = telemetry?.coder !== undefined ? formatCoderHint(telemetry.coder) : undefined;
      return hint !== undefined ? `coder working · ${hint}` : undefined;
    }
    case "REVIEW":
      if (liveness?.coder) return `coder fixing${roundSuffix}`;
      if (liveness?.reviewer) return `reviewer judging${roundSuffix}`;
      return undefined;
    case "GATE": {
      const bar = telemetry?.gate !== undefined ? formatGateStepBar(telemetry.gate) : undefined;
      return bar !== undefined ? `gate · ${bar}` : undefined;
    }
    default:
      return undefined;
  }
}

function reviewRound(events: readonly JournalFact[]): number {
  let round = 0;
  for (const event of events) {
    if (event.event === "local_review_requested" || event.event === "local_verdict") {
      const value = event["round"];
      if (typeof value === "number") round = Math.max(round, value);
    }
  }
  return round;
}

function prUrlFrom(events: readonly JournalFact[], statusPr: string | undefined): string | undefined {
  if (statusPr !== undefined) return statusPr;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.event === "pr_opened" && typeof event["url"] === "string") return event["url"];
  }
  return undefined;
}

export function ageLabel(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function sortPriorityFor(phase: FleetRenderPhase): number {
  switch (phase) {
    case "NEEDS_YOU":
      return 0;
    case "READY":
      return 1;
    case "PARKED":
      return 3;
    case "CLOSED":
      return 4;
    default:
      return 2;
  }
}
// -/ 3/4

// -- 4/4 CORE · deriveFleetView <-
export function deriveFleetView(input: { rows: readonly FleetRow[]; tab: FleetTab }): FleetView {
  const filtered = input.rows.filter((row) => tabForPhase(row.renderPhase) === input.tab);
  const sorted = [...filtered].sort((a, b) => {
    const priorityDiff = a.sortPriority - b.sortPriority;
    if (priorityDiff !== 0) return priorityDiff;
    return b.lastEventAt.localeCompare(a.lastEventAt);
  });
  const needsCount = input.rows.filter(
    (row) => tabForPhase(row.renderPhase) === "live" && row.needsYou,
  ).length;
  return {
    tab: input.tab,
    rows: sorted,
    needsCount,
    ...(emptyStateFor(input.rows, sorted) !== undefined
      ? { emptyState: emptyStateFor(input.rows, sorted) }
      : {}),
  };
}

function tabForPhase(phase: FleetRenderPhase): FleetTab {
  if (phase === "PARKED") return "parked";
  if (phase === "CLOSED") return "closed";
  return "live";
}

function emptyStateFor(
  allRows: readonly FleetRow[],
  visibleRows: readonly FleetRow[],
): "onboarding" | "all-quiet" | undefined {
  if (visibleRows.length > 0) return undefined;
  if (allRows.length === 0) return "onboarding";
  const hasLive = allRows.some((row) => tabForPhase(row.renderPhase) === "live");
  return hasLive ? undefined : "all-quiet";
}
// -/ 4/4
