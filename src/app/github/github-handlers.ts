/**
 * @overview Application handlers for GitHub intent inspection, PR autoclose
 *   repair, and review dossier body projection.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at printIntent              <- renders the canonical gate intent.
 *   2. Then ensurePrAutoclose            <- repairs and verifies a PR body.
 *   3. Then updatePrBodyDossier          <- projects local review rounds into the PR body.
 *
 *   MAIN FLOW
 *   ---------
 *   CLI options -> handler -> persisted combo/work plan -> GitHub adapter -> output
 *
 *   PUBLIC API
 *   ----------
 *   printIntent            Print the canonical issue or work-plan gate intent.
 *   ensurePrAutoclose      Ensure a PR body visibly closes its source issue.
 *   updatePrBodyDossier    Update the PR body with review round dossier blocks.
 *
 *   INTERNALS
 *   ---------
 *   None.
 *
 * @exports printIntent, ensurePrAutoclose, updatePrBodyDossier
 * @deps ../../core/pr-body-dossier, ../../core/state, ../../roles/gatekeeper, ../deps, ../work-items/persisted-work-plan, ./github, node:fs, node:path
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { projectDossierPrBody, type DossierRound } from "../../core/pr-body-dossier.js";
import { comboHome, readCombo, runDirFor } from "../../core/state.js";
import {
  buildIssuePrIntent,
  buildWorkPlanPrIntent,
  ensureIssueAutocloseInPrBody,
  hasIssueAutocloseInPrBody,
} from "../../roles/gatekeeper.js";
import { fetchIssueDetails } from "./github.js";
import { isGitHubIssueWorkItem, readPersistedWorkPlan } from "../work-items/persisted-work-plan.js";
import type { AppDeps } from "../deps.js";

// -- 1/2 CORE · printIntent <- START HERE --
export function printIntent(deps: Pick<AppDeps, "env" | "gh" | "out">, comboId: string): void {
  const runDir = runDirFor(comboHome(deps.env), comboId);
  const combo = readCombo(runDir);
  if (isGitHubIssueWorkItem(combo)) {
    const issueDetails = fetchIssueDetails(deps.gh, combo.issueUrl);
    deps.out(
      buildIssuePrIntent({
        combo,
        issueTitle: issueDetails.title,
        issueBody: issueDetails.body,
      }),
    );
    return;
  }

  deps.out(buildWorkPlanPrIntent(readPersistedWorkPlan(runDir, combo)));
}
// -/ 1/2

// -- 2/2 CORE · ensurePrAutoclose --
export function ensurePrAutoclose(
  deps: Pick<AppDeps, "env" | "gh" | "out">,
  options: { name: string; prUrl: string },
): void {
  const runDir = runDirFor(comboHome(deps.env), options.name);
  const combo = readCombo(runDir);
  const viewed = deps.gh(["pr", "view", options.prUrl, "--json", "body", "--jq", ".body"]);
  if (viewed.status !== 0) {
    throw new Error(
      "gh pr view failed for " + options.prUrl + ": " + (viewed.stderr.trim() || "unknown error"),
    );
  }

  const nextBody = ensureIssueAutocloseInPrBody(viewed.stdout, combo);
  if (nextBody === viewed.stdout) {
    deps.out("pr autoclose already present for " + combo.id);
    return;
  }

  const bodyPath = join(runDir, "pr-body.autoclose.md");
  writeFileSync(bodyPath, nextBody);
  const edited = deps.gh(["pr", "edit", options.prUrl, "--body-file", bodyPath]);
  if (edited.status !== 0) {
    throw new Error(
      "gh pr edit failed for " + options.prUrl + ": " + (edited.stderr.trim() || "unknown error"),
    );
  }
  const verified = deps.gh(["pr", "view", options.prUrl, "--json", "body", "--jq", ".body"]);
  if (verified.status !== 0) {
    throw new Error(
      "gh pr view failed while verifying " +
        options.prUrl +
        ": " +
        (verified.stderr.trim() || "unknown error"),
    );
  }
  if (!hasIssueAutocloseInPrBody(verified.stdout, combo)) {
    throw new Error(
      "pr autoclose verification failed for " +
        options.prUrl +
        ": body still lacks a visible GitHub autoclose keyword for " +
        combo.id,
    );
  }
  deps.out("pr autoclose ensured for " + combo.id);
}
// -/ 2/2

// -- 3/3 CORE · updatePrBodyDossier --
export function updatePrBodyDossier(
  deps: Pick<AppDeps, "env" | "gh" | "out">,
  options: { name: string; prUrl: string; rounds: DossierRound[] },
): void {
  const runDir = runDirFor(comboHome(deps.env), options.name);
  const combo = readCombo(runDir);
  const viewed = deps.gh(["pr", "view", options.prUrl, "--json", "body", "--jq", ".body"]);
  if (viewed.status !== 0) {
    throw new Error(
      "gh pr view failed for " + options.prUrl + ": " + (viewed.stderr.trim() || "unknown error"),
    );
  }

  const nextBody = projectDossierPrBody({
    rounds: options.rounds,
    existingBody: viewed.stdout,
  });
  if (nextBody === viewed.stdout) {
    deps.out("pr dossier already current for " + combo.id);
    return;
  }

  const bodyPath = join(runDir, "pr-body.dossier.md");
  writeFileSync(bodyPath, nextBody);
  const edited = deps.gh(["pr", "edit", options.prUrl, "--body-file", bodyPath]);
  if (edited.status !== 0) {
    throw new Error(
      "gh pr edit failed for " + options.prUrl + ": " + (edited.stderr.trim() || "unknown error"),
    );
  }
  deps.out("pr dossier updated for " + combo.id);
}
// -/ 3/3
