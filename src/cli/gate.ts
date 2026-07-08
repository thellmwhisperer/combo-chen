/**
 * @overview Gatekeeper CLI helpers. ~1110 lines, 20 exports, persistent attach window, mirror sync, initial/post-address gates.
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
 *   GATEKEEPER_WINDOW, NO_MISTAKES_CONFIG_FILE
 *   buildGatekeeperAttachCommand, startGatekeeperWindow
 *   ensureGatekeeperWindow, refreshGatekeeperWindow, remoteShaForRef, latestGateStatus
 *   latestPublishedGateSha, shaMatchesHead, propagateNoMistakesConfig
 *   startInitialGateRetry, buildPostAddressGateScript, restartPostAddressGate, runPostAddressGateIfNeeded, syncNoMistakesMirror
 *
 *   INTERNALS
 *   ---------
 *   requireComboGit, worktreeHeadSha, latestLocalRecoveryHeadShaAfterGate,
 *   latestLocalGateReplacementHeadShaAfterGate, publishedGateSupersededByLocalRecovery,
 *   buildGateRunScript, buildInitialGateRetryScript, gateStatusIdleScript, renderGatekeeperCommand,
 *   buildPersistentGatekeeperWindowCommand, buildScriptWithGatekeeperAttachCommand
 *
 * @exports GateDeps, GatekeeperWindowDeps, PostAddressGateDeps, GatekeeperAttachOptions, PostAddressGateCheckResult, GATEKEEPER_WINDOW, NO_MISTAKES_CONFIG_FILE, buildGatekeeperAttachCommand, startGatekeeperWindow, ensureGatekeeperWindow, refreshGatekeeperWindow, remoteShaForRef, latestGateStatus, latestPublishedGateSha, shaMatchesHead, propagateNoMistakesConfig, scriptedMirrorGatekeeperCommandTemplate, startInitialGateRetry, buildPostAddressGateScript, restartPostAddressGate, runPostAddressGateIfNeeded, syncNoMistakesMirror
 * @deps node:{fs,path}, ../core/{combo,events,state}, ../infra/{config-snapshot,tmux}, ../roles/gatekeeper, ../shell/templates, ./github, ./sessions, ./work-plan
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
import { renderShellTemplate } from "../shell/templates.js";
import { appendEvent, readEvents, type ComboEvent } from "../core/events.js";
import type { ComboRecord } from "../core/state.js";
import { loadRuntimeConfig } from "../infra/config-snapshot.js";
import {
  killWindowArgs,
  listWindowsArgs,
  newWindowArgs,
  nudgeWindowArgs,
  type TmuxResult,
} from "../infra/tmux.js";
import {
  buildGatekeeperInvocation,
  buildIssuePrIntent,
  buildNoMistakesPushIntent,
  buildWorkPlanPrIntent,
} from "../roles/gatekeeper.js";
import { fetchIssueDetails } from "./github.js";
import { GATE_RUNNER_WINDOW, windowSet } from "./sessions.js";
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
export const NO_MISTAKES_CONFIG_FILE = ".no-mistakes.yaml";
// -/ 1/5

// -- 2/5 CORE · Gatekeeper tmux window <- START HERE --
export function buildGatekeeperAttachCommand(combo: ComboRecord, options: GatekeeperAttachOptions): string {
  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0) {
    throw new Error("gatekeeper attach timeout must be > 0 seconds");
  }
  if (!Number.isFinite(options.retryIntervalSeconds) || options.retryIntervalSeconds <= 0) {
    throw new Error("gatekeeper attach retry interval must be > 0 seconds");
  }
  const maxAttempts = Math.ceil(options.timeoutSeconds / options.retryIntervalSeconds);
  return renderShellTemplate("gatekeeper-attach", {
    __WORKTREE__: shellQuote(combo.worktree),
    __EXPECTED_BRANCH__: shellQuote(combo.branch),
    __ATTACH_MODE__: options.replaceProcess === false ? "wait" : "exec",
    __DONE_FILE__: shellQuote(options.stopWhenFileExists ?? ""),
    __MAX_ATTEMPTS__: String(maxAttempts),
    __TIMEOUT_SECONDS__: String(options.timeoutSeconds),
    __RETRY_INTERVAL_SECONDS__: String(options.retryIntervalSeconds),
  }).trimEnd();
}

function buildGatekeeperSingleAttachProbeCommand(
  combo: ComboRecord,
  options: { replaceProcess?: boolean } = {},
): string {
  return renderShellTemplate("gatekeeper-attach-probe", {
    __WORKTREE__: shellQuote(combo.worktree),
    __EXPECTED_BRANCH__: shellQuote(combo.branch),
    __ATTACH_MODE__: options.replaceProcess === false ? "wait" : "exec",
  }).trimEnd();
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
    throw new Error(`${description} failed for ${combo.id}: ${result.stderr.trim() || "unknown error"}`);
  }
  return { stdout: result.stdout };
}
interface LatestGateStatus {
  state: string;
  headSha?: string;
}

type LocalRecoveryAfterGate =
  | { kind: "gate_stale"; headSha: string }
  | { kind: "address_done"; headSha: string }
  | { kind: "review_comment"; headSha: string }
  | { kind: "pr_conflict"; headSha: string };

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
    if (event.event === "gate_status" && event["state"] === "idle" && typeof event["head_sha"] === "string") {
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

function latestLocalRecoveryAfterGate(
  events: ComboEvent[],
  gateSha: string,
): LocalRecoveryAfterGate | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (
      event.event === "gate_stale" &&
      event["old_sha"] === gateSha &&
      typeof event["new_sha"] === "string" &&
      event["new_sha"] !== ""
    ) {
      return { kind: "gate_stale", headSha: event["new_sha"] };
    }
    if (event.event === "address_done" && typeof event["head_sha"] === "string" && event["head_sha"] !== "") {
      return { kind: "address_done", headSha: event["head_sha"] };
    }
    if (event.event === "review_comment") {
      return typeof event["head_sha"] === "string" && event["head_sha"] !== ""
        ? { kind: "review_comment", headSha: event["head_sha"] }
        : undefined;
    }
    if (
      event.event === "pr_conflict" &&
      event["action"] === "rebase_required" &&
      typeof event["sha"] === "string" &&
      event["sha"] !== ""
    ) {
      return { kind: "pr_conflict", headSha: event["sha"] };
    }
    if (event.event === "gate_validated" && event["sha"] === gateSha) return undefined;
    if (event.event === "gate_status" && event["state"] === "idle" && event["head_sha"] === gateSha) {
      return undefined;
    }
  }
  return undefined;
}

function latestLocalGateReplacementHeadShaAfterGate(
  events: ComboEvent[],
  gateSha: string,
): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (
      event.event === "gate_stale" &&
      event["old_sha"] === gateSha &&
      typeof event["new_sha"] === "string" &&
      event["new_sha"] !== ""
    ) {
      return event["new_sha"];
    }
    if (event.event === "gate_validated" && event["sha"] === gateSha) return undefined;
    if (event.event === "gate_status" && event["state"] === "idle" && event["head_sha"] === gateSha) {
      return undefined;
    }
  }
  return undefined;
}

function publishedGateSupersededByLocalRecovery(events: ComboEvent[], publishedSha: string): boolean {
  const recoveryHeadSha = latestLocalGateReplacementHeadShaAfterGate(events, publishedSha);
  return recoveryHeadSha !== undefined;
}

function hasGateStale(events: ComboEvent[], oldSha: string, newSha: string): boolean {
  return events.some(
    (event) => event.event === "gate_stale" && event["old_sha"] === oldSha && event["new_sha"] === newSha,
  );
}

function worktreeHeadSha(deps: GateDeps, combo: ComboRecord): string {
  return requireComboGit(deps, combo, ["rev-parse", "HEAD"], "git rev-parse HEAD").stdout.trim();
}

function worktreeContainsSha(
  deps: GateDeps,
  combo: ComboRecord,
  ancestorSha: string,
  headSha: string,
): boolean {
  if (ancestorSha === headSha) return true;
  const result = deps.git(["merge-base", "--is-ancestor", ancestorSha, headSha], combo.worktree);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(
    `git merge-base --is-ancestor failed for ${combo.id}: ${result.stderr.trim() || `exit code ${result.status}`}`,
  );
}

function hasUncommittedChanges(deps: GateDeps, combo: ComboRecord): boolean {
  return (
    requireComboGit(deps, combo, ["status", "--porcelain"], "git status --porcelain").stdout.trim() !== ""
  );
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
    if (!(error instanceof Error) || !error.message.includes("placeholders require work item facts")) {
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

function buildPersistentGatekeeperWindowCommand(command: string): string {
  return renderShellTemplate("persistent-gatekeeper-window", {
    __ATTACH_COMMAND__: command,
  }).trimEnd();
}

function buildScriptWithGatekeeperAttachCommand(
  combo: ComboRecord,
  scriptPath: string,
  options: GatekeeperAttachOptions,
): string {
  const scriptWindowLog = `${scriptPath}.window.log`;
  const scriptDoneFile = `${scriptWindowLog}.done`;
  return renderShellTemplate("gate-script-window", {
    __WINDOW_LOG__: shellQuote(scriptWindowLog),
    __DONE_FILE__: shellQuote(scriptDoneFile),
    __SCRIPT_PATH__: shellQuote(scriptPath),
    __ATTACH_WITH_DONE__: buildGatekeeperAttachCommand(combo, {
      ...options,
      replaceProcess: false,
      stopWhenFileExists: scriptDoneFile,
    }),
    __FINAL_ATTACH_PROBE__: buildGatekeeperSingleAttachProbeCommand(combo, { replaceProcess: false }),
    __IDLE_ATTACH__: buildGatekeeperAttachCommand(combo, { ...options, replaceProcess: false }),
  }).trimEnd();
}

function runCommandInGatekeeperWindow(deps: GatekeeperWindowDeps, combo: ComboRecord, command: string): void {
  const listed = deps.tmux(listWindowsArgs(combo.tmuxSession));
  if (listed.status !== 0) {
    throw new Error(
      `tmux failed to list windows in "${combo.tmuxSession}": ` +
        `${listed.stderr.trim() || "unknown error"}`,
    );
  }
  const windows = windowSet(listed.stdout);
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

function gateFailureReasonScript(): string {
  return renderShellTemplate("gate-failure-reason").trimEnd();
}

function gateStatusIdleScript(emit: string, options: { withHeadSha: boolean }): string {
  return renderShellTemplate("gate-status-idle", {
    __EMIT__: emit,
    __HEAD_FIELD__: options.withHeadSha ? ' --field head_sha="$gatekeeper_head_sha"' : "",
  }).trimEnd();
}

function gateAlreadyRunningGuardScript(input: { combo: ComboRecord; headSha: string; emit: string }): string {
  return renderShellTemplate("gate-already-running-guard", {
    __EXPECTED_BRANCH__: shellQuote(input.combo.branch),
    __EXPECTED_HEAD__: shellQuote(input.headSha.slice(0, 7)),
    __EMIT__: input.emit,
  }).trimEnd();
}

// -/ 3/5

// -- 4/5 CORE · Initial and post-address gate scripts --
interface GateRunScriptInput {
  combo: ComboRecord;
  runDir: string;
  gatekeeperCommand: string;
  gatekeeperMirrorIntent: string;
  headSha: string;
  emit: string;
  ensurePrAutoclose?: string;
  gateLeaseAcquire?: string;
  gateLeaseRelease?: string;
}

function buildGateRunScript(input: GateRunScriptInput & { kind: "initial" | "post"; tail: string }): string {
  const shortSha = input.headSha.slice(0, 12);
  const banner =
    input.kind === "initial"
      ? `initial gate retry for ${input.combo.id} at ${input.headSha}`
      : `post-address gate for ${input.combo.id} at ${input.headSha}`;
  return renderShellTemplate("gate-run", {
    __BANNER__: shellQuote(banner),
    __GATEKEEPER_LOG__: shellQuote(join(input.runDir, `gatekeeper-${input.kind}-${shortSha}.log`)),
    __STATUS_FILE__: shellQuote(join(input.runDir, `gatekeeper-${input.kind}-${shortSha}.status`)),
    __AUTOCLOSE_LOG__: shellQuote(join(input.runDir, `autoclose-${input.kind}-${shortSha}.log`)),
    __WORKTREE__: shellQuote(input.combo.worktree),
    __EMIT__: input.emit,
    __GATE_LEASE_SCRIPT__: gateLeaseScriptLines({
      acquire: input.gateLeaseAcquire,
      release: input.gateLeaseRelease,
    }).join("\n"),
    __MIRROR_PUBLISH__: buildNoMistakesMirrorPublishScript(input.combo, input.gatekeeperMirrorIntent).join(
      "\n",
    ),
    __GATEKEEPER_RUN__: buildNoMistakesGatekeeperRunScript(input.gatekeeperCommand, {
      expectedBranch: input.combo.branch,
    }).join("\n"),
    __ALREADY_RUNNING_GUARD__: gateAlreadyRunningGuardScript(input),
    __RECOVERY_SCRIPT__: checksPassedContextCanceledRecoveryScript().join("\n"),
    __FAILURE_REASON__: gateFailureReasonScript(),
    __BRANCH__: shellQuote(input.combo.branch),
    __TAIL__: input.tail.trimEnd(),
  });
}

function buildInitialGateRetryScript(input: GateRunScriptInput & { activateReviewer: string }): string {
  return buildGateRunScript({
    ...input,
    kind: "initial",
    tail: renderShellTemplate("gate-run-tail-initial", {
      __ENSURE_PR_AUTOCLOSE__: input.ensurePrAutoclose ?? ":",
      __EMIT__: input.emit,
      __STATUS_IDLE_HEAD__: gateStatusIdleScript(input.emit, { withHeadSha: true }),
      __ACTIVATE_REVIEWER__: input.activateReviewer,
    }),
  });
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
  const renderedGatekeeper = renderScriptedMirrorGatekeeperCommand(
    deps,
    combo,
    runDir,
    config.gatekeeperCommand,
  );
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

export function buildPostAddressGateScript(input: GateRunScriptInput & { prUrl: string }): string {
  return buildGateRunScript({
    ...input,
    kind: "post",
    tail: renderShellTemplate("gate-run-tail-post", {
      __PR_URL__: shellQuote(input.prUrl),
      __ENSURE_PR_AUTOCLOSE__: input.ensurePrAutoclose ?? ":",
      __EMIT__: input.emit,
      __STATUS_IDLE_HEAD__: gateStatusIdleScript(input.emit, { withHeadSha: true }),
      __STATUS_IDLE_NO_HEAD__: gateStatusIdleScript(input.emit, { withHeadSha: false }),
    }),
  });
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
    deps.out(
      `gate: worktree has uncommitted changes for ${combo.id}; waiting for commit before gate restart`,
    );
    return { started: false, headSha, reason: "uncommitted_changes" };
  }

  const lastPublishedSha = latestPublishedGateSha(events);
  const publishedGateIsSuperseded =
    lastPublishedSha !== undefined && publishedGateSupersededByLocalRecovery(events, lastPublishedSha);
  if (
    lastPublishedSha !== undefined &&
    lastPublishedSha !== headSha &&
    !publishedGateIsSuperseded &&
    !worktreeContainsSha(deps, combo, lastPublishedSha, headSha)
  ) {
    deps.out(
      `gate-restart: refusing post-address gate for ${combo.id}; worktree HEAD ${headSha} ` +
        `does not include published gate ${lastPublishedSha}`,
    );
    return { started: false, headSha, reason: "coder_worktree_out_of_sync" };
  }
  if (publishedGateIsSuperseded && lastPublishedSha !== undefined) {
    deps.out(
      `gate-restart: published gate ${lastPublishedSha} was superseded by local recovery; ` +
        `restarting post-address gate from ${headSha}`,
    );
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
  const renderedGatekeeper = renderScriptedMirrorGatekeeperCommand(
    deps,
    combo,
    runDir,
    config.gatekeeperCommand,
  );
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
  if (lastStatus === undefined && lastPublishedSha === undefined)
    return { status: "idle", reason: "no_gate" };

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

  const recovery = latestLocalRecoveryAfterGate(events, lastPublishedSha);
  const recoveryHasUsableHead =
    recovery !== undefined &&
    (recovery.kind === "gate_stale" || recovery.kind === "address_done"
      ? recovery.headSha === headSha
      : recovery.headSha !== headSha);
  if (!recoveryHasUsableHead) {
    deps.out(`director: no coder HEAD change for ${combo.id}; waiting for coder to commit`);
    return { status: "idle", reason: "no_coder_head_change", headSha };
  }

  const publishedGateIsSuperseded = publishedGateSupersededByLocalRecovery(events, lastPublishedSha);
  if (!publishedGateIsSuperseded && !worktreeContainsSha(deps, combo, lastPublishedSha, headSha)) {
    deps.out(
      `director: worktree HEAD ${headSha} does not include published gate ${lastPublishedSha}; ` +
        "waiting for coder sync before post-address gate",
    );
    return {
      status: "blocked",
      reason: "coder_worktree_out_of_sync",
      headSha,
      publishedSha: lastPublishedSha,
    };
  }
  if (publishedGateIsSuperseded) {
    deps.out(
      `director: published gate ${lastPublishedSha} was superseded by local recovery; ` +
        `starting post-address gate from ${headSha}`,
    );
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
  const renderedGatekeeper = renderScriptedMirrorGatekeeperCommand(
    deps,
    combo,
    runDir,
    config.gatekeeperCommand,
  );
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
