/**
 * @overview Gatekeeper CLI helpers. ~1070 lines, 20 exports, persistent attach window, mirror sync, initial/post-address gates.
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
 *   PostAddressGateCheckResult
 *   GATEKEEPER_WINDOW, GATE_RUNNER_WINDOW, NO_MISTAKES_CONFIG_FILE
 *   buildGatekeeperAttachCommand, startGatekeeperWindow
 *   ensureGatekeeperWindow, refreshGatekeeperWindow, remoteShaForRef, latestGateStatus
 *   latestPublishedGateSha, shaMatchesHead, propagateNoMistakesConfig
 *   startInitialGateRetry, buildPostAddressGateScript, restartPostAddressGate, runPostAddressGateIfNeeded, syncNoMistakesMirror
 *
 *   INTERNALS
 *   ---------
 *   requireComboGit, worktreeHeadSha, latestCoderRecoveryHeadShaAfterGate,
 *   buildInitialGateRetryScript, gateStatusIdleScript, shellScript, renderGatekeeperCommand, buildPersistentGatekeeperWindowCommand, buildScriptWithGatekeeperAttachCommand
 *
 * @exports GateDeps, GatekeeperWindowDeps, PostAddressGateDeps, GatekeeperAttachOptions, PostAddressGateCheckResult, GATEKEEPER_WINDOW, GATE_RUNNER_WINDOW, NO_MISTAKES_CONFIG_FILE, buildGatekeeperAttachCommand, startGatekeeperWindow, ensureGatekeeperWindow, refreshGatekeeperWindow, remoteShaForRef, latestGateStatus, latestPublishedGateSha, shaMatchesHead, propagateNoMistakesConfig, scriptedMirrorGatekeeperCommandTemplate, startInitialGateRetry, buildPostAddressGateScript, restartPostAddressGate, runPostAddressGateIfNeeded, syncNoMistakesMirror
 * @deps node:{fs,path}, ../core/{combo,events,state}, ../infra/{config-snapshot,tmux}, ../roles/gatekeeper, ./github, ./sessions, ./work-plan
 */
import { chmodSync, copyFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildNoMistakesGatekeeperRunScript,
  buildNoMistakesMirrorPublishScript,
  checksPassedContextCanceledRecoveryScript,
  gateLeaseScriptLines,
  guardNoMistakesDaemonStart,
  shellQuote,
} from "../core/combo.js";
import { appendEvent, readEvents, type ComboEvent } from "../core/events.js";
import type { ComboRecord } from "../core/state.js";
import { loadRuntimeConfig } from "../infra/config-snapshot.js";
import { killWindowArgs, listWindowsArgs, newWindowArgs, nudgeWindowArgs, type TmuxResult } from "../infra/tmux.js";
import {
  buildGatekeeperInvocation,
  buildIssuePrIntent,
  buildNoMistakesPushIntent,
  buildWorkPlanPrIntent,
} from "../roles/gatekeeper.js";
import { fetchIssueDetails } from "./github.js";
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
  replaceProcess?: boolean;
  stopWhenFileExists?: string;
}

export type PostAddressGateCheckResult =
  | { status: "started"; headSha: string }
  | { status: "blocked"; reason: "coder_worktree_out_of_sync"; headSha: string; publishedSha: string }
  | { status: "idle"; reason: string; headSha?: string };

export const GATEKEEPER_WINDOW = "gatekeeper";
export const GATE_RUNNER_WINDOW = "gate-runner";
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
  // Resolve it through branch-aware axi status before attaching; bare attach is
  // repo-global in no-mistakes and can follow a sibling combo run.
  const maxAttempts = Math.ceil(options.timeoutSeconds / options.retryIntervalSeconds);
  const attachLine = options.replaceProcess === false
    ? "    no-mistakes attach --run \"$no_mistakes_run_id\""
    : "    exec no-mistakes attach --run \"$no_mistakes_run_id\"";
  const doneFileLines = options.stopWhenFileExists === undefined
    ? []
    : [`gatekeeper_done_file=${shellQuote(options.stopWhenFileExists)}`];
  const doneCheckLines = options.stopWhenFileExists === undefined
    ? []
    : [
      '  if [ -n "$gatekeeper_done_file" ] && [ -f "$gatekeeper_done_file" ]; then',
      '    echo "gatekeeper-attach: gate script finished before attach became available" >&2',
      "    exit 2",
      "  fi",
    ];
  return [
    `cd ${shellQuote(combo.worktree)}`,
    `expected_branch=${shellQuote(combo.branch)}`,
    "expected_head=$(git rev-parse --short=7 HEAD 2>/dev/null || true)",
    ...doneFileLines,
    "attempt=0",
    "while :; do",
    "  no_mistakes_status=$(no-mistakes axi status 2>/dev/null || true)",
    "  no_mistakes_run_id=$(printf '%s\\n' \"$no_mistakes_status\" | sed -n 's/^[[:space:]]*id:[[:space:]]*//p' | sed -n '1p')",
    "  no_mistakes_run_id=$(printf '%s' \"$no_mistakes_run_id\" | sed 's/^\"//; s/\"$//')",
    "  if [ -n \"$no_mistakes_run_id\" ] && [ -n \"$expected_head\" ] && printf '%s\\n' \"$no_mistakes_status\" | grep -F \"branch: $expected_branch\" >/dev/null && printf '%s\\n' \"$no_mistakes_status\" | grep -F \"head: $expected_head\" >/dev/null && printf '%s\\n' \"$no_mistakes_status\" | grep -Eq '^[[:space:]]*status:[[:space:]]*(active|in_progress|running)[[:space:]]*$'; then",
    attachLine,
    "  fi",
    ...doneCheckLines,
    "  attempt=$((attempt + 1))",
    `  if [ "$attempt" -gt ${maxAttempts} ]; then`,
    `    echo "gatekeeper-attach: timed out after ${options.timeoutSeconds} seconds" >&2`,
    "    exit 1",
    "  fi",
    `  echo "gatekeeper-attach: waiting for gatekeeper on $expected_branch@$expected_head (attempt $attempt/${maxAttempts})..." >&2`,
    `  sleep ${options.retryIntervalSeconds}`,
    "done",
  ].join("\n");
}

function buildGatekeeperSingleAttachProbeCommand(
  combo: ComboRecord,
  options: { replaceProcess?: boolean } = {},
): string {
  const attachLine = options.replaceProcess === false
    ? "  no-mistakes attach --run \"$no_mistakes_run_id\""
    : "  exec no-mistakes attach --run \"$no_mistakes_run_id\"";
  return [
    `cd ${shellQuote(combo.worktree)}`,
    `expected_branch=${shellQuote(combo.branch)}`,
    "expected_head=$(git rev-parse --short=7 HEAD 2>/dev/null || true)",
    "no_mistakes_status=$(no-mistakes axi status 2>/dev/null || true)",
    "no_mistakes_run_id=$(printf '%s\\n' \"$no_mistakes_status\" | sed -n 's/^[[:space:]]*id:[[:space:]]*//p' | sed -n '1p')",
    "no_mistakes_run_id=$(printf '%s' \"$no_mistakes_run_id\" | sed 's/^\"//; s/\"$//')",
    "if [ -n \"$no_mistakes_run_id\" ] && [ -n \"$expected_head\" ] && printf '%s\\n' \"$no_mistakes_status\" | grep -F \"branch: $expected_branch\" >/dev/null && printf '%s\\n' \"$no_mistakes_status\" | grep -F \"head: $expected_head\" >/dev/null && printf '%s\\n' \"$no_mistakes_status\" | grep -Eq '^[[:space:]]*status:[[:space:]]*(active|in_progress|running)[[:space:]]*$'; then",
    attachLine,
    "fi",
  ].join("\n");
}

export function startGatekeeperWindow(
  deps: GatekeeperWindowDeps,
  combo: ComboRecord,
  options: GatekeeperAttachOptions,
): void {
  const created = deps.tmux(
    newWindowArgs(
      combo.tmuxSession,
      GATEKEEPER_WINDOW,
      buildPersistentGatekeeperWindowCommand(buildGatekeeperAttachCommand(combo, options)),
    ),
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

export function refreshGatekeeperWindow(
  deps: GatekeeperWindowDeps,
  combo: ComboRecord,
  options: GatekeeperAttachOptions,
): void {
  runCommandInGatekeeperWindow(
    deps,
    combo,
    buildPersistentGatekeeperWindowCommand(buildGatekeeperAttachCommand(combo, options)),
  );
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

export function shaMatchesHead(candidate: string | undefined, headSha: string | undefined): boolean {
  if (candidate === undefined || headSha === undefined) return false;
  const pin = candidate.trim().toLowerCase();
  const head = headSha.trim().toLowerCase();
  return pin.length >= 7 && (pin === head || head.startsWith(pin));
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

function latestCoderRecoveryHeadShaAfterGate(events: ComboEvent[], gateSha: string): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.event === "review_comment") {
      return typeof event["head_sha"] === "string" && event["head_sha"] !== ""
        ? event["head_sha"]
        : undefined;
    }
    if (
      event.event === "pr_conflict" &&
      event["action"] === "rebase_required" &&
      typeof event["sha"] === "string" &&
      event["sha"] !== ""
    ) {
      return event["sha"];
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

function worktreeContainsSha(deps: GateDeps, combo: ComboRecord, ancestorSha: string, headSha: string): boolean {
  if (ancestorSha === headSha) return true;
  const result = deps.git(["merge-base", "--is-ancestor", ancestorSha, headSha], combo.worktree);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(
    `git merge-base --is-ancestor failed for ${combo.id}: ${result.stderr.trim() || `exit code ${result.status}`}`,
  );
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

function buildPersistentGatekeeperWindowCommand(command: string): string {
  return shellScript(
    "combo_chen_idle=1",
    "trap 'combo_chen_idle=0' INT",
    'while [ "$combo_chen_idle" = 1 ]; do',
    "(",
    indentShellLines(command.split(/\r?\n/), 2),
    ")",
    "combo_chen_gatekeeper_window_code=$?",
    'printf "\\n[combo-chen] gatekeeper exited with code %s\\n" "$combo_chen_gatekeeper_window_code"',
    'printf "[combo-chen] gatekeeper idle; waiting for the next current-head run.\\n"',
    'if [ "${COMBO_CHEN_GATEKEEPER_WINDOW_HOLD:-1}" = "0" ]; then',
    '  exit "$combo_chen_gatekeeper_window_code"',
    "fi",
    "sleep 1",
    "done",
    'exec "${SHELL:-/bin/sh}"',
  );
}

function buildScriptWithGatekeeperAttachCommand(
  combo: ComboRecord,
  scriptPath: string,
  options: GatekeeperAttachOptions,
): string {
  const scriptWindowLog = `${scriptPath}.window.log`;
  const scriptDoneFile = `${scriptWindowLog}.done`;
  const idleAttach = buildGatekeeperAttachCommand(combo, {
    ...options,
    replaceProcess: false,
  });
  const finalAttachProbe = buildGatekeeperSingleAttachProbeCommand(combo, {
    replaceProcess: false,
  });
  return shellScript(
    `combo_chen_gate_script_window_log=${shellQuote(scriptWindowLog)}`,
    `combo_chen_gate_script_done=${shellQuote(scriptDoneFile)}`,
    `rm -f "$combo_chen_gate_script_done"`,
    "(",
    `  sh ${shellQuote(scriptPath)} > "$combo_chen_gate_script_window_log" 2>&1`,
    "  combo_chen_gate_script_inner_code=$?",
    `  printf '%s\\n' "$combo_chen_gate_script_inner_code" > "$combo_chen_gate_script_done"`,
    `  exit "$combo_chen_gate_script_inner_code"`,
    ") &",
    "combo_chen_gate_script_pid=$!",
    "combo_chen_gate_attach_code=0",
    "(",
    indentShellLines(
      buildGatekeeperAttachCommand(combo, {
        ...options,
        replaceProcess: false,
        stopWhenFileExists: scriptDoneFile,
      }).split(/\r?\n/),
      2,
    ),
    ") || combo_chen_gate_attach_code=$?",
    'if [ "$combo_chen_gate_attach_code" -ne 0 ]; then',
    '  printf "[combo-chen] gatekeeper attach exited with code %s; showing gate script log.\\n" "$combo_chen_gate_attach_code" >&2',
    '  tail -80 "$combo_chen_gate_script_window_log" >&2 2>/dev/null || true',
    "fi",
    "combo_chen_gate_script_code=0",
    'wait "$combo_chen_gate_script_pid" || combo_chen_gate_script_code=$?',
    'if [ -f "$combo_chen_gate_script_done" ]; then',
    '  combo_chen_gate_script_code=$(cat "$combo_chen_gate_script_done" 2>/dev/null || printf "%s" "$combo_chen_gate_script_code")',
    "fi",
    'printf "\\n[combo-chen] gate script exited with code %s\\n" "$combo_chen_gate_script_code"',
    'printf "[combo-chen] gatekeeper final attach probe for current run.\\n"',
    "combo_chen_gate_attach_code=0",
    "(",
    indentShellLines(finalAttachProbe.split(/\r?\n/), 2),
    ") || combo_chen_gate_attach_code=$?",
    'if [ "$combo_chen_gate_attach_code" -ne 0 ]; then',
    '  printf "[combo-chen] gatekeeper final attach exited with code %s\\n" "$combo_chen_gate_attach_code" >&2',
    "fi",
    'printf "[combo-chen] gatekeeper idle; waiting for the next current-head run.\\n"',
    'if [ "${COMBO_CHEN_GATEKEEPER_WINDOW_HOLD:-1}" = "0" ]; then',
    '  exit "$combo_chen_gate_script_code"',
    "fi",
    "combo_chen_idle=1",
    "trap 'combo_chen_idle=0' INT",
    'while [ "$combo_chen_idle" = 1 ]; do',
    "  combo_chen_gate_attach_code=0",
    "  (",
    indentShellLines(idleAttach.split(/\r?\n/), 4),
    "  ) || combo_chen_gate_attach_code=$?",
    '  printf "\\n[combo-chen] gatekeeper attach exited with code %s\\n" "$combo_chen_gate_attach_code"',
    '  printf "[combo-chen] gatekeeper idle; waiting for the next current-head run.\\n"',
    "  sleep 1",
    "done",
    'exec "${SHELL:-/bin/sh}"',
  );
}

function runCommandInGatekeeperWindow(
  deps: GatekeeperWindowDeps,
  combo: ComboRecord,
  command: string,
): void {
  const listed = deps.tmux(listWindowsArgs(combo.tmuxSession));
  if (listed.status !== 0) {
    throw new Error(
      `tmux failed to list windows in "${combo.tmuxSession}": ` +
        `${listed.stderr.trim() || "unknown error"}`,
    );
  }
  const windows = new Set(listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  if (windows.has(GATE_RUNNER_WINDOW)) {
    const killed = deps.tmux(killWindowArgs(combo.tmuxSession, GATE_RUNNER_WINDOW));
    if (killed.status !== 0) {
      throw new Error(
        `tmux failed to remove legacy "${GATE_RUNNER_WINDOW}" in "${combo.tmuxSession}": ` +
          `${killed.stderr.trim() || "unknown error"}`,
      );
    }
  }
  if (!windows.has(GATEKEEPER_WINDOW)) {
    const created = deps.tmux(newWindowArgs(combo.tmuxSession, GATEKEEPER_WINDOW, command));
    if (created.status !== 0) {
      throw new Error(
        `tmux failed to start gatekeeper watcher in "${combo.tmuxSession}": ` +
          `${created.stderr.trim() || "unknown error"}`,
      );
    }
    return;
  }

  const target = `${combo.tmuxSession}:${GATEKEEPER_WINDOW}`;
  const interrupted = deps.tmux(["send-keys", "-t", target, "C-c"]);
  if (interrupted.status !== 0) {
    throw new Error(
      `tmux failed to interrupt gatekeeper in "${combo.tmuxSession}": ` +
        `${interrupted.stderr.trim() || "unknown error"}`,
    );
  }
  for (const args of nudgeWindowArgs(combo.tmuxSession, GATEKEEPER_WINDOW, command)) {
    const sent = deps.tmux(args);
    if (sent.status !== 0) {
      throw new Error(
        `tmux failed to prompt gatekeeper in "${combo.tmuxSession}": ` +
          `${sent.stderr.trim() || "unknown error"}`,
      );
    }
  }
}

function gateFailureReasonScript(): string[] {
  return [
    "gatekeeper_failure_reason=gate_failed",
    "if grep -Eiq 'daemon.*(dead|died|exited|not running)|connection refused|ECONNREFUSED' \"$gatekeeper_log\"; then",
    "  gatekeeper_failure_reason=daemon_dead",
    "fi",
  ];
}

function gateStatusIdleScript(emit: string, headShaField?: string): string[] {
  const headField = headShaField === undefined ? "" : ` ${headShaField}`;
  return [
    'if [ -n "$gatekeeper_recovery_reason" ]; then',
    `  ${emit} gate_status --field state=idle${headField} --field recovery="$gatekeeper_recovery_reason"`,
    "else",
    `  ${emit} gate_status --field state=idle${headField}`,
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
    "    gatekeeper_run_id=$(sed -n 's/^[[:space:]]*id:[[:space:]]*//p' \"$status_probe_log\" | sed -n '1p')",
    "    if [ -z \"$gatekeeper_run_id\" ]; then",
    "      cat \"$status_probe_log\" >> \"$gatekeeper_log\" 2>/dev/null || true",
    "      exit \"$gatekeeper_code\"",
    "    fi",
    "    gatekeeper_head_sha=$(git rev-parse HEAD 2>/dev/null || true)",
    `    ${input.emit} gate_status --field state=fix_inflight --field head_sha="$gatekeeper_head_sha"`,
    "    gate_lease_release || true",
    "    exec no-mistakes attach --run \"$gatekeeper_run_id\"",
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
  activateReviewer: string;
  ensurePrAutoclose?: string;
  gateLeaseAcquire?: string;
  gateLeaseRelease?: string;
}): string {
  const shortSha = input.headSha.slice(0, 12);
  const gatekeeperLog = join(input.runDir, `gatekeeper-initial-${shortSha}.log`);
  const statusFile = join(input.runDir, `gatekeeper-initial-${shortSha}.status`);
  const autocloseLog = join(input.runDir, `autoclose-initial-${shortSha}.log`);
  return shellScript(
    "#!/bin/sh",
    "set -u",
    `printf '%s\\n' ${shellQuote(`initial gate retry for ${input.combo.id} at ${input.headSha}`)}`,
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
    indentShellLines(
      buildNoMistakesGatekeeperRunScript(input.gatekeeperCommand, {
        expectedBranch: input.combo.branch,
      }),
      4,
    ),
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
    checksPassedContextCanceledRecoveryScript(),
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
    indentShellLines(gateStatusIdleScript(input.emit, '--field head_sha="$gatekeeper_head_sha"'), 2),
    `  ${input.emit} pr_opened --field url="$pr_url"`,
    `  ${input.activateReviewer}`,
    "else",
    indentShellLines(gateStatusIdleScript(input.emit, '--field head_sha="$gatekeeper_head_sha"'), 2),
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
      emit: `${cli} emit -n ${shellQuote(combo.id)} --skip-gate-window-recovery`,
      activateReviewer: `${cli} activate-reviewer -n ${shellQuote(combo.id)}`,
      gateLeaseAcquire: `${cli} gate-lease acquire -n ${shellQuote(combo.id)}`,
      gateLeaseRelease: `${cli} gate-lease release -n ${shellQuote(combo.id)}`,
      ...(isGitHubIssueWorkItem(combo)
        ? { ensurePrAutoclose: `${cli} ensure-pr-autoclose -n ${shellQuote(combo.id)} --pr-url` }
        : {}),
    })}\n`,
  );
  chmodSync(scriptPath, 0o755);

  runCommandInGatekeeperWindow(
    deps,
    combo,
    buildScriptWithGatekeeperAttachCommand(combo, scriptPath, {
      timeoutSeconds: config.gatekeeperAttachTimeoutSeconds,
      retryIntervalSeconds: config.gatekeeperAttachRetryIntervalSeconds,
    }),
  );
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
    indentShellLines(
      buildNoMistakesGatekeeperRunScript(input.gatekeeperCommand, {
        expectedBranch: input.combo.branch,
      }),
      4,
    ),
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
    checksPassedContextCanceledRecoveryScript(),
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
    indentShellLines(gateStatusIdleScript(input.emit, '--field head_sha="$gatekeeper_head_sha"'), 2),
    `  ${input.emit} gate_validated --field sha="$gatekeeper_head_sha"`,
    "else",
    indentShellLines(gateStatusIdleScript(input.emit), 2),
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
  attachOptions: GatekeeperAttachOptions;
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
      emit: `${input.cli} emit -n ${shellQuote(input.combo.id)} --skip-gate-window-recovery`,
      gateLeaseAcquire: `${input.cli} gate-lease acquire -n ${shellQuote(input.combo.id)}`,
      gateLeaseRelease: `${input.cli} gate-lease release -n ${shellQuote(input.combo.id)}`,
      ...(isGitHubIssueWorkItem(input.combo)
        ? { ensurePrAutoclose: `${input.cli} ensure-pr-autoclose -n ${shellQuote(input.combo.id)} --pr-url` }
        : {}),
    })}\n`,
  );
  chmodSync(scriptPath, 0o755);

  const command = buildScriptWithGatekeeperAttachCommand(input.combo, scriptPath, input.attachOptions);

  runCommandInGatekeeperWindow(input.deps, input.combo, command);
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

  const lastPublishedSha = latestPublishedGateSha(events);
  if (
    lastPublishedSha !== undefined &&
    lastPublishedSha !== headSha &&
    !worktreeContainsSha(deps, combo, lastPublishedSha, headSha)
  ) {
    deps.out(
      `gate-restart: refusing post-address gate for ${combo.id}; worktree HEAD ${headSha} ` +
        `does not include published gate ${lastPublishedSha}`,
    );
    return { started: false, headSha, reason: "coder_worktree_out_of_sync" };
  }

  if (!hasAddressDone(events, headSha)) {
    appendEvent(runDir, "address_done", { head_sha: headSha });
  }
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
    attachOptions: {
      timeoutSeconds: config.gatekeeperAttachTimeoutSeconds,
      retryIntervalSeconds: config.gatekeeperAttachRetryIntervalSeconds,
    },
  });
  return { started: true, headSha };
}

export function runPostAddressGateIfNeeded(input: {
  deps: PostAddressGateDeps;
  combo: ComboRecord;
  runDir: string;
  prUrl: string;
  cli: string;
}): PostAddressGateCheckResult {
  const { deps, combo, runDir, prUrl, cli } = input;
  const events = readEvents(runDir);
  const lastStatus = latestGateStatus(events);
  const lastPublishedSha = latestPublishedGateSha(events);
  if (lastStatus === undefined && lastPublishedSha === undefined) return { status: "idle", reason: "no_gate" };

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
    return { status: "idle", reason: "gate_in_flight", headSha };
  }

  if (lastPublishedSha === undefined || lastPublishedSha === headSha) {
    return { status: "idle", reason: "published_head_current", headSha };
  }

  if (lastStatus?.state === "failed" && lastStatus.headSha === headSha) {
    deps.out(`director: post-address gate already failed for ${combo.id} at ${headSha}`);
    return { status: "idle", reason: "gate_failed_at_head", headSha };
  }

  const recoveryHeadSha = latestCoderRecoveryHeadShaAfterGate(events, lastPublishedSha);
  if (recoveryHeadSha === undefined || recoveryHeadSha === headSha) {
    deps.out(`director: no coder HEAD change for ${combo.id}; waiting for coder to commit`);
    return { status: "idle", reason: "no_coder_head_change", headSha };
  }

  if (!worktreeContainsSha(deps, combo, lastPublishedSha, headSha)) {
    deps.out(
      `director: worktree HEAD ${headSha} does not include published gate ${lastPublishedSha}; ` +
        "waiting for coder sync before post-address gate",
    );
    return { status: "blocked", reason: "coder_worktree_out_of_sync", headSha, publishedSha: lastPublishedSha };
  }

  if (propagateNoMistakesConfig(combo.repoDir, combo.worktree)) {
    deps.out(`no-mistakes: copied local config to ${combo.worktree}/${NO_MISTAKES_CONFIG_FILE}`);
  }

  if (hasUncommittedChanges(deps, combo)) {
    deps.out(`director: worktree has uncommitted changes for ${combo.id}; waiting for coder to commit`);
    return { status: "idle", reason: "uncommitted_changes", headSha };
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
    attachOptions: {
      timeoutSeconds: config.gatekeeperAttachTimeoutSeconds,
      retryIntervalSeconds: config.gatekeeperAttachRetryIntervalSeconds,
    },
  });
  deps.out(`director: post-address gate started for ${combo.id} at ${headSha}`);
  return { status: "started", headSha };
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
