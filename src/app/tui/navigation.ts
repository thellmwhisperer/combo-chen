/**
 * @overview Pure keyboard navigation logic for the TUI. Extracted from the Ink
 *   component so behavior is fully testable without React/Yoga. The component
 *   wires this to Ink's useInput; this module holds all navigation state
 *   transitions (PRD §8 frozen keyboard contract). Covers fleet, dive-in,
 *   decision-card modal (PRD s7/s8), and the tmux jump intent.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at navigate        <- (state, input, rows, ctx) -> new state.
 *   2. Then NavState            <- the navigation state shape.
 *   3. Then initialNavState     <- the entry state.
 *
 *   MAIN FLOW
 *   ---------
 *   Ink useInput -> NavInput + NavContext -> navigate(state, ...) -> NavState
 *
 *   PUBLIC API
 *   ----------
 *   NavState          Navigation state (tab, selected, dive, modal, action, exit).
 *   NavInput          One keyboard input event (character + key flags).
 *   NavAction         Transient side-effect intent (jump or decide).
 *   NavContext        Data flags the pure fold cannot derive (decision/live availability).
 *   initialNavState   The entry state (live tab, nothing selected).
 *   navigate          Pure state transition.
 *
 * @exports NavState, NavInput, NavAction, NavContext, initialNavState, navigate
 * @deps ./fleet-fold
 */
import type { FleetTab } from "./fleet-fold.js";

// -- 1/2 CORE · types + navigate <- START HERE --
export interface NavAction {
  readonly kind: "jump" | "decide";
  readonly verb?: string;
}

export interface NavState {
  readonly tab: FleetTab;
  readonly selected: number;
  readonly diveComboId: string | null;
  readonly decisionOpen: boolean;
  readonly action: NavAction | null;
  readonly shouldExit: boolean;
}

export interface NavInput {
  readonly input: string;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
}

/**
 * Data-dependent flags the pure fold cannot derive from key input alone.
 * The component computes these from the current data each keystroke.
 */
export interface NavContext {
  /** A pending decision card exists for the current combo (dive or selection). */
  readonly decisionAvailable?: boolean;
  /** The dived combo has a live actor the Enter jump can target. */
  readonly liveActorAvailable?: boolean;
}

export const initialNavState: NavState = {
  tab: "live",
  selected: 0,
  diveComboId: null,
  decisionOpen: false,
  action: null,
  shouldExit: false,
};

const DECISION_KEYS: Record<string, string> = {
  r: "retry",
  s: "skip",
  t: "take_over",
  i: "ignore",
};

export function navigate(
  state: NavState,
  input: NavInput,
  rows: readonly { readonly comboId: string }[],
  ctx: NavContext = {},
): NavState {
  // Decision modal intercepts all keys while open.
  if (state.decisionOpen) {
    if (input.input === "q" || input.escape || input.leftArrow) {
      return { ...state, decisionOpen: false };
    }
    const verb = DECISION_KEYS[input.input];
    if (verb !== undefined) {
      return { ...state, decisionOpen: false, action: { kind: "decide", verb } };
    }
    return state;
  }

  if (state.diveComboId !== null) {
    if (input.input === "q" || input.escape || input.leftArrow) {
      return { ...state, diveComboId: null };
    }
    if (input.input === "v" && ctx.decisionAvailable) {
      return { ...state, decisionOpen: true };
    }
    if ((input.return || input.rightArrow) && ctx.liveActorAvailable) {
      return { ...state, action: { kind: "jump" } };
    }
    return state;
  }

  if (input.input === "q" || input.escape || input.leftArrow) {
    return { ...state, shouldExit: true };
  }
  if (input.input === "1") return { ...state, tab: "live", selected: 0 };
  if (input.input === "2") return { ...state, tab: "parked", selected: 0 };
  if (input.input === "3") return { ...state, tab: "closed", selected: 0 };
  if (input.input === "v" && ctx.decisionAvailable) {
    return { ...state, decisionOpen: true };
  }
  if (input.upArrow) {
    return { ...state, selected: Math.max(0, state.selected - 1) };
  }
  if (input.downArrow) {
    return { ...state, selected: Math.min(Math.max(0, rows.length - 1), state.selected + 1) };
  }
  if (input.return || input.rightArrow) {
    const row = rows[state.selected];
    if (row !== undefined) return { ...state, diveComboId: row.comboId };
  }
  return state;
}
// -/ 1/2

// (2/2 reserved for future navigation extensions)
