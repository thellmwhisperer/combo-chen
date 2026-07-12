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

import type { FleetRow } from "./fleet-fold.js";
import { Home } from "./home.js";

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
