/**
 * @overview TUI home entry point: single-instance tmux session management,
 *   fleet data loading, and Ink render loop. Lazily imported from the
 *   commander action so ordinary commands never initialize React/Yoga.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at runTuiHome          <- session management or direct render.
 *   2. Then homeSessionActions      <- pure: what tmux commands to run.
 *   3. Then renderTuiHome           <- data load + Ink render + refresh.
 *
 *   MAIN FLOW
 *   ---------
 *   bare combo-chen (TTY) -> runTuiHome -> ensure combo-chen-home session
 *     -> inside session: COMBO_CHEN_TUI_DIRECT=1 -> renderTuiHome
 *     -> renderTuiHome loads fleet rows, renders <Home>, refreshes on interval
 *
 *   PUBLIC API
 *   ----------
 *   HOME_SESSION_NAME   The tmux session name for the TUI home.
 *   TUI_DIRECT_ENV      Env var marking the in-session TUI process.
 *   insideTmux          Pure: detect $TMUX presence.
 *   isTtyStdout         Pure: detect TTY stdout.
 *   homeSessionCommand  Pure: build the command string for the tmux session.
 *   homeSessionActions  Pure: build tmux arg arrays for ensure/switch/attach.
 *   runTuiHome          Entry: session management or direct render.
 *
 *   INTERNALS
 *   ---------
 *   loadFleetRows, renderTuiHome, REFRESH_INTERVAL_MS.
 *
 * @exports HOME_SESSION_NAME, TUI_DIRECT_ENV, insideTmux, isTtyStdout, homeSessionCommand, homeSessionActions, runTuiHome
 * @deps ../../core/events, ../../core/state, ../../infra/tmux, ../reporting/status-fold, ./fleet-fold, ./home
 */
import { readEvents } from "../../core/events.js";
import { comboHome, listCombos, runDirFor } from "../../core/state.js";
import { attachSessionArgs, hasSessionArgs, newSessionArgs, switchClientArgs } from "../../infra/tmux.js";
import type { AppDeps } from "../deps.js";
import { deriveActorLiveness, deriveFleetRow, type FleetRow } from "./fleet-fold.js";

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

// -- 2/3 CORE · runTuiHome entry <-
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
// -/ 2/3

// -- 3/3 HELPER · data loading + render loop --
const DEFAULT_REFRESH_MS = 5000;

export function refreshIntervalMs(env: Record<string, string | undefined>): number {
  const raw = env["COMBO_CHEN_TUI_REFRESH_MS"];
  const parsed = raw !== undefined ? Number(raw) : DEFAULT_REFRESH_MS;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REFRESH_MS;
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

async function renderTuiHome(deps: AppDeps): Promise<void> {
  const { render } = await import("ink");
  const React = await import("react");
  const { Home } = await import("./home.js");
  const initialRows = loadFleetRows(deps.env, deps.tmux);
  const instance = render(React.createElement(Home, { rows: initialRows }));
  const interval = setInterval(() => {
    try {
      const rows = loadFleetRows(deps.env, deps.tmux);
      instance.rerender(React.createElement(Home, { rows }));
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
// -/ 3/3
