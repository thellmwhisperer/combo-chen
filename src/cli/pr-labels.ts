/**
 * @overview Combo PR label projection helpers.
 *   ~220 lines, pure desired-label and diff logic for GitHub PR labels.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at projectComboPrLabels     <- journal + live PR facts to labels.
 *   2. Then diffComboPrLabels            <- idempotent GitHub label add/remove plan.
 *   3. Bottom helpers                    <- current-head, stale, and check predicates.
 *
 *   MAIN FLOW
 *   ---------
 *   journal events + gh pr view/check facts -> combo:* labels -> add/remove diff
 *
 *   PUBLIC API
 *   ----------
 *   COMBO_PR_LABELS, ComboPrLabel, ComboPrLabelProjectionInput, ComboPrLabelProjection
 *   projectComboPrLabels, diffComboPrLabels, isComboPrLabel
 *
 *   INTERNALS
 *   ---------
 *   orderedLabels, current work label, stale/conflict/current-head predicates
 *
 * @exports COMBO_PR_LABELS, ComboPrLabel, ComboPrLabelProjectionInput, ComboPrLabelProjection, projectComboPrLabels, diffComboPrLabels, isComboPrLabel
 * @deps ../core/events, ./checks
 */
import type { ComboEvent } from "../core/events.js";
import {
  checkNameMatchesAny,
  checkRollupSucceeded,
  checkSignalIsSuccess,
  requiredChecksSucceeded,
} from "./checks.js";

// -- 1/3 CORE - label catalogue + public types <- START HERE --
export const COMBO_PR_LABELS = [
  "combo:working-coder",
  "combo:working-reviewer",
  "combo:working-gate",
  "combo:lgtm",
  "combo:coderabbit-green",
  "combo:ready",
  "combo:stale",
  "combo:conflict",
  "combo:needs-human",
] as const;

export type ComboPrLabel = (typeof COMBO_PR_LABELS)[number];

export interface ComboPrLabelProjectionInput {
  events: ComboEvent[];
  pr: {
    state: string;
    headSha: string;
    mergeStateStatus?: string;
    statusCheckRollup?: unknown[];
  };
  activity?: {
    coderRespondingActive?: boolean;
    reviewerActive?: boolean;
    gateActive?: boolean;
  };
  requiredCheckNames?: string[];
  ambientCheckNames?: string[];
  codeRabbitCheckNames?: string[];
}

export interface ComboPrLabelProjection {
  labels: ComboPrLabel[];
  headSha: string;
  prState: string;
  reason: "pr_not_open" | "conflict" | "stale" | "current";
}

export interface ComboPrLabelDiff {
  add: ComboPrLabel[];
  remove: ComboPrLabel[];
}

const COMBO_PR_LABEL_SET = new Set<string>(COMBO_PR_LABELS);
const DEFAULT_CODERABBIT_CHECK_NAMES = ["CodeRabbit"];

export function isComboPrLabel(label: string): label is ComboPrLabel {
  return COMBO_PR_LABEL_SET.has(label);
}
// -/ 1/3

// -- 2/3 CORE - projection + diff --
export function projectComboPrLabels(input: ComboPrLabelProjectionInput): ComboPrLabelProjection {
  const labels = new Set<ComboPrLabel>();
  const headSha = input.pr.headSha;
  const prState = input.pr.state;

  if (prState !== "OPEN") {
    return { labels: [], headSha, prState, reason: "pr_not_open" };
  }

  const conflict = prHasConflict(input.pr.mergeStateStatus);
  const workLabel = currentWorkLabel(input.events, headSha, input.activity);
  if (workLabel !== undefined && !conflict) labels.add(workLabel);

  if (conflict) {
    labels.add("combo:conflict");
    return { labels: orderedLabels(labels), headSha, prState, reason: "conflict" };
  }

  const lgtmCurrent = shaMatchesHead(livePinnedLgtmSha(input.events), headSha);
  const codeRabbitGreen = namedCheckSucceeded(
    input.pr.statusCheckRollup,
    input.codeRabbitCheckNames ?? DEFAULT_CODERABBIT_CHECK_NAMES,
  );
  const readyCurrent = currentReadyAgreement(input, lgtmCurrent);
  const stale = hasStaleCurrentHeadSignal(input.events, headSha);

  if (lgtmCurrent) labels.add("combo:lgtm");
  if (codeRabbitGreen) labels.add("combo:coderabbit-green");
  if (readyCurrent) labels.add("combo:ready");
  if (stale && !readyCurrent) labels.add("combo:stale");

  return {
    labels: orderedLabels(labels),
    headSha,
    prState,
    reason: stale && !readyCurrent ? "stale" : "current",
  };
}

export function diffComboPrLabels(existingLabels: string[], desiredLabels: Iterable<ComboPrLabel>): ComboPrLabelDiff {
  const existing = new Set(existingLabels.filter(isComboPrLabel));
  const desired = new Set(desiredLabels);
  const add = orderedLabels(COMBO_PR_LABELS.filter((label) => desired.has(label) && !existing.has(label)));
  const remove = orderedLabels(COMBO_PR_LABELS.filter((label) => existing.has(label) && !desired.has(label)));
  return { add, remove };
}

function orderedLabels(labels: Iterable<ComboPrLabel>): ComboPrLabel[] {
  const set = new Set(labels);
  return COMBO_PR_LABELS.filter((label) => set.has(label));
}
// -/ 2/3

// -- 3/3 HELPER - current-head and check predicates --
function currentWorkLabel(
  events: ComboEvent[],
  headSha: string,
  activity: ComboPrLabelProjectionInput["activity"] = {},
): ComboPrLabel | undefined {
  if (activity.gateActive || journalGateActive(events)) return "combo:working-gate";
  if (activity.coderRespondingActive || hasUnaddressedReviewComment(events, headSha)) {
    return "combo:working-coder";
  }
  if (activity.reviewerActive) return "combo:working-reviewer";
  return undefined;
}

function journalGateActive(events: ComboEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.event === "gate_started") return true;
    if (
      event.event === "gate_validated" ||
      event.event === "gate_failed" ||
      event.event === "gate_stale" ||
      event.event === "pr_opened" ||
      event.event === "ready_for_merge"
    ) {
      return false;
    }
    if (event.event === "gate_status" && event["state"] === "idle") return false;
  }
  return false;
}

function hasUnaddressedReviewComment(events: ComboEvent[], headSha: string): boolean {
  let pending = false;
  for (const event of events) {
    if (event.event === "review_comment" && eventMatchesHead(event, headSha)) pending = true;
    if (
      (event.event === "address_done" || event.event === "address_noop") &&
      shaMatchesHead(stringField(event, "head_sha"), headSha)
    ) {
      pending = false;
    }
  }
  return pending;
}

function eventMatchesHead(event: ComboEvent, headSha: string): boolean {
  const eventHead = stringField(event, "head_sha");
  return eventHead === undefined || shaMatchesHead(eventHead, headSha);
}

function prHasConflict(mergeStateStatus: string | undefined): boolean {
  const state = mergeStateStatus?.trim().toUpperCase();
  return state === "DIRTY" || state === "CONFLICTING";
}

function currentReadyAgreement(input: ComboPrLabelProjectionInput, lgtmCurrent: boolean): boolean {
  const headSha = input.pr.headSha;
  return (
    latestReadyForMergeSha(input.events) !== undefined &&
    shaMatchesHead(latestReadyForMergeSha(input.events), headSha) &&
    lgtmCurrent &&
    shaMatchesHead(latestPublishedGateSha(input.events), headSha) &&
    checkRollupSucceeded(input.pr.statusCheckRollup, {
      requiredCheckNames: input.requiredCheckNames,
      ambientCheckNames: input.ambientCheckNames,
    }) &&
    requiredChecksSucceeded(input.pr.statusCheckRollup, input.requiredCheckNames ?? [])
  );
}

function namedCheckSucceeded(rollup: unknown[] | undefined, names: string[]): boolean {
  if (rollup === undefined) return false;
  return rollup.some((item) => checkNameMatchesAny(item, names) && checkSignalIsSuccess(item));
}

function hasStaleCurrentHeadSignal(events: ComboEvent[], headSha: string): boolean {
  return [livePinnedLgtmSha(events), latestReadyForMergeSha(events), latestPublishedGateSha(events)].some(
    (sha) => sha !== undefined && !shaMatchesHead(sha, headSha),
  );
}

function livePinnedLgtmSha(events: ComboEvent[]): string | undefined {
  let sha: string | undefined;
  for (const event of events) {
    if (event.event === "lgtm") sha = stringField(event, "sha");
    if (event.event === "lgtm_stale" && stringField(event, "old_sha") === sha) {
      sha = undefined;
    }
  }
  return sha;
}

function latestReadyForMergeSha(events: ComboEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.event === "ready_for_merge") return stringField(event, "sha");
  }
  return undefined;
}

function latestPublishedGateSha(events: ComboEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.event === "gate_validated") return stringField(event, "sha");
    if (event.event === "gate_status" && event["state"] === "idle") {
      return stringField(event, "head_sha");
    }
  }
  return undefined;
}

function shaMatchesHead(candidate: string | undefined, headSha: string): boolean {
  if (candidate === undefined) return false;
  const pin = candidate.trim().toLowerCase();
  const head = headSha.trim().toLowerCase();
  return pin.length >= 7 && (pin === head || head.startsWith(pin));
}

function stringField(event: ComboEvent, field: string): string | undefined {
  const value = event[field];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
// -/ 3/3
