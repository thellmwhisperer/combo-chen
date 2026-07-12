/**
 * @overview Core logic: the combo phase state machine.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at deriveStatus               <- event -> phase state machine
 *   2. Phase / ComboStatus types           <- status shape and phase enum
 *
 * @exports deriveStatus, Phase, ComboStatus
 * @deps ./events, ./state
 */
import type { ComboEvent } from "./events.js";

export type Phase =
  "SETUP" | "CODING" | "LOCAL_REVIEW" | "GATING" | "REVIEWING" | "READY" | "STOPPED" | "STALLED";

export interface ComboStatus {
  phase: Phase;
  needsHuman: boolean;
  reason?: string;
  pr?: string;
  lastEvent?: ComboEvent;
}

// -- 1/1 CORE · Phase derivation + types --

export function deriveStatus(events: ComboEvent[]): ComboStatus {
  let phase: Phase = "SETUP";
  let pr: string | undefined;
  // Escalations fold by event identity: needs_human events pend under their
  // journal timestamp (unique per appendEvent) and a decision resolves only
  // the escalation its needs_human_ref names. Failure events that carry no
  // referenceable identity latch a flag instead; any progress event clears
  // everything, preserving the v0 "next phase advance" semantics.
  const pending = new Map<string, string | undefined>();
  let flagReason: string | undefined;
  let flagged = false;
  let reason: string | undefined;
  const clearHuman = (): void => {
    pending.clear();
    flagged = false;
    flagReason = undefined;
    reason = undefined;
  };
  const flag = (flagValue: string | undefined): void => {
    flagged = true;
    flagReason = flagValue;
    reason = flagValue;
  };

  for (const event of events) {
    switch (event.event) {
      case "coder_started":
        phase = "CODING";
        clearHuman();
        break;
      case "coder_done":
        if (phase === "SETUP" || phase === "CODING") {
          phase = "GATING";
          clearHuman();
        }
        break;
      case "gate_started":
        phase = "GATING";
        clearHuman();
        break;
      case "gate_status":
        if (event["state"] === "idle" && phase === "GATING" && pr !== undefined) {
          phase = "REVIEWING";
          clearHuman();
        }
        break;
      case "gate_validated":
        if (phase === "GATING" && pr !== undefined) {
          phase = "REVIEWING";
          clearHuman();
        }
        break;
      case "pr_opened":
        phase = "REVIEWING";
        clearHuman();
        pr = typeof event["url"] === "string" ? (event["url"] as string) : pr;
        break;
      // v1 pre-publish review loop: LOCAL_REVIEW sits between coder_done and
      // the gate; journals without these events derive exactly as before.
      case "local_review_requested":
        phase = "LOCAL_REVIEW";
        clearHuman();
        break;
      case "local_verdict":
        if (phase !== "LOCAL_REVIEW") break;
        if (event["code"] === 0) {
          phase = "GATING";
          clearHuman();
        } else if (event["code"] === 1) {
          clearHuman();
        } else if (event["code"] === 2 || event["code"] === 3) {
          flag(`local_verdict_code_${event["code"]}`);
        }
        break;
      case "decision": {
        pending.delete(String(event["needs_human_ref"]));
        reason = pending.size > 0 ? [...pending.values()].at(-1) : flagReason;
        break;
      }
      case "address_done":
      case "address_noop":
      case "gate_stale":
      case "lgtm_stale":
      case "pr_conflict":
        if (phase === "READY") {
          phase = "REVIEWING";
          clearHuman();
        }
        break;
      case "ready_for_merge":
        phase = "READY";
        clearHuman();
        pr = typeof event["pr_url"] === "string" ? (event["pr_url"] as string) : pr;
        break;
      case "coder_failed":
      case "gate_failed":
      case "pr_autoclose_failed":
      case "rebase_failed":
      case "rebase_conflict":
        phase = "STALLED";
        flag(event.event);
        if (event.event === "pr_autoclose_failed" && typeof event["url"] === "string") {
          pr = event["url"];
        }
        break;
      case "needs_human": {
        const escalationReason =
          typeof event["reason"] === "string" ? (event["reason"] as string) : undefined;
        pending.set(event.t, escalationReason);
        reason = escalationReason;
        break;
      }
      case "merged":
        phase = "STALLED";
        flag("closure_pending");
        break;
      case "stopped":
      case "combo_closed":
        phase = "STOPPED";
        clearHuman();
        break;
      default:
        break;
    }
  }

  const needsHuman = flagged || pending.size > 0;
  const status: ComboStatus = { phase, needsHuman };
  if (reason !== undefined && needsHuman) status.reason = reason;
  if (pr !== undefined) status.pr = pr;
  const last = events[events.length - 1];
  if (last !== undefined) status.lastEvent = last;
  return status;
}

// -/ 1/1
