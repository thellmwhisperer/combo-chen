/**
 * @overview Gatekeeper CLI helpers. ~840 lines, 19 exports, attach window, mirror sync, initial/post-address gates.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at ensureGatekeeperWindow <- live no-mistakes attach window.
 *   2. Then syncNoMistakesMirror       <- mirror freshness and push semaphore.
 *   3. Then startInitialGateRetry      <- relaunches coder-finished/no-PR gates.
 *   4. Then runPostAddressGateIfNeeded <- validates local addressing commits through no-mistakes.
 *   5. Pure helpers                    <- buildGatekeeperAttachCommand, remoteShaForRef.
 *
 *   MAIN FLOW
 *   ---------
 *   ensureGatekeeperWindow -> startGatekeeperWindow; resume/director -> generated gate script -> gate lease -> mirror push with intent -> config handoff + gatekeeper run; syncNoMistakesMirror -> fetch -> compare -> guarded push
 *
 *   PUBLIC API
 *   ----------
 *   GateDeps, GatekeeperWindowDeps, PostAddressGateDeps, GatekeeperAttachOptions
 *   GATEKEEPER_WINDOW, NO_MISTAKES_CONFIG_FILE
 *   buildGatekeeperAttachCommand, startGatekeeperWindow
 *   ensureGatekeeperWindow, remoteShaForRef, latestGateStatus
 *   latestPublishedGateSha, propagateNoMistakesConfig
 *   startInitialGateRetry, buildPostAddressGateScript, restartPostAddressGate, runPostAddressGateIfNeeded, syncNoMistakesMirror
 *
 *   INTERNALS
 *   ---------
 *   requireComboGit, worktreeHeadSha, buildInitialGateRetryScript, shellScript, renderGatekeeperCommand
 *
 * @exports GateDeps, GatekeeperWindowDeps, PostAddressGateDeps, GatekeeperAttachOptions, GATEKEEPER_WINDOW, NO_MISTAKES_CONFIG_FILE, buildGatekeeperAttachCommand, startGatekeeperWindow, ensureGatekeeperWindow, remoteShaForRef, latestGateStatus, latestPublishedGateSha, propagateNoMistakesConfig, scriptedMirrorGatekeeperCommandTemplate, startInitialGateRetry, buildPostAddressGateScript, restartPostAddressGate, runPostAddressGateIfNeeded, syncNoMistakesMirror
 * @deps node:{fs,path}, ../core/{combo,events,state}, ../infra/{config-snapshot,tmux}, ../roles/gatekeeper, ./github, ./sessions, ./work-plan
 */
import { chmodSync, copyFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildNoMistakesGatekeeperRunScript,
  buildNoMistakesMirrorPublishScript,
  gateLeaseScriptLines,
  guardNoMistakesDaemonStart,
  shellQuote,
} from "../core/combo.js";
import { appendEvent, readEvents, type ComboEvent } from "../core/events.js";
import type { ComboRecord } from "../core/state.js";
import { loadRuntimeConfig } from "../infra/config-snapshot.js";
import { listWindowsArgs, newWindowArgs, type TmuxResult } from "../infra/tmux.js";
import {
  buildGatekeeperInvocation,
  buildIssuePrIntent,
  buildNoMistakesPushIntent,
  buildWorkPlanPrIntent,
} from "../roles/gatekeeper.js";
import { fetchIssueDetails } from "./github.js";
import { killWindowIfPresent } from "./sessions.js";
import { isGitHubIssueWorkItem, readPersistedWorkPlan } from "./work-plan.js";

// -- 1/5 HELPER · Types and constants --
export interface GateDeps {
  out: (line: string) => void;
  git: (args: string[], cwd: string) => { status: number; stdout: string; stderr: string };
}

export interface GatekeeperWindowDeps {
  tmux: (args: string[]) => TmuxResult;
}

export interface PostAddressGateDeps extends GateDeps, GatekeeperWindowDeps {
  env: Record<string, string | undefined>;
  gh: (args: string[]) => { status: number; stdout: string; stderr: string };
}

export interface GatekeeperAttachOptions {
  timeoutSeconds: number;
  retryIntervalSeconds: number;
}

export const GATEKEEPER_WINDOW = "gatekeeper";
export const NO_MISTAKES_CONFIG_FILE = ".no-mistakes.yaml";
// -/ 1/5

// -- 2/5 CORE · Gatekeeper tmux window <- START HERE --
export function buildGatekeeperAttachCommand(
  combo: ComboRecord,
  options: GatekeeperAttachOptions,
): string {
  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0) {
    throw new Error("gatekeeper attach timeout must be > 0 seconds");
  }
  if (!Number.isFinite(options.retryIntervalSeconds) || options.retryIntervalSeconds <= 0) {
    throw new Error("gatekeeper attach retry interval must be > 0 seconds");
  }
  // The no-mistakes run id does not exist until the runner reaches gatekeeper.
  // Without --run, attach follows the active run for this worktree.
  const maxAttempts = Math.ceil(options.timeoutSeconds / options.retryIntervalSeconds);
  return [
    `cd ${shellQuote(combo.worktree)}`,
    "attempt=0",
    "while :; do",
    "  if no-mistakes axi status 2>/dev/null | grep -Eq '^[[:space:]]*status:[[:space:]]*running[[:space:]]*$'; then",
    "    exec no-mistakes attach",
    "  fi",
    "  attempt=$((attempt + 1))",
    `  if [ "$attempt" -gt ${maxAttempts} ]; then`,
    `    echo "gatekeeper-attach: timed out after ${options.timeoutSeconds} seconds" >&2`,
    "    exit 1",
    "  fi",
    `  echo "gatekeeper-attach: waiting for gatekeeper (attempt $attempt/${maxAttempts})..." >&2`,
    `  sleep ${options.retryIntervalSeconds}`,
    "done",
  ].join("\n");
}

export function startGatekeeperWindow(
  deps: GatekeeperWindowDeps,
  combo: ComboRecord,
  options: GatekeeperAttachOptions,
): void {
  const created = deps.tmux(
    newWindowArgs(combo.tmuxSession, GATEKEEPER_WINDOW, buildGatekeeperAttachCommand(combo, options)),
  );
  if (created.status !== 0) {
    throw new Error(
      `tmux failed to start gatekeeper watcher in "${combo.tmuxSession}": ` +
        `${created.stderr.trim() || "unknown error"}`,
    );
  }
}

export function ensureGatekeeperWindow(
  deps: GatekeeperWindowDeps,
  combo: ComboRecord,
  options: GatekeeperAttachOptions,
): void {
  const listed = deps.tmux(listWindowsArgs(combo.tmuxSession));
  if (listed.status !== 0) {
    throw new Error(
      `tmux failed to list windows in "${combo.tmuxSession}": ` +
        `${listed.stderr.trim() || "unknown error"}`,
    );
  }
  if (listed.stdout.split(/\r?\n/).includes(GATEKEEPER_WINDOW)) return;

  startGatekeeperWindow(deps, combo, options);
}
// -/ 2/5

// -- 3/5 HELPER · Gate state, git, and command rendering --
export function remoteShaForRef(stdout: string, ref: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const [sha, candidate] = line.trim().split(/\s+/, 2);
    if (candidate === ref && sha !== undefined && sha !== "") return sha;
  }
  return undefined;
}

function requireComboGit(
  deps: GateDeps,
  combo: ComboRecord,
  args: string[],
  description: string,
): { stdout: string } {
  const result = deps.git(args, combo.worktree);
  if (result.status !== 0) {
    throw new Error(
      `${description} failed for ${combo.id}: ${result.stderr.trim() || "unknown error"}`,
    );
  }
  return { stdout: result.stdout };
}
interface LatestGateStatus {
  state: string;
  headSha?: string;
}

export function latestGateStatus(events: ComboEvent[]): LatestGateStatus | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.event !== "gate_status" || typeof event["state"] !== "string") continue;
    const status: LatestGateStatus = { state: event["state"] };
    if (typeof event["head_sha"] === "string" && event["head_sha"] !== "") {
      status.headSha = event["head_sha"];
    }
    return status;
  }
  return undefined;
}

export function latestPublishedGateSha(events: ComboEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.event === "gate_validated" && typeof event["sha"] === "string") {
      return event["sha"];
    }
    if (
      event.event === "gate_status" &&
      event["state"] === "idle" &&
      typeof event["head_sha"] === "string"
    ) {
      return event["head_sha"];
    }
  }
  return undefined;
}

export function propagateNoMistakesConfig(repoDir: string, worktree: string): boolean {
  const source = join(repoDir, NO_MISTAKES_CONFIG_FILE);
  const target = join(worktree, NO_MISTAKES_CONFIG_FILE);
  if (!existsSync(source) || existsSync(target) || source === target) return false;
  const sourceMode = statSync(source).mode & 0o7777;
  copyFileSync(source, target);
  chmodSync(target, sourceMode);
  return true;
}

function hasAddressDone(events: ComboEvent[], headSha: string): boolean {
  return events.some((event) => event.event === "address_done" && event["head_sha"] === headSha);
}

function latestReviewCommentHeadShaAfterGate(events: ComboEvent[], gateSha: string): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.event === "review_comment") {
      return typeof event["head_sha"] === "string" && event["head_sha"] !== ""
        ? event["head_sha"]
        : undefined;
    }
    if (event.event === "gate_validated" && event["sha"] === gateSha) return undefined;
    if (event.event === "gate_status" && event["state"] === "idle" && event["head_sha"] === gateSha) {
      return undefined;
    }
  }
  return undefined;
}

function hasGateStale(events: ComboEvent[], oldSha: string, newSha: string): boolean {
  return events.some(
    (event) =>
      event.event === "gate_stale" &&
      event["old_sha"] === oldSha &&
      event["new_sha"] === newSha,
  );
}

function worktreeHeadSha(deps: GateDeps, combo: ComboRecord): string {
  return requireComboGit(
    deps,
    combo,
    ["rev-parse", "HEAD"],
    "git rev-parse HEAD",
  ).stdout.trim();
}

function hasUncommittedChanges(deps: GateDeps, combo: ComboRecord): boolean {
  return requireComboGit(
    deps,
    combo,
    ["status", "--porcelain"],
    "git status --porcelain",
  ).stdout.trim() !== "";
}

interface RenderedGatekeeperCommand {
  command: string;
  pushIntent: string;
}

function renderGatekeeperCommand(
  deps: PostAddressGateDeps,
  combo: ComboRecord,
  runDir: string,
  gatekeeperCommand: string,
): RenderedGatekeeperCommand {
  if (!isGitHubIssueWorkItem(combo)) {
    const workPlan = readPersistedWorkPlan(runDir, combo);
    return {
      command: buildGatekeeperInvocation({ gatekeeperCommand, combo, workPlan }),
      pushIntent: buildNoMistakesPushIntent(buildWorkPlanPrIntent(workPlan)),
    };
  }

  let issueDetails: { title: string; body: string } | undefined;
  const loadIssueDetails = (): { title: string; body: string } => {
    issueDetails ??= fetchIssueDetails(deps.gh, combo.issueUrl);
    return issueDetails;
  };

  let command: string;
  try {
    command = buildGatekeeperInvocation({ gatekeeperCommand });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("placeholders require work item facts")
    ) {
      throw error;
    }
    const details = loadIssueDetails();
    command = buildGatekeeperInvocation({
      gatekeeperCommand,
      combo,
      issueTitle: details.title,
      issueBody: details.body,
    });
  }

  const details = loadIssueDetails();
  return {
    command,
    pushIntent: buildNoMistakesPushIntent(
      buildIssuePrIntent({
        combo,
        issueTitle: details.title,
        issueBody: details.body,
      }),
    ),
  };
}

export const scriptedMirrorGatekeeperCommandTemplate = guardNoMistakesDaemonStart;

function renderScriptedMirrorGatekeeperCommand(
  deps: PostAddressGateDeps,
  combo: ComboRecord,
  runDir: string,
  gatekeeperCommand: string,
): RenderedGatekeeperCommand {
  return renderGatekeeperCommand(
    deps,
    combo,
    runDir,
    scriptedMirrorGatekeeperCommandTemplate(gatekeeperCommand),
  );
}

type ShellSection = string | string[];

function shellScript(...sections: ShellSection[]): string {
  return sections.flat().join("\n");
}

function indentShellLines(lines: string[], spaces: number): string[] {
  const prefix = " ".repeat(spaces);
  return lines.map((line) => `${prefix}${line}`);
}

function gateFailureReasonScript(): string[] {
  return [
    "gatekeeper_failure_reason=gate_failed",
    "if grep -Eiq 'daemon.*(dead|died|exited|not running)|connection refused|ECONNREFUSED' \"$gatekeeper_log\"; then",
    "  gatekeeper_failure_reason=daemon_dead",
    "fi",
  ];
}

function gateAlreadyRunningGuardScript(input: {
  combo: ComboRecord;
  headSha: string;
  emit: string;
}): string[] {
  return [
    "if [ \"$gatekeeper_code\" -ne 0 ]; then",
    "  status_probe_log=\"${gatekeeper_log}.status\"",
    `  if no-mistakes axi status > "$status_probe_log" 2>&1 && grep -F ${shellQuote(`branch: ${input.combo.branch}`)} "$status_probe_log" >/dev/null && grep -F ${shellQuote(`head: ${input.headSha.slice(0, 7)}`)} "$status_probe_log" >/dev/null && grep -Eq '^[[:space:]]*status:[[:space:]]*(active|in_progress|running)[[:space:]]*$' "$status_probe_log"; then`,
    "    gatekeeper_head_sha=$(git rev-parse HEAD 2>/dev/null || true)",
    `    ${input.emit} gate_status --field state=fix_inflight --field head_sha="$gatekeeper_head_sha"`,
    "    gate_lease_release || true",
    "    exec no-mistakes attach",
    "  fi",
    "  cat \"$status_probe_log\" >> \"$gatekeeper_log\" 2>/dev/null || true",
    "fi",
  ];
}

// -/ 3/5

// -- 4/5 CORE · Initial and post-address gate scripts --
function buildInitialGateRetryScript(input: {
  combo: ComboRecord;
  runDir: string;
  gatekeeperCommand: string;
  gatekeeperMirrorIntent: string;
  headSha: string;
  emit: string;
  activateCoder: string;
  activateReviewer: string;
  ensurePrAutoclose?: string;
  gateLeaseAcquire?: string;
  gateLeaseRelease?: string;
}): string {
  const shortSha = input.headSha.slice(0, 12);
  const gatekeeperLog = join(input.runDir, `gatekeeper-initial-${shortSha}.log`);
  const autocloseLog = join(input.runDir, `autoclose-initial-${shortSha}.log`);
  return shellScript(
    "#!/bin/sh",
    "set -u",
    `printf '%s\\n' ${shellQuote(`initial gate retry for ${input.combo.id} at ${input.headSha}`)}`,
    `gatekeeper_log=${shellQuote(gatekeeperLog)}`,
    `autoclose_log=${shellQuote(autocloseLog)}`,
    `cd ${shellQuote(input.combo.worktree)}`,
    `${input.emit} gate_started`,
    "gatekeeper_start_sha=$(git rev-parse HEAD 2>/dev/null || true)",
    "gate_lease_code=0",
    gateLeaseScriptLines({ acquire: input.gateLeaseAcquire, release: input.gateLeaseRelease }),
    `${input.emit} gate_status --field state=fix_inflight --field head_sha="$gatekeeper_start_sha"`,
    "gatekeeper_code=0",
    "(",
    indentShellLines(buildNoMistakesMirrorPublishScript(input.combo, input.gatekeeperMirrorIntent), 2),
    indentShellLines(buildNoMistakesGatekeeperRunScript(input.gatekeeperCommand, { waitForConfigBeforeRun: true }), 2),
    `) > "$gatekeeper_log" 2>&1 || gatekeeper_code=$?`,
    gateAlreadyRunningGuardScript(input),
    "if grep -Eq '^outcome:[[:space:]]*awaiting_approval[[:space:]]*$' \"$gatekeeper_log\"; then",
    "  gatekeeper_head_sha=$(git rev-parse HEAD 2>/dev/null || true)",
    `  ${input.emit} gate_status --field state=awaiting_approval --field head_sha="$gatekeeper_head_sha"`,
    `  ${input.emit} needs_human --field reason=gate_waiting`,
    "  exit 0",
    "fi",
    "if [ \"$gatekeeper_code\" -ne 0 ]; then",
    "  gatekeeper_head_sha=$(git rev-parse HEAD 2>/dev/null || true)",
    indentShellLines(gateFailureReasonScript(), 2),
    `  ${input.emit} gate_status --field state=failed --field head_sha="$gatekeeper_head_sha"`,
    `  ${input.emit} gate_failed --field exit_code="$gatekeeper_code" --field reason="$gatekeeper_failure_reason"`,
    "  exit \"$gatekeeper_code\"",
    "fi",
    "gatekeeper_head_sha=$(git rev-parse HEAD 2>/dev/null || true)",
    `pr_url=$(gh pr list --head ${shellQuote(input.combo.branch)} --json url --jq '.[0].url' 2>/dev/null || true)`,
    `if [ -n "\${pr_url:-}" ]; then`,
    `  pr_head_sha=$(gh pr view "$pr_url" --json headRefOid --jq '.headRefOid' 2>/dev/null || true)`,
    `  if [ -n "\${pr_head_sha:-}" ]; then`,
    `    gatekeeper_head_sha="$pr_head_sha"`,
    "  fi",
    input.ensurePrAutoclose === undefined
      ? "  :"
      : [
        `  if ${input.ensurePrAutoclose} "$pr_url" > "$autoclose_log" 2>&1; then`,
        "    :",
        "  else",
        "    autoclose_code=$?",
        `    ${input.emit} gate_status --field state=failed --field head_sha="$gatekeeper_head_sha"`,
        `    ${input.emit} gate_failed --field exit_code="$autoclose_code"`,
        `    ${input.emit} pr_autoclose_failed --field exit_code="$autoclose_code" --field url="$pr_url"`,
        `    exit "$autoclose_code"`,
        "  fi",
      ],
    `  ${input.emit} gate_status --field state=idle --field head_sha="$gatekeeper_head_sha"`,
    `  ${input.emit} pr_opened --field url="$pr_url"`,
    `  ${input.activateCoder}`,
    `  ${input.activateReviewer}`,
    "else",
    `  ${input.emit} gate_status --field state=idle --field head_sha="$gatekeeper_head_sha"`,
    `  ${input.emit} needs_human --field reason=pr_missing`,
    "fi",
  );
}

export function startInitialGateRetry(input: {
  deps: PostAddressGateDeps;
  combo: ComboRecord;
  runDir: string;
  cli: string;
}): { started: true; headSha: string } | { started: false; headSha: string; reason: string } {
  const { deps, combo, runDir, cli } = input;
  if (propagateNoMistakesConfig(combo.repoDir, combo.worktree)) {
    deps.out(`no-mistakes: copied local config to ${combo.worktree}/${NO_MISTAKES_CONFIG_FILE}`);
  }

  const headSha = worktreeHeadSha(deps, combo);
  if (hasUncommittedChanges(deps, combo)) {
    deps.out(`gate: worktree has uncommitted changes for ${combo.id}; waiting for commit before gate retry`);
    return { started: false, headSha, reason: "uncommitted_changes" };
  }

  const config = loadRuntimeConfig(runDir, { repoDir: combo.repoDir, env: deps.env });
  const renderedGatekeeper = renderScriptedMirrorGatekeeperCommand(deps, combo, runDir, config.gatekeeperCommand);
  const scriptPath = join(runDir, `gatekeeper-initial-${headSha.slice(0, 12)}.sh`);
  writeFileSync(
    scriptPath,
    `${buildInitialGateRetryScript({
      combo,
      runDir,
      gatekeeperCommand: renderedGatekeeper.command,
      gatekeeperMirrorIntent: renderedGatekeeper.pushIntent,
      headSha,
      emit: `${cli} emit -n ${shellQuote(combo.id)}`,
      activateCoder: `${cli} activate-coder -n ${shellQuote(combo.id)}`,
      activateReviewer: `${cli} activate-reviewer -n ${shellQuote(combo.id)}`,
      gateLeaseAcquire: `${cli} gate-lease acquire -n ${shellQuote(combo.id)}`,
      gateLeaseRelease: `${cli} gate-lease release -n ${shellQuote(combo.id)}`,
      ...(isGitHubIssueWorkItem(combo)
        ? { ensurePrAutoclose: `${cli} ensure-pr-autoclose -n ${shellQuote(combo.id)} --pr-url` }
        : {}),
    })}\n`,
  );
  chmodSync(scriptPath, 0o755);

  killWindowIfPresent(deps, combo, GATEKEEPER_WINDOW);
  const created = deps.tmux(newWindowArgs(combo.tmuxSession, GATEKEEPER_WINDOW, `sh ${shellQuote(scriptPath)}`));
  if (created.status !== 0) {
    throw new Error(
      `tmux failed to start initial gatekeeper retry in "${combo.tmuxSession}": ` +
        `${created.stderr.trim() || "unknown error"}`,
    );
  }
  return { started: true, headSha };
}

export function buildPostAddressGateScript(input: {
  combo: ComboRecord;
  runDir: string;
  gatekeeperCommand: string;
  gatekeeperMirrorIntent: string;
  headSha: string;
  prUrl: string;
  emit: string;
  ensurePrAutoclose?: string;
  gateLeaseAcquire?: string;
  gateLeaseRelease?: string;
}): string {
  const shortSha = input.headSha.slice(0, 12);
  const gatekeeperLog = join(input.runDir, `gatekeeper-post-${shortSha}.log`);
  const statusFile = join(input.runDir, `gatekeeper-post-${shortSha}.status`);
  const autocloseLog = join(input.runDir, `autoclose-post-${shortSha}.log`);
  return shellScript(
    "#!/bin/sh",
    "set -u",
    `printf '%s\\n' ${shellQuote(`post-address gate for ${input.combo.id} at ${input.headSha}`)}`,
    `gatekeeper_log=${shellQuote(gatekeeperLog)}`,
    `status_file=${shellQuote(statusFile)}`,
    `autoclose_log=${shellQuote(autocloseLog)}`,
    `cd ${shellQuote(input.combo.worktree)}`,
    `${input.emit} gate_started`,
    "gatekeeper_start_sha=$(git rev-parse HEAD 2>/dev/null || true)",
    "gate_lease_code=0",
    gateLeaseScriptLines({ acquire: input.gateLeaseAcquire, release: input.gateLeaseRelease }),
    `${input.emit} gate_status --field state=fix_inflight --field head_sha="$gatekeeper_start_sha"`,
    `rm -f "$status_file"`,
    "(",
    "  gatekeeper_code=0",
    "  (",
    indentShellLines(buildNoMistakesMirrorPublishScript(input.combo, input.gatekeeperMirrorIntent), 4),
    indentShellLines(buildNoMistakesGatekeeperRunScript(input.gatekeeperCommand, { waitForConfigBeforeRun: true }), 4),
    "  ) || gatekeeper_code=$?",
    `  printf '%s\\n' "$gatekeeper_code" > "$status_file"`,
    `) 2>&1 | tee "$gatekeeper_log"`,
    `gatekeeper_code=$(cat "$status_file" 2>/dev/null || printf '1')`,
    `rm -f "$status_file"`,
    gateAlreadyRunningGuardScript(input),
    "if grep -Eq '^outcome:[[:space:]]*awaiting_approval[[:space:]]*$' \"$gatekeeper_log\"; then",
    "  gatekeeper_head_sha=$(git rev-parse HEAD 2>/dev/null || true)",
    `  ${input.emit} gate_status --field state=awaiting_approval --field head_sha="$gatekeeper_head_sha"`,
    `  ${input.emit} needs_human --field reason=gate_waiting`,
    "  exit 0",
    "fi",
    "if [ \"$gatekeeper_code\" -ne 0 ]; then",
    "  gatekeeper_head_sha=$(git rev-parse HEAD 2>/dev/null || true)",
    indentShellLines(gateFailureReasonScript(), 2),
    `  ${input.emit} gate_status --field state=failed --field head_sha="$gatekeeper_head_sha"`,
    `  ${input.emit} gate_failed --field exit_code="$gatekeeper_code" --field reason="$gatekeeper_failure_reason"`,
    "  exit \"$gatekeeper_code\"",
    "fi",
    "gatekeeper_head_sha=$(git rev-parse HEAD 2>/dev/null || true)",
    `pr_url=$(gh pr list --head ${shellQuote(input.combo.branch)} --json url --jq '.[0].url' 2>/dev/null || true)`,
    `if [ -z "\${pr_url:-}" ]; then pr_url=${shellQuote(input.prUrl)}; fi`,
    `pr_head_sha=$(gh pr view "$pr_url" --json headRefOid --jq '.headRefOid' 2>/dev/null || true)`,
    `if [ -n "\${pr_head_sha:-}" ]; then`,
    `  gatekeeper_head_sha="$pr_head_sha"`,
    "fi",
    input.ensurePrAutoclose === undefined
      ? ":"
      : [
        `if ${input.ensurePrAutoclose} "$pr_url" > "$autoclose_log" 2>&1; then`,
        "  :",
        "else",
        "  autoclose_code=$?",
        `  if [ -n "$gatekeeper_head_sha" ]; then`,
        `    ${input.emit} gate_status --field state=failed --field head_sha="$gatekeeper_head_sha"`,
        "  else",
        `    ${input.emit} gate_status --field state=failed`,
        "  fi",
        `  ${input.emit} gate_failed --field exit_code="$autoclose_code"`,
        `  ${input.emit} pr_autoclose_failed --field exit_code="$autoclose_code" --field url="$pr_url"`,
        `  exit "$autoclose_code"`,
        "fi",
      ],
    `if [ -n "$gatekeeper_head_sha" ]; then`,
    `  ${input.emit} gate_status --field state=idle --field head_sha="$gatekeeper_head_sha"`,
    `  ${input.emit} gate_validated --field sha="$gatekeeper_head_sha"`,
    "else",
    `  ${input.emit} gate_status --field state=idle`,
    "fi",
  );
}

function startPostAddressGate(input: {
  deps: PostAddressGateDeps;
  combo: ComboRecord;
  runDir: string;
  gatekeeperCommand: string;
  gatekeeperMirrorIntent: string;
  headSha: string;
  prUrl: string;
  cli: string;
}): void {
  const scriptPath = join(input.runDir, `gatekeeper-post-${input.headSha.slice(0, 12)}.sh`);
  writeFileSync(
    scriptPath,
    `${buildPostAddressGateScript({
      combo: input.combo,
      runDir: input.runDir,
      gatekeeperCommand: input.gatekeeperCommand,
      gatekeeperMirrorIntent: input.gatekeeperMirrorIntent,
      headSha: input.headSha,
      prUrl: input.prUrl,
      emit: `${input.cli} emit -n ${shellQuote(input.combo.id)}`,
      gateLeaseAcquire: `${input.cli} gate-lease acquire -n ${shellQuote(input.combo.id)}`,
      gateLeaseRelease: `${input.cli} gate-lease release -n ${shellQuote(input.combo.id)}`,
      ...(isGitHubIssueWorkItem(input.combo)
        ? { ensurePrAutoclose: `${input.cli} ensure-pr-autoclose -n ${shellQuote(input.combo.id)} --pr-url` }
        : {}),
    })}\n`,
  );
  chmodSync(scriptPath, 0o755);

  const command = `sh ${shellQuote(scriptPath)}`;

  killWindowIfPresent(input.deps, input.combo, GATEKEEPER_WINDOW);
  const created = input.deps.tmux(newWindowArgs(input.combo.tmuxSession, GATEKEEPER_WINDOW, command));
  if (created.status !== 0) {
    throw new Error(
      `tmux failed to start post-address gatekeeper in "${input.combo.tmuxSession}": ` +
        `${created.stderr.trim() || "unknown error"}`,
    );
  }
}

// Force a post-address gate for the current committed head, even when a prior
// gate already failed at that same SHA. This is the manual recovery lever
// (`gate-restart` after `pr_opened`); unlike runPostAddressGateIfNeeded it does
// NOT suppress a restart for an already-failed head. It still refuses on
// uncommitted changes, warns when a gate is genuinely in flight (the caller
// should confirm a stall first), writes the same address_done/gate_stale
// breadcrumbs as the idempotent path so status and forensics stay in parity,
// and keeps the canonical intent + mirror push + autoclose guard by going
// through the same generated gate script.
export function restartPostAddressGate(input: {
  deps: PostAddressGateDeps;
  combo: ComboRecord;
  runDir: string;
  prUrl: string;
  cli: string;
}): { started: true; headSha: string } | { started: false; headSha: string; reason: string } {
  const { deps, combo, runDir, prUrl, cli } = input;
  const events = readEvents(runDir);

  if (latestGateStatus(events)?.state === "fix_inflight") {
    deps.out(
      `gate-restart: warning - a gate is in flight for ${combo.id} (gate_status=fix_inflight); ` +
        `restarting replaces the running gatekeeper. Confirm it is stalled (no-mistakes axi status) before forcing.`,
    );
  }

  if (propagateNoMistakesConfig(combo.repoDir, combo.worktree)) {
    deps.out(`no-mistakes: copied local config to ${combo.worktree}/${NO_MISTAKES_CONFIG_FILE}`);
  }

  const headSha = worktreeHeadSha(deps, combo);
  if (hasUncommittedChanges(deps, combo)) {
    deps.out(`gate: worktree has uncommitted changes for ${combo.id}; waiting for commit before gate restart`);
    return { started: false, headSha, reason: "uncommitted_changes" };
  }

  if (!hasAddressDone(events, headSha)) {
    appendEvent(runDir, "address_done", { head_sha: headSha });
  }
  const lastPublishedSha = latestPublishedGateSha(events);
  if (
    lastPublishedSha !== undefined &&
    lastPublishedSha !== headSha &&
    !hasGateStale(events, lastPublishedSha, headSha)
  ) {
    appendEvent(runDir, "gate_stale", { old_sha: lastPublishedSha, new_sha: headSha });
  }

  const config = loadRuntimeConfig(runDir, { repoDir: combo.repoDir, env: deps.env });
  const renderedGatekeeper = renderScriptedMirrorGatekeeperCommand(deps, combo, runDir, config.gatekeeperCommand);
  startPostAddressGate({
    deps,
    combo,
    runDir,
    gatekeeperCommand: renderedGatekeeper.command,
    gatekeeperMirrorIntent: renderedGatekeeper.pushIntent,
    headSha,
    prUrl,
    cli,
  });
  return { started: true, headSha };
}

export function runPostAddressGateIfNeeded(input: {
  deps: PostAddressGateDeps;
  combo: ComboRecord;
  runDir: string;
  prUrl: string;
  cli: string;
}): void {
  const { deps, combo, runDir, prUrl, cli } = input;
  const events = readEvents(runDir);
  const lastStatus = latestGateStatus(events);
  const lastPublishedSha = latestPublishedGateSha(events);
  if (lastStatus === undefined && lastPublishedSha === undefined) return;

  const headSha = worktreeHeadSha(deps, combo);
  if (lastStatus?.state === "fix_inflight") {
    if (
      lastStatus.headSha !== undefined &&
      lastStatus.headSha !== headSha &&
      !hasGateStale(events, lastStatus.headSha, headSha)
    ) {
      appendEvent(runDir, "gate_stale", { old_sha: lastStatus.headSha, new_sha: headSha });
      deps.out(`director: gate in flight for ${combo.id} is stale at ${headSha}; waiting for it to finish`);
    } else {
      deps.out(`director: gate already in flight for ${combo.id}`);
    }
    return;
  }

  if (lastPublishedSha === undefined || lastPublishedSha === headSha) return;

  if (lastStatus?.state === "failed" && lastStatus.headSha === headSha) {
    deps.out(`director: post-address gate already failed for ${combo.id} at ${headSha}`);
    return;
  }

  const reviewHeadSha = latestReviewCommentHeadShaAfterGate(events, lastPublishedSha);
  if (reviewHeadSha === undefined || reviewHeadSha === headSha) {
    deps.out(`director: no coder HEAD change for ${combo.id}; waiting for coder to commit`);
    return;
  }

  if (propagateNoMistakesConfig(combo.repoDir, combo.worktree)) {
    deps.out(`no-mistakes: copied local config to ${combo.worktree}/${NO_MISTAKES_CONFIG_FILE}`);
  }

  if (hasUncommittedChanges(deps, combo)) {
    deps.out(`director: worktree has uncommitted changes for ${combo.id}; waiting for coder to commit`);
    return;
  }

  if (!hasAddressDone(events, headSha)) {
    appendEvent(runDir, "address_done", { head_sha: headSha });
  }
  if (!hasGateStale(events, lastPublishedSha, headSha)) {
    appendEvent(runDir, "gate_stale", { old_sha: lastPublishedSha, new_sha: headSha });
  }

  const config = loadRuntimeConfig(runDir, { repoDir: combo.repoDir, env: deps.env });
  const renderedGatekeeper = renderScriptedMirrorGatekeeperCommand(deps, combo, runDir, config.gatekeeperCommand);
  startPostAddressGate({
    deps,
    combo,
    runDir,
    gatekeeperCommand: renderedGatekeeper.command,
    gatekeeperMirrorIntent: renderedGatekeeper.pushIntent,
    headSha,
    prUrl,
    cli,
  });
  deps.out(`director: post-address gate started for ${combo.id} at ${headSha}`);
}
// -/ 4/5

// -- 5/5 CORE · syncNoMistakesMirror --
export function syncNoMistakesMirror(deps: GateDeps, combo: ComboRecord, runDir: string): boolean {
  const remote = deps.git(["remote", "get-url", "no-mistakes"], combo.worktree);
  if (remote.status !== 0) {
    // git exits 2 when the named remote is absent; that is expected for combos
    // whose repo has no no-mistakes mirror configured.
    if (remote.status !== 2) {
      deps.out(
        `mirror sync: git remote get-url no-mistakes failed for ${combo.id}: ${remote.stderr.trim() || `exit code ${remote.status}`}`,
      );
    }
    return false;
  }

  const originRef = `refs/remotes/origin/${combo.branch}`;
  const mirrorRef = `refs/heads/${combo.branch}`;
  requireComboGit(
    deps,
    combo,
    ["fetch", "origin", `+${combo.branch}:${originRef}`],
    "git fetch origin branch",
  );
  const origin = requireComboGit(
    deps,
    combo,
    ["rev-parse", originRef],
    "git rev-parse origin branch",
  ).stdout.trim();
  const mirrorSha = remoteShaForRef(
    requireComboGit(
      deps,
      combo,
      ["ls-remote", "--heads", "no-mistakes", combo.branch],
      "git ls-remote no-mistakes branch",
    ).stdout,
    mirrorRef,
  );

  if (origin === mirrorSha) return false;

  const events = readEvents(runDir);
  const lastGatekeeperStatus = latestGateStatus(events);
  if (lastGatekeeperStatus?.state === "fix_inflight") {
    deps.out(`mirror sync: gatekeeper fix in flight, skipping push for ${combo.id}`);
    return false;
  }

  const pushArgs = ["push", "no-mistakes"];
  if (mirrorSha !== undefined) {
    pushArgs.push(`--force-with-lease=${mirrorRef}:${mirrorSha}`);
  }
  pushArgs.push(`${originRef}:${mirrorRef}`);
  requireComboGit(deps, combo, pushArgs, "git push no-mistakes mirror");
  return true;
}
// -/ 5/5
