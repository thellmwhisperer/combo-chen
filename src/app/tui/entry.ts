/**
 * @overview TUI home entry point: single-instance tmux session management,
 *   data loading (fleet rows, dive-in threads, pending decisions), and the Ink
 *   render loop. The decision-card write goes through decideComboEscalation
 *   (same path as the `decide` subcommand); the dive-in jump composes pure tmux
 *   arg builders via deps.tmux. React/Yoga is imported lazily from the
 *   commander action so ordinary commands never initialize it.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at runTuiHome          <- session management or direct render.
 *   2. Then loadTuiData             <- rows + dives + decisions from run dirs.
 *   3. Then resolveJumpActions      <- pure: dive-in Enter -> tmux arg vectors.
 *   4. Then decideOptions           <- pure: decision verb -> decide handler opts.
 *   5. Then renderTuiHome           <- data load + Ink render + refresh.
 *
 *   MAIN FLOW
 *   ---------
 *   bare combo-chen (TTY) -> runTuiHome -> ensure combo-chen-home session
 *     -> inside session: COMBO_CHEN_TUI_DIRECT=1 -> renderTuiHome
 *     -> loadTuiData loads rows + dives + decisions, renders <Home>
 *     -> Enter on live actor -> resolveJumpActions -> deps.tmux (client moves)
 *     -> decision verb -> decideComboEscalation (one write path)
 *
 *   PUBLIC API
 *   ----------
 *   HOME_SESSION_NAME   The tmux session name for the TUI home.
 *   TUI_DIRECT_ENV      Env var marking the in-session TUI process.
 *   insideTmux          Pure: detect $TMUX presence.
 *   isTtyStdout         Pure: detect TTY stdout.
 *   homeSessionCommand  Pure: build the command string for the tmux session.
 *   homeSessionActions  Pure: build tmux arg arrays for ensure/switch/attach.
 *   loadVerdictsForCombo Pure: loop-state rounds -> verdict map (v0-safe).
 *   resolveJumpActions  Pure: live actor -> tmux jump arg vectors (or null).
 *   decideOptions       Pure: decision verb -> decideComboEscalation options.
 *   TuiData             Loaded fleet + dives + decisions + combo index.
 *   runTuiHome          Entry: session management or direct render.
 *
 *   INTERNALS
 *   ---------
 *   loadFleetRows, loadTuiData, renderTuiHome, REFRESH_INTERVAL_MS.
 *
 * @exports HOME_SESSION_NAME, TUI_DIRECT_ENV, insideTmux, isTtyStdout, homeSessionCommand, homeSessionActions, loadVerdictsForCombo, resolveJumpActions, decideOptions, TuiData, runTuiHome
 * @deps ../../core/events, ../../core/loop-state, ../../core/state, ../../core/verdict, ../../infra/tmux, ../deps, ../lifecycle/lifecycle-handlers, ./decisions-fold, ./fleet-fold, ./thread-fold, ./tmux-jump
 */
import { readEvents } from "../../core/events.js";
import { readLoopState, type LoopState } from "../../core/loop-state.js";
import { comboHome, listCombos, runDirFor, type ComboRecord } from "../../core/state.js";
import { readVerdictFile, type VerdictFile } from "../../core/verdict.js";
import { attachSessionArgs, hasSessionArgs, newSessionArgs, switchClientArgs } from "../../infra/tmux.js";
import type { AppDeps } from "../deps.js";
import { decideComboEscalation } from "../lifecycle/lifecycle-handlers.js";
import { derivePendingDecisions, type DecisionCard } from "./decisions-fold.js";
import { deriveActorLiveness, deriveFleetRow, type FleetRow } from "./fleet-fold.js";
import { jumpToActorActions } from "./tmux-jump.js";
import { deriveThread, type ThreadView } from "./thread-fold.js";

// -- 1/3 CORE · pure session + TTY helpers <-
export const HOME_SESSION_NAME = "combo-chen-home";
export const TUI_DIRECT_ENV = "COMBO_CHEN_TUI_DIRECT";

export function insideTmux(env: Record<string, string | undefined>): boolean {
  const value = env["TMUX"];
  return value !== undefined && value !== "";
}

export function isTtyStdout(stream: { isTTY?: boolean } = process.stdout): boolean {
  return stream.isTTY === true;
}

export function homeSessionCommand(cli: string): string {
  return `${TUI_DIRECT_ENV}=1 ${cli}`;
}

export function homeSessionActions(exists: boolean, inside: boolean, cli: string): string[][] {
  if (exists) {
    return [inside ? switchClientArgs(HOME_SESSION_NAME) : attachSessionArgs(HOME_SESSION_NAME)];
  }
  const create = newSessionArgs(HOME_SESSION_NAME, "fleet", homeSessionCommand(cli));
  const connect = inside ? switchClientArgs(HOME_SESSION_NAME) : attachSessionArgs(HOME_SESSION_NAME);
  return [create, connect];
}
// -/ 1/3

// -- 2/6 CORE · runTuiHome entry <-
export async function runTuiHome(deps: AppDeps, cli: string): Promise<void> {
  if (deps.env[TUI_DIRECT_ENV] === "1") {
    await renderTuiHome(deps);
    return;
  }
  const exists = deps.tmux(hasSessionArgs(HOME_SESSION_NAME)).status === 0;
  const actions = homeSessionActions(exists, insideTmux(deps.env), cli);
  for (const args of actions) {
    deps.tmux(args);
  }
}
// -/ 2/6

// -- 3/6 CORE · verdict loading (dive-in thread findings source) <-
/**
 * Reads the per-round verdict artifacts for one combo run, keyed by round, as
 * recorded in loop-state.json. v0 journals have no loop-state and yield an
 * empty map (the thread degrades to journal events without inline findings).
 * A missing or torn verdict is skipped, never fatal.
 */
export function loadVerdictsForCombo(runDir: string, loopState?: LoopState): Map<number, VerdictFile> {
  const map = new Map<number, VerdictFile>();
  let state = loopState;
  if (state === undefined) {
    try {
      state = readLoopState(runDir);
    } catch {
      return map;
    }
  }
  if (state === undefined) return map;
  for (const round of state.rounds) {
    try {
      map.set(round.round, readVerdictFile(runDir, round.round));
    } catch {
      // Missing or torn verdict: thread renders without those findings.
    }
  }
  return map;
}
// -/ 3/6

// -- 4/6 CORE · resolveJumpActions (TUI moves the client only) <-
/**
 * Pure: builds the tmux arg vectors that move the client onto the live actor's
 * window (and bind prefix-B to return), or null when there is no live actor to
 * jump to. The entry layer executes these via deps.tmux; the TUI never sends
 * keys or reads panes.
 */
export function resolveJumpActions(input: {
  readonly insideTmux: boolean;
  readonly comboSession: string;
  readonly liveActor?: { readonly actor: "coder" | "reviewer" | "gate" };
  readonly homeSession: string;
}): string[][] | null {
  if (input.liveActor === undefined || input.comboSession === "") return null;
  return jumpToActorActions({
    insideTmux: input.insideTmux,
    comboSession: input.comboSession,
    actor: input.liveActor.actor,
    homeSession: input.homeSession,
  });
}
// -/ 4/6

// -- 5/6 CORE · decideOptions (one write path: feeds decideComboEscalation) <-
/**
 * Builds the option object the `decide` subcommand handler consumes, so the
 * TUI decision card and the CLI share a single decision-event write path. The
 * verb is normalized the same way the handler normalizes it.
 */
export function decideOptions(
  name: string,
  verb: string,
  ref?: string,
): { name: string; verb: string; by: "human"; ref?: string } {
  const normalized = verb.replace(/-/g, "_");
  const opts: { name: string; verb: string; by: "human"; ref?: string } = {
    name,
    verb: normalized,
    by: "human",
  };
  if (ref !== undefined) opts.ref = ref;
  return opts;
}
// -/ 5/6

// -- 6/6 HELPER · data loading + render loop <- START HERE
const DEFAULT_REFRESH_MS = 5000;

export function refreshIntervalMs(env: Record<string, string | undefined>): number {
  const raw = env["COMBO_CHEN_TUI_REFRESH_MS"];
  const parsed = raw !== undefined ? Number(raw) : DEFAULT_REFRESH_MS;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REFRESH_MS;
}

export interface TuiData {
  readonly rows: readonly FleetRow[];
  readonly dives: Record<string, ThreadView>;
  readonly decisions: Record<string, readonly DecisionCard[]>;
  readonly combosById: Record<string, ComboRecord>;
}

export function loadFleetRows(env: Record<string, string | undefined>, tmux: AppDeps["tmux"]): FleetRow[] {
  const home = comboHome(env);
  const combos = listCombos(home, () => {});
  const rows: FleetRow[] = [];
  for (const combo of combos) {
    const runDir = runDirFor(home, combo.id);
    let events;
    try {
      events = readEvents(runDir);
    } catch {
      continue;
    }
    if (events.length === 0) continue;
    const sessionAlive = tmux(hasSessionArgs(combo.tmuxSession)).status === 0;
    const liveness = deriveActorLiveness(events, sessionAlive);
    rows.push(deriveFleetRow({ combo, events, liveness }));
  }
  return rows;
}

export function loadTuiData(deps: AppDeps): TuiData {
  const home = comboHome(deps.env);
  const combos = listCombos(home, () => {});
  const rows: FleetRow[] = [];
  const dives: Record<string, ThreadView> = {};
  const decisions: Record<string, readonly DecisionCard[]> = {};
  const combosById: Record<string, ComboRecord> = {};
  for (const combo of combos) {
    combosById[combo.id] = combo;
    const runDir = runDirFor(home, combo.id);
    let events;
    try {
      events = readEvents(runDir);
    } catch {
      continue;
    }
    if (events.length === 0) continue;
    const sessionAlive = deps.tmux(hasSessionArgs(combo.tmuxSession)).status === 0;
    const liveness = deriveActorLiveness(events, sessionAlive);
    rows.push(deriveFleetRow({ combo, events, liveness }));
    const verdicts = loadVerdictsForCombo(runDir);
    dives[combo.id] = deriveThread({ combo, events, verdicts, liveness });
    const pending = derivePendingDecisions({ comboId: combo.id, events });
    if (pending.length > 0) decisions[combo.id] = pending;
  }
  return { rows, dives, decisions, combosById };
}

async function renderTuiHome(deps: AppDeps): Promise<void> {
  const { render } = await import("ink");
  const React = await import("react");
  const { Home } = await import("./home.js");
  const inside = insideTmux(deps.env);
  const initial = loadTuiData(deps);
  let current = initial;

  const onJump = (comboId: string): void => {
    const combo = current.combosById[comboId];
    if (combo === undefined) return;
    const actions = resolveJumpActions({
      insideTmux: inside,
      comboSession: combo.tmuxSession,
      liveActor: current.dives[comboId]?.liveActor,
      homeSession: HOME_SESSION_NAME,
    });
    if (actions === null) return;
    for (const args of actions) deps.tmux(args);
  };
  const onDecide = (comboId: string, verb: string, ref?: string): void => {
    decideComboEscalation(deps, decideOptions(comboId, verb, ref));
  };

  const instance = render(
    React.createElement(Home, {
      rows: initial.rows,
      dives: initial.dives,
      decisions: initial.decisions,
      onJump,
      onDecide,
    }),
  );
  const interval = setInterval(() => {
    try {
      current = loadTuiData(deps);
      instance.rerender(
        React.createElement(Home, {
          rows: current.rows,
          dives: current.dives,
          decisions: current.decisions,
          onJump,
          onDecide,
        }),
      );
    } catch {
      // Data loading errors are non-fatal; keep the last known state.
    }
  }, refreshIntervalMs(deps.env));
  try {
    await instance.waitUntilExit();
  } finally {
    clearInterval(interval);
  }
}
// -/ 6/6
