/**
 * @overview Pure pending decision-card fold (PRD s7/s8). Derives the modal
 *   decision cards from journal events: each unanswered needs_human escalation
 *   yields one card, identified by its unique journal timestamp. A decision
 *   event resolves the escalation it names via needs_human_ref, mirroring the
 *   W5b `decide` handler's pending semantics exactly (one write path; this is
 *   the read path). The card surfaces a humanized question, two-line context,
 *   and the fixed decision verbs.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at derivePendingDecisions  <- events -> DecisionCard[].
 *   2. Then humanizeReason              <- reason -> human-facing question.
 *
 *   MAIN FLOW
 *   ---------
 *   journal events -> derivePendingDecisions -> DecisionCard[] (modal set)
 *
 *   PUBLIC API
 *   ----------
 *   DECISION_VERBS         The fixed verbs (re-exported from the decide handler).
 *   DecisionCard           One pending escalation's modal content.
 *   DecisionsInput         Fold input.
 *   derivePendingDecisions Pure fold: events -> pending decision cards.
 *
 *   INTERNALS
 *   ---------
 *   humanizeReason.
 *
 * @exports DECISION_VERBS, DecisionCard, DecisionsInput, derivePendingDecisions
 * @deps ../lifecycle/lifecycle-handlers, ../reporting/status-fold
 */
import { DECISION_VERBS } from "../lifecycle/lifecycle-handlers.js";
import type { JournalFact } from "../reporting/status-fold.js";

export { DECISION_VERBS };

// -- 1/2 CORE · derivePendingDecisions <- START HERE --

export interface DecisionCard {
  /** Journal timestamp of the needs_human event (unique identity). */
  readonly ref: string;
  readonly comboId: string;
  readonly reason: string;
  readonly question: string;
  /** Second line of context (PRD s7: two lines). The first line is the comboId. */
  readonly workItemLabel?: string;
  readonly verbs: readonly string[];
}

export interface DecisionsInput {
  readonly comboId: string;
  readonly events: readonly JournalFact[];
  readonly workItemLabel?: string;
}

export function derivePendingDecisions(input: DecisionsInput): DecisionCard[] {
  const decided = new Set(
    input.events
      .filter((event) => event.event === "decision")
      .map((event) => String(event["needs_human_ref"])),
  );
  const pending = input.events.filter((event) => event.event === "needs_human" && !decided.has(event.t));
  return pending.map((event) => {
    const reason = typeof event["reason"] === "string" ? (event["reason"] as string) : event.event;
    return {
      ref: event.t,
      comboId: input.comboId,
      reason,
      question: humanizeReason(reason),
      ...(input.workItemLabel !== undefined ? { workItemLabel: input.workItemLabel } : {}),
      verbs: DECISION_VERBS,
    };
  });
}
// -/ 1/2

// -- 2/2 HELPER · humanizeReason --
/**
 * Maps a machine needs_human reason to a one-sentence question the operator
 * can act on. Unknown reasons fall back to their raw text so the card never
 * hides information the journal carries.
 */
export function humanizeReason(reason: string): string {
  switch (reason) {
    case "gate_failed":
      return "The gate failed and could not auto-recover. Retry, or take over?";
    case "local_verdict_code_2":
      return "The reviewer flagged an ambiguous issue (code 2) that needs a product call.";
    case "local_verdict_code_3":
      return "The reviewer escalated this combo (code 3). What should happen next?";
    case "tmux_missing":
      return "The combo's tmux session is missing. Recreate it, or stop the combo?";
    case "pr_missing":
      return "No PR was opened for this combo. Retry the gate, or take over?";
    default:
      return reason;
  }
}
// -/ 2/2
