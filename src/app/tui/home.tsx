/**
 * @overview Ink/React TUI home per PRD §8 surface 2. Renders the fleet view,
 *   the dive-in thread (the combo as a chronological conversation), and the
 *   decision-card modal. A thin shell: navigation logic lives in navigation.ts
 *   (pure, tested), fleet data in fleet-fold.ts, thread data in thread-fold.ts,
 *   decision cards in decisions-fold.ts (all pure, tested). The component
 *   fires side effects (tmux jump, decision write) via callbacks the entry
 *   wires; it holds no state the run dir cannot provide. Frozen design rules:
 *   no progress bars for agent work (fleet rows: dot train; dive-in live actor:
 *   braille loop spinner; both + count-up timer), gate steps rendered as
 *   per-step checkmarks + step counter (enumerable steps), numbers always
 *   verb-labeled, Enter/→ dives in / jumps to the live actor, q/←/Esc backs
 *   out.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at Home               <- top-level component: nav state + side effects.
 *   2. Then FleetBody              <- fleet rows + empty states.
 *   3. Then DiveThread             <- breadcrumb + entries + findings + live actor.
 *   4. Then DecisionModal          <- question/context/verbs over any view.
 *
 *   MAIN FLOW
 *   ---------
 *   rows + dives + decisions -> <Home> -> FleetBody | DiveThread (+ DecisionModal)
 *   keyboard -> useInput -> navigate(state, input, ctx) -> side effects -> re-render
 *
 *   PUBLIC API
 *   ----------
 *   Home        The TUI home component (fleet + dive + modal + jump).
 *
 *   INTERNALS
 *   ---------
 *   FleetBody, FleetRowView, DiveThread, ThreadEntryView, DecisionModal,
 *   OnboardingScreen, AllQuietScreen, DiveUnavailable, phaseGlyph, phaseColor,
 *   entryGlyph, entryColor, severityColor, stageGlyph.
 *
 * @exports Home
 * @deps ink, react, ./decisions-fold, ./fleet-fold, ./live-telemetry, ./navigation, ./thread-fold
 */
import { Box, Text, useApp, useInput } from "ink";
import React, { useEffect, useState } from "react";

import type { DecisionCard } from "./decisions-fold.js";
import { deriveFleetView, type FleetRenderPhase, type FleetRow, type FleetView } from "./fleet-fold.js";
import { dotTrain, spinFrame } from "./live-telemetry.js";
import { initialNavState, navigate, type NavState } from "./navigation.js";
import type { ThreadEntry, ThreadView } from "./thread-fold.js";

// -- 1/5 HELPER · phase + entry + severity rendering facts --
const PHASE_GLYPH: Record<FleetRenderPhase, string> = {
  CODER: "\u25B6",
  REVIEW: "\u25B6",
  GATE: "\u25B6",
  PR: "\u25B6",
  READY: "\u2713",
  NEEDS_YOU: "\u2691",
  PARKED: "\u25A0",
  CLOSED: "\u2713",
};

const PHASE_COLOR: Record<FleetRenderPhase, string> = {
  CODER: "green",
  REVIEW: "yellow",
  GATE: "yellow",
  PR: "yellow",
  READY: "green",
  NEEDS_YOU: "red",
  PARKED: "gray",
  CLOSED: "gray",
};

const ENTRY_GLYPH: Record<ThreadEntry["kind"], string> = {
  launched: "\u25B8",
  coder_done: "\u25CF",
  coder_failed: "\u25CF",
  review_requested: "\u25C6",
  verdict: "\u25C6",
  gate: "\u25B6",
  pr: "\u25CF",
  ready: "\u2713",
  escalated: "\u2691",
  decision: "\u25C8",
  parked: "\u25A0",
  closed: "\u2713",
  note: "\u25CF",
};

const ENTRY_COLOR: Record<ThreadEntry["kind"], string> = {
  launched: "gray",
  coder_done: "green",
  coder_failed: "red",
  review_requested: "magenta",
  verdict: "magenta",
  gate: "yellow",
  pr: "green",
  ready: "green",
  escalated: "red",
  decision: "yellow",
  parked: "gray",
  closed: "gray",
  note: "gray",
};

function severityColor(severity: string): string {
  if (severity === "blocker" || severity === "major") return "red";
  if (severity === "minor") return "yellow";
  return "gray";
}

function stageGlyph(state: "done" | "live" | "pending"): string {
  if (state === "done") return "\u2713";
  if (state === "live") return "\u26A1";
  return "\u00B7";
}

/** Format epoch ms as HH:MM (UTC) for deterministic clock/timestamp display. */
function clockLabel(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** Format an entry's `at` ISO timestamp (or "now") as a short time label. */
function entryTimeLabel(at: string): string {
  if (at === "now") return "now";
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? "--:--" : clockLabel(ms);
}

/** Count rendered lines an entry will occupy (headline + detail + findings). */
function entryLineCount(entry: ThreadEntry): number {
  let lines = 1;
  if (entry.detail !== undefined) lines += 1;
  if (entry.findings !== undefined) lines += entry.findings.length;
  return lines;
}

/**
 * Trim entries to fit within `availableLines`, keeping the most recent (the live
 * actor entry is always last). Returns the entries to show and how many were
 * hidden from the top.
 */
function boundEntriesForViewport(
  entries: readonly ThreadEntry[],
  availableLines: number,
): { readonly shown: readonly ThreadEntry[]; readonly hidden: number } {
  if (entries.length === 0) return { shown: [], hidden: 0 };
  const totalLines = entries.reduce((sum, e) => sum + entryLineCount(e), 0);
  if (totalLines <= availableLines) return { shown: entries, hidden: 0 };
  let remaining = availableLines;
  let cutIndex = entries.length;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const h = entryLineCount(entries[i]!);
    if (remaining < h && cutIndex < entries.length) break;
    if (remaining < h) break;
    remaining -= h;
    cutIndex = i;
  }
  // Always keep at least the last entry (live actor).
  if (cutIndex >= entries.length) cutIndex = entries.length - 1;
  return { shown: entries.slice(cutIndex), hidden: cutIndex };
}
// -/ 1/5

// -- 2/5 CORE · Home <- START HERE --
export interface HomeProps {
  readonly rows: readonly FleetRow[];
  readonly dives?: Readonly<Record<string, ThreadView>>;
  readonly decisions?: Readonly<Record<string, readonly DecisionCard[]>>;
  readonly onJump?: (comboId: string) => void;
  readonly onDecide?: (comboId: string, verb: string, ref?: string) => void;
  /** Transient non-fatal notice (e.g. a stale-card decision write that failed). */
  readonly notice?: string;
  /** Testing seam / external control: seed the initial navigation state. */
  readonly initialNav?: NavState;
  /** Testing seam: fixed time for deterministic dot-train/spinner animation. */
  readonly now?: number;
  /** Testing seam: terminal row count for viewport-bounded rendering. */
  readonly viewportRows?: number;
}

export function Home({
  rows,
  dives,
  decisions,
  onJump,
  onDecide,
  notice,
  initialNav,
  now,
  viewportRows,
}: HomeProps): React.ReactElement {
  const { exit } = useApp();
  const [nav, setNav] = useState<NavState>(initialNav ?? initialNavState);
  const renderNow = now ?? Date.now();
  const terminalRows =
    viewportRows ?? (process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : 999);

  const view = deriveFleetView({ rows, tab: nav.tab });

  useInput((input, key) => {
    const currentRows = deriveFleetView({ rows, tab: nav.tab }).rows;
    const fleetSelectedId = currentRows[nav.selected]?.comboId;
    const focusId = nav.diveComboId ?? fleetSelectedId ?? null;
    const dive = focusId !== null ? dives?.[focusId] : undefined;
    const pendingCount = focusId !== null ? (decisions?.[focusId]?.length ?? 0) : 0;
    const ctx = {
      decisionAvailable: pendingCount > 0,
      liveActorAvailable: dive?.liveActor !== undefined,
    };
    const next = navigate(
      nav,
      {
        input,
        ...(key.upArrow ? { upArrow: true } : {}),
        ...(key.downArrow ? { downArrow: true } : {}),
        ...(key.leftArrow ? { leftArrow: true } : {}),
        ...(key.rightArrow ? { rightArrow: true } : {}),
        ...(key.return ? { return: true } : {}),
        ...(key.escape ? { escape: true } : {}),
      },
      currentRows,
      ctx,
    );
    setNav(next);
  });

  // Side-effect intents (jump / decide) fire once when set, then clear. Keyed
  // on nav.action so this is deterministic under a seeded initial state too.
  useEffect(() => {
    if (nav.action === null) return;
    const currentRows = deriveFleetView({ rows, tab: nav.tab }).rows;
    const focusId = nav.diveComboId ?? currentRows[nav.selected]?.comboId ?? null;
    if (focusId !== null) {
      if (nav.action.kind === "jump") {
        onJump?.(focusId);
      } else if (nav.action.kind === "decide" && nav.action.verb !== undefined) {
        const ref = decisions?.[focusId]?.[0]?.ref;
        onDecide?.(focusId, nav.action.verb, ref);
      }
    }
    setNav((current) => ({ ...current, action: null }));
  }, [nav.action, rows, nav.tab, nav.selected, nav.diveComboId, decisions, onJump, onDecide]);

  useEffect(() => {
    if (nav.shouldExit) exit();
  }, [nav.shouldExit, exit]);

  const focusId = nav.diveComboId ?? view.rows[nav.selected]?.comboId ?? null;
  const modalCard = nav.decisionOpen && focusId !== null ? (decisions?.[focusId]?.[0] ?? null) : null;
  const noticeBox = notice !== undefined ? <Notice text={notice} /> : null;

  if (nav.diveComboId !== null) {
    return (
      <DiveThread
        dive={dives?.[nav.diveComboId]}
        comboId={nav.diveComboId}
        modal={modalCard}
        now={renderNow}
        viewportRows={terminalRows}
      >
        {noticeBox}
      </DiveThread>
    );
  }
  return (
    <FleetBody
      view={view}
      selected={nav.selected}
      modal={modalCard}
      now={renderNow}
      viewportRows={terminalRows}
    >
      {noticeBox}
    </FleetBody>
  );
}
// -/ 2/5

// -- 3/5 CORE · FleetBody + rows + empty states + modal <-
function FleetBody({
  view,
  selected,
  modal,
  now,
  viewportRows,
  children,
}: {
  readonly view: FleetView;
  readonly selected: number;
  readonly modal: DecisionCard | null;
  readonly now: number;
  readonly viewportRows: number;
  readonly children?: React.ReactNode;
}): React.ReactElement {
  if (view.emptyState === "onboarding") {
    return (
      <Box flexDirection="column">
        <OnboardingScreen />
        {children}
        {modal !== null && <DecisionModal card={modal} />}
      </Box>
    );
  }
  if (view.emptyState === "all-quiet") {
    return (
      <Box flexDirection="column">
        <AllQuietScreen />
        {children}
        {modal !== null && <DecisionModal card={modal} />}
      </Box>
    );
  }

  // Fixed lines: header(1) + margin(1) + tabs(1) + margin(1) + footer_margin(1) + footer(1) = 6
  const FIXED_FLEET_LINES = 6;
  const rowBudget = Math.max(1, Math.floor((viewportRows - FIXED_FLEET_LINES) / 2));
  const visibleRows = view.rows.slice(0, rowBudget);
  const hiddenRowCount = view.rows.length - visibleRows.length;

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Box>
          <Text color="magenta">combo-chen</Text>
          <Text dimColor> · fleet </Text>
          {view.needsCount > 0 ? (
            <Text color="red">
              {"● "}
              {view.needsCount} need{view.needsCount === 1 ? "" : "s"} you
            </Text>
          ) : (
            <Text color="green">● all quiet</Text>
          )}
        </Box>
        <Text dimColor>{clockLabel(now)}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          [1] live{view.tab === "live" ? " ●" : ""} [2] parked{view.tab === "parked" ? " ●" : ""} [3] closed
          {view.tab === "closed" ? " ●" : ""}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {visibleRows.map((row, i) => (
          <FleetRowView key={row.comboId} row={row} selected={i === selected} now={now} />
        ))}
        {hiddenRowCount > 0 && <Text dimColor>{"↑ " + hiddenRowCount + " more"}</Text>}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{"↑↓ select · Enter dive · v decision · 1-3 tabs · q quit"}</Text>
      </Box>
      {children}
      {modal !== null && <DecisionModal card={modal} />}
    </Box>
  );
}

function FleetRowView({
  row,
  selected,
  now,
}: {
  readonly row: FleetRow;
  readonly selected: boolean;
  readonly now: number;
}): React.ReactElement {
  const glyph = PHASE_GLYPH[row.renderPhase];
  const color = PHASE_COLOR[row.renderPhase];
  const marker = selected ? "❯" : " ";
  const isLive = row.renderPhase === "CODER" || row.renderPhase === "REVIEW" || row.renderPhase === "GATE";
  const train = isLive ? dotTrain(now, Date.parse(row.lastEventAt), 1400, 5) : null;
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Box>
          <Text color={selected ? color : undefined}>{marker} </Text>
          <Text>
            <Text color={color}>
              {glyph} {row.renderPhase}
            </Text>{" "}
            {row.workItemLabel}
          </Text>
        </Box>
        <Text dimColor>
          {row.lastActivityLabel} ago · {row.ageLabel}
        </Text>
      </Box>
      <Box marginLeft={4}>
        {train !== null && <Text color={color}>{train} </Text>}
        <Text dimColor>{row.detailLine}</Text>
      </Box>
    </Box>
  );
}
// -/ 3/5

// -- 4/5 CORE · DiveThread (breadcrumb + entries + findings + live actor) <-
function DiveThread({
  dive,
  comboId,
  modal,
  now,
  viewportRows,
  children,
}: {
  readonly dive: ThreadView | undefined;
  readonly comboId: string;
  readonly modal: DecisionCard | null;
  readonly now: number;
  readonly viewportRows: number;
  readonly children?: React.ReactNode;
}): React.ReactElement {
  if (dive === undefined) {
    return (
      <Box flexDirection="column">
        <DiveUnavailable comboId={comboId} />
        {children}
        {modal !== null && <DecisionModal card={modal} />}
      </Box>
    );
  }
  const crumb = dive.breadcrumb.stages.map((s) => `${s.stage} ${stageGlyph(s.state)}`).join(" ─ ");
  const hasLiveActor = dive.liveActor !== undefined;
  const phaseColor = PHASE_COLOR[dive.renderPhase] ?? "gray";

  // Fixed lines: title(1) + margin(1) + crumb(1) + margin(1) + entries_margin(1)
  //   + projection_margin(1)+projection(1) [if present]
  //   + footer_margin(1)+footer(1) = 8 or 10
  const FIXED_LINES = 6 + (dive.projection !== undefined ? 2 : 0);
  const rawBudget = Math.max(1, viewportRows - FIXED_LINES);
  // Reserve 1 line for the "↑ N earlier" indicator if entries are trimmed.
  const firstPass = boundEntriesForViewport(dive.entries, rawBudget);
  const entryBudget = firstPass.hidden > 0 ? Math.max(1, rawBudget - 1) : rawBudget;
  const { shown, hidden } = boundEntriesForViewport(dive.entries, entryBudget);

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Box>
          <Text color="magenta">{comboId}</Text>
          <Text dimColor> · </Text>
          <Text>{dive.workItemLabel}</Text>
        </Box>
        <Text color={phaseColor}>
          {dive.renderPhase}
          {dive.round > 0 ? " r" + dive.round : ""}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{crumb}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {hidden > 0 && <Text dimColor>{"↑ " + hidden + " earlier"}</Text>}
        {shown.map((entry, i) => (
          <ThreadEntryView key={`${entry.at}-${i}`} entry={entry} now={now} />
        ))}
      </Box>
      {dive.projection !== undefined && (
        <Box marginTop={1}>
          <Text dimColor>next: {dive.projection}</Text>
        </Box>
      )}
      <Box marginTop={1} justifyContent="space-between">
        <Text dimColor>
          {hasLiveActor
            ? "Enter hands on live actor · v decision · q/←/Esc back"
            : "v decision · q/←/Esc back"}
        </Text>
        <Text dimColor>{comboId}</Text>
      </Box>
      {children}
      {modal !== null && <DecisionModal card={modal} />}
    </Box>
  );
}

function ThreadEntryView({
  entry,
  now,
}: {
  readonly entry: ThreadEntry;
  readonly now: number;
}): React.ReactElement {
  const glyph = ENTRY_GLYPH[entry.kind];
  const color = ENTRY_COLOR[entry.kind];
  const spinner = entry.live ? spinFrame(now) : null;
  const ts = entryTimeLabel(entry.at);
  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text dimColor>{ts}</Text>
        <Text color={color}>{glyph}</Text>
        <Text color={entry.live ? color : undefined}>{entry.headline}</Text>
        {spinner !== null && <Text color={color}>{spinner}</Text>}
      </Box>
      {entry.detail !== undefined && (
        <Box marginLeft={11}>
          <Text dimColor>{entry.detail}</Text>
        </Box>
      )}
      {entry.findings?.map((finding, i) => (
        <Box key={i} marginLeft={11}>
          <Text>
            <Text color={severityColor(finding.severity)}>{finding.severity}</Text>
            <Text dimColor>
              {"  "}
              {finding.file}
              {finding.line !== undefined ? `:${finding.line}` : ""}
            </Text>
            {"  "}
            {finding.title}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
// -/ 4/5

// -- 5/5 HELPER · DecisionModal + empty states + dive unavailable --
function DecisionModal({ card }: { readonly card: DecisionCard }): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" marginTop={1} paddingX={1}>
      <Box>
        <Text color="red">{"⚑ decision · "}</Text>
        <Text color="yellow">{card.comboId}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>{card.question}</Text>
      </Box>
      <Box flexDirection="column">
        <Text dimColor>{card.comboId}</Text>
        {card.workItemLabel !== undefined && <Text dimColor>{card.workItemLabel}</Text>}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color="yellow">[r]</Text> retry · give the coder a hint
        </Text>
        <Text>
          <Text color="yellow">[s]</Text> skip finding · file a follow-up
        </Text>
        <Text>
          <Text color="yellow">[t]</Text> take over · attach to the coder window
        </Text>
        <Text>
          <Text color="yellow">[i]</Text> ignore · stop routing
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{"Esc/q later · your choice is journaled as a decision event"}</Text>
      </Box>
    </Box>
  );
}

function OnboardingScreen(): React.ReactElement {
  return (
    <Box flexDirection="column" paddingY={1}>
      <Box>
        <Text color="magenta">combo-chen</Text>
        <Text dimColor> · no combos yet</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text>Start one:</Text>
        <Text color="green">{"  combo-chen run --issue <url>"}</Text>
        <Text dimColor>{"  (or --plan <file>)"}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>q quit</Text>
      </Box>
    </Box>
  );
}

function AllQuietScreen(): React.ReactElement {
  return (
    <Box flexDirection="column" paddingY={1}>
      <Box>
        <Text color="magenta">combo-chen</Text>
        <Text dimColor> · </Text>
        <Text color="green">all quiet, nothing needs you</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{"↑↓ select · Enter dive · 1-3 tabs · q quit"}</Text>
      </Box>
    </Box>
  );
}

function DiveUnavailable({ comboId }: { readonly comboId: string }): React.ReactElement {
  return (
    <Box flexDirection="column" paddingY={1}>
      <Box>
        <Text color="magenta">{comboId}</Text>
        <Text dimColor> · dive data unavailable</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{"q/←/Esc back to fleet"}</Text>
      </Box>
    </Box>
  );
}

function Notice({ text }: { readonly text: string }): React.ReactElement {
  return (
    <Box marginTop={1}>
      <Text color="red">{"! "}</Text>
      <Text color="yellow">{text}</Text>
    </Box>
  );
}
// -/ 5/5
