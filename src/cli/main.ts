#!/usr/bin/env node
/**
 * combo-chen — conductor for autonomous issue → PR pipelines.
 *
 * v0 surface: run | attach | status | stop | events (+ emit, the runner's pen).
 * The CLI is setup and introspection; the generated runner script inside
 * tmux is the combo's spine. The director — human or agent — drives with
 * these five commands.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

import { buildRunnerScript, deriveStatus, shellQuote } from "../core/combo.js";
import {
  appendEvent,
  canonicalEventName,
  followEvents,
  readEvents,
  type EventName,
} from "../core/events.js";
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
  attachSessionArgs,
  hasSessionArgs,
  killSessionArgs,
  killWindowArgs,
  listPanesArgs,
  listWindowsArgs,
  newSessionArgs,
  newWindowArgs,
  splitWindowArgs,
  tmux as realTmux,
  type TmuxResult,
} from "../infra/tmux.js";
import { buildGatekeeperInvocation, ensureIssueAutocloseInPrBody } from "../roles/gatekeeper.js";
import { buildReviewerInvocation, incrementalReviewerPrompt } from "../roles/reviewer.js";
import { buildCoderInvocation, persistCoderThreadArtifact } from "../roles/coder.js";
import {
  buildCoderRespondingResumeCommand,
  buildReviewWatchCommand,
  fetchReviewCommentSignals,
  latestPrUrl,
  readCoderThreadArtifact,
  routeReviewComments,
} from "../roles/coder-responding.js";
import {
  ensureGatekeeperWindow,
  startGatekeeperWindow,
  syncNoMistakesMirror,
} from "./gate.js";
import { fetchIssueDetails, latestGitHubLgtmSha, parsePrView, remoteSlug, type PrView } from "./github.js";
import { teardownMergedCombo } from "./lifecycle.js";
import {
  canonicalLgtmShaForHead,
  hasJournaledLgtm,
  hasMergedEvent,
  latestOpenedPrUrl,
  livePinnedLgtmSha,
  terminalReviewerEvent,
} from "./reviewer.js";
import { buildReviewerWatchCommand, resolvePollMs } from "./watchers.js";

export { resolvePollMs } from "./watchers.js";

const CODER_WINDOW = "coder";
const REVIEWER_WINDOW = "reviewer";
const REVIEWER_WATCH_WINDOW = "reviewer-watch";

export interface Deps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  tmux: (args: string[]) => TmuxResult;
  git: (args: string[], cwd: string) => { status: number; stdout: string; stderr: string };
  gh: (args: string[]) => { status: number; stdout: string; stderr: string };
  sleep: (ms: number) => Promise<void>;
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
    gh: (args) => {
      const result = spawnSync("gh", args, { encoding: "utf8" });
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

function coerce(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
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

function killComboSession(deps: Deps, combo: ComboRecord): void {
  const killed = deps.tmux(killSessionArgs(combo.tmuxSession));
  if (killed.status !== 0) {
    throw new Error(
      `tmux kill-session failed for "${combo.tmuxSession}": ` +
        `${killed.stderr.trim() || "unknown error"}`,
    );
  }
}

function killWindowIfPresent(deps: Deps, combo: ComboRecord, windowName: string): void {
  const listed = deps.tmux(listWindowsArgs(combo.tmuxSession));
  if (listed.status !== 0) {
    throw new Error(
      `tmux failed to list windows in "${combo.tmuxSession}": ` +
        `${listed.stderr.trim() || "unknown error"}`,
    );
  }
  const exists = listed.stdout.split(/\r?\n/).includes(windowName);
  if (!exists) return;

  const killed = deps.tmux(killWindowArgs(combo.tmuxSession, windowName));
  if (killed.status !== 0) {
    throw new Error(
      `tmux failed to replace "${windowName}" in "${combo.tmuxSession}": ` +
        `${killed.stderr.trim() || "unknown error"}`,
    );
  }
}

function resolveAttachCombo(
  deps: Deps,
  home: string,
  name: string | undefined,
): ComboRecord {
  const combos = listCombos(home);
  if (name !== undefined) {
    const combo = combos.find((candidate) => candidate.id === name);
    if (!combo) throw new Error(`No combo named "${name}"`);
    if (deps.tmux(hasSessionArgs(combo.tmuxSession)).status !== 0) {
      throw new Error(
        `Combo "${combo.id}" is not running: tmux session "${combo.tmuxSession}" does not exist`,
      );
    }
    return combo;
  }

  const running = combos.filter((combo) => deps.tmux(hasSessionArgs(combo.tmuxSession)).status === 0);
  if (running.length === 0) {
    throw new Error("No running combos. Start one: combo-chen run --issue <url>");
  }
  if (running.length > 1) {
    throw new Error(
      `Several combos are running (${running.map((combo) => combo.id).join(", ")}); pass --name <comboId>`,
    );
  }
  return running[0]!;
}

function paneCount(stdout: string): number {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean).length;
}

function ensureJournalPane(deps: Deps, combo: ComboRecord): void {
  const listed = deps.tmux(listPanesArgs(combo.tmuxSession, CODER_WINDOW));
  if (listed.status !== 0) {
    throw new Error(
      `tmux failed to inspect coder panes in "${combo.tmuxSession}": ` +
        `${listed.stderr.trim() || "unknown error"}`,
    );
  }
  if (paneCount(listed.stdout) >= 2) return;

  const split = deps.tmux(
    splitWindowArgs(combo.tmuxSession, CODER_WINDOW, `${cliInvocation()} events --follow -n ${combo.id}`),
  );
  if (split.status !== 0) {
    throw new Error(
      `tmux failed to recreate the journal pane in "${combo.tmuxSession}": ` +
        `${split.stderr.trim() || "unknown error"}`,
    );
  }
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
    .option("--prompt <text>", "Override the coder's objective prompt")
    .action(async (options: { issue: string; repo: string; prompt?: string }) => {
      const issue = parseIssueUrl(options.issue);
      if (!deps.issueExists(options.issue)) {
        throw new Error(`Issue not reachable: ${options.issue} (gh issue view failed)`);
      }
      const issueDetails = fetchIssueDetails(deps.gh, options.issue);

      // The wrong cwd must not silently row on unrelated code: when the
      // target repo has an origin, its slug has to equal the issue's
      // owner/repo exactly (substring matching would accept owner/repo-fork).
      const remote = deps.git(["remote", "get-url", "origin"], options.repo);
      const remoteUrl = remote.stdout.trim();
      if (remote.status === 0 && remoteUrl !== "") {
        const slug = remoteSlug(remoteUrl);
        if (slug?.toLowerCase() !== `${issue.owner}/${issue.repo}`.toLowerCase()) {
          throw new Error(
            `Repo mismatch: origin is "${remoteUrl}" but the issue belongs to ${issue.owner}/${issue.repo}. ` +
              `Pass the right --repo.`,
          );
        }
      }

      const config = loadConfig({ repoDir: options.repo, env: deps.env });
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

      const coderInput: Parameters<typeof buildCoderInvocation>[0] = {
        coderCommand: config.coderCommand,
        combo,
      };
      if (options.prompt !== undefined) coderInput.prompt = options.prompt;

      const runner = buildRunnerScript({
        combo,
        coderCommand: buildCoderInvocation(coderInput),
        gatekeeperCommand: buildGatekeeperInvocation({
          gatekeeperCommand: config.gatekeeperCommand,
          combo,
          issueTitle: issueDetails.title,
          issueBody: issueDetails.body,
        }),
        activateCoder: `${cliInvocation()} activate-coder -n ${id}`,
        emit: `${cliInvocation()} emit -n ${id}`,
        activateReviewer: `${cliInvocation()} activate-reviewer -n ${id}`,
        ensurePrAutoclose: `${cliInvocation()} ensure-pr-autoclose -n ${shellQuote(id)} --pr-url`,
      });
      const runnerPath = join(runDir, "runner.sh");
      writeFileSync(runnerPath, runner);
      chmodSync(runnerPath, 0o755);

      // Birth event lands BEFORE the detached runner can emit anything,
      // so journal ordering always matches the tested contract.
      appendEvent(runDir, "combo_created", {
        issue_url: combo.issueUrl,
        repo: combo.repoDir,
        worktree: combo.worktree,
        branch: combo.branch,
        tmux: session,
      });

      const created = deps.tmux(newSessionArgs(session, CODER_WINDOW, `sh "${runnerPath}"`));
      if (created.status !== 0) {
        // A combo that never started must not leave orphans behind: undo the
        // run dir, the worktree, and the branch `worktree add -b` created, so
        // a retry is idempotent. Worktree first — a branch checked out in a
        // worktree can't be deleted.
        rmSync(runDir, { recursive: true, force: true });
        deps.git(["worktree", "remove", "--force", worktree], options.repo);
        deps.git(["branch", "-D", branch], options.repo);
        throw new Error(`tmux failed to start the combo: ${created.stderr.trim()}`);
      }
      try {
        ensureJournalPane(deps, combo);
        startGatekeeperWindow(deps, combo, {
          timeoutSeconds: config.gatekeeperAttachTimeoutSeconds,
          retryIntervalSeconds: config.gatekeeperAttachRetryIntervalSeconds,
        });
      } catch (error) {
        const killed = deps.tmux(killSessionArgs(session));
        if (killed.status !== 0) {
          throw new Error(
            `tmux rollback failed for "${session}": ${killed.stderr.trim() || "unknown error"}`,
          );
        }
        rmSync(runDir, { recursive: true, force: true });
        deps.git(["worktree", "remove", "--force", worktree], options.repo);
        deps.git(["branch", "-D", branch], options.repo);
        throw error;
      }

      deps.out(`🥢 ${session}`);
      deps.out(`   worktree ${worktree} · branch ${branch}`);
      deps.out(`   coder: ${config.roles.coder} · gatekeeper: ${config.roles.gatekeeper}`);
      deps.out(`   journal: tmux attach -t ${session}  ·  combo-chen events --follow -n ${id}`);
    });

  program
    .command("attach")
    .description("Attach to a running combo tmux session")
    .option("-n, --name <comboId>", "Combo id")
    .action(async (options: { name?: string }) => {
      const combo = resolveAttachCombo(deps, comboHome(deps.env), options.name);
      ensureJournalPane(deps, combo);
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
      const home = comboHome(deps.env);
      const runDir = runDirFor(home, options.name);
      const combo = readCombo(runDir);
      const prUrl = latestOpenedPrUrl(runDir);
      if (!prUrl) {
        throw new Error(`Cannot activate reviewer for ${combo.id}: no pr_opened event in the journal`);
      }

      const config = loadConfig({ repoDir: combo.repoDir, env: deps.env });
      const reviewerCommand = buildReviewerInvocation({
        combo,
        prUrl,
        protocol: config.reviewerProtocol,
        reviewerCommand: config.reviewerCommand,
      });

      killWindowIfPresent(deps, combo, REVIEWER_WINDOW);
      killWindowIfPresent(deps, combo, REVIEWER_WATCH_WINDOW);

      const created = deps.tmux(newWindowArgs(combo.tmuxSession, REVIEWER_WINDOW, reviewerCommand));
      if (created.status !== 0) {
        throw new Error(
          `tmux failed to start reviewer in "${combo.tmuxSession}": ` +
            `${created.stderr.trim() || "unknown error"}`,
        );
      }

      const watcher = deps.tmux(
        newWindowArgs(
          combo.tmuxSession,
          REVIEWER_WATCH_WINDOW,
          buildReviewerWatchCommand({
            cli: cliInvocation(),
            comboHome: home,
            comboId: combo.id,
            pollSeconds: config.limits.babysitPollSeconds,
          }),
        ),
      );
      if (watcher.status !== 0) {
        throw new Error(
          `tmux failed to start reviewer watcher in "${combo.tmuxSession}": ` +
            `${watcher.stderr.trim() || "unknown error"}`,
        );
      }

      deps.out(`reviewer: ${config.reviewerAgent} reviewing ${prUrl} in ${combo.tmuxSession}:${REVIEWER_WINDOW}`);
      deps.out(`${REVIEWER_WATCH_WINDOW}: polling reviewer hard signals every ${config.limits.babysitPollSeconds}s`);
    });

  program
    .command("reviewer-tick", { hidden: true })
    .description("Poll reviewer hard signals once")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .action(async (options: { name: string }) => {
      const runDir = runDirFor(comboHome(deps.env), options.name);
      const combo = readCombo(runDir);
      const prUrl = latestOpenedPrUrl(runDir);
      if (!prUrl) {
        throw new Error(`Cannot tick reviewer for ${combo.id}: no pr_opened event in the journal`);
      }

      let events = readEvents(runDir);
      const terminalEvent = terminalReviewerEvent(events);
      if (terminalEvent) {
        deps.out(`reviewer: already terminal at ${terminalEvent.event}`);
        return;
      }

      const pr = deps.gh(["pr", "view", prUrl, "--json", "headRefOid,state,mergedBy,baseRefName,mergeCommit"]);
      if (pr.status !== 0) {
        deps.out(`reviewer: gh pr view failed for ${combo.id} (status ${pr.status}): ${pr.stderr.trim() || "unknown error"}`);
        return;
      }

      let prView: PrView;
      try {
        prView = parsePrView(pr.stdout);
      } catch (error) {
        deps.out(
          `reviewer: failed to parse PR data for ${combo.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      const headSha = prView.headSha;

      if (prView.state === "MERGED") {
        const by = prView.mergedBy ?? "unknown";
        const mergeSha = prView.mergeSha;
        if (!mergeSha) {
          throw new Error(`Cannot tear down ${combo.id}: merged PR did not report mergeCommit.oid`);
        }
        const baseRefName = prView.baseRefName;
        if (!baseRefName) {
          throw new Error(`Cannot tear down ${combo.id}: merged PR did not report baseRefName`);
        }
        if (!hasMergedEvent(events, [mergeSha, headSha])) {
          appendEvent(runDir, "merged", { sha: mergeSha, by });
        }
        const config = loadConfig({ repoDir: combo.repoDir });
        try {
          await teardownMergedCombo({
            deps,
            combo,
            mergeSha,
            baseRefName,
            retries: config.limits.teardownGitRetries,
            backoffSeconds: config.limits.teardownGitBackoffSeconds,
          });
        } catch (error) {
          deps.out(
            `reviewer: teardown pending for ${combo.id}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        appendEvent(runDir, "combo_closed", {});
        deps.out(`reviewer: merged ${mergeSha} by ${by}`);
        killComboSession(deps, combo);
        return;
      }

      if (prView.state === "CLOSED") {
        appendEvent(runDir, "needs_human", { reason: "pr_closed" });
        appendEvent(runDir, "combo_closed", {});
        deps.out(`reviewer: closed`);
        killComboSession(deps, combo);
        return;
      }

      let githubPinnedSha: string | undefined;
      try {
        githubPinnedSha = latestGitHubLgtmSha(deps.gh, prUrl);
      } catch (error) {
        deps.out(
          `reviewer: failed to read LGTM pins for ${combo.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      if (githubPinnedSha) {
        const canonicalPinnedSha = canonicalLgtmShaForHead(githubPinnedSha, headSha);
        if (!hasJournaledLgtm(events, canonicalPinnedSha)) {
          appendEvent(runDir, "lgtm", { sha: canonicalPinnedSha });
          events = readEvents(runDir);
        }
      }

      const pinnedSha = livePinnedLgtmSha(events);
      if (!pinnedSha) {
        deps.out(`reviewer: no pinned lgtm for ${combo.id}`);
        return;
      }
      if (pinnedSha === headSha) {
        deps.out(`reviewer: lgtm current at ${headSha}`);
        return;
      }

      const config = loadConfig({ repoDir: combo.repoDir, env: deps.env });
      const reviewerCommand = buildReviewerInvocation({
        combo,
        prUrl,
        protocol: config.reviewerProtocol,
        reviewerCommand: config.reviewerCommand,
        prompt: incrementalReviewerPrompt({
          combo,
          prUrl,
          protocol: config.reviewerProtocol,
          oldSha: pinnedSha,
          newSha: headSha,
        }),
      });

      killWindowIfPresent(deps, combo, REVIEWER_WINDOW);

      const created = deps.tmux(newWindowArgs(combo.tmuxSession, REVIEWER_WINDOW, reviewerCommand));
      if (created.status !== 0) {
        throw new Error(
          `tmux failed to start reviewer re-review in "${combo.tmuxSession}": ` +
            `${created.stderr.trim() || "unknown error"}`,
        );
      }

      appendEvent(runDir, "lgtm_stale", { old_sha: pinnedSha, new_sha: headSha });
      deps.out(`reviewer: lgtm_stale ${pinnedSha} -> ${headSha}; re-reviewing ${prUrl}`);
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
      const runDir = runDirFor(comboHome(deps.env), options.name);
      const canonicalEvent = canonicalEventName(event);
      if (canonicalEvent === "coder_done") {
        const combo = readCombo(runDir);
        persistCoderThreadArtifact({ runDir, worktree: combo.worktree });
      }
      appendEvent(runDir, event as EventName, parseFields(options.field));
      if (canonicalEvent === "gate_started") {
        // The gatekeeper tmux window runs `no-mistakes attach`, which exits when
        // no active no-mistakes run exists — often before the runner's gatekeeper
        // command starts one.  Recreate the window now so the live role
        // window is visible when the no-mistakes run becomes active.
        try {
          const combo = readCombo(runDir);
          const config = loadConfig({ repoDir: combo.repoDir, env: deps.env });
          ensureGatekeeperWindow(deps, combo, {
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
      deps.out(`pr autoclose ensured for ${combo.id}`);
    });

  program
    .command("activate-coder", { hidden: true })
    .description("Start the resumed coder and its review-comment watcher")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .action(async (options: { name: string }) => {
      const runDir = runDirFor(comboHome(deps.env), options.name);
      const combo = readCombo(runDir);
      const config = loadConfig({ repoDir: combo.repoDir, env: deps.env });
      const artifact = readCoderThreadArtifact(runDir);
      const coderResponding = deps.tmux(
        newWindowArgs(
          combo.tmuxSession,
          config.coderRespondingWindowName,
          buildCoderRespondingResumeCommand(artifact, config.coderResumeCommand),
        ),
      );
      if (coderResponding.status !== 0) {
        throw new Error(
          `tmux failed to start ${config.coderRespondingWindowName}: ${coderResponding.stderr.trim() || "unknown error"}`,
        );
      }
      const watcher = deps.tmux(
        newWindowArgs(
          combo.tmuxSession,
          config.coderRespondingWatchWindowName,
          buildReviewWatchCommand({
            cli: cliInvocation(),
            comboId: combo.id,
            pollSeconds: config.limits.babysitPollSeconds,
          }),
        ),
      );
      if (watcher.status !== 0) {
        try {
          deps.tmux(killWindowArgs(combo.tmuxSession, config.coderRespondingWindowName));
        } catch {
          // Preserve the watcher startup failure; cleanup errors are secondary.
        }
        throw new Error(
          `tmux failed to start ${config.coderRespondingWatchWindowName}: ${watcher.stderr.trim() || "unknown error"}`,
        );
      }
      deps.out(`coder responding active for ${combo.id}`);
    });

  program
    .command("nudge-review-comments", { hidden: true })
    .description("One-shot sweep: route new PR comments to the coder responding window")
    .requiredOption("-n, --name <comboId>", "Combo id")
    .action(async (options: { name: string }) => {
      const runDir = runDirFor(comboHome(deps.env), options.name);
      const combo = readCombo(runDir);
      const prUrl = latestPrUrl(readEvents(runDir));
      if (prUrl === undefined) {
        throw new Error(`No pr_opened event for combo "${options.name}"`);
      }
      const config = loadConfig({ repoDir: combo.repoDir, env: deps.env });
      try {
        const synced = syncNoMistakesMirror(deps, combo, runDir);
        if (synced) {
          deps.out(`mirror synced for ${combo.id}`);
        }
      } catch (err) {
        deps.out(
          `mirror sync failed for ${combo.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const routed = routeReviewComments({
        runDir,
        tmuxSession: combo.tmuxSession,
        comments: fetchReviewCommentSignals(prUrl, deps.gh),
        reviewNudgePrompt: config.reviewNudgePrompt,
        windowName: config.coderRespondingWindowName,
        tmux: deps.tmux,
      });
      for (const comment of routed) {
        deps.out(`nudged ${comment.url}`);
      }
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
