/**
 * @overview Monotonic GitHub label projection for combo lifecycle state.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at projectComboPrLabels  <- journal + PR facts to one lifecycle label.
 *   2. Then diffComboPrLabels         <- idempotent add/remove plan.
 *   3. Then syncComboPrLabels         <- GitHub mutation and journal audit.
 *
 *   MAIN FLOW
 *   ---------
 *   journal + PR state -> working|ready|merged|conflict -> diff -> provision/mutate
 *
 *   PUBLIC API
 *   ----------
 *   projectComboPrLabels, diffComboPrLabels, syncComboPrLabels
 *
 *   INTERNALS
 *   ---------
 *   label provisioning, PR view parsing, journal field helpers
 *
 * @exports ComboPrLabel, ComboPrLabelProjectionInput, ComboPrLabelProjection, ComboPrLabelDiff, SyncComboPrLabelsInput, SyncComboPrLabelsResult, projectComboPrLabels, diffComboPrLabels, syncComboPrLabels
 * @deps ../../core/events, ../github/github
 */
import { execSync } from "node:child_process";
import { appendEvent, type ComboEvent } from "../../core/events.js";
import type { GhRunner } from "../github/github.js";

// -- 1/3 CORE · monotonic projection <- START HERE --
const COMBO_PR_LABELS = ["combo:working", "combo:ready", "combo:merged", "combo:conflict"] as const;
export type ComboPrLabel = (typeof COMBO_PR_LABELS)[number];

const COMBO_PR_LABEL_METADATA: Record<ComboPrLabel, { color: string; description: string }> = {
  "combo:working": { color: "FBCA04", description: "Combo work is in progress." },
  "combo:ready": { color: "0E8A16", description: "Combo PR is ready for human merge." },
  "combo:merged": { color: "5319E7", description: "Combo PR was merged." },
  "combo:conflict": { color: "B60205", description: "Combo PR needs conflict resolution." },
};

export interface ComboPrLabelProjectionInput {
  events: ComboEvent[];
  pr: { state: string; headSha: string; mergeStateStatus?: string };
}

export interface ComboPrLabelProjection {
  labels: ComboPrLabel[];
  headSha: string;
  prState: string;
  reason: "working" | "ready" | "merged" | "conflict";
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

export function projectComboPrLabels(input: ComboPrLabelProjectionInput): ComboPrLabelProjection {
  const state = input.pr.state.trim().toUpperCase();
  const conflict = ["DIRTY", "CONFLICTING"].includes(input.pr.mergeStateStatus?.trim().toUpperCase() ?? "");
  let label: ComboPrLabel;
  let reason: ComboPrLabelProjection["reason"];
  if (state === "MERGED" || input.events.some((event) => event.event === "merged")) {
    label = "combo:merged";
    reason = "merged";
  } else if (conflict) {
    label = "combo:conflict";
    reason = "conflict";
  } else if (latestReadySha(input.events) !== undefined) {
    label = "combo:ready";
    reason = "ready";
  } else {
    label = "combo:working";
    reason = "working";
  }
  return { labels: [label], headSha: input.pr.headSha, prState: input.pr.state, reason };
}

export function diffComboPrLabels(
  existingLabels: string[],
  desiredLabels: Iterable<ComboPrLabel>,
): ComboPrLabelDiff {
  const existing = new Set(existingLabels.filter(isComboPrLabel));
  const desired = new Set(desiredLabels);
  return {
    add: COMBO_PR_LABELS.filter((label) => desired.has(label) && !existing.has(label)),
    remove: COMBO_PR_LABELS.filter((label) => existing.has(label) && !desired.has(label)),
  };
}

function latestReadySha(events: ComboEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.event === "ready_for_merge" && typeof event["sha"] === "string") return event["sha"];
  }
  return undefined;
}

const COMBO_PR_LABEL_SET = new Set<string>(COMBO_PR_LABELS);
function isComboPrLabel(label: string): label is ComboPrLabel {
  return COMBO_PR_LABEL_SET.has(label);
}
// -/ 1/3

// -- 2/3 CORE · GitHub mutation + audit --
export function syncComboPrLabels(input: SyncComboPrLabelsInput): SyncComboPrLabelsResult {
  const current = fetchComboPrLabelView(input.gh, input.prUrl);
  const projection = projectComboPrLabels({ events: input.events, pr: current.pr });
  const diff = diffComboPrLabels(current.labels, projection.labels);
  let liveLabels = current.labels;
  if (diff.remove.length > 0) {
    editPrLabels(input.gh, input.prUrl, "--remove-label", diff.remove);
    const updated = fetchComboPrLabelView(input.gh, input.prUrl);
    appendPrLabelsUpdated(input, projection, liveLabels, updated.labels, [], diff.remove);
    liveLabels = updated.labels;
  }
  const additions = diffComboPrLabels(liveLabels, projection.labels).add;
  if (additions.length > 0) {
    editPrLabels(input.gh, input.prUrl, "--add-label", additions);
    const updated = fetchComboPrLabelView(input.gh, input.prUrl);
    appendPrLabelsUpdated(input, projection, liveLabels, updated.labels, additions, []);
    liveLabels = updated.labels;
  }
  return {
    prUrl: input.prUrl,
    oldLabels: current.labels,
    newLabels: liveLabels,
    projection,
    diff,
    changed: diff.add.length > 0 || diff.remove.length > 0,
  };
}

function appendPrLabelsUpdated(
  input: SyncComboPrLabelsInput,
  projection: ComboPrLabelProjection,
  oldLabels: string[],
  newLabels: string[],
  addedLabels: ComboPrLabel[],
  removedLabels: ComboPrLabel[],
): void {
  appendEvent(input.runDir, "pr_labels_updated", {
    pr_url: input.prUrl,
    head_sha: projection.headSha,
    old_labels: oldLabels,
    new_labels: newLabels,
    added_labels: addedLabels,
    removed_labels: removedLabels,
    reason: projection.reason,
    ...(input.source === undefined ? {} : { source: input.source }),
  });
}

function editPrLabels(
  gh: GhRunner,
  prUrl: string,
  flag: "--add-label" | "--remove-label",
  labels: ComboPrLabel[],
): void {
  const provisioned = new Set<ComboPrLabel>();
  for (let attempt = 0; attempt <= labels.length; attempt += 1) {
    const result = gh(["pr", "edit", prUrl, flag, labels.join(",")]);
    if (result.status === 0) return;
    const detail = ghFailureDetail(result);
    const missing =
      flag === "--add-label" && /'[^']+' not found/i.test(detail)
        ? labels.filter((label) => detail.includes(label) && !provisioned.has(label))
        : [];
    if (missing.length === 0) throw new Error(`PR label update failed for ${prUrl}: ${detail}`);
    provisionComboPrLabels(gh, prUrl, missing);
    for (const label of missing) provisioned.add(label);
    execSync("sleep 0.5", { stdio: "ignore" });
  }
  throw new Error(`PR label update failed for ${prUrl}: label provisioning retry limit reached`);
}

function provisionComboPrLabels(gh: GhRunner, prUrl: string, labels: ComboPrLabel[]): void {
  const repo = repoSlugFromPrUrl(prUrl);
  for (const label of labels) {
    const metadata = COMBO_PR_LABEL_METADATA[label];
    const result = gh([
      "label",
      "create",
      label,
      "--color",
      metadata.color,
      "--description",
      metadata.description,
      "--force",
      ...(repo === undefined ? [] : ["--repo", repo]),
    ]);
    if (result.status !== 0)
      throw new Error(`PR label provision failed for ${prUrl}: ${label}: ${ghFailureDetail(result)}`);
  }
}
// -/ 2/3

// -- 3/3 HELPER · PR view parsing --
const PR_LABEL_VIEW_FIELDS = "headRefOid,state,mergeStateStatus,labels";

function fetchComboPrLabelView(
  gh: GhRunner,
  prUrl: string,
): { pr: ComboPrLabelProjectionInput["pr"]; labels: string[] } {
  const result = gh(["pr", "view", prUrl, "--json", PR_LABEL_VIEW_FIELDS]);
  if (result.status !== 0)
    throw new Error(`PR labels not reachable for ${prUrl}: ${ghFailureDetail(result)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `PR labels not readable for ${prUrl}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (typeof parsed !== "object" || parsed === null)
    throw new Error(`PR labels not readable for ${prUrl}: invalid JSON`);
  const record = parsed as Record<string, unknown>;
  const headSha = record["headRefOid"];
  if (typeof headSha !== "string" || headSha.trim() === "")
    throw new Error(`PR labels not readable for ${prUrl}: missing headRefOid`);
  const state = typeof record["state"] === "string" ? record["state"] : "OPEN";
  const mergeStateStatus = record["mergeStateStatus"];
  return {
    pr: { headSha, state, ...(typeof mergeStateStatus === "string" ? { mergeStateStatus } : {}) },
    labels: labelNames(record["labels"]),
  };
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((label) => (typeof label === "string" ? label : (label as { name?: unknown })?.name))
        .filter((label): label is string => typeof label === "string" && label.trim() !== ""),
    ),
  ];
}

function repoSlugFromPrUrl(prUrl: string): string | undefined {
  try {
    const parts = new URL(prUrl).pathname.split("/").filter(Boolean);
    const pull = parts.indexOf("pull");
    return pull >= 2 ? `${parts[pull - 2]}/${parts[pull - 1]}` : undefined;
  } catch {
    return undefined;
  }
}

function ghFailureDetail(result: ReturnType<GhRunner>): string {
  return result.stderr.trim() || result.stdout.trim() || "gh command failed";
}
// -/ 3/3
