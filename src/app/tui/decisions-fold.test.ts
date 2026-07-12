/**
 * @overview Pending decision-card fold tests. The fold mirrors the W5b
 *   `decide` handler's pending semantics: a needs_human at timestamp t is
 *   pending until a decision event carries t as needs_human_ref. Unique event
 *   identity (journal timestamp) drives the set, so multiple escalations keep
 *   their cards until each is answered.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at pending set        <- one escalation, answered, re-escalated.
 *   2. Then card content           <- question/context/verbs derivation.
 *
 *   MAIN FLOW
 *   ---------
 *   events -> derivePendingDecisions -> DecisionCard[]
 *
 *   PUBLIC API
 *   ----------
 *   None (test file).
 *
 * @exports none
 * @deps ./decisions-fold, vitest
 */
import { describe, expect, it } from "vitest";

import type { JournalFact } from "../reporting/status-fold.js";
import { DECISION_VERBS, derivePendingDecisions } from "./decisions-fold.js";

function fact(event: string, t: string, extra: Record<string, unknown> = {}): JournalFact {
  return { t, event, ...extra };
}

// -- 1/2 CORE · pending set semantics --
describe("derivePendingDecisions pending set", () => {
  it("returns no cards when there are no needs_human events", () => {
    expect(derivePendingDecisions({ comboId: "o-r-7", events: [] })).toEqual([]);
  });

  it("returns a card for an unanswered needs_human", () => {
    const cards = derivePendingDecisions({
      comboId: "o-r-7",
      events: [fact("needs_human", "2026-07-12T08:00:00.000Z", { reason: "gate_failed" })],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.ref).toBe("2026-07-12T08:00:00.000Z");
    expect(cards[0]?.comboId).toBe("o-r-7");
  });

  it("clears the card when a decision references the needs_human timestamp", () => {
    const events: JournalFact[] = [
      fact("needs_human", "2026-07-12T08:00:00.000Z", { reason: "gate_failed" }),
      fact("decision", "2026-07-12T09:00:00.000Z", {
        needs_human_ref: "2026-07-12T08:00:00.000Z",
        verb: "retry",
      }),
    ];
    expect(derivePendingDecisions({ comboId: "o-r-7", events })).toEqual([]);
  });

  it("keeps multiple pending escalations as separate cards by timestamp identity", () => {
    const events: JournalFact[] = [
      fact("needs_human", "2026-07-12T08:00:00.000Z", { reason: "gate_failed" }),
      fact("needs_human", "2026-07-12T10:00:00.000Z", { reason: "local_verdict_code_2" }),
      fact("decision", "2026-07-12T09:00:00.000Z", {
        needs_human_ref: "2026-07-12T08:00:00.000Z",
        verb: "skip",
      }),
    ];
    const cards = derivePendingDecisions({ comboId: "o-r-7", events });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.ref).toBe("2026-07-12T10:00:00.000Z");
  });

  it("treats a re-escalation after a decision as a new pending card", () => {
    const events: JournalFact[] = [
      fact("needs_human", "2026-07-12T08:00:00.000Z", { reason: "gate_failed" }),
      fact("decision", "2026-07-12T09:00:00.000Z", {
        needs_human_ref: "2026-07-12T08:00:00.000Z",
        verb: "retry",
      }),
      fact("needs_human", "2026-07-12T11:00:00.000Z", { reason: "gate_failed" }),
    ];
    const cards = derivePendingDecisions({ comboId: "o-r-7", events });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.ref).toBe("2026-07-12T11:00:00.000Z");
  });
});
// -/ 1/2

// -- 2/2 CORE · card content --
describe("derivePendingDecisions card content", () => {
  it("derives a humanized question from the reason and includes combo context", () => {
    const cards = derivePendingDecisions({
      comboId: "o-r-7",
      workItemLabel: "#142 Add 2FA",
      events: [fact("needs_human", "2026-07-12T08:00:00.000Z", { reason: "gate_failed" })],
    });
    const card = cards[0]!;
    expect(card.question).toContain("gate");
    expect(card.context).toContain("o-r-7");
    expect(card.context).toContain("#142");
    expect(card.verbs).toEqual(DECISION_VERBS);
  });

  it("falls back to the raw reason for unknown codes", () => {
    const cards = derivePendingDecisions({
      comboId: "o-r-7",
      events: [fact("needs_human", "2026-07-12T08:00:00.000Z", { reason: "some-novel-reason" })],
    });
    expect(cards[0]?.question).toContain("some-novel-reason");
  });

  it("exposes the four decision verbs in a stable order", () => {
    expect(DECISION_VERBS).toEqual(["retry", "skip", "take_over", "ignore"]);
  });
});
// -/ 2/2
