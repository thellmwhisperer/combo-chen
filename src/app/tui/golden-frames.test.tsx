/**
 * @overview Byte-for-byte TUI golden frames transcribed from the approved v1
 *   HTML mock. Frozen registry/journal-level fixtures pass through the real
 *   fleet and thread folds at an explicit 100x24 terminal size. The fixtures
 *   preserve the mock's six live capsules, copy, clock, ages, and animation
 *   phase; production must move toward these files, never vice versa.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at capsules               <- literal mock registry/journal data.
 *   2. Then fleetRows/dives             <- real fold boundary.
 *   3. Then golden assertions           <- fixed-size byte comparisons.
 *
 *   MAIN FLOW
 *   ---------
 *   mock registry+journals -> real folds -> Home at 100x24 -> golden files
 *
 *   PUBLIC API
 *   ----------
 *   None (test file).
 *
 * @exports none
 * @deps ink-testing-library, node:fs, node:url, vitest, ../../core/state, ../reporting/status-fold, ./fleet-fold, ./home, ./live-telemetry, ./navigation, ./thread-fold
 */
import { render } from "ink-testing-library";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { ComboRecord } from "../../core/state.js";
import type { JournalFact } from "../reporting/status-fold.js";
import { deriveFleetRow, type FleetRow } from "./fleet-fold.js";
import type { LiveTelemetryFacts } from "./live-telemetry.js";
import { Home } from "./home.js";
import { initialNavState } from "./navigation.js";
import { deriveThread, type ThreadView } from "./thread-fold.js";

// -- 1/3 FIXTURES · journal-level data for the six mock capsules --
// Raw JournalFact[] + ComboRecord fed through the REAL fold path.
// NOW is fixed so clock labels, ages, spinner frames, and dot-train positions
// are all deterministic. NOW = 2026-07-12T12:00:00.000Z → clockLabel = "12:00".
const NOW = Date.parse("2026-07-12T12:00:00.000Z");
const MOCK_COLUMNS = 100;
const MOCK_ROWS = 24;
const T = (m: number): string => new Date(NOW - m * 60_000).toISOString();

function mockCombo(id: string, n: number, title: string, createdMinAgo: number): ComboRecord {
  return {
    id,
    schemaVersion: 1,
    issueUrl: `https://github.com/owner/repo/issues/${n}`,
    workItemSourceType: "github_issue",
    workItemSourceReference: `#${n}`,
    workItemTitle: title,
    repoDir: "/r",
    worktree: "/r",
    branch: `b${n}`,
    tmuxSession: `c-${id}`,
    createdAt: T(createdMinAgo),
  };
}

function ev(t: string, event: string, extra: Record<string, unknown> = {}): JournalFact {
  return { t, event, ...extra };
}

interface MockCapsule {
  readonly combo: ComboRecord;
  readonly events: readonly JournalFact[];
  readonly liveness: { readonly coder?: boolean; readonly reviewer?: boolean; readonly gate?: boolean };
  readonly telemetry?: LiveTelemetryFacts;
}

const capsules: readonly MockCapsule[] = [
  // NEEDS YOU #144 — escalated after 3 rejected verdicts
  {
    combo: mockCombo("owner-repo-144", 144, "Migrate pagination", 246),
    events: [
      ev(T(246), "combo_created", { note: "overture ✓ · worktree issue-144" }),
      ev(T(210), "coder_done", {
        commits: 6,
        iter: 15,
        tok: "61K",
        mins: 36,
        summary: "Cursor-based pagination across list endpoints",
      }),
      ev(T(190), "local_review_requested", { round: 1 }),
      ev(T(185), "local_verdict", { round: 1, code: 1 }),
      ev(T(170), "coder_started"),
      ev(T(150), "local_review_requested", { round: 2 }),
      ev(T(145), "local_verdict", { round: 2, code: 1 }),
      ev(T(120), "coder_started"),
      ev(T(95), "local_review_requested", { round: 3 }),
      ev(T(90), "local_verdict", { round: 3, code: 1 }),
      ev(T(41), "needs_human", {
        reason: 'no-progress: 2 fixes rejected, "cursor contract" still open',
      }),
    ],
    liveness: {},
  },
  // READY #146 — gate passed, waiting for merge
  {
    combo: mockCombo("owner-repo-146", 146, "Dark mode", 242),
    events: [
      ev(T(242), "combo_created", { note: "overture ✓ · worktree issue-146" }),
      ev(T(202), "coder_done"),
      ev(T(187), "local_review_requested", { round: 1 }),
      ev(T(185), "local_verdict", { round: 1, code: 0 }),
      ev(T(180), "gate_started"),
      ev(T(150), "gate_validated"),
      ev(T(150), "pr_opened", { url: "https://github.com/owner/repo/pull/430" }),
      ev(T(140), "review_comment", {
        author: "coderabbitai",
        kind: "green",
        url: "https://github.com/owner/repo/pull/430#review",
      }),
      ev(T(139), "ready_for_merge"),
    ],
    liveness: {},
  },
  // REVIEW #142 — coder fixing round 2 after two rejected verdicts
  {
    combo: mockCombo("owner-repo-142", 142, "Add 2FA to login flow", 138),
    events: [
      ev(T(138), "combo_created", {
        note: "overture ✓ · worktree issue-142 · branch combo/issue-142",
      }),
      ev(T(107), "coder_done", {
        commits: 4,
        iter: 12,
        tok: "45K",
        mins: 31,
        summary: "TOTP enrollment, verification and recovery codes",
      }),
      ev(T(8), "local_review_requested", { round: 0 }),
      ev(T(8), "local_verdict", { round: 0, code: 1 }),
      ev(T(5), "coder_started", { round: 1, mode: "review_fix" }),
      ev(T(4), "local_review_requested", { round: 1 }),
      ev(T(4), "local_verdict", { round: 1, code: 1 }),
      ev(T(3), "coder_started", { round: 2, mode: "review_fix", on: "auth.ts" }),
    ],
    liveness: { coder: true },
  },
  // GATE #143 — gate running
  {
    combo: mockCombo("owner-repo-143", 143, "Fix N+1 in bookings", 101),
    events: [
      ev(T(101), "combo_created", { issue_url: "x" }),
      ev(T(70), "coder_done"),
      ev(T(55), "local_review_requested", { round: 1 }),
      ev(T(50), "local_verdict", { round: 1, code: 0 }),
      ev(T(28), "gate_started"),
      ev(T(24), "gate_step", { step: "review" }),
      ev(T(9), "gate_step", { step: "test" }),
    ],
    liveness: { gate: true },
    telemetry: {
      gate: {
        steps: [
          { name: "review", state: "done" },
          { name: "test", state: "live" },
          { name: "lint", state: "pending" },
        ],
      },
    },
  },
  // CODER #151 — initial coding, live coder
  {
    combo: mockCombo("owner-repo-151", 151, "Extract payment provider", 14),
    events: [
      ev(T(14), "combo_created", {
        note: "overture ✓ · worktree issue-151 · branch combo/issue-151",
      }),
      ev(T(13), "coder_started", { mode: "gnhf", max_iterations: 24, on: "provider.ts" }),
    ],
    liveness: { coder: true },
    telemetry: {
      coder: {
        mode: "gnhf",
        iteration: 1,
        maxIterations: 24,
        inputTokens: 1_180,
        currentFile: "provider.ts",
      },
    },
  },
  // REVIEW #149 — reviewer judging the rejected changeset
  {
    combo: mockCombo("owner-repo-149", 149, "Harden auth route guards", 70),
    events: [
      ev(T(70), "combo_created", { note: "overture ✓ · worktree issue-149" }),
      ev(T(58), "coder_done", {
        commits: 3,
        iter: 9,
        tok: "31K",
        mins: 24,
        summary: "Centralize route guard checks",
      }),
      ev(T(40), "local_review_requested", { round: 0 }),
      ev(T(40), "local_verdict", { round: 0, code: 1 }),
    ],
    liveness: { reviewer: true },
  },
];

const fleetRows: readonly FleetRow[] = capsules.map(({ combo, events, liveness, telemetry }) =>
  deriveFleetRow({ combo, events, liveness, telemetry, now: NOW }),
);
const dives: Record<string, ThreadView> = Object.fromEntries(
  capsules.map(({ combo, events, liveness, telemetry }) => [
    combo.id,
    deriveThread({ combo, events, liveness, telemetry, now: NOW }),
  ]),
);
// -/ 1/3

// -- 2/3 GOLDEN FRAMES · frozen fixture files (byte-for-byte) --
const goldenDir = fileURLToPath(new URL("./__goldens__/", import.meta.url));
const GOLDEN_FLEET = readFileSync(goldenDir + "fleet.txt", "utf8").trimEnd();
const GOLDEN_DIVE_CODER = readFileSync(goldenDir + "dive-coder.txt", "utf8").trimEnd();
const GOLDEN_DIVE_BOUNDED = readFileSync(goldenDir + "dive-bounded.txt", "utf8").trimEnd();
// -/ 2/3

// -- 3/3 ASSERTIONS --
describe("Mock golden frames (journal-folded, byte-for-byte)", () => {
  it("six-row fleet matches golden (clock, two-part ages, dot trains)", () => {
    const { lastFrame, stdout } = render(
      <Home rows={fleetRows} now={NOW} viewportRows={MOCK_ROWS} viewportColumns={MOCK_COLUMNS} />,
    );
    const frame = lastFrame()!;
    expect(stdout.columns).toBe(MOCK_COLUMNS);
    expect(frame.split("\n").length).toBeLessThanOrEqual(MOCK_ROWS);
    expect(frame.trimEnd()).toBe(GOLDEN_FLEET);
  });

  it("dive-in coder (#151) matches golden (spinner, timestamp column, footer)", () => {
    const dived = { ...initialNavState, diveComboId: "owner-repo-151" };
    const { lastFrame } = render(
      <Home
        rows={fleetRows}
        dives={dives}
        initialNav={dived}
        now={NOW}
        viewportRows={MOCK_ROWS}
        viewportColumns={MOCK_COLUMNS}
      />,
    );
    expect(lastFrame()?.trimEnd()).toBe(GOLDEN_DIVE_CODER);
  });

  it("dive-in viewport-bounds tall thread (title+footer visible, entries trimmed)", () => {
    const dived = { ...initialNavState, diveComboId: "owner-repo-144" };
    const { lastFrame } = render(
      <Home
        rows={fleetRows}
        dives={dives}
        initialNav={dived}
        now={NOW}
        viewportRows={10}
        viewportColumns={MOCK_COLUMNS}
      />,
    );
    const frame = lastFrame()!;
    expect(frame.trimEnd()).toBe(GOLDEN_DIVE_BOUNDED);
    // Structural invariants: title first, capsule id last, truncation present.
    expect(frame.startsWith("owner-repo-144")).toBe(true);
    expect(frame).toContain("↑ 8 earlier");
    expect(frame).toContain("owner-repo-144");
  });
});
// -/ 3/3
