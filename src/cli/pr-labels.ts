/**
 * @overview Combo PR label projection helpers.
 *   ~414 lines, deterministic desired-label, diff, and GitHub mutation helpers.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at projectComboPrLabels     <- journal + live PR facts to labels.
 *   2. Then diffComboPrLabels            <- idempotent GitHub label add/remove plan.
 *   3. Then syncComboPrLabels            <- fetch live labels, mutate GitHub, journal metadata.
 *   4. Bottom helpers                    <- current-head, stale, checks, and parsing.
 *
 *   MAIN FLOW
 *   ---------
 *   journal events + gh pr view/check facts -> combo:* labels -> add/remove diff -> optional gh edit + journal
 *
 *   PUBLIC API
 *   ----------
 *   COMBO_PR_LABELS, ComboPrLabel, ComboPrLabelProjectionInput, ComboPrLabelProjection,
 *   ComboPrLabelDiff, SyncComboPrLabelsInput, SyncComboPrLabelsResult
 *   projectComboPrLabels, diffComboPrLabels, syncComboPrLabels, isComboPrLabel
 *
 *   INTERNALS
 *   ---------
 *   orderedLabels, current work label, stale/conflict/current-head predicates, GH label parsing
 *
 * @exports COMBO_PR_LABELS, ComboPrLabel, ComboPrLabelProjectionInput, ComboPrLabelProjection, ComboPrLabelDiff, SyncComboPrLabelsInput, SyncComboPrLabelsResult, projectComboPrLabels, diffComboPrLabels, syncComboPrLabels, isComboPrLabel
 * @deps ../core/events, ./checks, ./github, ./reviewer
 */
import { appendEvent, type ComboEvent } from "../core/events.js";
import {
  checkNameMatchesAny,
  checkRollupSucceeded,
  checkSignalIsSuccess,
  requiredChecksSucceeded,
} from "./checks.js";
import type { GhRunner } from "./github.js";
import { livePinnedLgtmSha } from "./reviewer.js";

// -- 1/4 CORE - label catalogue + public types <- START HERE --
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

export interface SyncComboPrLabelsInput {
  gh: GhRunner;
  runDir: string;
  prUrl: string;
  events: ComboEvent[];
  activity?: ComboPrLabelProjectionInput["activity"];
  requiredCheckNames?: string[];
  ambientCheckNames?: string[];
  codeRabbitCheckNames?: string[];
  source?: string;
}

export interface SyncComboPrLabelsResult {
  prUrl: string;
  oldLabels: string[];
  newLabels: string[];
  projection: ComboPrLabelProjection;
  diff: ComboPrLabelDiff;
  changed: boolean;
}

const COMBO_PR_LABEL_SET = new Set<string>(COMBO_PR_LABELS);
const DEFAULT_CODERABBIT_CHECK_NAMES = ["CodeRabbit"];
const PR_LABEL_VIEW_FIELDS = "headRefOid,state,mergeStateStatus,statusCheckRollup,labels";

export function isComboPrLabel(label: string): label is ComboPrLabel {
  return COMBO_PR_LABEL_SET.has(label);
}
// -/ 1/4

// -- 2/4 CORE - projection + diff --
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
    configuredCodeRabbitCheckNames(input),
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
// -/ 2/4

// -- 3/4 CORE - GitHub mutation + journal metadata --
export function syncComboPrLabels(input: SyncComboPrLabelsInput): SyncComboPrLabelsResult {
  const current = fetchComboPrLabelView(input.gh, input.prUrl);
  const projection = projectComboPrLabels({
    events: input.events,
    pr: current.pr,
    activity: input.activity,
    requiredCheckNames: input.requiredCheckNames,
    ambientCheckNames: input.ambientCheckNames,
    codeRabbitCheckNames: input.codeRabbitCheckNames,
  });
  const diff = diffComboPrLabels(current.labels, projection.labels);
  let liveLabels = current.labels;

  if (diff.remove.length > 0) {
    editPrLabels(input.gh, input.prUrl, "--remove-label", diff.remove);
    const updated = fetchComboPrLabelView(input.gh, input.prUrl);
    appendPrLabelsUpdated(input, projection, {
      oldLabels: liveLabels,
      newLabels: updated.labels,
      addedLabels: [],
      removedLabels: diff.remove,
    });
    liveLabels = updated.labels;
  }
  const addLabels = diffComboPrLabels(liveLabels, projection.labels).add;
  if (addLabels.length > 0) {
    editPrLabels(input.gh, input.prUrl, "--add-label", addLabels);
    const updated = fetchComboPrLabelView(input.gh, input.prUrl);
    appendPrLabelsUpdated(input, projection, {
      oldLabels: liveLabels,
      newLabels: updated.labels,
      addedLabels: addLabels,
      removedLabels: [],
    });
    liveLabels = updated.labels;
  }

  const changed = diff.add.length > 0 || diff.remove.length > 0;

  return {
    prUrl: input.prUrl,
    oldLabels: current.labels,
    newLabels: liveLabels,
    projection,
    diff,
    changed,
  };
}

function editPrLabels(
  gh: GhRunner,
  prUrl: string,
  flag: "--add-label" | "--remove-label",
  labels: ComboPrLabel[],
): void {
  if (labels.length === 0) return;
  const result = gh(["pr", "edit", prUrl, flag, labels.join(",")]);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "gh pr edit failed";
    throw new Error(`PR label update failed for ${prUrl}: ${detail}`);
  }
}

function appendPrLabelsUpdated(
  input: SyncComboPrLabelsInput,
  projection: ComboPrLabelProjection,
  change: {
    oldLabels: string[];
    newLabels: string[];
    addedLabels: ComboPrLabel[];
    removedLabels: ComboPrLabel[];
  },
): void {
  appendEvent(input.runDir, "pr_labels_updated", {
    pr_url: input.prUrl,
    head_sha: projection.headSha,
    old_labels: change.oldLabels,
    new_labels: change.newLabels,
    added_labels: change.addedLabels,
    removed_labels: change.removedLabels,
    reason: projection.reason,
    ...(input.source !== undefined ? { source: input.source } : {}),
  });
}
// -/ 3/4

// -- 4/4 HELPER - current-head, check predicates, and GH parsing --
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

function configuredCodeRabbitCheckNames(input: ComboPrLabelProjectionInput): string[] {
  const explicit = nonEmptyStrings(input.codeRabbitCheckNames);
  if (explicit.length > 0) return explicit;
  const configuredAmbient = nonEmptyStrings(input.ambientCheckNames);
  if (configuredAmbient.length > 0) return configuredAmbient;
  return DEFAULT_CODERABBIT_CHECK_NAMES;
}

function nonEmptyStrings(values: string[] | undefined): string[] {
  return values?.map((value) => value.trim()).filter((value) => value.length > 0) ?? [];
}

function hasStaleCurrentHeadSignal(events: ComboEvent[], headSha: string): boolean {
  return [livePinnedLgtmSha(events), latestReadyForMergeSha(events), latestPublishedGateSha(events)].some(
    (sha) => sha !== undefined && !shaMatchesHead(sha, headSha),
  );
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

function fetchComboPrLabelView(
  gh: GhRunner,
  prUrl: string,
): { pr: ComboPrLabelProjectionInput["pr"]; labels: string[] } {
  const result = gh(["pr", "view", prUrl, "--json", PR_LABEL_VIEW_FIELDS]);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "gh pr view failed";
    throw new Error(`PR labels not reachable for ${prUrl}: ${detail}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new Error(
      `PR labels not readable for ${prUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`PR labels not readable for ${prUrl}: gh pr view returned invalid JSON`);
  }

  const record = parsed as Record<string, unknown>;
  const headRefOid = record["headRefOid"];
  if (typeof headRefOid !== "string" || headRefOid.trim() === "") {
    throw new Error(`PR labels not readable for ${prUrl}: missing headRefOid`);
  }
  const state = record["state"];
  const mergeStateStatus = record["mergeStateStatus"];
  const statusCheckRollup = record["statusCheckRollup"];
  return {
    pr: {
      headSha: headRefOid,
      state: typeof state === "string" && state.trim() !== "" ? state : "OPEN",
      ...(typeof mergeStateStatus === "string" && mergeStateStatus.trim() !== ""
        ? { mergeStateStatus }
        : {}),
      ...(Array.isArray(statusCheckRollup) ? { statusCheckRollup } : {}),
    },
    labels: labelNames(record["labels"]),
  };
}

function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const label of labels) {
    const name = labelName(label);
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function labelName(label: unknown): string | undefined {
  if (typeof label === "string") {
    const trimmed = label.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof label !== "object" || label === null) return undefined;
  const name = (label as { name?: unknown }).name;
  return typeof name === "string" && name.trim() !== "" ? name : undefined;
}
// -/ 4/4
