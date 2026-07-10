#!/usr/bin/env node
/**
 * @overview Thin Commander adapter for combo-chen commands and production dependency wiring.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at createProgram         <- declares the public and hidden CLI surface.
 *   2. Use defaultDeps                <- real process/git/gh/tmux adapters.
 *   3. Follow imported handlers       <- application behavior lives under src/app.
 *
 *   MAIN FLOW
 *   ---------
 *   isDirectRun -> createProgram(defaultDeps()) -> Commander parsing -> app handler
 *
 *   PUBLIC API
 *   ----------
 *   createProgram     Build the Commander program and delegate every command.
 *   defaultDeps       Provide production adapters for application handlers.
 *   isDirectRun       Detect direct execution through URL, cli.mjs, or realpath.
 *   Deps              Compatibility alias for the shared AppDeps contract.
 *   resolvePollMs                 Re-exported watcher cadence helper.
 *   buildDirectorWatchCommand     Re-exported director watcher helper.
 *
 *   INTERNALS
 *   ---------
 *   cliInvocation and the process entrypoint.
 *
 * @exports createProgram, defaultDeps, isDirectRun, Deps, resolvePollMs, buildDirectorWatchCommand
 * @deps commander, node:{child_process,fs,url}, ../app/{deps,director,gate,github,launch,lifecycle,reporting}, ../infra/{release-metadata,tmux}, ../update/index
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command } from "commander";

import type { AppDeps } from "../app/deps.js";
import {
  activateComboCoder,
  activateComboReviewer,
  nudgeComboReviewComments,
  sendDirectorPrompt,
  tickComboDirector,
  tickComboReviewer,
  watchDirector,
} from "../app/director/handlers.js";
import { handleGateLease, restartGate } from "../app/gate/handlers.js";
import { ensurePrAutoclose, printIntent } from "../app/github/handlers.js";
import { launchCombo, runOverture, type LaunchOptions } from "../app/launch/handlers.js";
import {
  attachCombo,
  closeCombo,
  emitComboEvent,
  parkPersistedCombo,
  printComboEvents,
  reconcileComboState,
  resumePersistedCombo,
  stopCombo,
} from "../app/lifecycle/handlers.js";
import { reportNeedsHuman, showForensics, showStatus } from "../app/reporting/handlers.js";
import { formatReleaseMetadata, releaseMetadata } from "../infra/release-metadata.js";
import { tmux as realTmux } from "../infra/tmux.js";
import { checkForPassiveUpdate, runSelfUpdate } from "../update/index.js";
import { resolveConfiguredTeamIdentity } from "../infra/team-identity.js";
export { buildDirectorWatchCommand, resolvePollMs } from "../app/director/watchers.js";
export type Deps = AppDeps;

// -- 1/3 HELPER · Production adapters --
export function defaultDeps(): AppDeps {
  return {
    env: process.env,
    out: (line) => process.stdout.write(line + "\n"),
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
      const stderr =
        (result.stderr ?? "").trim().length > 0 ? (result.stderr ?? "") : (result.error?.message ?? "");
      return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr };
    },
    noMistakes: (args, cwd, options) => {
      const result = spawnSync("no-mistakes", args, {
        cwd,
        encoding: "utf8",
        ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
      });
      const stderr =
        (result.stderr ?? "").trim().length > 0 ? (result.stderr ?? "") : (result.error?.message ?? "");
      return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr };
    },
    resolveTeamIdentity: resolveConfiguredTeamIdentity,
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
  return '"' + process.execPath + '" "' + script + '"';
}
// -/ 1/3

// -- 2/3 CORE · createProgram <- START HERE --
export function createProgram(deps: AppDeps): Command {
  const program = new Command("combo-chen");
  const cli = cliInvocation();
  program.exitOverride();
  program.description("The parallel capsule director for autonomous work-item → PR pipelines.");
  program.version(formatReleaseMetadata(releaseMetadata), "-v, --version", "Print release build metadata");
  program.hook("preAction", async (_program, actionCommand) => {
    await checkForPassiveUpdate(deps, actionCommand.name());
  });

  program
    .command("update")
    .description("Update this combo-chen release archive from GitHub Releases")
    .option("--beta", "Include prerelease GitHub releases", false)
    .option("-y, --yes", "Skip confirmation and active-runtime safety prompts", false)
    .action(async (options: { beta?: boolean; yes?: boolean }) => {
      await runSelfUpdate(deps, options);
    });

  program
    .command("overture")
    .description("Check and record the launch runway for a GitHub issue or local markdown plan")
    .option("--issue <url>", "GitHub issue URL")
    .option("--plan <file>", "Local markdown work plan")
    .option("--repo <dir>", "Target repo directory", process.cwd())
    .option("--base <ref>", "Base ref for the combo branch", "origin/main")
    .action((options: { issue?: string; plan?: string; repo: string; base: string }) => {
      runOverture(deps, options);
    });

  program
    .command("run")
    .description("Launch a combo for a GitHub issue or local markdown plan")
    .option("--issue <url>", "GitHub issue URL")
    .option("--plan <file>", "Local markdown work plan")
    .option("--repo <dir>", "Target repo directory", process.cwd())
    .option("--prompt <text>", "Override the coder's objective prompt")
    .option("--base <ref>", "Base ref for the combo branch", "origin/main")
    .action(async (options: LaunchOptions) => {
      await launchCombo(deps, options, cli);
    });

  program
    .command("attach")
    .description("Attach to a running combo tmux session")
    .option("-n, --name <comboId>", "Combo id")
    .action((options: { name?: string }) => {
      attachCombo(deps, options.name, cli);
    });

  program
    .command("activate-reviewer")
    .description("Start the configured reviewer window for an opened PR")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .action((options: { name: string }) => {
      activateComboReviewer(deps, options.name, cli);
    });

  program
    .command("reviewer-tick", { hidden: true })
    .description("Poll reviewer hard signals once")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .action(async (options: { name: string }) => {
      await tickComboReviewer(deps, options.name);
    });

  program
    .command("director-prompt")
    .description("Send a deterministic prompt to a combo's director window")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .requiredOption("--reason <reason>", "Why the director is being prompted")
    .argument("<message...>", "Prompt text to send")
    .action((messageParts: string[], options: { name: string; reason: string }) => {
      sendDirectorPrompt(deps, {
        name: options.name,
        reason: options.reason,
        message: messageParts.join(" "),
      });
    });

  program
    .command("director-tick", { hidden: true })
    .description("Run one director orchestration pass")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .action(async (options: { name: string }) => {
      await tickComboDirector(deps, options.name, cli);
    });

  program
    .command("director-watch", { hidden: true })
    .description("Run the director orchestration loop")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .option("--iterations <n>", "Stop after n ticks; intended for tests and one-shot supervision")
    .action(async (options: { name: string; iterations?: string }) => {
      await watchDirector(deps, options, cli);
    });

  program
    .command("closure")
    .description("Converge one GitHub-merged combo's terminal journal and local resources")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .action(async (options: { name: string }) => {
      await closeCombo(deps, options.name);
    });

  program
    .command("reconcile")
    .description("Compare local combo journals with GitHub and repair missing terminal events")
    .option("-n, --name <comboId>", "Only reconcile one combo")
    .option("--apply", "Append reconcile events and run pending teardown", false)
    .action(async (options: { apply: boolean; name?: string }) => {
      await reconcileComboState(deps, options);
    });

  program
    .command("resume")
    .description("Resume a persisted combo without starting a fresh run")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .action(async (options: { name: string }) => {
      await resumePersistedCombo(deps, options.name, cli);
    });

  program
    .command("needs-human-report")
    .description("Report needs_human counts by journal reason")
    .action(() => {
      reportNeedsHuman(deps);
    });

  program
    .command("status")
    .description(
      "Show the parallel capsule dashboard; marks merged combos closure-pending and auto-closes closed PR salvage cases",
    )
    .option("--deep", "Probe downstream no-mistakes/GitHub recovery state")
    .option("--all", "Include terminal historical combos", false)
    .action(async (options: { deep?: boolean; all?: boolean }) => {
      await showStatus(deps, options, cli);
    });

  program
    .command("forensics")
    .description("Produce combo forensics reports, with explicit outcome recording opt-in")
    .option("--issues <numbers>", "Comma-separated GitHub issue numbers (filters issue-backed combos)")
    .option("-n, --name <comboId>", "Combo id to include")
    .option("--format <format>", "markdown or json", "markdown")
    .option("--record-outcome", "Post each matched Outcome block to its source GitHub issue")
    .action(async (options: { issues?: string; name?: string; format: string; recordOutcome?: boolean }) => {
      await showForensics(deps, options);
    });

  program
    .command("park")
    .description("Write a reboot handoff and stop local combo processes without terminally closing it")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .option("--by <who>", "Who is parking it", "human")
    .action((options: { name: string; by: string }) => {
      parkPersistedCombo(deps, options, cli);
    });

  program
    .command("stop")
    .description("Kill a combo's tmux session (journal survives)")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .option("--by <who>", "Who is stopping it", "human")
    .action((options: { name: string; by: string }) => {
      stopCombo(deps, options);
    });

  program
    .command("events")
    .description("Print a combo's journal (JSONL); --follow to tail")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .option("--follow", "Keep following new events", false)
    .action(async (options: { name: string; follow: boolean }) => {
      await printComboEvents(deps, options);
    });

  program
    .command("emit", { hidden: true })
    .description("Append a lifecycle event (used by the runner)")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .argument("<event>", "Event name")
    .option("--skip-gate-window-recovery", "Skip gatekeeper window recovery for gate_started", false)
    .option(
      "--field <key=value...>",
      "Payload fields",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .action((event: string, options: { name: string; field: string[]; skipGateWindowRecovery: boolean }) => {
      emitComboEvent(deps, event, options, cli);
    });

  program
    .command("intent")
    .description(
      "Print the canonical no-mistakes issue PR intent for a combo (inspection/forensics; to relaunch a gate use gate-restart)",
    )
    .requiredOption("-n, --name <comboId>", "Combo id")
    .action((options: { name: string }) => {
      printIntent(deps, options.name);
    });

  program
    .command("gate-lease", { hidden: true })
    .description("Acquire or release the branch-scoped no-mistakes gate lease for generated scripts")
    .argument("<action>", "acquire or release")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .option("--head-sha <sha>", "Current gate head SHA for acquire")
    .action((action: string, options: { name: string; headSha?: string }) => {
      handleGateLease(deps, action, options);
    });

  program
    .command("gate-restart")
    .description(
      "Restart the no-mistakes gate for a combo using the canonical intent (one plain command; replaces a manual axi run)",
    )
    .requiredOption("-n, --name <comboId>", "Combo id")
    .action((options: { name: string }) => {
      restartGate(deps, options.name, cli);
    });

  program
    .command("ensure-pr-autoclose", { hidden: true })
    .description("Ensure the PR body visibly autocloses the combo source issue")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .requiredOption("--pr-url <url>", "Pull request URL")
    .action((options: { name: string; prUrl: string }) => {
      ensurePrAutoclose(deps, options);
    });

  program
    .command("activate-coder", { hidden: true })
    .description("Start the resumed coder responding worker")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .action((options: { name: string }) => {
      activateComboCoder(deps, options.name, cli);
    });

  program
    .command("nudge-review-comments", { hidden: true })
    .description("One-shot sweep: route new PR comments to the coder responding window")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .action((options: { name: string }) => {
      nudgeComboReviewComments(deps, options.name);
    });

  return program;
}
// -/ 2/3

// -- 3/3 CORE · Direct-run detection and process entrypoint --
export function isDirectRun(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  if (metaUrl === pathToFileURL(argv1).href || argv1.endsWith("cli.mjs")) return true;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

const directRun = isDirectRun(import.meta.url, process.argv[1]);
if (directRun) {
  createProgram(defaultDeps())
    .parseAsync(process.argv)
    .catch((error: unknown) => {
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string" && code.startsWith("commander.")) {
        process.exitCode = (error as { exitCode?: number }).exitCode ?? 0;
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write("combo-chen: " + message + "\n");
      process.exitCode = 1;
    });
}
// -/ 3/3
