/**
 * @overview Pure keyboard navigation logic for the TUI home (fleet view).
 *   Extracted from the Ink component so behavior is fully testable without
 *   React/Yoga. The component wires this to Ink's useInput; this module
 *   holds all navigation state transitions (PRD §8 frozen keyboard contract).
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at navigate        <- (state, input, rowCount) -> new state.
 *   2. Then NavState            <- the navigation state shape.
 *   3. Then initialNavState     <- the entry state.
 *
 *   MAIN FLOW
 *   ---------
 *   Ink useInput -> NavInput -> navigate(state, input, rowCount) -> NavState
 *
 *   PUBLIC API
 *   ----------
 *   NavState          Navigation state (tab, selected, dive, exit).
 *   NavInput          One keyboard input event (character + key flags).
 *   initialNavState   The entry state (live tab, nothing selected).
 *   navigate          Pure state transition.
 *
 * @exports NavState, NavInput, initialNavState, navigate
 * @deps ./fleet-fold
 */
import type { FleetTab } from "./fleet-fold.js";

// -- 1/2 CORE · types + navigate <-
export interface NavState {
  readonly tab: FleetTab;
  readonly selected: number;
  readonly diveComboId: string | null;
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

export const initialNavState: NavState = {
  tab: "live",
  selected: 0,
  diveComboId: null,
  shouldExit: false,
};

export function navigate(
  state: NavState,
  input: NavInput,
  rows: readonly { readonly comboId: string }[],
): NavState {
  if (state.diveComboId !== null) {
    if (input.input === "q" || input.escape || input.leftArrow) {
      return { ...state, diveComboId: null };
    }
    return state;
  }
  if (input.input === "q" || input.escape || input.leftArrow) {
    return { ...state, shouldExit: true };
  }
  if (input.input === "1") return { ...state, tab: "live", selected: 0 };
  if (input.input === "2") return { ...state, tab: "parked", selected: 0 };
  if (input.input === "3") return { ...state, tab: "closed", selected: 0 };
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
