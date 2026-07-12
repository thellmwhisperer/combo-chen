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

// -- 3/4 CORE · decision modal navigation (PRD s7/s8) <-
describe("navigate decision modal", () => {
  function diveInto(id: string): ReturnType<typeof navigate> {
    return navigate(initialNavState, { input: "", return: true }, [{ comboId: id }]);
  }

  it("opens the modal on v when a pending decision is available", () => {
    const state = navigate(diveInto("alpha"), { input: "v" }, [{ comboId: "alpha" }], {
      decisionAvailable: true,
    });
    expect(state.decisionOpen).toBe(true);
  });

  it("does not open the modal when no decision is available", () => {
    const state = navigate(diveInto("alpha"), { input: "v" }, [{ comboId: "alpha" }]);
    expect(state.decisionOpen).toBe(false);
  });

  it("closes the modal on Escape, q, or ArrowLeft", () => {
    let state = navigate(diveInto("alpha"), { input: "v" }, [{ comboId: "alpha" }], {
      decisionAvailable: true,
    });
    state = navigate(state, { input: "", escape: true }, [{ comboId: "alpha" }]);
    expect(state.decisionOpen).toBe(false);
  });

  it("selects a decision verb via r/s/t/i and emits a decide action, closing the modal", () => {
    let state = navigate(diveInto("alpha"), { input: "v" }, [{ comboId: "alpha" }], {
      decisionAvailable: true,
    });
    state = navigate(state, { input: "r" }, [{ comboId: "alpha" }]);
    expect(state.decisionOpen).toBe(false);
    expect(state.action).toEqual({ kind: "decide", verb: "retry" });

    state = navigate({ ...state, action: null, decisionOpen: true }, { input: "s" }, [{ comboId: "alpha" }]);
    expect(state.action).toEqual({ kind: "decide", verb: "skip" });

    state = navigate({ ...state, action: null, decisionOpen: true }, { input: "t" }, [{ comboId: "alpha" }]);
    expect(state.action).toEqual({ kind: "decide", verb: "take_over" });

    state = navigate({ ...state, action: null, decisionOpen: true }, { input: "i" }, [{ comboId: "alpha" }]);
    expect(state.action).toEqual({ kind: "decide", verb: "ignore" });
  });

  it("opens the modal from the fleet on v when the selected row has a pending decision", () => {
    const state = navigate(initialNavState, { input: "v" }, [{ comboId: "alpha" }], {
      decisionAvailable: true,
    });
    expect(state.decisionOpen).toBe(true);
  });

  it("swallows navigation keys while the modal is open", () => {
    let state = navigate(diveInto("alpha"), { input: "v" }, [{ comboId: "alpha" }], {
      decisionAvailable: true,
    });
    const before = { ...state, action: null };
    state = navigate({ ...before }, { input: "", downArrow: true }, [{ comboId: "alpha" }]);
    expect(state.diveComboId).toBe("alpha");
    expect(state.decisionOpen).toBe(true);
  });
});
// -/ 3/4

// -- 4/4 CORE · tmux jump navigation (PRD s8 Enter on live actor) <-
describe("navigate tmux jump", () => {
  it("emits a jump action on Enter in dive when a live actor is available", () => {
    let state = navigate(initialNavState, { input: "", return: true }, [{ comboId: "alpha" }]);
    state = navigate(state, { input: "", return: true }, [{ comboId: "alpha" }], {
      liveActorAvailable: true,
    });
    expect(state.action).toEqual({ kind: "jump" });
    expect(state.diveComboId).toBe("alpha");
  });

  it("does not emit a jump action when no live actor is available", () => {
    let state = navigate(initialNavState, { input: "", return: true }, [{ comboId: "alpha" }]);
    state = navigate(state, { input: "", return: true }, [{ comboId: "alpha" }]);
    expect(state.action).toBeNull();
  });

  it("does not emit a jump action from the fleet (Enter dives instead)", () => {
    const state = navigate(initialNavState, { input: "", return: true }, [{ comboId: "alpha" }], {
      liveActorAvailable: true,
    });
    expect(state.action).toBeNull();
    expect(state.diveComboId).toBe("alpha");
  });
});
// -/ 4/4
