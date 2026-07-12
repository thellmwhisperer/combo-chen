/**
 * @overview Tombstone: "dive-in viewport stacking." Pins the contract that the
 *   dive-in thread is bounded to the terminal viewport — the title bar and
 *   footer are always visible, and entries are trimmed to fit. On main-v1 (pre
 *   viewport fix) the full thread renders unbounded, so at a small viewport the
 *   output exceeds stdout.rows and Ink's log-update cannot erase the previous
 *   frame, causing the "stacked header" artifact the captain reported.
 *
 *   This test is decoupled from the spinner change: it asserts viewport
 *   structure (title first, footer last, entry count bounded), not animation
 *   glyphs.
 *
 * @exports none
 * @deps ink-testing-library, vitest, ../../core/state, ../reporting/status-fold, ./fleet-fold, ./home, ./thread-fold
 */
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import type { ComboRecord } from "../../core/state.js";
import type { JournalFact } from "../reporting/status-fold.js";
import { deriveFleetRow } from "./fleet-fold.js";
import { Home } from "./home.js";
import { initialNavState } from "./navigation.js";
import { deriveThread } from "./thread-fold.js";

const NOW = Date.parse("2026-07-12T12:00:00.000Z");
const T = (m: number): string => new Date(NOW - m * 60_000).toISOString();

function combo(id: string, n: number): ComboRecord {
  return {
    id,
    schemaVersion: 1,
    issueUrl: `https://github.com/o/r/issues/${n}`,
    workItemSourceType: "github_issue",
    workItemSourceReference: `#${n}`,
    workItemTitle: "Tall thread combo",
    repoDir: "/r",
    worktree: "/r",
    branch: `b${n}`,
    tmuxSession: `c-${id}`,
    createdAt: T(200),
  };
}

function ev(t: string, event: string, extra: Record<string, unknown> = {}): JournalFact {
  return { t, event, ...extra };
}

// A combo with many events → tall thread that exceeds a small viewport.
const tallCombo = combo("owner-repo-99", 99);
const tallEvents: JournalFact[] = [
  ev(T(200), "combo_created", { issue_url: "x" }),
  ev(T(190), "coder_done"),
  ev(T(180), "local_review_requested", { round: 1 }),
  ev(T(175), "local_verdict", { round: 1, code: 1 }),
  ev(T(170), "coder_started"),
  ev(T(160), "local_review_requested", { round: 2 }),
  ev(T(155), "local_verdict", { round: 2, code: 1 }),
  ev(T(150), "coder_started"),
  ev(T(140), "local_review_requested", { round: 3 }),
  ev(T(135), "local_verdict", { round: 3, code: 1 }),
  ev(T(41), "needs_human", { reason: "no-progress" }),
];

const tallRow = deriveFleetRow({ combo: tallCombo, events: tallEvents, liveness: {}, now: NOW });
const tallDive = deriveThread({ combo: tallCombo, events: tallEvents, liveness: {}, now: NOW });

describe("Tombstone: dive-in viewport stacking", () => {
  it("dive-in output does not exceed viewportRows (title+footer always visible)", () => {
    const viewportRows = 10;
    const dived = { ...initialNavState, diveComboId: tallCombo.id };
    const { lastFrame } = render(
      <Home
        rows={[tallRow]}
        dives={{ [tallCombo.id]: tallDive }}
        initialNav={dived}
        now={NOW}
        viewportRows={viewportRows}
      />,
    );
    const frame = lastFrame()!;
    const lines = frame.split("\n");

    // The rendered output must not exceed the viewport height.
    expect(lines.length).toBeLessThanOrEqual(viewportRows);

    // Title (combo id) is always the first visible line.
    expect(lines[0]).toContain(tallCombo.id);

    // Footer (capsule id) is always the last non-empty line.
    const lastNonEmpty = [...lines].reverse().find((l) => l.trim() !== "")!;
    expect(lastNonEmpty).toContain(tallCombo.id);
  });

  it("dive-in shows truncation indicator when entries are trimmed", () => {
    const dived = { ...initialNavState, diveComboId: tallCombo.id };
    const { lastFrame } = render(
      <Home
        rows={[tallRow]}
        dives={{ [tallCombo.id]: tallDive }}
        initialNav={dived}
        now={NOW}
        viewportRows={8}
      />,
    );
    const frame = lastFrame()!;
    // The "↑ N earlier" indicator proves entries were trimmed to fit.
    expect(frame).toContain("↑");
    expect(frame).toContain("earlier");
  });

  it("dive-in at full viewport shows all entries without trimming", () => {
    const dived = { ...initialNavState, diveComboId: tallCombo.id };
    const { lastFrame } = render(
      <Home
        rows={[tallRow]}
        dives={{ [tallCombo.id]: tallDive }}
        initialNav={dived}
        now={NOW}
        viewportRows={999}
      />,
    );
    const frame = lastFrame()!;
    // No truncation indicator when viewport is large enough.
    expect(frame).not.toContain("↑");
    expect(frame).toContain("launched");
    expect(frame).toContain("needs you");
  });
});
