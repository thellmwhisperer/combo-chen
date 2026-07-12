/**
 * @overview Application handlers for overture and the transactional capsule combo launch.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at launchCombo              <- complete launch transaction and rollback.
 *   2. Then runOverture                  <- read-only launch runway.
 *   3. Read acquireTreehouseWorktree     <- lease and branch boundary.
 *
 *   MAIN FLOW
 *   ---------
 *   options -> overture -> Treehouse lease -> artifacts -> capsule tmux topology -> launched combo
 *   Pane 0 is the `combo-chen capsule <run-dir>` v1 sequencer.
 *
 *   PUBLIC API
 *   ----------
 *   launchCombo      Launch a combo from an issue or work plan.
 *   runOverture      Validate and print the launch runway.
 *
 *   INTERNALS
 *   ---------
 *   Treehouse path parsing, lease acquisition, rollback, and best-effort cleanup.
 *
 * @exports launchCombo, runOverture
 * @deps ../../core/events, ../../core/runtime-ledger, ../../core/shell-quote, ../../core/state, ../../core/work-plan, ../../infra/config, ../../infra/config-snapshot, ../../infra/tmux, ../../roles/coder-invocation, ../../roles/director-invocation, ../../roles/gatekeeper, ../deps, ../gate/gate, ../runtime/sessions, ../work-items/persisted-work-plan, ./overture, node:fs, node:path
 */
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";

import { appendEvent } from "../../core/events.js";
import { buildRuntimeLedger, writeRuntimeLedger } from "../../core/runtime-ledger.js";
import { shellQuote } from "../../core/shell-quote.js";
import { comboHome, writeCombo, type ComboRecord } from "../../core/state.js";
import { renderWorkPlanMarkdown } from "../../core/work-plan.js";
import { writeConfigSnapshot } from "../../infra/config-snapshot.js";
import { killSessionArgs, newSessionArgs } from "../../infra/tmux.js";
import { buildDirectorInvocation } from "../../roles/director-invocation.js";
import {
  GATEKEEPER_WINDOW,
  NO_MISTAKES_CONFIG_FILE,
  propagateNoMistakesConfig,
  startGatekeeperWindow,
} from "../gate/gate.js";
import { assertOverturePassed, prepareOverture, renderOvertureChecklist } from "./overture.js";
import {
  CAPSULE_WINDOW,
  CODER_WINDOW,
  DIRECTOR_WINDOW,
  JOURNAL_WINDOW,
  REVIEWER_WINDOW,
  capsuleWindowCommand,
  ensureWindowPresent,
  idleRoleWindowCommand,
} from "../runtime/sessions.js";
import { WORK_PLAN_ARTIFACT } from "../work-items/persisted-work-plan.js";
import type { AppDeps } from "../deps.js";

export interface LaunchOptions {
  issue?: string;
  plan?: string;
  repo: string;
  prompt?: string;
  base: string;
}

// -- 1/3 CORE · launchCombo <- START HERE --
export async function launchCombo(deps: AppDeps, options: LaunchOptions, cli: string): Promise<void> {
  const hasIssue = options.issue !== undefined;
  const hasPlan = options.plan !== undefined;
  if (hasIssue === hasPlan) {
    throw new Error("combo-chen run requires exactly one of --issue <url> or --plan <file>");
  }

  const overture = prepareOverture({
    deps,
    issueUrl: options.issue,
    planFile: options.plan,
    repoDir: options.repo,
    baseRef: options.base,
  });
  for (const line of renderOvertureChecklist(overture.result)) deps.out(line);
  assertOverturePassed(overture.result);

  let { combo } = overture;
  const { config, runDir, workPlan } = overture;
  const resolvedTeam = overture.result.resolvedTeam;
  if (options.prompt !== undefined) {
    rmSync(runDir, { recursive: true, force: true });
    throw new Error(
      "--prompt is not supported with the capsule engine yet: the capsule rebuilds the coder " +
        "invocation from the frozen snapshot. Encode the objective in the issue or work plan.",
    );
  }
  try {
    combo = acquireTreehouseWorktree({ deps, combo, baseRef: options.base });
  } catch (error) {
    rmSync(runDir, { recursive: true, force: true });
    throw error;
  }
  const id = combo.id;
  const home = comboHome(deps.env);
  const session = combo.tmuxSession;
  const worktree = combo.worktree;

  const directorCommand = buildDirectorInvocation({
    combo,
    directorCommand: config.directorCommand,
  });

  try {
    if (propagateNoMistakesConfig(options.repo, worktree)) {
      deps.out("no-mistakes: copied local config to " + worktree + "/" + NO_MISTAKES_CONFIG_FILE);
    }
    writeCombo(runDir, combo);
    writeConfigSnapshot(runDir, resolvedTeam === undefined ? config : { ...config, resolvedTeam });
    const planPath = join(runDir, WORK_PLAN_ARTIFACT);
    writeFileSync(planPath, renderWorkPlanMarkdown(workPlan));
    writeRuntimeLedger(
      runDir,
      buildRuntimeLedger({
        combo,
        runDir,
        cli,
        roleWindows: {
          capsule: CAPSULE_WINDOW,
          journal: JOURNAL_WINDOW,
          director: DIRECTOR_WINDOW,
          coder: CODER_WINDOW,
          gatekeeper: GATEKEEPER_WINDOW,
          reviewer: REVIEWER_WINDOW,
        },
        promptTargets: {
          director: session + ":" + DIRECTOR_WINDOW,
          workPlan: planPath,
        },
      }),
    );

    appendEvent(runDir, "combo_created", {
      issue_url: combo.issueUrl,
      work_item_source_type: workPlan.source.type,
      work_item_source_reference: workPlan.source.reference,
      work_item_title: workPlan.title,
      repo: combo.repoDir,
      worktree: combo.worktree,
      branch: combo.branch,
      tmux: session,
    });
    if (resolvedTeam !== undefined) {
      appendEvent(runDir, "team", { roles: resolvedTeam });
    }
  } catch (error) {
    rmSync(runDir, { recursive: true, force: true });
    rollbackTreehouseLaunch(deps, combo);
    throw error;
  }

  const journalCommand = cli + " events --follow -n " + shellQuote(id);
  const created = deps.tmux(
    newSessionArgs(session, CAPSULE_WINDOW, capsuleWindowCommand({ cli, comboHome: home, runDir })),
  );
  if (created.status !== 0) {
    rmSync(runDir, { recursive: true, force: true });
    rollbackTreehouseLaunch(deps, combo);
    throw new Error("tmux failed to start the combo: " + created.stderr.trim());
  }
  try {
    ensureWindowPresent(deps, combo, JOURNAL_WINDOW, journalCommand);
    ensureWindowPresent(deps, combo, DIRECTOR_WINDOW, directorCommand);
    ensureWindowPresent(deps, combo, CODER_WINDOW, idleRoleWindowCommand(CODER_WINDOW));
    startGatekeeperWindow(deps, combo, {
      timeoutSeconds: config.gatekeeperAttachTimeoutSeconds,
      retryIntervalSeconds: config.gatekeeperAttachRetryIntervalSeconds,
    });
    ensureWindowPresent(deps, combo, REVIEWER_WINDOW, idleRoleWindowCommand(REVIEWER_WINDOW));
  } catch (error) {
    const killed = deps.tmux(killSessionArgs(session));
    let rollbackError: string | undefined;
    if (killed.status !== 0) {
      rollbackError =
        'tmux rollback failed for "' + session + '": ' + (killed.stderr.trim() || "unknown error");
    }
    rmSync(runDir, { recursive: true, force: true });
    rollbackTreehouseLaunch(deps, combo);
    if (rollbackError !== undefined) {
      throw new Error((error instanceof Error ? error.message : String(error)) + "; " + rollbackError, {
        cause: error,
      });
    }
    throw error;
  }

  deps.out("🥢 " + session);
  deps.out("   worktree " + worktree + " · branch " + combo.branch);
  deps.out("   coder: " + config.roles.coder + " · gatekeeper: " + config.roles.gatekeeper);
  deps.out(
    [
      "   topology: capsule=" + CAPSULE_WINDOW,
      "journal=" + JOURNAL_WINDOW,
      "director=" + DIRECTOR_WINDOW,
      "coder=" + CODER_WINDOW,
      "gatekeeper=" + GATEKEEPER_WINDOW,
      "reviewer=" + REVIEWER_WINDOW,
      "coder-response=" + CODER_WINDOW,
    ].join(" · "),
  );
  deps.out("   journal: tmux attach -t " + session + "  ·  combo-chen events --follow -n " + id);
}
// -/ 1/3

// -- 2/3 CORE · runOverture --
export function runOverture(
  deps: AppDeps,
  options: { issue?: string; plan?: string; repo: string; base: string },
): void {
  const overture = prepareOverture({
    deps,
    issueUrl: options.issue,
    planFile: options.plan,
    repoDir: options.repo,
    baseRef: options.base,
  });
  for (const line of renderOvertureChecklist(overture.result)) deps.out(line);
  assertOverturePassed(overture.result);
}
// -/ 2/3

// -- 3/3 HELPER · Treehouse lease acquisition and rollback --
function commandFailureText(result: { stdout: string; stderr: string }): string {
  return result.stderr.trim() || result.stdout.trim() || "unknown error";
}

function treehouseLeasePath(stdout: string): string {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length !== 1) {
    throw new Error("treehouse get --lease returned " + lines.length + " path lines (expected exactly one)");
  }
  return lines[0]!;
}

function returnTreehouseWorktreeBestEffort(
  deps: Pick<AppDeps, "out" | "treehouse">,
  repoDir: string,
  worktree: string,
): void {
  const result = deps.treehouse(["return", "--force", worktree], repoDir);
  if (result.status !== 0) {
    deps.out("warning: failed to return treehouse worktree " + worktree + ": " + commandFailureText(result));
  }
}

function deleteBranchBestEffort(deps: Pick<AppDeps, "git" | "out">, repoDir: string, branch: string): void {
  const result = deps.git(["branch", "-D", branch], repoDir);
  if (result.status !== 0) {
    deps.out(
      "warning: failed to delete combo branch " +
        branch +
        " from " +
        repoDir +
        ": " +
        commandFailureText(result),
    );
  }
}

function rollbackTreehouseLaunch(deps: Pick<AppDeps, "git" | "out" | "treehouse">, combo: ComboRecord): void {
  returnTreehouseWorktreeBestEffort(deps, combo.repoDir, combo.worktree);
  deleteBranchBestEffort(deps, combo.repoDir, combo.branch);
}

function acquireTreehouseWorktree(input: {
  deps: Pick<AppDeps, "git" | "out" | "treehouse">;
  combo: ComboRecord;
  baseRef: string;
}): ComboRecord {
  const leased = input.deps.treehouse(
    ["get", "--lease", "--lease-holder", input.combo.id],
    input.combo.repoDir,
  );
  if (leased.status !== 0) {
    throw new Error("treehouse get --lease failed: " + commandFailureText(leased));
  }
  const worktree = treehouseLeasePath(leased.stdout);
  const combo: ComboRecord = {
    ...input.combo,
    worktree,
    worktreeProvider: "treehouse",
    treehouseLeaseHolder: input.combo.id,
  };
  const worktreeState = input.deps.git(["status", "--porcelain"], worktree);
  if (worktreeState.status !== 0) {
    rollbackTreehouseLaunch(input.deps, combo);
    throw new Error(
      "treehouse lease worktree state check failed for " +
        worktree +
        ": " +
        commandFailureText(worktreeState),
    );
  }
  if (worktreeState.stdout.trim() !== "") {
    rollbackTreehouseLaunch(input.deps, combo);
    throw new Error(
      "treehouse lease returned dirty worktree at " + worktree + ": " + worktreeState.stdout.trim(),
    );
  }
  const switched = input.deps.git(["switch", "-c", combo.branch, input.baseRef], worktree);
  if (switched.status !== 0) {
    rollbackTreehouseLaunch(input.deps, combo);
    throw new Error(
      "git switch -c " + combo.branch + " " + input.baseRef + " failed: " + commandFailureText(switched),
    );
  }
  return combo;
}
// -/ 3/3
