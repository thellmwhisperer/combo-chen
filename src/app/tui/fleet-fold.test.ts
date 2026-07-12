/**
 * @overview Fleet-view normalization layer contract tests.
 *   Pure fold: journal events + combo + injected liveness -> render rows.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at v0 rendering         <- renders journals without v1 events.
 *   2. Then v1 review loop rendering  <- local_verdict/round/detail mapping.
 *   3. Then deriveFleetView           <- sorting, tabs, empty states.
 *
 *   MAIN FLOW
 *   ---------
 *   combo + journal + liveness -> deriveFleetRow -> render row
 *   rows -> deriveFleetView -> sorted/filtered fleet model
 *
 *   PUBLIC API
 *   ----------
 *   None (test file).
 *
 * @exports none
 * @deps ./fleet-fold, ../../core/state, vitest
 */
import { describe, expect, it } from "vitest";

import type { ComboRecord } from "../../core/state.js";
import { deriveActorLiveness, deriveFleetRow, deriveFleetView, type FleetRenderPhase } from "./fleet-fold.js";

// -- 1/3 HELPER · fixtures --
const NOW = Date.parse("2026-07-12T12:00:00.000Z");

function combo(overrides: Partial<ComboRecord> = {}): ComboRecord {
  return {
    id: "o-r-7",
    issueUrl: "https://github.com/o/r/issues/7",
    repoDir: "/repos/r",
    worktree: "/repos/r/.worktrees/7",
    branch: "combo/7",
    tmuxSession: "combo-chen-o-r-7",
    createdAt: "2026-07-12T08:00:00.000Z",
    ...overrides,
  };
}

function ts(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}
// -/ 1/3

// -- 2/3 CORE · deriveFleetRow <- START HERE --
describe("deriveFleetRow v0 journals (no v1 events)", () => {
  it("renders a freshly-launched combo as CODER", () => {
    const row = deriveFleetRow({
      combo: combo(),
      events: [
        { t: ts(120), event: "combo_created", issue_url: "https://github.com/o/r/issues/7" },
        { t: ts(118), event: "coder_started" },
      ],
      now: NOW,
    });
    expect(row.renderPhase).toBe("CODER");
    expect(row.needsYou).toBe(false);
    expect(row.detailLine).toContain("coder");
  });

  it("renders a post-publish PR as PR", () => {
    const row = deriveFleetRow({
      combo: combo(),
      events: [
        { t: ts(120), event: "combo_created", issue_url: "x" },
        { t: ts(100), event: "coder_started" },
        { t: ts(80), event: "coder_done" },
        { t: ts(75), event: "gate_started" },
        { t: ts(60), event: "pr_opened", url: "https://github.com/o/r/pull/42" },
      ],
      now: NOW,
    });
    expect(row.renderPhase).toBe("PR");
    expect(row.prUrl).toBe("https://github.com/o/r/pull/42");
  });

  it("renders ready_for_merge as READY with merge detail", () => {
    const row = deriveFleetRow({
      combo: combo(),
      events: [
        { t: ts(120), event: "combo_created", issue_url: "x" },
        { t: ts(100), event: "coder_started" },
        { t: ts(80), event: "coder_done" },
        { t: ts(75), event: "gate_started" },
        { t: ts(60), event: "pr_opened", url: "https://github.com/o/r/pull/42" },
        {
          t: ts(10),
          event: "ready_for_merge",
          sha: "abc123",
          pr_url: "https://github.com/o/r/pull/42",
        },
      ],
      now: NOW,
    });
    expect(row.renderPhase).toBe("READY");
    expect(row.detailLine).toContain("ready");
  });

  it("renders merged + combo_closed as CLOSED", () => {
    const row = deriveFleetRow({
      combo: combo(),
      events: [
        { t: ts(120), event: "combo_created", issue_url: "x" },
        { t: ts(100), event: "coder_started" },
        { t: ts(80), event: "coder_done" },
        { t: ts(60), event: "pr_opened", url: "https://github.com/o/r/pull/42" },
        { t: ts(5), event: "merged", sha: "abc", by: "javi" },
        { t: ts(4), event: "combo_closed" },
      ],
      now: NOW,
    });
    expect(row.renderPhase).toBe("CLOSED");
    expect(row.needsYou).toBe(false);
  });

  it("renders needs_human as NEEDS_YOU with reason in detail", () => {
    const row = deriveFleetRow({
      combo: combo(),
      events: [
        { t: ts(120), event: "combo_created", issue_url: "x" },
        { t: ts(100), event: "coder_started" },
        { t: ts(80), event: "coder_done" },
        { t: ts(10), event: "needs_human", reason: "gate_failed" },
      ],
      now: NOW,
    });
    expect(row.renderPhase).toBe("NEEDS_YOU");
    expect(row.needsYou).toBe(true);
    expect(row.detailLine).toContain("gate_failed");
  });

  it("renders coder_failed as NEEDS_YOU", () => {
    const row = deriveFleetRow({
      combo: combo(),
      events: [
        { t: ts(120), event: "combo_created", issue_url: "x" },
        { t: ts(100), event: "coder_started" },
        { t: ts(10), event: "coder_failed", exit_code: 1, has_new_commits: false },
      ],
      now: NOW,
    });
    expect(row.renderPhase).toBe("NEEDS_YOU");
    expect(row.needsYou).toBe(true);
  });

  it("renders parked as PARKED", () => {
    const row = deriveFleetRow({
      combo: combo(),
      events: [
        { t: ts(120), event: "combo_created", issue_url: "x" },
        { t: ts(100), event: "coder_started" },
        { t: ts(40), event: "parked", by: "operator", summary_path: "/tmp/sum.md" },
      ],
      now: NOW,
    });
    expect(row.renderPhase).toBe("PARKED");
  });

  it("labels age and last activity", () => {
    const row = deriveFleetRow({
      combo: combo(),
      events: [
        { t: ts(120), event: "combo_created", issue_url: "x" },
        { t: ts(10), event: "coder_started" },
      ],
      now: NOW,
    });
    expect(row.ageLabel).toContain("h");
    expect(row.lastActivityLabel).toContain("m");
  });
});

describe("deriveFleetRow v1 review loop", () => {
  it("renders local_review_requested as REVIEW with round", () => {
    const row = deriveFleetRow({
      combo: combo(),
      events: [
        { t: ts(120), event: "combo_created", issue_url: "x" },
        { t: ts(100), event: "coder_started" },
        { t: ts(80), event: "coder_done" },
        { t: ts(70), event: "local_review_requested", round: 1, sha: "abc" },
      ],
      now: NOW,
    });
    expect(row.renderPhase).toBe("REVIEW");
    expect(row.round).toBe(1);
  });

  it("shows reviewer judging when reviewer liveness is active", () => {
    const row = deriveFleetRow({
      combo: combo(),
      events: [
        { t: ts(120), event: "combo_created", issue_url: "x" },
        { t: ts(80), event: "coder_done" },
        { t: ts(70), event: "local_review_requested", round: 1, sha: "abc" },
      ],
      liveness: { reviewer: true },
      now: NOW,
    });
    expect(row.renderPhase).toBe("REVIEW");
    expect(row.detailLine).toContain("reviewer");
    expect(row.detailLine).toContain("round 1");
  });

  it("shows coder fixing when coder liveness is active after a code-1 verdict", () => {
    const row = deriveFleetRow({
      combo: combo(),
      events: [
        { t: ts(120), event: "combo_created", issue_url: "x" },
        { t: ts(80), event: "coder_done" },
        { t: ts(70), event: "local_review_requested", round: 1, sha: "abc" },
        {
          t: ts(60),
          event: "local_verdict",
          round: 1,
          code: 1,
          verdict_path: "/tmp/v1.json",
          identity: { model: "opus", runtime: "claude" },
        },
      ],
      liveness: { coder: true },
      now: NOW,
    });
    expect(row.renderPhase).toBe("REVIEW");
    expect(row.detailLine).toContain("coder");
    expect(row.detailLine).toContain("fix");
  });

  it("advances to GATE on local_verdict code 0", () => {
    const row = deriveFleetRow({
      combo: combo(),
      events: [
        { t: ts(120), event: "combo_created", issue_url: "x" },
        { t: ts(80), event: "coder_done" },
        { t: ts(70), event: "local_review_requested", round: 1, sha: "abc" },
        {
          t: ts(60),
          event: "local_verdict",
          round: 1,
          code: 0,
          verdict_path: "/tmp/v1.json",
          identity: { model: "opus" },
        },
      ],
      now: NOW,
    });
    expect(row.renderPhase).toBe("GATE");
  });

  it("escalates on local_verdict code 3", () => {
    const row = deriveFleetRow({
      combo: combo(),
      events: [
        { t: ts(120), event: "combo_created", issue_url: "x" },
        { t: ts(80), event: "coder_done" },
        { t: ts(70), event: "local_review_requested", round: 1, sha: "abc" },
        {
          t: ts(60),
          event: "local_verdict",
          round: 1,
          code: 3,
          verdict_path: "/tmp/v1.json",
          identity: { model: "opus" },
        },
      ],
      now: NOW,
    });
    expect(row.renderPhase).toBe("NEEDS_YOU");
    expect(row.needsYou).toBe(true);
  });
});

describe("deriveFleetRow liveness on CODER phase", () => {
  it("shows live coder when coder liveness active", () => {
    const row = deriveFleetRow({
      combo: combo(),
      events: [
        { t: ts(120), event: "combo_created", issue_url: "x" },
        { t: ts(10), event: "coder_started" },
      ],
      liveness: { coder: true },
      now: NOW,
    });
    expect(row.detailLine).toContain("live");
  });
});

describe("deriveActorLiveness", () => {
  it("returns empty when session is not alive", () => {
    const liveness = deriveActorLiveness(
      [{ t: ts(10), event: "coder_started" }],
      false,
    );
    expect(liveness).toEqual({});
  });

  it("reports coder active during CODING phase", () => {
    const liveness = deriveActorLiveness(
      [{ t: ts(10), event: "coder_started" }],
      true,
    );
    expect(liveness).toEqual({ coder: true });
  });

  it("reports reviewer active during LOCAL_REVIEW with no verdict yet", () => {
    const liveness = deriveActorLiveness(
      [
        { t: ts(80), event: "coder_done" },
        { t: ts(70), event: "local_review_requested", round: 1, sha: "abc" },
      ],
      true,
    );
    expect(liveness).toEqual({ reviewer: true });
  });

  it("reports coder active during LOCAL_REVIEW after code-1 verdict", () => {
    const liveness = deriveActorLiveness(
      [
        { t: ts(70), event: "local_review_requested", round: 1, sha: "abc" },
        {
          t: ts(60),
          event: "local_verdict",
          round: 1,
          code: 1,
          verdict_path: "/v",
          identity: {},
        },
      ],
      true,
    );
    expect(liveness).toEqual({ coder: true });
  });

  it("reports gate active during GATING phase", () => {
    const liveness = deriveActorLiveness(
      [
        { t: ts(80), event: "coder_done" },
        { t: ts(75), event: "gate_started" },
      ],
      true,
    );
    expect(liveness).toEqual({ gate: true });
  });

  it("returns empty for terminal phases", () => {
    const liveness = deriveActorLiveness(
      [
        { t: ts(80), event: "coder_done" },
        { t: ts(60), event: "pr_opened", url: "https://x" },
        { t: ts(5), event: "combo_closed" },
      ],
      true,
    );
    expect(liveness).toEqual({});
  });
});
// -/ 2/3

// -- 3/3 CORE · deriveFleetView sorting, tabs, empty states --
describe("deriveFleetView", () => {
  function rowFor(
    phase: FleetRenderPhase,
    overrides: Record<string, unknown> = {},
  ): Parameters<typeof deriveFleetView>[0]["rows"][number] {
    return {
      comboId: phase,
      workItemLabel: phase,
      renderPhase: phase,
      needsYou: false,
      detailLine: "",
      round: 0,
      createdAt: "2026-07-12T08:00:00.000Z",
      lastEventAt: "2026-07-12T11:00:00.000Z",
      ageLabel: "4h",
      lastActivityLabel: "1h",
      sortPriority: 2,
      ...overrides,
    };
  }

  it("sorts needs-you-first, then READY, then rest by recency", () => {
    const view = deriveFleetView({
      rows: [
        rowFor("PR", { comboId: "pr", lastEventAt: "2026-07-12T11:00:00.000Z" }),
        rowFor("READY", { comboId: "ready", sortPriority: 1 }),
        rowFor("NEEDS_YOU", { comboId: "needs", needsYou: true, sortPriority: 0 }),
        rowFor("CODER", { comboId: "coder", lastEventAt: "2026-07-12T11:30:00.000Z" }),
      ],
      tab: "live",
    });
    const ids = view.rows.map((r) => r.comboId);
    expect(ids).toEqual(["needs", "ready", "coder", "pr"]);
  });

  it("live tab excludes parked and closed", () => {
    const view = deriveFleetView({
      rows: [
        rowFor("CODER", { comboId: "live" }),
        rowFor("PARKED", { comboId: "parked", sortPriority: 3 }),
        rowFor("CLOSED", { comboId: "closed", sortPriority: 4 }),
      ],
      tab: "live",
    });
    expect(view.rows.map((r) => r.comboId)).toEqual(["live"]);
  });

  it("parked tab shows only parked", () => {
    const view = deriveFleetView({
      rows: [
        rowFor("CODER", { comboId: "live" }),
        rowFor("PARKED", { comboId: "parked", sortPriority: 3 }),
      ],
      tab: "parked",
    });
    expect(view.rows.map((r) => r.comboId)).toEqual(["parked"]);
  });

  it("closed tab shows only closed", () => {
    const view = deriveFleetView({
      rows: [
        rowFor("CODER", { comboId: "live" }),
        rowFor("CLOSED", { comboId: "closed", sortPriority: 4 }),
      ],
      tab: "closed",
    });
    expect(view.rows.map((r) => r.comboId)).toEqual(["closed"]);
  });

  it("reports needsCount across all live rows", () => {
    const view = deriveFleetView({
      rows: [
        rowFor("NEEDS_YOU", { comboId: "a", needsYou: true, sortPriority: 0 }),
        rowFor("NEEDS_YOU", { comboId: "b", needsYou: true, sortPriority: 0 }),
        rowFor("CODER", { comboId: "c" }),
      ],
      tab: "live",
    });
    expect(view.needsCount).toBe(2);
  });

  it("empty onboarding state when no combos at all", () => {
    const view = deriveFleetView({ rows: [], tab: "live" });
    expect(view.emptyState).toBe("onboarding");
  });

  it("all-quiet empty state when live tab empty but closed combos exist", () => {
    const view = deriveFleetView({
      rows: [rowFor("CLOSED", { comboId: "closed", sortPriority: 4 })],
      tab: "live",
    });
    expect(view.emptyState).toBe("all-quiet");
  });

  it("no empty state when live rows exist", () => {
    const view = deriveFleetView({
      rows: [rowFor("CODER", { comboId: "live" })],
      tab: "live",
    });
    expect(view.emptyState).toBeUndefined();
  });
});
// -/ 3/3
