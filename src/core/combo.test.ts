/**
 * @overview Unit tests for core combo phase derivation (deriveStatus).
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at describe("deriveStatus")  ← phase state machine contract
 *
 *   ┌─ TEST AREAS ──────────────────────────────────────────────┐
 *   │ deriveStatus         Verifies the phase state machine      │
 *   └────────────────────────────────────────────────────────────┘
 *
 * @exports none (test file)
 * @deps vitest, ./combo, ./events
 */
import { describe, expect, it } from "vitest";

import type { ComboEvent } from "./events.js";
import { deriveStatus } from "./combo.js";

function ev(event: ComboEvent["event"], extra: Record<string, unknown> = {}): ComboEvent {
  return { t: new Date().toISOString(), event, ...extra };
}

// -- 1/1 CORE · Phase derivation tests (deriveStatus) --

describe("deriveStatus", () => {
  it("starts in SETUP", () => {
    expect(deriveStatus([]).phase).toBe("SETUP");
    expect(deriveStatus([ev("combo_created", { issue_url: "x" })]).phase).toBe("SETUP");
  });

  it("advances through the documented phases", () => {
    const events = [ev("combo_created", { issue_url: "x" }), ev("coder_started")];
    expect(deriveStatus(events).phase).toBe("CODING");

    events.push(ev("coder_done"));
    expect(deriveStatus(events).phase).toBe("GATING");

    events.push(ev("gate_started"));
    expect(deriveStatus(events).phase).toBe("GATING");

    events.push(ev("pr_opened", { url: "https://github.com/o/r/pull/9" }));
    const status = deriveStatus(events);
    expect(status.phase).toBe("REVIEWING");
    expect(status.pr).toBe("https://github.com/o/r/pull/9");
  });

  it("marks the combo READY only from a ready_for_merge event", () => {
    const status = deriveStatus([
      ev("pr_opened", { url: "https://github.com/o/r/pull/9" }),
      ev("gate_validated", { sha: "def456" }),
      ev("lgtm", { sha: "def456" }),
      ev("ready_for_merge", {
        sha: "def456",
        pr_url: "https://github.com/o/r/pull/9",
      }),
    ]);

    expect(status.phase).toBe("READY");
    expect(status.needsHuman).toBe(false);
    expect(status.pr).toBe("https://github.com/o/r/pull/9");
  });

  it("moves a READY combo back to REVIEWING when head-bound signals go stale", () => {
    for (const staleEvent of [
      ev("lgtm_stale", { old_sha: "def456", new_sha: "fedcba" }),
      ev("gate_stale", { old_sha: "def456", new_sha: "fedcba" }),
      ev("address_done", { head_sha: "fedcba" }),
      ev("pr_conflict", {
        sha: "def456",
        pr_url: "https://github.com/o/r/pull/9",
        merge_state: "DIRTY",
        action: "rebase_required",
      }),
    ]) {
      const status = deriveStatus([
        ev("pr_opened", { url: "https://github.com/o/r/pull/9" }),
        ev("ready_for_merge", {
          sha: "def456",
          pr_url: "https://github.com/o/r/pull/9",
        }),
        staleEvent,
      ]);

      expect(status.phase).toBe("REVIEWING");
      expect(status.needsHuman).toBe(false);
      expect(status.pr).toBe("https://github.com/o/r/pull/9");
    }
  });

  it("returns an existing PR to REVIEWING when a follow-up gate completes", () => {
    for (const gateDone of [
      ev("gate_status", { state: "idle", head_sha: "fedcba" }),
      ev("gate_validated", { sha: "fedcba" }),
    ]) {
      const status = deriveStatus([
        ev("pr_opened", { url: "https://github.com/o/r/pull/9" }),
        ev("gate_started"),
        gateDone,
      ]);

      expect(status.phase).toBe("REVIEWING");
      expect(status.needsHuman).toBe(false);
      expect(status.pr).toBe("https://github.com/o/r/pull/9");
    }
  });

  it("latches needs_human until the next phase advance", () => {
    const events = [ev("coder_started"), ev("needs_human", { reason: "gate_decision" })];
    const status = deriveStatus(events);
    expect(status.needsHuman).toBe(true);
    expect(status.reason).toBe("gate_decision");

    events.push(ev("gate_started"));
    expect(deriveStatus(events).needsHuman).toBe(false);
  });

  it("marks failures as STALLED and needing a human", () => {
    for (const failed of [
      ev("coder_failed", { exit_code: 1, has_new_commits: false }),
      ev("gate_failed", { exit_code: 17 }),
      ev("pr_autoclose_failed", { exit_code: 18, url: "https://github.com/o/r/pull/9" }),
      ev("rebase_failed", { base: "base-sha" }),
      ev("rebase_conflict", { base: "base-sha" }),
    ]) {
      const status = deriveStatus([failed]);
      expect(status.phase).toBe("STALLED");
      expect(status.needsHuman).toBe(true);
    }
  });

  it("terminal stop wins over everything", () => {
    const status = deriveStatus([
      ev("coder_started"),
      ev("needs_human", { reason: "x" }),
      ev("stopped", { by: "human" }),
    ]);
    expect(status.phase).toBe("STOPPED");
    expect(status.needsHuman).toBe(false);
  });

  it("does not treat parking for reboot as terminal", () => {
    const status = deriveStatus([
      ev("coder_started"),
      ev("coder_failed", { exit_code: 124, has_new_commits: true }),
      ev("parked", { by: "maintainer", summary_path: "/runs/o-r-7/park-handoff.md" }),
    ]);
    expect(status.phase).toBe("STALLED");
    expect(status.needsHuman).toBe(true);
    expect(status.reason).toBe("coder_failed");
  });

  it("enters the pre-publish LOCAL_REVIEW phase when a local review is requested", () => {
    const status = deriveStatus([
      ev("coder_started"),
      ev("coder_done"),
      ev("local_review_requested", { round: 1, sha: "abc123" }),
    ]);

    expect(status.phase).toBe("LOCAL_REVIEW");
    expect(status.needsHuman).toBe(false);
    expect(status.pr).toBeUndefined();
  });

  it("advances LOCAL_REVIEW by local_verdict code", () => {
    const loop = [
      ev("coder_started"),
      ev("coder_done"),
      ev("local_review_requested", { round: 1, sha: "abc123" }),
    ];
    const verdict = (code: number) =>
      ev("local_verdict", {
        round: 1,
        code,
        verdict_path: "/runs/o-r-7/verdict-1.json",
        identity: { model: "m", runtime: "r" },
      });

    const fix = deriveStatus([...loop, verdict(1)]);
    expect(fix.phase).toBe("LOCAL_REVIEW");
    expect(fix.needsHuman).toBe(false);

    const approved = deriveStatus([...loop, verdict(0)]);
    expect(approved.phase).toBe("GATING");
    expect(approved.needsHuman).toBe(false);

    for (const code of [2, 3]) {
      const escalated = deriveStatus([...loop, verdict(code)]);
      expect(escalated.phase).toBe("LOCAL_REVIEW");
      expect(escalated.needsHuman).toBe(true);
      expect(escalated.reason).toBe(`local_verdict_code_${code}`);
    }
  });

  it("ignores a local_verdict outside the LOCAL_REVIEW phase", () => {
    const status = deriveStatus([
      ev("pr_opened", { url: "https://github.com/o/r/pull/9" }),
      ev("local_verdict", {
        round: 1,
        code: 3,
        verdict_path: "/runs/o-r-7/verdict-1.json",
        identity: { model: "m", runtime: "r" },
      }),
    ]);

    expect(status.phase).toBe("REVIEWING");
    expect(status.needsHuman).toBe(false);
  });

  it("clears a pending needs_human only when a decision references its identity", () => {
    const escalation = ev("needs_human", { reason: "local_verdict_code_3" });
    const events = [
      ev("coder_started"),
      ev("local_review_requested", { round: 1, sha: "abc123" }),
      escalation,
    ];
    expect(deriveStatus(events).needsHuman).toBe(true);

    const unrelated = deriveStatus([
      ...events,
      ev("decision", { needs_human_ref: "1999-01-01T00:00:03.000Z", verb: "retry" }),
    ]);
    expect(unrelated.needsHuman).toBe(true);
    expect(unrelated.reason).toBe("local_verdict_code_3");

    const decided = deriveStatus([
      ...events,
      ev("decision", { needs_human_ref: escalation.t, verb: "retry" }),
    ]);
    expect(decided.needsHuman).toBe(false);
    expect(decided.phase).toBe("LOCAL_REVIEW");
  });

  it("keeps the other escalation pending when only one of two is decided", () => {
    const first = { ...ev("needs_human", { reason: "review_no_progress" }), t: "2026-07-12T00:00:01.000Z" };
    const second = { ...ev("needs_human", { reason: "review_fix_noop" }), t: "2026-07-12T00:00:02.000Z" };
    const events = [
      ev("coder_started"),
      ev("local_review_requested", { round: 1, sha: "abc123" }),
      first,
      second,
    ];

    const oneDecided = deriveStatus([...events, ev("decision", { needs_human_ref: second.t, verb: "skip" })]);
    expect(oneDecided.needsHuman).toBe(true);
    expect(oneDecided.reason).toBe("review_no_progress");

    const bothDecided = deriveStatus([
      ...events,
      ev("decision", { needs_human_ref: second.t, verb: "skip" }),
      ev("decision", { needs_human_ref: first.t, verb: "retry" }),
    ]);
    expect(bothDecided.needsHuman).toBe(false);
  });

  it("folds legacy same-timestamp escalations as one identity", () => {
    // appendEvent now allocates unique timestamps; journals written before
    // that guarantee may alias, and a decision then resolves the shared ref.
    const shared = "2026-07-12T00:00:05.000Z";
    const events = [
      ev("coder_started"),
      { ...ev("needs_human", { reason: "review_no_progress" }), t: shared },
      { ...ev("needs_human", { reason: "review_fix_noop" }), t: shared },
    ];
    expect(deriveStatus(events).needsHuman).toBe(true);

    const decided = deriveStatus([...events, ev("decision", { needs_human_ref: shared, verb: "ignore" })]);
    expect(decided.needsHuman).toBe(false);
  });

  it("leaves follow_ups out of phase derivation", () => {
    const status = deriveStatus([
      ev("coder_started"),
      ev("local_review_requested", { round: 1, sha: "abc123" }),
      ev("follow_ups", { round: 1, items: [] }),
    ]);

    expect(status.phase).toBe("LOCAL_REVIEW");
    expect(status.needsHuman).toBe(false);
  });

  it("keeps merged PRs actionable until closure records combo_closed", () => {
    const merged = deriveStatus([
      ev("pr_opened", { url: "https://github.com/o/r/pull/9" }),
      ev("needs_human", { reason: "pr_ready" }),
      ev("merged", { sha: "def456", by: "maintainer" }),
    ]);
    expect(merged.phase).toBe("STALLED");
    expect(merged.needsHuman).toBe(true);
    expect(merged.reason).toBe("closure_pending");

    const closed = deriveStatus([
      ev("pr_opened", { url: "https://github.com/o/r/pull/9" }),
      ev("needs_human", { reason: "pr_ready" }),
      ev("merged", { sha: "def456", by: "maintainer" }),
      ev("combo_closed"),
    ]);
    expect(closed.phase).toBe("STOPPED");
    expect(closed.needsHuman).toBe(false);
  });
});
// -/ 1/1
