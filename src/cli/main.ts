#!/usr/bin/env node
/**
 * combo-chen — conductor for autonomous issue → PR pipelines.
 *
 * v0 surface: run | status | stop | events (+ emit, the runner's pen).
 * The CLI is setup and introspection; the generated runner script inside
 * tmux is the combo's spine. The director — human or agent — drives with
 * these four commands.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

import { buildRunnerScript, deriveStatus } from "../core/combo.js";
import { appendEvent, followEvents, readEvents, type EventName } from "../core/events.js";
import {
  comboHome,
  comboIdFromIssueUrl,
  listCombos,
  parseIssueUrl,
  readCombo,
  runDirFor,
  writeCombo,
  type ComboRecord,
} from "../core/state.js";
import { loadConfig } from "../infra/config.js";
import {
  hasSessionArgs,
  killSessionArgs,
  newSessionArgs,
  newWindowArgs,
  tmux as realTmux,
  type TmuxResult,
} from "../infra/tmux.js";
import { buildHodorInvocation } from "../roles/hodor.js";
import { buildRowerInvocation } from "../roles/rower.js";

export interface Deps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  tmux: (args: string[]) => TmuxResult;
  git: (args: string[], cwd: string) => { status: number; stdout: string; stderr: string };
  issueExists: (issueUrl: string) => boolean;
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
    issueExists: (issueUrl) => {
      const result = spawnSync("gh", ["issue", "view", issueUrl, "--json", "number"], {
        encoding: "utf8",
      });
      return (result.status ?? 1) === 0;
    },
  };
}

function coerce(value: string): unknown {
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

function parseFields(fields: string[]): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of fields) {
    const eq = field.indexOf("=");
    if (eq === -1) throw new Error(`--field expects key=value, got "${field}"`);
    payload[field.slice(0, eq)] = coerce(field.slice(eq + 1));
  }
  return payload;
}

function cliInvocation(): string {
  const script = fileURLToPath(import.meta.url);
  return `"${process.execPath}" "${script}"`;
}

export function createProgram(deps: Deps): Command {
  const program = new Command("combo-chen");
  program.exitOverride();
  program.description("Conductor for autonomous issue → PR pipelines.");

  program
    .command("run")
    .description("Launch a combo for a GitHub issue")
    .requiredOption("--issue <url>", "GitHub issue URL")
    .option("--repo <dir>", "Target repo directory", process.cwd())
    .option("--prompt <text>", "Override the rower's objective prompt")
    .action(async (options: { issue: string; repo: string; prompt?: string }) => {
      const issue = parseIssueUrl(options.issue);
      if (!deps.issueExists(options.issue)) {
        throw new Error(`Issue not reachable: ${options.issue} (gh issue view failed)`);
      }

      const config = loadConfig({ repoDir: options.repo });
      const id = comboIdFromIssueUrl(options.issue);
      const home = comboHome(deps.env);
      const runDir = runDirFor(home, id);
      const session = `combo-chen-${id}`;

      if (deps.tmux(hasSessionArgs(session)).status === 0) {
        throw new Error(`Combo already running: tmux session "${session}" exists`);
      }

      const branch = `combo/issue-${issue.number}`;
      const worktree = join(options.repo, ".worktrees", `issue-${issue.number}`);
      const combo: ComboRecord = {
        id,
        issueUrl: options.issue,
        repoDir: options.repo,
        worktree,
        branch,
        tmuxSession: session,
        createdAt: new Date().toISOString(),
      };

      const worktreeResult = deps.git(["worktree", "add", worktree, "-b", branch], options.repo);
      if (worktreeResult.status !== 0) {
        throw new Error(`git worktree add failed: ${worktreeResult.stderr.trim()}`);
      }

      writeCombo(runDir, combo);

      const rowerInput: Parameters<typeof buildRowerInvocation>[0] = {
        rowerCommand: config.rowerCommand,
        combo,
      };
      if (options.prompt !== undefined) rowerInput.prompt = options.prompt;

      const runner = buildRunnerScript({
        combo,
        rowerCommand: buildRowerInvocation(rowerInput),
        hodorCommand: buildHodorInvocation({ hodorCommand: config.hodorCommand }),
        emit: `${cliInvocation()} emit -n ${id}`,
      });
      const runnerPath = join(runDir, "runner.sh");
      writeFileSync(runnerPath, runner);
      chmodSync(runnerPath, 0o755);

      const created = deps.tmux(newSessionArgs(session, "rower", `sh "${runnerPath}"`));
      if (created.status !== 0) {
        throw new Error(`tmux failed to start the combo: ${created.stderr.trim()}`);
      }
      deps.tmux(newWindowArgs(session, "watch", `${cliInvocation()} events --follow -n ${id}`));

      appendEvent(runDir, "combo_created", {
        issue_url: combo.issueUrl,
        repo: combo.repoDir,
        worktree: combo.worktree,
        branch: combo.branch,
        tmux: session,
      });

      deps.out(`🥢 ${session}`);
      deps.out(`   worktree ${worktree} · branch ${branch}`);
      deps.out(`   rower: ${config.roles.rower} · hodor: ${config.roles.hodor}`);
      deps.out(`   watch: tmux attach -t ${session}  ·  combo-chen events --follow -n ${id}`);
    });

  program
    .command("status")
    .description("One line per combo: phase, needs-human, PR")
    .action(async () => {
      const combos = listCombos(comboHome(deps.env));
      if (combos.length === 0) {
        deps.out("no combos. start one: combo-chen run --issue <url>");
        return;
      }
      deps.out("COMBO                          PHASE     NEEDS-HUMAN      PR");
      for (const combo of combos) {
        const status = deriveStatus(readEvents(runDirFor(comboHome(deps.env), combo.id)));
        const needs = status.needsHuman ? (status.reason ?? "yes") : "—";
        const pr = status.pr ?? "—";
        deps.out(
          `${combo.id.padEnd(30)} ${status.phase.padEnd(9)} ${needs.padEnd(16)} ${pr}`,
        );
      }
    });

  program
    .command("stop")
    .description("Kill a combo's tmux session (journal survives)")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .option("--by <who>", "Who is stopping it", "human")
    .action(async (options: { name: string; by: string }) => {
      const runDir = runDirFor(comboHome(deps.env), options.name);
      const combo = readCombo(runDir);
      deps.tmux(killSessionArgs(combo.tmuxSession));
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
      for await (const event of followEvents(runDir)) {
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
      const runDir = runDirFor(comboHome(deps.env), options.name);
      appendEvent(runDir, event as EventName, parseFields(options.field));
    });

  return program;
}

const isDirectRun = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return import.meta.url === new URL(`file://${argv1}`).href || argv1.endsWith("cli.mjs");
})();

if (isDirectRun) {
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
