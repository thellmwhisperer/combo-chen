/**
 * @overview Pure keyboard navigation contract tests for the TUI home.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at fleet navigation   <- tab switching, selection, quit.
 *   2. Then dive navigation         <- dive-in, back out.
 *
 *   MAIN FLOW
 *   ---------
 *   NavState + NavInput + rows -> navigate -> new NavState
 *
 *   PUBLIC API
 *   ----------
 *   None (test file).
 *
 * @exports none
 * @deps ./navigation, vitest
 */
import { describe, expect, it } from "vitest";

import { initialNavState, navigate } from "./navigation.js";

// -- 1/2 CORE · fleet navigation <-
describe("navigate fleet navigation", () => {
  it("switches tabs with 1/2/3 and resets selection", () => {
    const rows = [{ comboId: "a" }, { comboId: "b" }];
    let state = navigate(initialNavState, { input: "", downArrow: true }, rows);
    expect(state.selected).toBe(1);
    state = navigate(state, { input: "2" }, rows);
    expect(state.tab).toBe("parked");
    expect(state.selected).toBe(0);
    state = navigate(state, { input: "3" }, rows);
    expect(state.tab).toBe("closed");
    state = navigate(state, { input: "1" }, rows);
    expect(state.tab).toBe("live");
  });

  it("moves selection down then clamps at bottom", () => {
    const rows = [{ comboId: "a" }, { comboId: "b" }, { comboId: "c" }];
    let state = initialNavState;
    state = navigate(state, { input: "", downArrow: true }, rows);
    expect(state.selected).toBe(1);
    state = navigate(state, { input: "", downArrow: true }, rows);
    expect(state.selected).toBe(2);
    state = navigate(state, { input: "", downArrow: true }, rows);
    expect(state.selected).toBe(2);
  });

  it("moves selection up then clamps at 0", () => {
    const rows = [{ comboId: "a" }, { comboId: "b" }];
    let state = navigate(initialNavState, { input: "", downArrow: true }, rows);
    state = navigate(state, { input: "", upArrow: true }, rows);
    expect(state.selected).toBe(0);
    state = navigate(state, { input: "", upArrow: true }, rows);
    expect(state.selected).toBe(0);
  });

  it("requests exit on q at fleet", () => {
    const state = navigate(initialNavState, { input: "q" }, []);
    expect(state.shouldExit).toBe(true);
  });

  it("requests exit on Escape at fleet", () => {
    const state = navigate(initialNavState, { input: "", escape: true }, []);
    expect(state.shouldExit).toBe(true);
  });

  it("requests exit on ArrowLeft at fleet", () => {
    const state = navigate(initialNavState, { input: "", leftArrow: true }, []);
    expect(state.shouldExit).toBe(true);
  });

  it("ignores unknown keys", () => {
    const state = navigate(initialNavState, { input: "z" }, [{ comboId: "a" }]);
    expect(state).toEqual(initialNavState);
  });
});
// -/ 1/2

// -- 2/2 CORE · dive navigation <-
describe("navigate dive-in and back", () => {
  it("enters dive on Enter with the selected combo id", () => {
    const rows = [{ comboId: "alpha" }, { comboId: "beta" }];
    let state = navigate(initialNavState, { input: "", downArrow: true }, rows);
    state = navigate(state, { input: "", return: true }, rows);
    expect(state.diveComboId).toBe("beta");
  });

  it("enters dive on ArrowRight with the selected combo id", () => {
    const rows = [{ comboId: "alpha" }];
    const state = navigate(initialNavState, { input: "", rightArrow: true }, rows);
    expect(state.diveComboId).toBe("alpha");
  });

  it("does not enter dive when no row is selected", () => {
    const state = navigate(initialNavState, { input: "", return: true }, []);
    expect(state.diveComboId).toBeNull();
  });

  it("backs out of dive on q", () => {
    const rows = [{ comboId: "alpha" }];
    let state = navigate(initialNavState, { input: "", return: true }, rows);
    state = navigate(state, { input: "q" }, rows);
    expect(state.diveComboId).toBeNull();
  });

  it("backs out of dive on Escape", () => {
    const rows = [{ comboId: "alpha" }];
    let state = navigate(initialNavState, { input: "", return: true }, rows);
    state = navigate(state, { input: "", escape: true }, rows);
    expect(state.diveComboId).toBeNull();
  });

  it("backs out of dive on ArrowLeft", () => {
    const rows = [{ comboId: "alpha" }];
    let state = navigate(initialNavState, { input: "", return: true }, rows);
    state = navigate(state, { input: "", leftArrow: true }, rows);
    expect(state.diveComboId).toBeNull();
  });

  it("does not exit while in dive on q (backs to fleet instead)", () => {
    const rows = [{ comboId: "alpha" }];
    let state = navigate(initialNavState, { input: "", return: true }, rows);
    state = navigate(state, { input: "q" }, rows);
    expect(state.shouldExit).toBe(false);
    expect(state.diveComboId).toBeNull();
  });

  it("ignores tab switches while in dive", () => {
    const rows = [{ comboId: "alpha" }];
    let state = navigate(initialNavState, { input: "", return: true }, rows);
    const before = state;
    state = navigate(state, { input: "2" }, rows);
    expect(state).toEqual(before);
  });
});
// -/ 2/2
