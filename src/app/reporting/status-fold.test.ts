/**
 * @overview Pure status and recap fold contract tests.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at deriveStatusSurface tests <- mutation-free live status facts.
 *   2. Then deriveRecap tests             <- time-bounded journal digest.
 *
 *   MAIN FLOW
 *   ---------
 *   combo + journal + injected facts -> pure folds -> render-ready models
 *
 *   PUBLIC API
 *   ----------
 *   None (test file).
 *
 *   INTERNALS
 *   ---------
 *   combo fixture and journal fact fixtures.
 *
 * @exports none
 * @deps ./status-fold, ../../core/state, vitest
 */
import { describe, expect, it } from "vitest";

import type { ComboRecord } from "../../core/state.js";
import { deriveRecap, deriveStatusSurface, renderRecap } from "./status-fold.js";

// -- 1/2 CORE · deriveStatusSurface <- START HERE --
const combo: ComboRecord = {
  id: "o-r-7",
  issueUrl: "https://github.com/o/r/issues/7",
  repoDir: "/repos/r",
  worktree: "/repos/r/.worktrees/7",
  branch: "combo/7",
  tmuxSession: "combo-chen-o-r-7",
  createdAt: "2026-07-12T08:00:00.000Z",
};

describe("deriveStatusSurface", () => {
  it("derives missing-process attention without changing the journal", () => {
    const events = [{ t: "2026-07-12T08:01:00.000Z", event: "coder_started" }] as never[];
    const before = structuredClone(events);

    const row = deriveStatusSurface({ combo, events, probes: { sessionExists: false } });

    expect(row.status).toMatchObject({ phase: "CODING", needsHuman: true, reason: "tmux_missing" });
    expect(row.processRepair).toEqual({ event: "needs_human", reason: "tmux_missing" });
    expect(events).toEqual(before);
  });

  it("does not treat parked or stopped runs as missing processes", () => {
    for (const event of [
      { t: "2026-07-12T08:02:00.000Z", event: "parked", by: "operator", summary_path: "x" },
      { t: "2026-07-12T08:02:00.000Z", event: "stopped", by: "operator" },
    ]) {
      const row = deriveStatusSurface({
        combo,
        events: [event] as never[],
        probes: { sessionExists: false },
      });
      expect(row.processRepair).toBeUndefined();
      expect(row.status.reason).not.toBe("tmux_missing");
    }
  });
});
// -/ 1/2

// -- 2/2 CORE · deriveRecap and renderRecap --
describe("deriveRecap", () => {
  it("summarizes new v1 events, phase changes, severity trend, escalation, decision, and merge", () => {
    const recap = deriveRecap({
      combo,
      since: "2026-07-12T09:00:00.000Z",
      events: [
        { t: "2026-07-12T09:01:00.000Z", event: "coder_started" },
        { t: "2026-07-12T09:02:00.000Z", event: "local_review_requested", round: 1 },
        {
          t: "2026-07-12T09:03:00.000Z",
          event: "local_verdict",
          round: 1,
          findings: [{ severity: "major" }, { severity: "minor" }],
        },
        {
          t: "2026-07-12T09:04:00.000Z",
          event: "local_verdict",
          round: 2,
          findings: [{ severity: "minor" }],
        },
        { t: "2026-07-12T09:05:00.000Z", event: "needs_human", reason: "intent" },
        {
          t: "2026-07-12T09:06:00.000Z",
          event: "decision",
          needs_human_ref: "2026-07-12T09:05:00.000Z",
          verb: "retry",
        },
        { t: "2026-07-12T09:07:00.000Z", event: "follow_ups", items: ["document edge case"] },
        { t: "2026-07-12T09:08:00.000Z", event: "merged", sha: "abc1234", by: "javi" },
      ],
    });

    expect(recap.phaseChanges.map((change) => change.phase)).toContain("CODING");
    expect(recap.verdicts).toMatchObject([
      { round: 1, total: 2, severities: { major: 1, minor: 1 } },
      { round: 2, total: 1, trend: -1, severities: { minor: 1 } },
    ]);
    expect(recap.escalations).toHaveLength(1);
    expect(recap.decisions).toHaveLength(1);
    expect(recap.followUps).toHaveLength(1);
    expect(recap.merges).toHaveLength(1);
    expect(renderRecap([recap])).toContain("findings 1 (down 1)");
  });

  it("uses the latest parked event as the default since-you-left boundary", () => {
    const recap = deriveRecap({
      combo,
      events: [
        { t: "2026-07-12T08:10:00.000Z", event: "needs_human", reason: "old" },
        { t: "2026-07-12T08:20:00.000Z", event: "parked" },
        { t: "2026-07-12T08:30:00.000Z", event: "needs_human", reason: "new" },
      ],
    });

    expect(recap.since).toBe("2026-07-12T08:20:00.000Z");
    expect(recap.escalations.map((event) => event.summary)).toEqual(["new"]);
  });
});
// -/ 2/2
