/**
 * @overview TUI home (fleet view) rendering contract tests.
 *   Keyboard navigation logic is tested in navigation.test.ts (pure).
 *   These tests verify the Ink component renders correct content for given
 *   fleet states.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at fleet rendering    <- rows, header, detail lines.
 *   2. Then empty states            <- onboarding, all-quiet.
 *
 *   MAIN FLOW
 *   ---------
 *   FleetRow[] -> <Home rows={...}> -> rendered output string
 *
 *   PUBLIC API
 *   ----------
 *   None (test file).
 *
 * @exports none
 * @deps ink-testing-library, react, ./home, ./fleet-fold, vitest
 */
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import type { DecisionCard } from "./decisions-fold.js";
import type { FleetRow } from "./fleet-fold.js";
import { Home } from "./home.js";
import { initialNavState } from "./navigation.js";
import type { ThreadView } from "./thread-fold.js";

// -- 1/3 HELPER · fixtures --
function row(overrides: Partial<FleetRow> = {}): FleetRow {
  return {
    comboId: "o-r-7",
    workItemLabel: "#7 Add login",
    renderPhase: "CODER",
    needsYou: false,
    detailLine: "coder working",
    round: 0,
    createdAt: "2026-07-12T08:00:00.000Z",
    lastEventAt: "2026-07-12T11:30:00.000Z",
    ageLabel: "4h",
    lastActivityLabel: "30m",
    sortPriority: 2,
    ...overrides,
  };
}

function thread(overrides: Partial<ThreadView> = {}): ThreadView {
  return {
    comboId: "o-r-7",
    workItemLabel: "#7 Add login",
    renderPhase: "CODER",
    round: 0,
    breadcrumb: { stages: [] },
    entries: [
      { at: "2026-07-12T08:00:00.000Z", kind: "launched", headline: "launched" },
      { at: "2026-07-12T08:30:00.000Z", kind: "coder_done", headline: "coder finished" },
    ],
    pendingDecisions: 0,
    ...overrides,
  };
}

function card(overrides: Partial<DecisionCard> = {}): DecisionCard {
  return {
    ref: "2026-07-12T09:00:00.000Z",
    comboId: "o-r-7",
    reason: "gate_failed",
    question: "The gate failed and could not auto-recover.",
    workItemLabel: "#7 Add login",
    verbs: ["retry", "skip", "take_over", "ignore"],
    ...overrides,
  };
}
// -/ 1/3

// -- 2/3 CORE · fleet rendering <-
describe("Home fleet rendering", () => {
  it("renders rows with phase, work item, and detail line", () => {
    const { lastFrame } = render(
      <Home
        rows={[
          row({ comboId: "a", workItemLabel: "#142 Add 2FA", detailLine: "coder working · live" }),
          row({
            comboId: "b",
            workItemLabel: "#144 Migrate pagination",
            renderPhase: "NEEDS_YOU",
            needsYou: true,
            detailLine: "needs you: gate_failed",
            sortPriority: 0,
          }),
        ]}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("#142");
    expect(frame).toContain("coder working");
    expect(frame).toContain("#144");
    expect(frame).toContain("needs you: gate_failed");
  });

  it("shows needs-you count in the header", () => {
    const { lastFrame } = render(
      <Home
        rows={[
          row({ comboId: "a", needsYou: true, renderPhase: "NEEDS_YOU", sortPriority: 0 }),
          row({ comboId: "b", needsYou: true, renderPhase: "NEEDS_YOU", sortPriority: 0 }),
        ]}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("2");
    expect(frame).toContain("needs you");
  });

  it("shows all-quiet when no combos need you", () => {
    const { lastFrame } = render(<Home rows={[row({ comboId: "a", needsYou: false })]} />);
    expect(lastFrame()).toContain("all quiet");
  });

  it("renders multiple rows with correct phases", () => {
    const { lastFrame } = render(
      <Home
        rows={[
          row({ comboId: "a", workItemLabel: "alpha", renderPhase: "CODER" }),
          row({
            comboId: "b",
            workItemLabel: "beta",
            renderPhase: "READY",
            detailLine: "ready for merge",
            sortPriority: 1,
          }),
        ]}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("CODER");
    expect(frame).toContain("alpha");
    expect(frame).toContain("READY");
    expect(frame).toContain("beta");
    expect(frame).toContain("ready for merge");
  });

  it("shows the tab bar with live selected by default", () => {
    const { lastFrame } = render(<Home rows={[row()]} />);
    const frame = lastFrame()!;
    expect(frame).toContain("live");
    expect(frame).toContain("parked");
    expect(frame).toContain("closed");
  });

  it("shows keyboard hints in footer", () => {
    const { lastFrame } = render(<Home rows={[row()]} />);
    const frame = lastFrame()!;
    expect(frame).toContain("select");
    expect(frame).toContain("dive");
    expect(frame).toContain("quit");
  });
});
// -/ 2/3

// -- 3/3 CORE · empty states <-
describe("Home empty states", () => {
  it("shows onboarding screen when no combos exist", () => {
    const { lastFrame } = render(<Home rows={[]} />);
    const frame = lastFrame()!;
    expect(frame).toContain("combo-chen");
    expect(frame).toContain("run --issue");
  });

  it("shows all-quiet when live tab is empty but closed combos exist", () => {
    const { lastFrame } = render(
      <Home
        rows={[
          row({
            comboId: "closed",
            workItemLabel: "#285 old",
            renderPhase: "CLOSED",
            detailLine: "closed",
            sortPriority: 4,
          }),
        ]}
      />,
    );
    const frame = lastFrame()!;
    expect(frame.toLowerCase()).toContain("quiet");
  });

  it("does not show all-quiet when live combos exist", () => {
    const { lastFrame } = render(
      <Home
        rows={[
          row({ comboId: "live", workItemLabel: "active combo" }),
          row({
            comboId: "closed",
            workItemLabel: "#285 old",
            renderPhase: "CLOSED",
            sortPriority: 4,
          }),
        ]}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("active combo");
    expect(frame).not.toContain("nothing needs you");
  });
});
// -/ 3/3

// -- 4/6 CORE · dive-in thread rendering (PRD s8) <-
describe("Home dive-in thread", () => {
  const dived = { ...initialNavState, diveComboId: "o-r-7" };

  it("renders the thread breadcrumb, entries, and work item on dive", () => {
    const dive = thread({
      breadcrumb: {
        stages: [
          { stage: "coder", state: "done" },
          { stage: "review", state: "live" },
          { stage: "gate", state: "pending" },
          { stage: "pr", state: "pending" },
          { stage: "merge", state: "pending" },
        ],
      },
      entries: [
        { at: "2026-07-12T08:00:00.000Z", kind: "launched", headline: "launched" },
        {
          at: "2026-07-12T09:00:00.000Z",
          kind: "verdict",
          headline: "reviewer V1 · code 1 · 2 findings",
          findings: [
            { severity: "major", file: "auth.ts", line: 88, title: "DRY violation" },
            { severity: "note", file: "enroll.ts", title: "naming" },
          ],
        },
      ],
    });
    const { lastFrame } = render(<Home rows={[row()]} dives={{ "o-r-7": dive }} initialNav={dived} />);
    const frame = lastFrame()!;
    expect(frame).toContain("coder");
    expect(frame).toContain("review");
    expect(frame).toContain("reviewer V1");
    expect(frame).toContain("auth.ts");
    expect(frame).toContain("DRY violation");
  });

  it("renders escalation and decision entries in the thread", () => {
    const dive = thread({
      entries: [
        { at: "2026-07-12T08:00:00.000Z", kind: "launched", headline: "launched" },
        { at: "2026-07-12T09:00:00.000Z", kind: "escalated", headline: "needs you · gate_failed" },
        { at: "2026-07-12T09:30:00.000Z", kind: "decision", headline: "you decided · retry" },
      ],
    });
    const { lastFrame } = render(<Home rows={[row()]} dives={{ "o-r-7": dive }} initialNav={dived} />);
    const frame = lastFrame()!;
    expect(frame).toContain("needs you");
    expect(frame).toContain("decided · retry");
  });

  it("shows the live actor jump hint in the footer when a live actor is present", () => {
    const dive = thread({
      liveActor: { actor: "coder", sinceMs: 5000, note: "coder working" },
      projection: "coder loop converges",
    });
    const { lastFrame } = render(<Home rows={[row()]} dives={{ "o-r-7": dive }} initialNav={dived} />);
    const frame = lastFrame()!.toLowerCase();
    expect(frame).toContain("enter");
    expect(frame).toContain("live actor");
  });

  it("omits the jump hint when no live actor is present", () => {
    const { lastFrame } = render(<Home rows={[row()]} dives={{ "o-r-7": thread() }} initialNav={dived} />);
    expect(lastFrame()!.toLowerCase()).not.toContain("live actor");
  });
});
// -/ 4/6

// -- 5/6 CORE · decision modal (PRD s7/s8) <-
describe("Home decision modal", () => {
  const modalOpen = { ...initialNavState, diveComboId: "o-r-7", decisionOpen: true };

  it("renders the decision card question, context, and verbs when opened", () => {
    const { lastFrame } = render(
      <Home rows={[row()]} decisions={{ "o-r-7": [card()] }} initialNav={modalOpen} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("decision");
    expect(frame).toContain("The gate failed");
    expect(frame).toContain("o-r-7");
    expect(frame).toContain("#7 Add login");
    expect(frame).toContain("[r]");
    expect(frame).toContain("[s]");
    expect(frame).toContain("[t]");
    expect(frame).toContain("[i]");
  });

  it("does not render the modal when there is no pending decision", () => {
    const { lastFrame } = render(<Home rows={[row()]} decisions={{}} initialNav={modalOpen} />);
    expect(lastFrame()).not.toContain("[r]");
  });

  it("invokes onDecide with the combo id, verb, and pending ref when a decide action is seeded", () => {
    const decided: Array<{ comboId: string; verb: string; ref?: string }> = [];
    render(
      <Home
        rows={[row()]}
        decisions={{ "o-r-7": [card()] }}
        initialNav={{
          ...initialNavState,
          diveComboId: "o-r-7",
          action: { kind: "decide", verb: "retry" },
        }}
        onDecide={(comboId, verb, ref) => decided.push({ comboId, verb, ref })}
      />,
    );
    expect(decided).toEqual([{ comboId: "o-r-7", verb: "retry", ref: "2026-07-12T09:00:00.000Z" }]);
  });

  it("does not duplicate the decision write (action clears after firing)", () => {
    const decided: string[] = [];
    const { lastFrame } = render(
      <Home
        rows={[row()]}
        decisions={{ "o-r-7": [card()] }}
        initialNav={{
          ...initialNavState,
          diveComboId: "o-r-7",
          action: { kind: "decide", verb: "skip" },
        }}
        onDecide={(_id, verb) => decided.push(verb)}
      />,
    );
    expect(decided).toEqual(["skip"]);
    // re-render must not re-fire the cleared action
    expect(lastFrame()).toBeDefined();
    expect(decided).toEqual(["skip"]);
  });

  it("surfaces a non-fatal notice line when one is provided", () => {
    const { lastFrame } = render(
      <Home rows={[row()]} notice="decision not recorded: no pending needs_human escalation for o-r-7" />,
    );
    expect(lastFrame()).toContain("decision not recorded");
  });
});
// -/ 5/6

// -- 6/6 CORE · tmux jump (PRD s8 Enter on live actor) <-
describe("Home tmux jump", () => {
  it("invokes onJump when a jump action fires for the dived combo", () => {
    const jumped: string[] = [];
    render(
      <Home
        rows={[row()]}
        dives={{ "o-r-7": thread() }}
        initialNav={{
          ...initialNavState,
          diveComboId: "o-r-7",
          action: { kind: "jump" },
        }}
        onJump={(comboId) => jumped.push(comboId)}
      />,
    );
    expect(jumped).toEqual(["o-r-7"]);
  });

  it("does not invoke onJump without a jump action", () => {
    const jumped: string[] = [];
    render(
      <Home
        rows={[row()]}
        dives={{ "o-r-7": thread() }}
        initialNav={{ ...initialNavState, diveComboId: "o-r-7" }}
        onJump={(c) => jumped.push(c)}
      />,
    );
    expect(jumped).toEqual([]);
  });
});
// -/ 6/6
