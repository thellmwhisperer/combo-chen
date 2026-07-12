import { render } from "ink-testing-library";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { ComboRecord } from "../../core/state.js";
import type { JournalFact } from "../reporting/status-fold.js";
import { deriveFleetRow, type FleetRow } from "./fleet-fold.js";
import { Home } from "./home.js";
import { initialNavState } from "./navigation.js";
import { deriveThread, type ThreadView } from "./thread-fold.js";

// -- 1/3 FIXTURES · journal-level data for the six mock capsules --
// Raw JournalFact[] + ComboRecord fed through the REAL fold path.
// NOW is fixed so clock labels, ages, spinner frames, and dot-train positions
// are all deterministic. NOW = 2026-07-12T12:00:00.000Z → clockLabel = "12:00".
const NOW = Date.parse("2026-07-12T12:00:00.000Z");
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
}

const capsules: readonly MockCapsule[] = [
  // NEEDS YOU #144 — escalated after 3 rejected verdicts
  {
    combo: mockCombo("owner-repo-144", 144, "Migrate pagination", 246),
    events: [
      ev(T(246), "combo_created", { issue_url: "x" }),
      ev(T(210), "coder_done"),
      ev(T(190), "local_review_requested", { round: 1 }),
      ev(T(185), "local_verdict", { round: 1, code: 1 }),
      ev(T(170), "coder_started"),
      ev(T(150), "local_review_requested", { round: 2 }),
      ev(T(145), "local_verdict", { round: 2, code: 1 }),
      ev(T(120), "coder_started"),
      ev(T(95), "local_review_requested", { round: 3 }),
      ev(T(90), "local_verdict", { round: 3, code: 1 }),
      ev(T(41), "needs_human", { reason: "no-progress" }),
    ],
    liveness: {},
  },
  // READY #146 — gate passed, waiting for merge
  {
    combo: mockCombo("owner-repo-146", 146, "Dark mode", 242),
    events: [
      ev(T(242), "combo_created", { issue_url: "x" }),
      ev(T(202), "coder_done"),
      ev(T(187), "local_review_requested", { round: 1 }),
      ev(T(185), "local_verdict", { round: 1, code: 0 }),
      ev(T(180), "gate_started"),
      ev(T(150), "gate_validated"),
      ev(T(149), "pr_opened", { url: "u" }),
      ev(T(139), "ready_for_merge"),
    ],
    liveness: {},
  },
  // CODER #142 — coder fixing after rejected verdict
  {
    combo: mockCombo("owner-repo-142", 142, "Add 2FA", 138),
    events: [
      ev(T(138), "combo_created", { issue_url: "x" }),
      ev(T(107), "coder_done"),
      ev(T(10), "local_review_requested", { round: 1 }),
      ev(T(8), "local_verdict", { round: 1, code: 1 }),
      ev(T(5), "coder_started"),
    ],
    liveness: { coder: true },
  },
  // CODER #151 — initial coding, live coder
  {
    combo: mockCombo("owner-repo-151", 151, "Extract provider", 14),
    events: [ev(T(14), "combo_created", { issue_url: "x" }), ev(T(13), "coder_started")],
    liveness: { coder: true },
  },
  // GATE #143 — gate running
  {
    combo: mockCombo("owner-repo-143", 143, "Fix N+1", 101),
    events: [
      ev(T(101), "combo_created", { issue_url: "x" }),
      ev(T(70), "coder_done"),
      ev(T(55), "local_review_requested", { round: 1 }),
      ev(T(50), "local_verdict", { round: 1, code: 0 }),
      ev(T(28), "gate_started"),
    ],
    liveness: { gate: true },
  },
  // CODER #149 — coder fixing after rejected verdict
  {
    combo: mockCombo("owner-repo-149", 149, "Harden guards", 70),
    events: [
      ev(T(70), "combo_created", { issue_url: "x" }),
      ev(T(58), "coder_done"),
      ev(T(40), "local_review_requested", { round: 1 }),
      ev(T(38), "local_verdict", { round: 1, code: 1 }),
      ev(T(35), "coder_started"),
    ],
    liveness: { coder: true },
  },
];

const fleetRows: readonly FleetRow[] = capsules.map(({ combo, events, liveness }) =>
  deriveFleetRow({ combo, events, liveness, now: NOW }),
);
const dives: Record<string, ThreadView> = Object.fromEntries(
  capsules.map(({ combo, events, liveness }) => [
    combo.id,
    deriveThread({ combo, events, liveness, now: NOW }),
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
    const { lastFrame } = render(<Home rows={fleetRows} now={NOW} viewportRows={24} />);
    expect(lastFrame()?.trimEnd()).toBe(GOLDEN_FLEET);
  });

  it("dive-in coder (#151) matches golden (spinner, timestamp column, footer)", () => {
    const dived = { ...initialNavState, diveComboId: "owner-repo-151" };
    const { lastFrame } = render(
      <Home rows={fleetRows} dives={dives} initialNav={dived} now={NOW} viewportRows={24} />,
    );
    expect(lastFrame()?.trimEnd()).toBe(GOLDEN_DIVE_CODER);
  });

  it("dive-in viewport-bounds tall thread (title+footer visible, entries trimmed)", () => {
    const dived = { ...initialNavState, diveComboId: "owner-repo-144" };
    const { lastFrame } = render(
      <Home rows={fleetRows} dives={dives} initialNav={dived} now={NOW} viewportRows={10} />,
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
