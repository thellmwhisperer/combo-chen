/**
 * @overview Dive-in thread fold (PRD s8): the combo rendered as a chronological
 *   thread — the local conversation v1 moved off GitHub, rendered back. Pure
 *   fold over journal events + verdict files (by round) + loop state + injected
 *   liveness. Verdict entries carry inline findings with severity and file:line
 *   sourced from the verdict artifact; escalations and human decisions appear as
 *   thread entries; the live actor is projected last with an activity note and
 *   next-event projection; phases render as a one-line breadcrumb. Degrades
 *   gracefully over v0 journals (no verdict files, no review-loop events). The
 *   renderer holds no state the run dir cannot provide.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at deriveThread         <- (combo, events, verdicts, liveness) -> ThreadView.
 *   2. Then entriesFromEvents        <- journal events -> chronological entries.
 *   3. Then liveActorFrom / breadcrumb / projection <- derived view facts.
 *
 *   MAIN FLOW
 *   ---------
 *   combo + events + verdicts + liveness -> deriveThread -> ThreadView
 *
 *   PUBLIC API
 *   ----------
 *   ThreadEntry, ThreadFinding, ThreadBreadcrumbStage, ThreadBreadcrumb
 *   LiveActor, ThreadInput, ThreadView
 *   deriveThread                   Pure fold to the dive-in thread view.
 *
 *   INTERNALS
 *   ---------
 *   entriesFromEvents, findingFromVerdict, verdictFindings, reviewRound,
 *   liveActorFrom, sinceForActor, liveActorEntry, breadcrumbFrom,
 *   projectionFrom, findLast.
 *
 * @exports ThreadEntry, ThreadFinding, ThreadBreadcrumbStage, ThreadBreadcrumb, LiveActor, ThreadInput, ThreadView, deriveThread
 * @deps ../../core/combo, ../../core/state, ../../core/verdict, ../reporting/status-fold, ./decisions-fold, ./fleet-fold, ./live-telemetry
 */
import { deriveStatus } from "../../core/combo.js";
import { describeWorkItem, type ComboRecord } from "../../core/state.js";
import type { VerdictFile, VerdictFinding } from "../../core/verdict.js";
import type { JournalFact } from "../reporting/status-fold.js";
import { derivePendingDecisions } from "./decisions-fold.js";
import { deriveFleetRow, type FleetRenderPhase } from "./fleet-fold.js";
import {
  formatCoderDetail,
  formatGateStepBar,
  formatMmss,
  type LiveTelemetryFacts,
} from "./live-telemetry.js";

// -- 1/5 CORE · types <- START HERE --
export type ThreadEntryKind =
  | "launched"
  | "coder_done"
  | "coder_failed"
  | "review_requested"
  | "verdict"
  | "gate"
  | "pr"
  | "ready"
  | "escalated"
  | "decision"
  | "parked"
  | "closed"
  | "note";

export interface ThreadFinding {
  readonly severity: VerdictFinding["severity"];
  readonly file: string;
  readonly line?: number;
  readonly title: string;
}

export interface ThreadEntry {
  readonly at: string;
  readonly kind: ThreadEntryKind;
  readonly headline: string;
  readonly detail?: string;
  readonly findings?: readonly ThreadFinding[];
  /** Projected live entry (no journal event behind it). Rendered last. */
  readonly live?: boolean;
  /** Stable epoch-ms start timestamp for dot-train animation (live entries). */
  readonly startMs?: number;
}

export type ThreadBreadcrumbStage = "coder" | "review" | "gate" | "pr" | "merge";

export interface ThreadBreadcrumbStageState {
  readonly stage: ThreadBreadcrumbStage;
  readonly state: "done" | "live" | "pending";
}

export interface ThreadBreadcrumb {
  readonly stages: readonly ThreadBreadcrumbStageState[];
}

export interface LiveActor {
  readonly actor: "coder" | "reviewer" | "gate";
  readonly sinceMs: number;
  readonly startMs?: number;
  readonly note: string;
  readonly telemetryLine?: string;
}

export interface ThreadInput {
  readonly combo: ComboRecord;
  readonly events: readonly JournalFact[];
  readonly verdicts?: ReadonlyMap<number, VerdictFile>;
  readonly liveness?: { readonly coder?: boolean; readonly reviewer?: boolean; readonly gate?: boolean };
  readonly telemetry?: LiveTelemetryFacts;
  readonly now?: number;
}

export interface ThreadView {
  readonly comboId: string;
  readonly workItemLabel: string;
  readonly renderPhase: FleetRenderPhase;
  readonly round: number;
  readonly breadcrumb: ThreadBreadcrumb;
  readonly entries: readonly ThreadEntry[];
  readonly liveActor?: LiveActor;
  readonly projection?: string;
  readonly pendingDecisions: number;
}
// -/ 1/5

// -- 2/5 CORE · deriveThread <-
export function deriveThread(input: ThreadInput): ThreadView {
  const now = input.now ?? Date.now();
  const events = input.events;
  const verdicts = input.verdicts ?? new Map<number, VerdictFile>();
  const status = deriveStatus(events as Parameters<typeof deriveStatus>[0]);
  const fleet = deriveFleetRow({
    combo: input.combo,
    events,
    liveness: input.liveness,
    now,
  });
  const entries = entriesFromEvents(events, verdicts, input.combo);
  const liveActor = liveActorFrom(events, input.liveness, input.telemetry, status.phase, now);
  const entriesWithLive = liveActor === undefined ? entries : [...entries, liveActorEntry(liveActor)];
  const projection = projectionFrom(status.phase, liveActor, fleet.renderPhase);
  return {
    comboId: input.combo.id,
    workItemLabel: describeWorkItem(input.combo).label,
    renderPhase: fleet.renderPhase,
    round: reviewRound(events),
    breadcrumb: breadcrumbFrom(events, status.phase),
    entries: entriesWithLive,
    ...(liveActor === undefined ? {} : { liveActor }),
    ...(projection === undefined ? {} : { projection }),
    pendingDecisions: derivePendingDecisions({ comboId: input.combo.id, events }).length,
  };
}
// -/ 2/5

// -- 3/5 CORE · entries from events + verdict findings --
function entriesFromEvents(
  events: readonly JournalFact[],
  verdicts: ReadonlyMap<number, VerdictFile>,
  combo: ComboRecord,
): ThreadEntry[] {
  const entries: ThreadEntry[] = [];
  const workItem = describeWorkItem(combo).label;
  for (const event of events) {
    const entry = entryFor(event, verdicts, workItem);
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

function entryFor(
  event: JournalFact,
  verdicts: ReadonlyMap<number, VerdictFile>,
  workItem: string,
): ThreadEntry | undefined {
  switch (event.event) {
    case "combo_created":
      return { at: event.t, kind: "launched", headline: "launched", detail: workItem };
    case "coder_done":
      return { at: event.t, kind: "coder_done", headline: "coder finished" };
    case "coder_failed": {
      const code = typeof event["exit_code"] === "number" ? ` · exit ${event["exit_code"]}` : "";
      return { at: event.t, kind: "coder_failed", headline: `coder failed${code}` };
    }
    case "local_review_requested": {
      const round = typeof event["round"] === "number" ? event["round"] : "?";
      return { at: event.t, kind: "review_requested", headline: `review requested · round ${round}` };
    }
    case "local_verdict": {
      const round = typeof event["round"] === "number" ? event["round"] : "?";
      const code = verdictCodeOf(event);
      const findings = verdictFindings(event, verdicts);
      const count = findings.length;
      const verdictLabel = code === 0 ? "lgtm" : `${count} finding${count === 1 ? "" : "s"}`;
      return {
        at: event.t,
        kind: "verdict",
        headline: `reviewer V${round} · code ${code} · ${verdictLabel}`,
        ...(findings.length > 0 ? { findings } : {}),
      };
    }
    case "gate_started":
      return { at: event.t, kind: "gate", headline: "gate started" };
    case "gate_validated":
      return { at: event.t, kind: "gate", headline: "gate validated" };
    case "pr_opened": {
      const url = typeof event["url"] === "string" ? event["url"] : undefined;
      return {
        at: event.t,
        kind: "pr",
        headline: "PR opened",
        ...(url !== undefined ? { detail: url } : {}),
      };
    }
    case "ready_for_merge":
      return { at: event.t, kind: "ready", headline: "READY · waiting for your merge" };
    case "needs_human": {
      const reason = typeof event["reason"] === "string" ? event["reason"] : "needs you";
      return { at: event.t, kind: "escalated", headline: `needs you · ${reason}` };
    }
    case "decision": {
      const verb = typeof event["verb"] === "string" ? event["verb"] : "decided";
      return { at: event.t, kind: "decision", headline: `you decided · ${verb}` };
    }
    case "parked":
      return { at: event.t, kind: "parked", headline: "parked" };
    case "merged": {
      const by = typeof event["by"] === "string" ? ` by ${event["by"]}` : "";
      return { at: event.t, kind: "note", headline: `merged${by}` };
    }
    case "combo_closed":
      return { at: event.t, kind: "closed", headline: "closed" };
    case "stopped":
      return { at: event.t, kind: "closed", headline: "stopped" };
    case "pr_conflict": {
      const state = typeof event["merge_state"] === "string" ? event["merge_state"] : "conflict";
      return { at: event.t, kind: "note", headline: `conflict · ${state}` };
    }
    case "rebase_conflict":
    case "rebase_failed":
      return { at: event.t, kind: "note", headline: `rebase issue · ${event.event}` };
    default:
      return undefined;
  }
}

function verdictCodeOf(event: JournalFact): number {
  const code = event["code"];
  return typeof code === "number" ? code : -1;
}

function verdictFindings(event: JournalFact, verdicts: ReadonlyMap<number, VerdictFile>): ThreadFinding[] {
  const round = event["round"];
  if (typeof round !== "number") return [];
  const verdict = verdicts.get(round);
  if (verdict === undefined) return [];
  return verdict.findings.map(findingFromVerdict);
}

function findingFromVerdict(finding: VerdictFinding): ThreadFinding {
  return {
    severity: finding.severity,
    file: finding.file,
    title: finding.title,
    ...(finding.line === undefined ? {} : { line: finding.line }),
  };
}
// -/ 3/5

// -- 4/5 CORE · live actor + live entry + review round --
function liveActorFrom(
  events: readonly JournalFact[],
  liveness: ThreadInput["liveness"],
  telemetry: LiveTelemetryFacts | undefined,
  phase: ReturnType<typeof deriveStatus>["phase"],
  now: number,
): LiveActor | undefined {
  if (liveness?.coder && (phase === "SETUP" || phase === "CODING" || phase === "LOCAL_REVIEW")) {
    const note = phase === "LOCAL_REVIEW" ? "coder fixing" : "coder working";
    const startIso = sinceForActor(events, "coder");
    const telemetryLine = telemetry?.coder !== undefined ? formatCoderDetail(telemetry.coder) : undefined;
    return {
      actor: "coder",
      sinceMs: Math.max(0, now - Date.parse(startIso)),
      startMs: Date.parse(startIso),
      note,
      ...(telemetryLine !== undefined ? { telemetryLine } : {}),
    };
  }
  if (liveness?.reviewer && phase === "LOCAL_REVIEW") {
    const startIso = sinceForActor(events, "reviewer");
    return {
      actor: "reviewer",
      sinceMs: Math.max(0, now - Date.parse(startIso)),
      startMs: Date.parse(startIso),
      note: "reviewer judging",
    };
  }
  if (liveness?.gate && phase === "GATING") {
    const startIso = sinceForActor(events, "gate");
    const telemetryLine = telemetry?.gate !== undefined ? formatGateStepBar(telemetry.gate) : undefined;
    return {
      actor: "gate",
      sinceMs: Math.max(0, now - Date.parse(startIso)),
      startMs: Date.parse(startIso),
      note: "no-mistakes validating",
      ...(telemetryLine !== undefined ? { telemetryLine } : {}),
    };
  }
  return undefined;
}

function sinceForActor(events: readonly JournalFact[], actor: "coder" | "reviewer" | "gate"): string {
  let name: string;
  if (actor === "coder") name = "coder_started";
  else if (actor === "reviewer") name = "local_review_requested";
  else name = "gate_started";
  return findLast(events, name)?.t ?? events[0]?.t ?? new Date(0).toISOString();
}

function liveActorEntry(actor: LiveActor): ThreadEntry {
  const timer = formatMmss(actor.sinceMs);
  const headline =
    actor.telemetryLine !== undefined
      ? `${actor.note} · ${timer} · ${actor.telemetryLine}`
      : `${actor.note} · ${timer}`;
  return {
    at: "now",
    kind: "note",
    live: true,
    headline,
    ...(actor.startMs !== undefined ? { startMs: actor.startMs } : {}),
    ...(actor.telemetryLine !== undefined ? { detail: actor.telemetryLine } : {}),
  };
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
// -/ 4/5

// -- 5/5 CORE · breadcrumb + projection + findLast --
function breadcrumbFrom(
  events: readonly JournalFact[],
  phase: ReturnType<typeof deriveStatus>["phase"],
): ThreadBreadcrumb {
  const has = (name: string): boolean => events.some((event) => event.event === name);
  const coderDone = has("coder_done");
  const gateReached = has("gate_started") || has("gate_validated") || has("pr_opened");
  const reviewCleared =
    events.some((event) => event.event === "local_verdict" && event["code"] === 0) || gateReached;
  const prReady = has("ready_for_merge") || has("merged");
  const merged = has("merged") || has("combo_closed") || has("stopped");

  const state = (done: boolean, livePhase: boolean): ThreadBreadcrumbStageState["state"] => {
    if (done) return "done";
    if (livePhase) return "live";
    return "pending";
  };

  return {
    stages: [
      { stage: "coder", state: state(coderDone, phase === "SETUP" || phase === "CODING") },
      { stage: "review", state: state(reviewCleared, phase === "LOCAL_REVIEW") },
      { stage: "gate", state: state(gateReached, phase === "GATING") },
      {
        stage: "pr",
        state: state(prReady, phase === "REVIEWING"),
      },
      { stage: "merge", state: state(merged, false) },
    ],
  };
}

function projectionFrom(
  phase: ReturnType<typeof deriveStatus>["phase"],
  liveActor: LiveActor | undefined,
  renderPhase: FleetRenderPhase,
): string | undefined {
  if (liveActor !== undefined) {
    switch (liveActor.actor) {
      case "coder":
        return phase === "LOCAL_REVIEW"
          ? "coder fix turn → reviewer re-reviews → next verdict"
          : "coder loop converges → coder_done → first review";
      case "reviewer":
        return "verdict lands when the reviewer finishes";
      case "gate":
        return "gate finishes → PR opens";
    }
  }
  switch (renderPhase) {
    case "PR":
      return "checks settle → READY";
    case "READY":
      return "nothing · waiting for your merge";
    case "NEEDS_YOU":
      return "nothing until you decide (v)";
    case "PARKED":
      return "resume to continue";
    case "CLOSED":
      return undefined;
    default:
      return undefined;
  }
}

function findLast(events: readonly JournalFact[], name: string): JournalFact | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]!.event === name) return events[i];
  }
  return undefined;
}
// -/ 5/5
