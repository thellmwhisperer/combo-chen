#!/usr/bin/env node
/**
 * @overview combo-chen CLI router — ~1175 lines, 24 commands, dependency wiring only.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at createProgram         <- registers every public/hidden command.
 *   2. Use defaultDeps                <- real process/git/gh/tmux adapters.
 *   3. Jump to extracted modules      <- command bodies delegate behavior out.
 *
 *   MAIN FLOW
 *   ---------
 *   isDirectRun -> createProgram(defaultDeps()) -> commander dispatch -> helper module
 *
 *   PUBLIC API
 *   ----------
 *   createProgram     Build the Commander program and wire command handlers.
 *   defaultDeps       Provide production adapters for command handlers.
 *   isDirectRun       Compare the current module URL against argv[1].
 *   Deps              Dependency interface used by CLI handlers and tests.
 *   resolvePollMs                 Re-exported watcher cadence helper for compatibility.
 *   buildDirectorWatchCommand     Re-exported director watcher helper for compatibility.
 *
 *   INTERNALS
 *   ---------
 *   cliInvocation, isParked, collectLocalWorktreeHeadSha; Treehouse lease acquisition/rollback; forensics option parsing/outcome recording; hidden command wiring for runner/reviewer/coder/gatekeeper.
 *
 * @exports createProgram, defaultDeps, isDirectRun, Deps, resolvePollMs, buildDirectorWatchCommand
 * @deps commander, node:{child_process,fs,path,url},
 *   ../core/{combo,events,gate-lease,runtime-ledger,state,work-plan}, ../infra/{config-snapshot,release-metadata,tmux}, ../roles/{coder,director,gatekeeper},
 *   ./args, ./closure, ./coder, ./director, ./director-prompt, ./forensics, ./gate, ./gate-lease, ./github, ./overture, ./park, ./passive-update, ./reconcile, ./resume, ./reviewer, ./sessions, ./status, ./update, ./work-plan, ./watchers
 */
import { spawnSync } from "node:child_process";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command } from "commander";

import { buildRunnerScript, deriveStatus, shellQuote } from "../core/combo.js";
import {
  appendEvent,
  canonicalEventName,
  followEvents,
  latestPrUrlFromEvents,
  readEvents,
  type ComboEvent,
  type EventName,
} from "../core/events.js";
import { readGateLeases } from "../core/gate-lease.js";
import { buildRuntimeLedger, readRuntimeLedger, updateRuntimeLedger, writeRuntimeLedger } from "../core/runtime-ledger.js";
import {
  comboHome,
  describeWorkItem,
  listCombos,
  parseIssueUrl,
  readCombo,
  runDirFor,
  writeCombo,
  type ComboRecord,
} from "../core/state.js";
import {
  renderWorkPlanMarkdown,
} from "../core/work-plan.js";
import { loadRuntimeConfig, writeConfigSnapshot } from "../infra/config-snapshot.js";
import { formatReleaseMetadata, releaseMetadata } from "../infra/release-metadata.js";
import {
  attachSessionArgs,
  hasSessionArgs,
  killSessionArgs,
  listWindowsArgs,
  newWindowArgs,
  newSessionArgs,
  tmux as realTmux,
  type TmuxResult,
} from "../infra/tmux.js";
import {
  buildGatekeeperInvocation,
  buildIssuePrIntent,
  buildWorkPlanPrIntent,
  buildNoMistakesPushIntent,
  ensureIssueAutocloseInPrBody,
  hasIssueAutocloseInPrBody,
} from "../roles/gatekeeper.js";
import { buildCoderInvocation, defaultWorkPlanPrompt, persistCoderThreadArtifact } from "../roles/coder.js";
import { buildDirectorInvocation } from "../roles/director.js";
import { parseEventFields } from "./args.js";
import { closeMergedCombo } from "./closure.js";
import { activateCoder, nudgeReviewComments } from "./coder.js";
import { tickDirector } from "./director.js";
import { promptDirector } from "./director-prompt.js";
import { analyzeForensicsCombo, renderForensicsMarkdown, renderForensicsOutcomeMarkdown } from "./forensics.js";
import {
  ensureGatekeeperWindow,
  GATEKEEPER_WINDOW,
  NO_MISTAKES_CONFIG_FILE,
  propagateNoMistakesConfig,
  refreshGatekeeperWindow,
  restartPostAddressGate,
  scriptedMirrorGatekeeperCommandTemplate,
  startGatekeeperWindow,
  startInitialGateRetry,
} from "./gate.js";
import { acquireGateLeaseForCombo, releaseGateLeaseForCombo } from "./gate-lease.js";
import { fetchForensicsGithubFacts, fetchIssueDetails } from "./github.js";
import {
  assertOverturePassed,
  prepareOverture,
  renderOvertureChecklist,
} from "./overture.js";
import { parkCombo } from "./park.js";
import {
  defaultPassiveUpdateCommandDeps,
  runPassiveUpdateCheck,
  shouldRunPassiveUpdateForCommand,
  type PassiveUpdateCliDeps,
} from "./passive-update.js";
import { reconcileCombos } from "./reconcile.js";
import { resumeCombo } from "./resume.js";
import {
  activateReviewer,
  tickReviewer,
} from "./reviewer.js";
import {
  CODER_WINDOW,
  DIRECTOR_WINDOW,
  DIRECTOR_WATCH_WINDOW,
  ensureComboSession,
  ensureJournalPane,
  ensureWindowPresent,
  JOURNAL_WINDOW,
  resolveAttachCombo,
} from "./sessions.js";
import { deepComboStatus, formatGateLeaseStatus, type CommandResult } from "./status.js";
import { defaultUpdateCommandDeps, runUpdateCommand, type UpdateCommandDeps } from "./update.js";
import { isGitHubIssueWorkItem, readPersistedWorkPlan, WORK_PLAN_ARTIFACT } from "./work-plan.js";
import { buildDirectorWatchCommand, resolvePollMs } from "./watchers.js";

export { buildDirectorWatchCommand, resolvePollMs } from "./watchers.js";

// -- 1/4 HELPER · Deps and production adapters --
export interface Deps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  tmux: (args: string[]) => TmuxResult;
  git: (args: string[], cwd: string) => { status: number; stdout: string; stderr: string };
  treehouse: (args: string[], cwd: string) => { status: number; stdout: string; stderr: string };
  gh: UpdateCommandDeps["gh"];
  noMistakes: (args: string[], cwd: string) => CommandResult;
  sleep: (ms: number) => Promise<void>;
  issueExists: (issueUrl: string) => boolean;
  update?: Partial<UpdateCommandDeps>;
  passiveUpdate?: Partial<PassiveUpdateCliDeps>;
}

export function defaultDeps(): Deps {
  return {
    env: process.env,
    out: (line) => process.stdout.write(`${line}\n`),
    tmux: realTmux,
    git: (args, cwd) => {
      const result = spawnSync("git", args, { cwd, encoding: "utf8" });
      return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
    treehouse: (args, cwd) => {
      const result = spawnSync("treehouse", args, {
        cwd,
        encoding: "utf8",
        env: { ...process.env, TREEHOUSE_NO_UPDATE_CHECK: "1" },
      });
      return {
        status: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? result.error?.message ?? "",
      };
    },
    gh: (args, options) => {
      const result = spawnSync("gh", args, {
        encoding: "utf8",
        ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
      });
      const stderr = (result.stderr ?? "").trim().length > 0 ? (result.stderr ?? "") : (result.error?.message ?? "");
      return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr };
    },
    noMistakes: (args, cwd) => {
      const result = spawnSync("no-mistakes", args, { cwd, encoding: "utf8" });
      return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    issueExists: (issueUrl) => {
      const result = spawnSync("gh", ["issue", "view", issueUrl, "--json", "number"], {
        encoding: "utf8",
      });
      return (result.status ?? 1) === 0;
    },
  };
}

function cliInvocation(): string {
  const script = fileURLToPath(import.meta.url);
  return `"${process.execPath}" "${script}"`;
}

function isParked(events: ComboEvent[]): boolean {
  return events.at(-1)?.event === "parked";
}

function commandFailureText(result: { stdout: string; stderr: string }): string {
  return result.stderr.trim() || result.stdout.trim() || "unknown error";
}

function treehouseLeasePath(stdout: string): string {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length !== 1) {
    throw new Error(`treehouse get --lease returned ${lines.length} path lines (expected exactly one)`);
  }
  return lines[0]!;
}

function returnTreehouseWorktreeBestEffort(deps: Pick<Deps, "treehouse">, repoDir: string, worktree: string): void {
  deps.treehouse(["return", "--force", worktree], repoDir);
}

function deleteBranchBestEffort(deps: Pick<Deps, "git">, repoDir: string, branch: string): void {
  deps.git(["branch", "-D", branch], repoDir);
}

function rollbackTreehouseLaunch(deps: Pick<Deps, "git" | "treehouse">, combo: ComboRecord): void {
  returnTreehouseWorktreeBestEffort(deps, combo.repoDir, combo.worktree);
  deleteBranchBestEffort(deps, combo.repoDir, combo.branch);
}

function acquireTreehouseWorktree(input: {
  deps: Pick<Deps, "git" | "treehouse">;
  combo: ComboRecord;
  baseRef: string;
}): ComboRecord {
  const leased = input.deps.treehouse(["get", "--lease", "--lease-holder", input.combo.id], input.combo.repoDir);
  if (leased.status !== 0) {
    throw new Error(`treehouse get --lease failed: ${commandFailureText(leased)}`);
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
    throw new Error(`treehouse lease worktree state check failed for ${worktree}: ${commandFailureText(worktreeState)}`);
  }
  if (worktreeState.stdout.trim() !== "") {
    rollbackTreehouseLaunch(input.deps, combo);
    throw new Error(`treehouse lease returned dirty worktree at ${worktree}: ${worktreeState.stdout.trim()}`);
  }
  const switched = input.deps.git(["switch", "-c", combo.branch, input.baseRef], worktree);
  if (switched.status !== 0) {
    rollbackTreehouseLaunch(input.deps, combo);
    throw new Error(`git switch -c ${combo.branch} ${input.baseRef} failed: ${commandFailureText(switched)}`);
  }
  return combo;
}

// -/ 1/4

// -- 2/4 CORE · createProgram command registry <- START HERE --
export function createProgram(deps: Deps): Command {
  const program = new Command("combo-chen");
  program.exitOverride();
  program.description("The parallel capsule director for autonomous work-item → PR pipelines.");
  program.version(formatReleaseMetadata(releaseMetadata), "-v, --version", "Print release build metadata");
  program.hook("preAction", async (_program, actionCommand) => {
    if (!shouldRunPassiveUpdateForCommand(actionCommand.name())) return;
    try {
      await runPassiveUpdateCheck({
        ...defaultPassiveUpdateCommandDeps({ env: deps.env, gh: deps.gh }),
        ...deps.passiveUpdate,
      });
    } catch {
      // Passive update checks must never affect the command they shadow.
    }
  });

  program
    .command("update")
    .description("Update this combo-chen release archive from GitHub Releases")
    .option("--beta", "Include prerelease GitHub releases", false)
    .option("-y, --yes", "Skip confirmation and active-runtime safety prompts", false)
    .action(async (options: { beta?: boolean; yes?: boolean }) => {
      const updateDeps: UpdateCommandDeps = {
        ...defaultUpdateCommandDeps({ gh: deps.gh, out: deps.out, env: deps.env }),
        ...deps.update,
      };
      await runUpdateCommand({
        beta: options.beta === true,
        yes: options.yes === true,
        deps: updateDeps,
      });
    });

  program
    .command("overture")
    .description("Check and record the launch runway for a GitHub issue or local markdown plan")
    .option("--issue <url>", "GitHub issue URL")
    .option("--plan <file>", "Local markdown work plan")
    .option("--repo <dir>", "Target repo directory", process.cwd())
    .option("--base <ref>", "Base ref for the combo branch", "origin/main")
    .action((options: { issue?: string; plan?: string; repo: string; base: string }) => {
      const overture = prepareOverture({
        deps,
        issueUrl: options.issue,
        planFile: options.plan,
        repoDir: options.repo,
        baseRef: options.base,
      });
      for (const line of renderOvertureChecklist(overture.result)) deps.out(line);
      assertOverturePassed(overture.result);
    });

  program
    .command("run")
    .description("Launch a combo for a GitHub issue or local markdown plan")
    .option("--issue <url>", "GitHub issue URL")
    .option("--plan <file>", "Local markdown work plan")
    .option("--repo <dir>", "Target repo directory", process.cwd())
    .option("--prompt <text>", "Override the coder's objective prompt")
    .option("--base <ref>", "Base ref for the combo branch", "origin/main")
    .action(async (options: { issue?: string; plan?: string; repo: string; prompt?: string; base: string }) => {
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
      let directorCommand = "";
      let runnerPath = "";

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
        const prIntent = issueDetails === undefined
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
          activateCoder: `${cliInvocation()} activate-coder -n ${quotedId}`,
          emit: `${cliInvocation()} emit -n ${quotedId}`,
          activateReviewer: `${cliInvocation()} activate-reviewer -n ${quotedId}`,
          gateLeaseAcquire: `${cliInvocation()} gate-lease acquire -n ${quotedId}`,
          gateLeaseRelease: `${cliInvocation()} gate-lease release -n ${quotedId}`,
        };
        if (issue !== undefined) {
          runnerInput.ensurePrAutoclose = `${cliInvocation()} ensure-pr-autoclose -n ${quotedId} --pr-url`;
        }
        const runner = buildRunnerScript(runnerInput);
        runnerPath = join(runDir, "runner.sh");

        if (propagateNoMistakesConfig(options.repo, worktree)) {
          deps.out(`no-mistakes: copied local config to ${worktree}/${NO_MISTAKES_CONFIG_FILE}`);
        }
        writeCombo(runDir, combo);
        writeConfigSnapshot(runDir, config);
        writeFileSync(join(runDir, WORK_PLAN_ARTIFACT), renderWorkPlanMarkdown(workPlan));
        writeRuntimeLedger(
          runDir,
          buildRuntimeLedger({
            combo,
            runDir,
            cli: cliInvocation(),
            roleWindows: {
              coder: CODER_WINDOW,
              journal: JOURNAL_WINDOW,
              director: DIRECTOR_WINDOW,
              gatekeeper: GATEKEEPER_WINDOW,
              directorWatch: DIRECTOR_WATCH_WINDOW,
            },
            promptTargets: {
              director: `${session}:${DIRECTOR_WINDOW}`,
              workPlan: join(runDir, WORK_PLAN_ARTIFACT),
            },
          }),
        );
        writeFileSync(runnerPath, runner);
        chmodSync(runnerPath, 0o755);

        // Birth event lands BEFORE the detached runner can emit anything,
        // so journal ordering always matches the tested contract.
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
      } catch (error) {
        rmSync(runDir, { recursive: true, force: true });
        rollbackTreehouseLaunch(deps, combo);
        throw error;
      }

      const created = deps.tmux(
        newSessionArgs(session, CODER_WINDOW, `COMBO_CHEN_RUNNER_PROGRESS=1 sh ${shellQuote(runnerPath)}`),
      );
      if (created.status !== 0) {
        // A combo that never started must not leave orphans behind: undo the
        // run dir, the Treehouse lease, and the branch created inside it, so
        // a retry is idempotent. Return the worktree first — a branch checked
        // out in a worktree can't be deleted.
        rmSync(runDir, { recursive: true, force: true });
        rollbackTreehouseLaunch(deps, combo);
        throw new Error(`tmux failed to start the combo: ${created.stderr.trim()}`);
      }
      try {
        ensureJournalPane(deps, combo, cliInvocation());
        ensureWindowPresent(
          deps,
          combo,
          DIRECTOR_WINDOW,
          directorCommand,
        );
        startGatekeeperWindow(deps, combo, {
          timeoutSeconds: config.gatekeeperAttachTimeoutSeconds,
          retryIntervalSeconds: config.gatekeeperAttachRetryIntervalSeconds,
        });
        const directorWatch = deps.tmux(
          newWindowArgs(
            session,
            DIRECTOR_WATCH_WINDOW,
            buildDirectorWatchCommand({
              cli: cliInvocation(),
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
            `tmux failed to start director watcher in "${session}": ` +
              `${directorWatch.stderr.trim() || "unknown error"}`,
          );
        }
      } catch (error) {
        const killed = deps.tmux(killSessionArgs(session));
        let rollbackError: string | undefined;
        if (killed.status !== 0) {
          rollbackError =
            `tmux rollback failed for "${session}": ${killed.stderr.trim() || "unknown error"}`;
        }
        rmSync(runDir, { recursive: true, force: true });
        rollbackTreehouseLaunch(deps, combo);
        if (rollbackError !== undefined) {
          throw new Error(`${error instanceof Error ? error.message : String(error)}; ${rollbackError}`);
        }
        throw error;
      }

      deps.out(`🥢 ${session}`);
      deps.out(`   worktree ${worktree} · branch ${branch}`);
      deps.out(`   coder: ${config.roles.coder} · gatekeeper: ${config.roles.gatekeeper}`);
      deps.out(
        [
          `   topology: coder=${CODER_WINDOW}`,
          `journal=${JOURNAL_WINDOW}`,
          `director=${DIRECTOR_WINDOW}`,
          `gatekeeper=${GATEKEEPER_WINDOW}`,
          `director-watch=${DIRECTOR_WATCH_WINDOW}`,
          "coder-responding=lazy",
        ].join(" · "),
      );
      deps.out(`   journal: tmux attach -t ${session}  ·  combo-chen events --follow -n ${id}`);
    });

  program
    .command("attach")
    .description("Attach to a running combo tmux session")
    .option("-n, --name <comboId>", "Combo id")
    .action(async (options: { name?: string }) => {
      const combo = resolveAttachCombo(deps, comboHome(deps.env), options.name);
      ensureJournalPane(deps, combo, cliInvocation());
      const attached = deps.tmux(attachSessionArgs(combo.tmuxSession));
      if (attached.status !== 0) {
        throw new Error(
          `tmux attach failed for "${combo.tmuxSession}" (the tmux error was sent to your terminal above)` +
            `${attached.stderr.trim() ? `: ${attached.stderr.trim()}` : ""}`,
        );
      }
    });

  program
    .command("activate-reviewer")
    .description("Start the configured reviewer window for an opened PR")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .action(async (options: { name: string }) => {
      activateReviewer({
        deps,
        home: comboHome(deps.env),
        comboId: options.name,
        cli: cliInvocation(),
      });
    });

  program
    .command("reviewer-tick", { hidden: true })
    .description("Poll reviewer hard signals once")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .action(async (options: { name: string }) => {
      await tickReviewer({
        deps,
        home: comboHome(deps.env),
        comboId: options.name,
      });
    });

  program
    .command("director-prompt")
    .description("Send a deterministic prompt to a combo's director window")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .requiredOption("--reason <reason>", "Why the director is being prompted")
    .argument("<message...>", "Prompt text to send")
    .action(async (messageParts: string[], options: { name: string; reason: string }) => {
      promptDirector({
        deps,
        home: comboHome(deps.env),
        comboId: options.name,
        reason: options.reason,
        message: messageParts.join(" "),
      });
    });

  program
    .command("director-tick", { hidden: true })
    .description("Run one director orchestration pass")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .action(async (options: { name: string }) => {
      await tickDirector({
        deps,
        home: comboHome(deps.env),
        comboId: options.name,
        cli: cliInvocation(),
      });
    });

  program
    .command("director-watch", { hidden: true })
    .description("Run the director orchestration loop")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .option("--iterations <n>", "Stop after n ticks; intended for tests and one-shot supervision")
    .action(async (options: { name: string; iterations?: string }) => {
      const home = comboHome(deps.env);
      const runDir = runDirFor(home, options.name);
      const combo = readCombo(runDir);
      const config = loadRuntimeConfig(runDir, { repoDir: combo.repoDir, env: deps.env });
      const maxTicks = options.iterations === undefined ? undefined : Number(options.iterations);
      if (maxTicks !== undefined && (!Number.isInteger(maxTicks) || maxTicks <= 0)) {
        throw new Error("--iterations must be a positive integer");
      }

      let ticks = 0;
      while (maxTicks === undefined || ticks < maxTicks) {
        await tickDirector({
          deps,
          home: comboHome(deps.env),
          comboId: options.name,
          cli: cliInvocation(),
        });
        ticks += 1;
        if (maxTicks !== undefined && ticks >= maxTicks) break;
        await deps.sleep(config.limits.babysitPollSeconds * 1000);
      }
    });

  program
    .command("closure")
    .description("Converge one GitHub-merged combo's terminal journal and local resources")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .action(async (options: { name: string }) => {
      await closeMergedCombo({
        deps,
        home: comboHome(deps.env),
        comboId: options.name,
      });
    });

  program
    .command("reconcile")
    .description("Compare local combo journals with GitHub and repair missing terminal events")
    .option("-n, --name <comboId>", "Only reconcile one combo")
    .option("--apply", "Append reconcile events and run pending teardown", false)
    .action(async (options: { apply: boolean; name?: string }) => {
      await reconcileCombos({
        deps,
        home: comboHome(deps.env),
        apply: options.apply,
        comboId: options.name,
      });
    });

  program
    .command("resume")
    .description("Resume a persisted combo without starting a fresh run")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .action(async (options: { name: string }) => {
      await resumeCombo({
        deps,
        home: comboHome(deps.env),
        comboId: options.name,
        cli: cliInvocation(),
      });
    });

  program
    .command("status")
    .description("Show the parallel capsule dashboard; marks merged combos closure-pending and auto-closes closed PR salvage cases")
    .option("--deep", "Probe downstream no-mistakes/GitHub recovery state")
    .option("--all", "Include terminal historical combos", false)
    .action(async (options: { deep?: boolean; all?: boolean }) => {
      const home = comboHome(deps.env);
      await reconcileCombos({ deps, home, apply: true, quiet: true, mergedTeardown: false });
      const gateLeases = readGateLeases(home);
      const combos = listCombos(home);
      if (combos.length === 0) {
        if (gateLeases.length > 0) deps.out(`active gate leases: ${formatGateLeaseStatus(gateLeases)}`);
        deps.out("no combos. start one: combo-chen run --issue <url> (or --plan <file>)");
        return;
      }
      const rows = combos.map((combo) => {
        const runDir = runDirFor(home, combo.id);
        const ledger = readRuntimeLedger(runDir, { cli: cliInvocation() });
        let events = readEvents(runDir);
        let status = deriveStatus(events);
        if (
          !isParked(events) &&
          status.phase !== "STOPPED" &&
          !status.needsHuman &&
          deps.tmux(hasSessionArgs(combo.tmuxSession)).status !== 0
        ) {
          appendEvent(runDir, "needs_human", { reason: "tmux_missing", source: "status" });
          events = readEvents(runDir);
          status = deriveStatus(events);
        }
        return { combo, events, status, runtimePrUrl: ledger.prUrl };
      });
      const visibleRows = options.all === true ? rows : rows.filter(({ status }) => status.phase !== "STOPPED");
      if (visibleRows.length === 0) {
        if (gateLeases.length > 0) deps.out(`active gate leases: ${formatGateLeaseStatus(gateLeases)}`);
        deps.out("no actionable combos. show history: combo-chen status --all");
        return;
      }
      const deep = options.deep === true;
      const header = `${"CAPSULE".padEnd(30)} ${"PHASE".padEnd(9)} ${"NEEDS-HUMAN".padEnd(16)} ${"WORK ITEM".padEnd(40)} ${"GATE-LEASE".padEnd(28)} PR`;
      deps.out(deep ? `${header} DOWNSTREAM` : header);
      for (const { combo, events, status, runtimePrUrl } of visibleRows) {
        const needs = status.needsHuman ? (status.reason ?? "yes") : "—";
        const prUrl = status.pr ?? runtimePrUrl;
        const pr = prUrl ?? "—";
        const workItem = describeWorkItem(combo).label;
        const lease = formatGateLeaseStatus(gateLeases.find((record) => record.branch === combo.branch));
        const line = `${combo.id.padEnd(30)} ${status.phase.padEnd(9)} ${needs.padEnd(16)} ${workItem.padEnd(40)} ${lease.padEnd(28)} ${pr}`;
        if (!deep) {
          deps.out(line);
          continue;
        }
        const runDir = runDirFor(home, combo.id);
        const config = loadRuntimeConfig(runDir, { repoDir: combo.repoDir, env: deps.env });
        const downstream = deepComboStatus(combo, events, deps.noMistakes, deps.gh, {
          prUrl,
          localHeadSha: collectLocalWorktreeHeadSha(deps, combo),
          requiredCheckNames: config.readyRequiredChecks,
          ambientCheckNames: config.externalCommentAgents,
          reviewerLogins: config.reviewerLogins,
        });
        deps.out(`${line} ${downstream ?? "—"}`);
      }
    });

  program
    .command("forensics")
    .description("Produce combo forensics reports, with explicit outcome recording opt-in")
    .option("--issues <numbers>", "Comma-separated GitHub issue numbers (filters issue-backed combos)")
    .option("-n, --name <comboId>", "Combo id to include")
    .option("--format <format>", "markdown or json", "markdown")
    .option("--record-outcome", "Post each matched Outcome block to its source GitHub issue")
    .action(async (options: { issues?: string; name?: string; format: string; recordOutcome?: boolean }) => {
      const home = comboHome(deps.env);
      const issueFilter = parseForensicsIssueFilter(options.issues);
      const format = parseForensicsFormat(options.format);
      if (options.recordOutcome && format === "json") {
        throw new Error("--record-outcome cannot be combined with --format json");
      }
      const combos = listCombos(home).filter((combo) => {
        if (options.name !== undefined && combo.id !== options.name) return false;
        if (issueFilter === undefined) return true;
        try {
          return issueFilter.has(parseIssueUrl(combo.issueUrl).number);
        } catch {
          return false;
        }
      });
      const reports = combos.map((combo) => {
        const runDir = runDirFor(home, combo.id);
        const events = readEvents(runDir);
        const config = loadRuntimeConfig(runDir, { repoDir: combo.repoDir, env: deps.env });
        return analyzeForensicsCombo({
          combo,
          events,
          local: { worktreeHeadSha: collectLocalWorktreeHeadSha(deps, combo) },
          github: fetchForensicsGithubFacts(
            deps.gh,
            combo.issueUrl.trim() === "" ? undefined : combo.issueUrl,
            latestPrUrlFromEvents(events),
            undefined,
            {
              requiredCheckNames: config.readyRequiredChecks,
              ambientCheckNames: config.externalCommentAgents,
              reviewerLogins: config.reviewerLogins,
            },
          ),
          tmux: collectForensicsTmuxFacts(deps, combo),
        });
      });

      if (format === "json") {
        deps.out(JSON.stringify({ reports }, null, 2));
        return;
      }
      if (reports.length === 0) {
        deps.out(`${renderForensicsMarkdown(reports)}\n\n${formatForensicsNoMatches(options.name, issueFilter)}`);
        return;
      }
      if (options.recordOutcome) {
        recordForensicsOutcomes(deps, reports);
      }
      deps.out(renderForensicsMarkdown(reports));
    });

  program
    .command("park")
    .description("Write a reboot handoff and stop local combo processes without terminally closing it")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .option("--by <who>", "Who is parking it", "human")
    .action(async (options: { name: string; by: string }) => {
      parkCombo({
        deps,
        home: comboHome(deps.env),
        comboId: options.name,
        cli: cliInvocation(),
        by: options.by,
      });
    });

  program
    .command("stop")
    .description("Kill a combo's tmux session (journal survives)")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .option("--by <who>", "Who is stopping it", "human")
    .action(async (options: { name: string; by: string }) => {
      const runDir = runDirFor(comboHome(deps.env), options.name);
      const combo = readCombo(runDir);
      const killed = deps.tmux(killSessionArgs(combo.tmuxSession));
      if (killed.status !== 0) {
        // The journal never lies: no stopped event for a session still alive.
        throw new Error(
          `tmux kill-session failed for "${combo.tmuxSession}": ${killed.stderr.trim() || "unknown error"}`,
        );
      }
      appendEvent(runDir, "stopped", { by: options.by });
      deps.out(`stopped ${combo.id} (tmux session ${combo.tmuxSession} killed, journal kept)`);
    });

  program
    .command("events")
    .description("Print a combo's journal (JSONL); --follow to tail")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .option("--follow", "Keep following new events", false)
    .action(async (options: { name: string; follow: boolean }) => {
      const runDir = runDirFor(comboHome(deps.env), options.name);
      if (!options.follow) {
        for (const event of readEvents(runDir)) deps.out(JSON.stringify(event));
        return;
      }
      const pollMs = resolvePollMs(deps.env);
      for await (const event of followEvents(runDir, pollMs === undefined ? {} : { pollMs })) {
        deps.out(JSON.stringify(event));
      }
    });

  program
    .command("emit", { hidden: true })
    .description("Append a lifecycle event (used by the runner)")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .argument("<event>", "Event name")
    .option("--field <key=value...>", "Payload fields", (value: string, prev: string[]) => [...prev, value], [])
    .action(async (event: string, options: { name: string; field: string[] }) => {
      const home = comboHome(deps.env);
      const runDir = runDirFor(home, options.name);
      const canonicalEvent = canonicalEventName(event);
      if (canonicalEvent === "coder_done") {
        const combo = readCombo(runDir);
        persistCoderThreadArtifact({ runDir, worktree: combo.worktree });
      }
      const payload = parseEventFields(options.field);
      appendEvent(runDir, event as EventName, payload);
      if (canonicalEvent === "pr_opened" && typeof payload["url"] === "string") {
        updateRuntimeLedger(runDir, {
          cli: cliInvocation(),
          prUrl: payload["url"],
          roleWindows: {
            coder: CODER_WINDOW,
            director: DIRECTOR_WINDOW,
            gatekeeper: GATEKEEPER_WINDOW,
            directorWatch: DIRECTOR_WATCH_WINDOW,
          },
        });
      }
      if (canonicalEvent === "gate_started") {
        // The gatekeeper tmux window runs `no-mistakes attach`, which exits when
        // no active no-mistakes run exists — often before the runner's gatekeeper
        // command starts one.  Recreate the window now so the live role
        // window is visible when the no-mistakes run becomes active.
        try {
          const combo = readCombo(runDir);
          const config = loadRuntimeConfig(runDir, { repoDir: combo.repoDir, env: deps.env });
          ensureComboSession({ deps, combo, home, cli: cliInvocation() });
          refreshGatekeeperWindow(deps, combo, {
            timeoutSeconds: config.gatekeeperAttachTimeoutSeconds,
            retryIntervalSeconds: config.gatekeeperAttachRetryIntervalSeconds,
          });
        } catch (err) {
          process.stderr.write(
            `combo-chen: gatekeeper window recovery failed for ${options.name}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
    });

  program
    .command("intent")
    .description("Print the canonical no-mistakes issue PR intent for a combo (inspection/forensics; to relaunch a gate use gate-restart)")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .action(async (options: { name: string }) => {
      const runDir = runDirFor(comboHome(deps.env), options.name);
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
    });

  program
    .command("gate-lease", { hidden: true })
    .description("Acquire or release the branch-scoped no-mistakes gate lease for generated scripts")
    .argument("<action>", "acquire or release")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .option("--head-sha <sha>", "Current gate head SHA for acquire")
    .action(async (action: string, options: { name: string; headSha?: string }) => {
      const home = comboHome(deps.env);
      const result = action === "acquire"
        ? acquireGateLeaseForCombo({
          home,
          comboId: options.name,
          headSha: options.headSha,
          out: deps.out,
        })
        : action === "release"
          ? releaseGateLeaseForCombo({
            home,
            comboId: options.name,
            out: deps.out,
          })
          : undefined;
      if (result === undefined) throw new Error("gate-lease action must be acquire or release");
      if (result.exitCode !== 0) process.exitCode = result.exitCode;
    });

  program
    .command("gate-restart")
    .description(
      "Restart the no-mistakes gate for a combo using the canonical intent (one plain command; replaces a manual axi run)",
    )
    .requiredOption("-n, --name <comboId>", "Combo id")
    .action(async (options: { name: string }) => {
      const home = comboHome(deps.env);
      const runDir = runDirFor(home, options.name);
      const combo = readCombo(runDir);
      const cli = cliInvocation();
      const recreated = ensureComboSession({ deps, combo, home, cli });
      const prUrl = latestPrUrlFromEvents(readEvents(runDir));
      if (prUrl === undefined) {
        const result = startInitialGateRetry({ deps, combo, runDir, cli });
        if (result.started) {
          deps.out(
            `gate-restart: initial gate restarted for ${combo.id} at ${result.headSha}` +
              `${recreated ? " (recreated tmux session)" : ""}`,
          );
        } else {
          deps.out(
            `gate-restart: initial gate not started for ${combo.id} (${result.reason}) at ${result.headSha}`,
          );
        }
        return;
      }
      const result = restartPostAddressGate({ deps, combo, runDir, prUrl, cli });
      if (result.started) {
        deps.out(
          `gate-restart: post-address gate restarted for ${combo.id} at ${result.headSha}` +
            `${recreated ? " (recreated tmux session)" : ""}`,
        );
      } else {
        deps.out(
          `gate-restart: post-address gate not started for ${combo.id} (${result.reason}) at ${result.headSha}`,
        );
      }
    });

  program
    .command("ensure-pr-autoclose", { hidden: true })
    .description("Ensure the PR body visibly autocloses the combo source issue")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .requiredOption("--pr-url <url>", "Pull request URL")
    .action(async (options: { name: string; prUrl: string }) => {
      const runDir = runDirFor(comboHome(deps.env), options.name);
      const combo = readCombo(runDir);
      const viewed = deps.gh(["pr", "view", options.prUrl, "--json", "body", "--jq", ".body"]);
      if (viewed.status !== 0) {
        throw new Error(`gh pr view failed for ${options.prUrl}: ${viewed.stderr.trim() || "unknown error"}`);
      }

      const nextBody = ensureIssueAutocloseInPrBody(viewed.stdout, combo);
      if (nextBody === viewed.stdout) {
        deps.out(`pr autoclose already present for ${combo.id}`);
        return;
      }

      const bodyPath = join(runDir, "pr-body.autoclose.md");
      writeFileSync(bodyPath, nextBody);
      const edited = deps.gh(["pr", "edit", options.prUrl, "--body-file", bodyPath]);
      if (edited.status !== 0) {
        throw new Error(`gh pr edit failed for ${options.prUrl}: ${edited.stderr.trim() || "unknown error"}`);
      }
      const verified = deps.gh(["pr", "view", options.prUrl, "--json", "body", "--jq", ".body"]);
      if (verified.status !== 0) {
        throw new Error(`gh pr view failed while verifying ${options.prUrl}: ${verified.stderr.trim() || "unknown error"}`);
      }
      if (!hasIssueAutocloseInPrBody(verified.stdout, combo)) {
        throw new Error(
          `pr autoclose verification failed for ${options.prUrl}: ` +
            `body still lacks a visible GitHub autoclose keyword for ${combo.id}`,
        );
      }
      deps.out(`pr autoclose ensured for ${combo.id}`);
    });

  program
    .command("activate-coder", { hidden: true })
    .description("Start the resumed coder responding worker")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .action(async (options: { name: string }) => {
      activateCoder({
        deps,
        home: comboHome(deps.env),
        comboId: options.name,
        cli: cliInvocation(),
      });
    });

  program
    .command("nudge-review-comments", { hidden: true })
    .description("One-shot sweep: route new PR comments to the coder responding window")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .action(async (options: { name: string }) => {
      nudgeReviewComments({
        deps,
        home: comboHome(deps.env),
        comboId: options.name,
      });
    });

  return program;
}
// -/ 2/4

// -- 3/4 HELPER · Forensics parsing + direct-run detection --
type ForensicsFormat = "markdown" | "json";

function parseForensicsFormat(value: string): ForensicsFormat {
  if (value === "markdown" || value === "json") return value;
  throw new Error('--format must be "markdown" or "json"');
}

function parseForensicsIssueFilter(value: string | undefined): Set<number> | undefined {
  if (value === undefined) return undefined;
  const parts = value.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) throw new Error("--issues must include at least one issue number");
  const numbers = new Set<number>();
  for (const part of parts) {
    const number = Number(part);
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error(`Invalid issue number in --issues: ${part}`);
    }
    numbers.add(number);
  }
  return numbers;
}

function formatForensicsNoMatches(name: string | undefined, issueFilter: Set<number> | undefined): string {
  if (name !== undefined) {
    return `No matching combo for -n ${name} in this COMBO_CHEN_HOME.`;
  }
  if (issueFilter !== undefined) {
    const issues = Array.from(issueFilter).sort((left, right) => left - right).join(",");
    return [
      `No matching issue-backed combos for --issues ${issues} in this COMBO_CHEN_HOME.`,
      "Use -n <combo-id> for plan-backed runs or rerun after launch.",
    ].join("\n");
  }
  return "No combos found in this COMBO_CHEN_HOME.";
}

function recordForensicsOutcomes(
  deps: Pick<Deps, "gh" | "out">,
  reports: ReturnType<typeof analyzeForensicsCombo>[],
): void {
  for (const report of reports) {
    if (report.issueUrl.trim() === "") {
      throw new Error(`Cannot record forensics outcome for ${report.id}: combo has no GitHub issue URL`);
    }
    const missing = missingOutcomeEvidence(report);
    if (missing.length > 0) {
      throw new Error(`Cannot record forensics outcome for ${report.id}: missing ${missing.join(" and ")}`);
    }
    const body = renderForensicsOutcomeMarkdown(report);
    const result = deps.gh(["issue", "comment", report.issueUrl, "--body", body]);
    if (result.status !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || "gh issue comment failed";
      throw new Error(`Failed to record forensics outcome for ${report.id}: ${detail}`);
    }
    deps.out(`forensics: recorded outcome for ${report.id} on ${report.issueUrl}`);
  }
}

function missingOutcomeEvidence(report: ReturnType<typeof analyzeForensicsCombo>): string[] {
  const missing: string[] = [];
  if (report.prUrl === undefined) missing.push("PR link");
  if (report.gates.reviewer.headSha === undefined) missing.push("head SHA");
  return missing;
}

function collectForensicsTmuxFacts(deps: Deps, combo: ComboRecord): { sessionExists: boolean; windows?: string[] } | undefined {
  try {
    const sessionExists = deps.tmux(hasSessionArgs(combo.tmuxSession)).status === 0;
    if (!sessionExists) return { sessionExists: false, windows: [] };
    const listed = deps.tmux(listWindowsArgs(combo.tmuxSession));
    if (listed.status !== 0) return { sessionExists: true };
    return {
      sessionExists: true,
      windows: listed.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0),
    };
  } catch {
    return undefined;
  }
}

function collectLocalWorktreeHeadSha(deps: Pick<Deps, "git">, combo: Pick<ComboRecord, "worktree">): string | undefined {
  try {
    const result = deps.git(["rev-parse", "HEAD"], combo.worktree);
    if (result.status !== 0) return undefined;
    const head = result.stdout.trim().split(/\r?\n/)[0]?.trim();
    return head === undefined || head === "" ? undefined : head;
  } catch {
    return undefined;
  }
}

export function isDirectRun(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  return metaUrl === pathToFileURL(argv1).href || argv1.endsWith("cli.mjs");
}

const directRun = isDirectRun(import.meta.url, process.argv[1]);
// -/ 3/4

// -- 4/4 CORE · CLI process entrypoint --
if (directRun) {
  createProgram(defaultDeps())
    .parseAsync(process.argv)
    .catch((error: unknown) => {
      // exitOverride() turns commander's own exits (help, version, usage
      // errors it already printed) into throws; don't double-report them.
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string" && code.startsWith("commander.")) {
        process.exitCode = (error as { exitCode?: number }).exitCode ?? 0;
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`combo-chen: ${message}\n`);
      process.exitCode = 1;
    });
}
// -/ 4/4
