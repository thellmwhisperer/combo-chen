/**
 * @overview Persisted work-plan artifact services. ~90 lines,
 *   source detection and artifact loading for runtime commands.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at isGitHubIssueWorkItem  <- source-type branch.
 *   2. Then readPersistedWorkPlan      <- run-dir artifact to WorkPlan.
 *
 *   MAIN FLOW
 *   ---------
 *   combo.json source metadata + work-plan.md -> WorkPlan for intent/gates/reviewer
 *
 *   PUBLIC API
 *   ----------
 *   WORK_PLAN_ARTIFACT      Stable run-dir artifact filename.
 *   isGitHubIssueWorkItem   True for legacy/current GitHub issue combos.
 *   readPersistedWorkPlan   Parse the normalized work-plan artifact.
 *
 *   INTERNALS
 *   ---------
 *   inferWorkItemSourceType, workPlanSourceFromCombo
 *
 * @exports WORK_PLAN_ARTIFACT, isGitHubIssueWorkItem, readPersistedWorkPlan
 * @deps ../../core/state, ../../core/work-plan, node:fs, node:path
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanOptional, type ComboRecord } from "../../core/state.js";
import {
  normalizeMarkdownWorkPlan,
  type WorkPlan,
  type WorkPlanSource,
  type WorkPlanSourceType,
} from "../../core/work-plan.js";

// -- 1/1 CORE · source detection + artifact loading <- START HERE --
export const WORK_PLAN_ARTIFACT = "work-plan.md";

export function isGitHubIssueWorkItem(combo: Pick<ComboRecord, "issueUrl" | "workItemSourceType">): boolean {
  const issueUrl = cleanOptional(combo.issueUrl);
  const sourceType = inferWorkItemSourceType(combo);
  return sourceType === "github_issue" && issueUrl !== undefined;
}

export function readPersistedWorkPlan(
  runDir: string,
  combo: Pick<ComboRecord, "issueUrl" | "workItemSourceType" | "workItemSourceReference">,
): WorkPlan {
  const artifactPath = join(runDir, WORK_PLAN_ARTIFACT);
  let markdown: string;
  try {
    markdown = readFileSync(artifactPath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Work plan artifact not readable: ${artifactPath} (${reason})`, { cause: error });
  }
  return normalizeMarkdownWorkPlan({
    markdown,
    source: workPlanSourceFromCombo(combo),
    requireAcceptanceCriteria: false,
  });
}

function inferWorkItemSourceType(
  combo: Pick<ComboRecord, "issueUrl" | "workItemSourceType">,
): WorkPlanSourceType | undefined {
  const issueUrl = cleanOptional(combo.issueUrl);
  return combo.workItemSourceType ?? (issueUrl === undefined ? undefined : "github_issue");
}

function workPlanSourceFromCombo(
  combo: Pick<ComboRecord, "issueUrl" | "workItemSourceType" | "workItemSourceReference">,
): WorkPlanSource {
  const issueUrl = cleanOptional(combo.issueUrl);
  const type = inferWorkItemSourceType(combo);
  const reference = cleanOptional(combo.workItemSourceReference) ?? issueUrl;
  if (type === undefined || reference === undefined) {
    throw new Error("Combo record lacks work item source metadata for persisted work plan");
  }
  return { type: type as WorkPlanSourceType, reference };
}
// -/ 1/1
