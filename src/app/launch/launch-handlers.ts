/**
 * @overview Application handlers for overture and the transactional combo launch.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at launchCombo              <- complete launch transaction and rollback.
 *   2. Then runOverture                  <- read-only launch runway.
 *   3. Read acquireTreehouseWorktree     <- lease and branch boundary.
 *
 *   MAIN FLOW
 *   ---------
 *   options -> overture -> Treehouse lease -> artifacts -> tmux topology -> launched combo
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
 * @deps ../../core/combo, ../../core/events, ../../core/runtime-ledger, ../../core/shell-quote, ../../core/state, ../../core/work-plan, ../../infra/config-snapshot, ../../infra/tmux, ../../roles/coder-invocation, ../../roles/director-invocation, ../../roles/gatekeeper, ../deps, ../director/watchers, ../gate/gate, ../runtime/sessions, ../work-items/persisted-work-plan, ./overture, node:fs, node:path
 */
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildRunnerScript } from "../../core/combo.js";
import { appendEvent } from "../../core/events.js";
import { buildRuntimeLedger, writeRuntimeLedger } from "../../core/runtime-ledger.js";
import { shellQuote } from "../../core/shell-quote.js";
import { comboHome, writeCombo, type ComboRecord } from "../../core/state.js";
import { renderWorkPlanMarkdown } from "../../core/work-plan.js";
import { writeConfigSnapshot } from "../../infra/config-snapshot.js";
import { killSessionArgs, newSessionArgs, newWindowArgs } from "../../infra/tmux.js";
import { buildCoderInvocation, defaultWorkPlanPrompt } from "../../roles/coder-invocation.js";
import { buildDirectorInvocation } from "../../roles/director-invocation.js";
import {
  buildGatekeeperInvocation,
  buildIssuePrIntent,
  buildNoMistakesPushIntent,
  buildWorkPlanPrIntent,
} from "../../roles/gatekeeper.js";
import {
  GATEKEEPER_WINDOW,
  NO_MISTAKES_CONFIG_FILE,
  propagateNoMistakesConfig,
  scriptedMirrorGatekeeperCommandTemplate,
  startGatekeeperWindow,
} from "../gate/gate.js";
import { assertOverturePassed, prepareOverture, renderOvertureChecklist } from "./overture.js";
import {
  CODER_WINDOW,
  DIRECTOR_WINDOW,
  DIRECTOR_WATCH_WINDOW,
  JOURNAL_WINDOW,
  REVIEWER_WINDOW,
  ensureWindowPresent,
  idleRoleWindowCommand,
} from "../runtime/sessions.js";
import { WORK_PLAN_ARTIFACT } from "../work-items/persisted-work-plan.js";
import { buildDirectorWatchCommand } from "../director/watchers.js";
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
  const { config, issue, issueDetails, runDir, workPlan } = overture;
  const resolvedTeam = overture.result.resolvedTeam;
  try {
    combo = acquireTreehouseWorktree({ deps, combo, baseRef: options.base });
  } catch (error) {
    rmSync(runDir, { recursive: true, force: true });
    throw error;
  }
  const id = combo.id;
  const home = comboHome(deps.env);
  const session = combo.tmuxSession;
  const branch = combo.branch;
  const worktree = combo.worktree;
  let directorCommand: string;
  let runnerPath: string;

  try {
    const coderInput: Parameters<typeof buildCoderInvocation>[0] = {
      coderCommand: config.coderCommand,
      combo,
    };
    if (options.prompt !== undefined) coderInput.prompt = options.prompt;
    else if (issue === undefined) {
      coderInput.prompt = defaultWorkPlanPrompt(workPlan, join(runDir, WORK_PLAN_ARTIFACT));
    }
    const coderCommand = buildCoderInvocation(coderInput);
    directorCommand = buildDirectorInvocation({
      combo,
      directorCommand: config.directorCommand,
    });
    const prIntent =
      issueDetails === undefined
        ? buildWorkPlanPrIntent(workPlan)
        : buildIssuePrIntent({
            combo,
            issueTitle: issueDetails.title,
            issueBody: issueDetails.body,
          });

    const gatekeeperCommand = buildGatekeeperInvocation({
      gatekeeperCommand: config.gatekeeperCommand,
      combo,
      ...(issueDetails === undefined
        ? { workPlan }
        : { issueTitle: issueDetails.title, issueBody: issueDetails.body }),
    });
    const quotedId = shellQuote(id);
    const runnerInput: Parameters<typeof buildRunnerScript>[0] = {
      combo,
      baseRef: options.base,
      coderCommand,
      gatekeeperCommand: scriptedMirrorGatekeeperCommandTemplate(gatekeeperCommand),
      gatekeeperMirrorIntent: buildNoMistakesPushIntent(prIntent),
      activateCoder: cli + " activate-coder -n " + quotedId,
      emit: cli + " emit -n " + quotedId,
      activateReviewer: cli + " activate-reviewer -n " + quotedId,
      gateLeaseAcquire: cli + " gate-lease acquire -n " + quotedId,
      gateLeaseRelease: cli + " gate-lease release -n " + quotedId,
    };
    if (issue !== undefined) {
      runnerInput.ensurePrAutoclose = cli + " ensure-pr-autoclose -n " + quotedId + " --pr-url";
    }
    const runner = buildRunnerScript(runnerInput);
    runnerPath = join(runDir, "runner.sh");

    if (propagateNoMistakesConfig(options.repo, worktree)) {
      deps.out("no-mistakes: copied local config to " + worktree + "/" + NO_MISTAKES_CONFIG_FILE);
    }
    writeCombo(runDir, combo);
    writeConfigSnapshot(runDir, resolvedTeam === undefined ? config : { ...config, resolvedTeam });
    writeFileSync(join(runDir, WORK_PLAN_ARTIFACT), renderWorkPlanMarkdown(workPlan));
    writeRuntimeLedger(
      runDir,
      buildRuntimeLedger({
        combo,
        runDir,
        cli,
        roleWindows: {
          journal: JOURNAL_WINDOW,
          director: DIRECTOR_WINDOW,
          coder: CODER_WINDOW,
          gatekeeper: GATEKEEPER_WINDOW,
          reviewer: REVIEWER_WINDOW,
          directorWatch: DIRECTOR_WATCH_WINDOW,
        },
        promptTargets: {
          director: session + ":" + DIRECTOR_WINDOW,
          workPlan: join(runDir, WORK_PLAN_ARTIFACT),
        },
      }),
    );
    writeFileSync(runnerPath, runner);
    chmodSync(runnerPath, 0o755);

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

  const created = deps.tmux(
    newSessionArgs(session, JOURNAL_WINDOW, cli + " events --follow -n " + shellQuote(id)),
  );
  if (created.status !== 0) {
    rmSync(runDir, { recursive: true, force: true });
    rollbackTreehouseLaunch(deps, combo);
    throw new Error("tmux failed to start the combo: " + created.stderr.trim());
  }
  try {
    ensureWindowPresent(deps, combo, DIRECTOR_WINDOW, directorCommand);
    ensureWindowPresent(
      deps,
      combo,
      CODER_WINDOW,
      "COMBO_CHEN_RUNNER_PROGRESS=1 sh " + shellQuote(runnerPath),
    );
    startGatekeeperWindow(deps, combo, {
      timeoutSeconds: config.gatekeeperAttachTimeoutSeconds,
      retryIntervalSeconds: config.gatekeeperAttachRetryIntervalSeconds,
    });
    ensureWindowPresent(deps, combo, REVIEWER_WINDOW, idleRoleWindowCommand(REVIEWER_WINDOW));
    const directorWatch = deps.tmux(
      newWindowArgs(
        session,
        DIRECTOR_WATCH_WINDOW,
        buildDirectorWatchCommand({
          cli,
          comboHome: home,
          comboId: id,
          pollSeconds: config.limits.babysitPollSeconds,
          watchFailureLimit: config.limits.watchFailureLimit,
          watchBackoffMaxSeconds: config.limits.watchBackoffMaxSeconds,
        }),
      ),
    );
    if (directorWatch.status !== 0) {
      throw new Error(
        'tmux failed to start director watcher in "' +
          session +
          '": ' +
          (directorWatch.stderr.trim() || "unknown error"),
      );
    }
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
  deps.out("   worktree " + worktree + " · branch " + branch);
  deps.out("   coder: " + config.roles.coder + " · gatekeeper: " + config.roles.gatekeeper);
  deps.out(
    [
      "   topology: journal=" + JOURNAL_WINDOW,
      "director=" + DIRECTOR_WINDOW,
      "coder=" + CODER_WINDOW,
      "gatekeeper=" + GATEKEEPER_WINDOW,
      "reviewer=" + REVIEWER_WINDOW,
      "director-watch=" + DIRECTOR_WATCH_WINDOW,
      "coder-response=" + config.coderRespondingWindowName,
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
