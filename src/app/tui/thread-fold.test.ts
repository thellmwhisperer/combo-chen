/**
 * @overview Dive-in thread fold tests: the combo rendered as a chronological
 *   thread (PRD s8). Pure fold over journal events + verdict files + loop
 *   state + injected liveness. Renders v1 review-loop journals with inline
 *   findings and degrades gracefully over v0 journals (no verdict files).
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at v0 journal thread   <- degrades to event entries, no findings.
 *   2. Then v1 review loop          <- verdict entries carry inline findings.
 *   3. Then escalations + decisions <- thread entries for each.
 *   4. Then live actor + breadcrumb + projection.
 *
 *   MAIN FLOW
 *   ---------
 *   events + verdicts + liveness -> deriveThread -> ThreadView
 *
 *   PUBLIC API
 *   ----------
 *   None (test file).
 *
 * @exports none
 * @deps ./thread-fold, ../../core/verdict, ../reporting/status-fold, vitest
 */
import { describe, expect, it } from "vitest";

import type { JournalFact } from "../reporting/status-fold.js";
import { deriveThread } from "./thread-fold.js";

function fact(event: string, t: string, extra: Record<string, unknown> = {}): JournalFact {
  return { t, event, ...extra };
}

const T0 = "2026-07-12T08:00:00.000Z";
const T1 = "2026-07-12T08:30:00.000Z";
const T2 = "2026-07-12T09:00:00.000Z";
const T3 = "2026-07-12T09:30:00.000Z";
const T4 = "2026-07-12T10:00:00.000Z";
const T5 = "2026-07-12T10:30:00.000Z";

function combo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "o-r-7",
    issueUrl: "https://github.com/o/r/issues/7",
    repoDir: "/repo",
    worktree: "/wt",
    branch: "combo/issue-7",
    tmuxSession: "combo-chen-o-r-7",
    createdAt: T0,
    ...overrides,
  };
}

// -- 1/5 CORE · v0 journal thread (graceful degradation) --
describe("deriveThread v0 journal", () => {
  it("maps launched, coder_done, gate, pr, ready, closed to chronological entries", () => {
    const events: JournalFact[] = [
      fact("combo_created", T0, { issue_url: "https://github.com/o/r/issues/7" }),
      fact("coder_done", T1),
      fact("gate_started", T2),
      fact("pr_opened", T3, { url: "https://github.com/o/r/pull/42" }),
      fact("ready_for_merge", T4, { sha: "abc", pr_url: "https://github.com/o/r/pull/42" }),
      fact("combo_closed", T5),
    ];
    const view = deriveThread({ combo: combo() as never, events, now: Date.parse(T5) });
    const kinds = view.entries.map((e) => e.kind);
    expect(kinds).toEqual(["launched", "coder_done", "gate", "pr", "ready", "closed"]);
  });

  it("marks the breadcrumb stages done as the combo advances", () => {
    const events: JournalFact[] = [
      fact("combo_created", T0),
      fact("coder_done", T1),
      fact("pr_opened", T3, { url: "https://github.com/o/r/pull/42" }),
    ];
    const view = deriveThread({ combo: combo() as never, events, now: Date.parse(T4) });
    const byStage = new Map(view.breadcrumb.stages.map((s) => [s.stage, s.state]));
    expect(byStage.get("coder")).toBe("done");
    expect(byStage.get("gate")).toBe("done");
    expect(byStage.get("pr")).toBe("live");
    expect(byStage.get("merge")).toBe("pending");
  });

  it("produces no findings on verdict-less v0 entries", () => {
    const events: JournalFact[] = [
      fact("combo_created", T0),
      fact("coder_done", T1),
      fact("combo_closed", T2),
    ];
    const view = deriveThread({ combo: combo() as never, events });
    for (const entry of view.entries) {
      expect(entry.findings ?? []).toEqual([]);
    }
  });
});
// -/ 1/5

// -- 2/5 CORE · v1 review loop with inline findings --
describe("deriveThread v1 review loop", () => {
  it("renders a verdict entry with inline findings sourced from the verdict file", () => {
    const events: JournalFact[] = [
      fact("combo_created", T0),
      fact("coder_done", T1),
      fact("local_review_requested", T2, { round: 1, sha: "abc" }),
      fact("local_verdict", T3, {
        round: 1,
        code: 1,
        verdict_path: "verdict-1.json",
        identity: { model: "m", runtime: "r" },
      }),
    ];
    const verdicts = new Map([
      [
        1,
        {
          schemaVersion: 1,
          round: 1,
          code: 1,
          reviewed: { sha: "abc" },
          identity: { model: "m", runtime: "r" },
          checklist: [{ id: "tdd-first", status: "pass" }],
          findings: [
            { id: "f1", severity: "major", file: "auth.ts", line: 88, title: "DRY violation", body: "x" },
            { id: "f2", severity: "note", file: "enroll.ts", title: "naming", body: "y" },
          ],
          followUps: [],
        },
      ],
    ]);
    const view = deriveThread({
      combo: combo() as never,
      events,
      verdicts: verdicts as never,
      now: Date.parse(T3),
    });
    const verdictEntry = view.entries.at(-1)!;
    expect(verdictEntry.kind).toBe("verdict");
    expect(verdictEntry.headline).toContain("1");
    expect(verdictEntry.headline).toContain("code 1");
    expect(verdictEntry.findings).toHaveLength(2);
    expect(verdictEntry.findings?.[0]).toMatchObject({
      severity: "major",
      file: "auth.ts",
      line: 88,
      title: "DRY violation",
    });
  });

  it("degrades a verdict entry to no findings when the verdict file is absent", () => {
    const events: JournalFact[] = [
      fact("combo_created", T0),
      fact("coder_done", T1),
      fact("local_verdict", T3, {
        round: 1,
        code: 0,
        verdict_path: "verdict-1.json",
        identity: { model: "m", runtime: "r" },
      }),
    ];
    const view = deriveThread({ combo: combo() as never, events, verdicts: new Map(), now: Date.parse(T3) });
    const verdictEntry = view.entries.at(-1)!;
    expect(verdictEntry.kind).toBe("verdict");
    expect(verdictEntry.headline).toContain("code 0");
    expect(verdictEntry.findings ?? []).toEqual([]);
  });

  it("counts review rounds across requests and verdicts", () => {
    const events: JournalFact[] = [
      fact("combo_created", T0),
      fact("coder_done", T1),
      fact("local_review_requested", T2, { round: 1, sha: "a" }),
      fact("local_verdict", T3, { round: 1, code: 1, verdict_path: "v1", identity: {} }),
      fact("local_review_requested", T4, { round: 2, sha: "b" }),
    ];
    const view = deriveThread({ combo: combo() as never, events, verdicts: new Map(), now: Date.parse(T4) });
    expect(view.round).toBe(2);
  });
});
// -/ 2/5

// -- 3/5 CORE · escalations + human decisions as thread entries --
describe("deriveThread escalations and decisions", () => {
  it("renders needs_human as an escalated entry and decision as a thread entry", () => {
    const events: JournalFact[] = [
      fact("combo_created", T0),
      fact("needs_human", T2, { reason: "gate_failed" }),
      fact("decision", T3, { needs_human_ref: T2, verb: "retry" }),
    ];
    const view = deriveThread({ combo: combo() as never, events, now: Date.parse(T3) });
    const kinds = view.entries.map((e) => e.kind);
    expect(kinds).toEqual(["launched", "escalated", "decision"]);
    const escalated = view.entries.find((e) => e.kind === "escalated")!;
    expect(escalated.headline).toContain("gate_failed");
    const decision = view.entries.find((e) => e.kind === "decision")!;
    expect(decision.headline).toContain("retry");
  });

  it("counts pending escalations for the decision-card trigger", () => {
    const view = deriveThread({
      combo: combo() as never,
      events: [fact("combo_created", T0), fact("needs_human", T2, { reason: "gate_failed" })],
      now: Date.parse(T3),
    });
    expect(view.pendingDecisions).toBe(1);
  });

  it("drops pending count to zero once a decision answers the escalation", () => {
    const view = deriveThread({
      combo: combo() as never,
      events: [
        fact("combo_created", T0),
        fact("needs_human", T2, { reason: "gate_failed" }),
        fact("decision", T3, { needs_human_ref: T2, verb: "skip" }),
      ],
      now: Date.parse(T3),
    });
    expect(view.pendingDecisions).toBe(0);
  });
});
// -/ 3/5

// -- 4/5 CORE · live actor projection (drives the tmux jump) --
describe("deriveThread live actor", () => {
  it("projects a live coder actor during the coding phase with coder liveness", () => {
    const events: JournalFact[] = [fact("combo_created", T0), fact("coder_started", T1)];
    const view = deriveThread({
      combo: combo() as never,
      events,
      liveness: { coder: true },
      now: Date.parse(T1) + 30_000,
    });
    expect(view.liveActor?.actor).toBe("coder");
    expect(view.liveActor?.note).toBeTruthy();
    expect(view.liveActor?.sinceMs).toBeGreaterThanOrEqual(0);
  });

  it("projects a live reviewer actor during local review with reviewer liveness", () => {
    const events: JournalFact[] = [
      fact("combo_created", T0),
      fact("coder_done", T1),
      fact("local_review_requested", T2, { round: 1, sha: "a" }),
    ];
    const view = deriveThread({
      combo: combo() as never,
      events,
      liveness: { reviewer: true },
      now: Date.parse(T2) + 5_000,
    });
    expect(view.liveActor?.actor).toBe("reviewer");
  });

  it("projects a live gate actor during gating with gate liveness", () => {
    const events: JournalFact[] = [
      fact("combo_created", T0),
      fact("coder_done", T1),
      fact("local_review_requested", T2, { round: 1, sha: "a" }),
      fact("local_verdict", T3, { round: 1, code: 0, verdict_path: "v1", identity: {} }),
      fact("gate_started", T4),
    ];
    const view = deriveThread({
      combo: combo() as never,
      events,
      liveness: { gate: true },
      now: Date.parse(T4) + 5_000,
    });
    expect(view.liveActor?.actor).toBe("gate");
  });

  it("projects no live actor when liveness is empty", () => {
    const events: JournalFact[] = [fact("combo_created", T0)];
    const view = deriveThread({ combo: combo() as never, events });
    expect(view.liveActor).toBeUndefined();
  });
});
// -/ 4/5

// -- 5/5 CORE · projection (next event) and empty state --
describe("deriveThread projection and shape", () => {
  it("projects the next expected event for a live coder", () => {
    const view = deriveThread({
      combo: combo() as never,
      events: [fact("combo_created", T0), fact("coder_started", T1)],
      liveness: { coder: true },
      now: Date.parse(T1),
    });
    expect(view.projection).toBeTruthy();
    expect(view.projection).toContain("coder");
  });

  it("projects nothing once the combo is closed", () => {
    const view = deriveThread({
      combo: combo() as never,
      events: [fact("combo_created", T0), fact("combo_closed", T1)],
      now: Date.parse(T1),
    });
    expect(view.projection).toBeUndefined();
  });

  it("exposes the combo id and work item label for the header", () => {
    const view = deriveThread({
      combo: { ...combo(), workItemTitle: "Add 2FA" } as never,
      events: [fact("combo_created", T0)],
    });
    expect(view.comboId).toBe("o-r-7");
    expect(view.workItemLabel).toContain("7");
  });
});
// -/ 5/5
