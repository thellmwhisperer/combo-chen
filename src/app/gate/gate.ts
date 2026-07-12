/**
 * @overview Gatekeeper window and gate state services for persistent no-mistakes attach and gate status queries.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at ensureGatekeeperWindow  <- live no-mistakes attach window.
 *   2. Then latestGateStatus            <- gate state from journal events.
 *   3. Then propagateNoMistakesConfig   <- local config artifact copy.
 *   4. Gatekeeper attach helpers        <- window entry commands.
 *
 *   MAIN FLOW
 *   ---------
 *   ensureGatekeeperWindow -> startGatekeeperWindow -> persistent-window loop -> gatekeeper-attach script
 *
 *   PUBLIC API
 *   ----------
 *   GateDeps, GatekeeperWindowDeps, GatekeeperAttachOptions
 *   GATEKEEPER_WINDOW, NO_MISTAKES_CONFIG_FILE
 *   buildGatekeeperAttachCommand, startGatekeeperWindow
 *   ensureGatekeeperWindow, refreshGatekeeperWindow, remoteShaForRef
 *   latestGateStatus, latestPublishedGateSha, shaMatchesHead, propagateNoMistakesConfig
 *
 *   INTERNALS
 *   ---------
 *   GATEKEEPER_ATTACH_SCRIPT, PERSISTENT_GATEKEEPER_WINDOW_SCRIPT, AXILIB, GATEKEEPER_ATTACH_PROBE_SCRIPT
 *   buildPersistentGatekeeperWindowCommand, buildGatekeeperSingleAttachProbeCommand, runCommandInGatekeeperWindow
 *
 * @exports GateDeps, GatekeeperWindowDeps, GatekeeperAttachOptions, GATEKEEPER_WINDOW, NO_MISTAKES_CONFIG_FILE, buildGatekeeperAttachCommand, startGatekeeperWindow, ensureGatekeeperWindow, refreshGatekeeperWindow, remoteShaForRef, latestGateStatus, latestPublishedGateSha, shaMatchesHead, propagateNoMistakesConfig
 * @deps ../../core/events, ../../core/shell-quote, ../../core/state, ../../infra/config-snapshot, ../../infra/tmux, ../runtime/sessions, node:fs, node:path
 */
import { chmodSync, copyFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

import type { ComboEvent } from "../../core/events.js";
import { shellQuote } from "../../core/shell-quote.js";
import type { ComboRecord } from "../../core/state.js";
import {
  killWindowArgs,
  listWindowsArgs,
  newWindowArgs,
  nudgeWindowArgs,
  type TmuxResult,
} from "../../infra/tmux.js";
import { GATE_RUNNER_WINDOW, windowSet } from "../runtime/sessions.js";

// Inlined shell scripts for gatekeeper tmux window entry (replaces src/shell/templates).
const AXILIB = `no_mistakes_axi_field() {
  printf '%s\n' "$1" | sed -n "s/^[[:space:]]*$2:[[:space:]]*//p" | sed -n '1p' | sed 's/^"//; s/"$//; s/[[:space:]]*$//'
}
no_mistakes_axi_run_is_active() {
  case "$1" in
    active | in_progress | pending | running) return 0 ;;
    *) return 1 ;;
  esac
}
no_mistakes_axi_run_is_attachable() {
  case "$1" in
    active | in_progress | running) return 0 ;;
    *) return 1 ;;
  esac
}
no_mistakes_axi_head_matches() {
  if [ -z "$1" ] || [ -z "$2" ]; then return 1; fi
  case "$1" in "$2"*) return 0 ;; esac
  case "$2" in "$1"*) return 0 ;; esac
  return 1
}`;

const GATEKEEPER_ATTACH_SCRIPT = `${AXILIB}
cd __WORKTREE__ || exit 1
expected_branch=__EXPECTED_BRANCH__
expected_head=$(git rev-parse --short=7 HEAD 2>/dev/null || true)
gatekeeper_attach_mode=__ATTACH_MODE__
gatekeeper_done_file=__DONE_FILE__
attach_max_attempts=__MAX_ATTEMPTS__
attempt=0
while :; do
  no_mistakes_status=$(no-mistakes axi status 2>/dev/null || true)
  no_mistakes_run_id=$(no_mistakes_axi_field "$no_mistakes_status" id)
  no_mistakes_run_branch=$(no_mistakes_axi_field "$no_mistakes_status" branch)
  no_mistakes_run_head=$(no_mistakes_axi_field "$no_mistakes_status" head)
  no_mistakes_run_status=$(no_mistakes_axi_field "$no_mistakes_status" status)
  if [ -n "$no_mistakes_run_id" ] && [ "$no_mistakes_run_branch" = "$expected_branch" ] && no_mistakes_axi_head_matches "$no_mistakes_run_head" "$expected_head" && no_mistakes_axi_run_is_attachable "$no_mistakes_run_status"; then
    if [ "$gatekeeper_attach_mode" = "exec" ]; then
      exec no-mistakes attach --run "$no_mistakes_run_id"
    else
      no-mistakes attach --run "$no_mistakes_run_id"
    fi
  fi
  if [ -n "$gatekeeper_done_file" ] && [ -f "$gatekeeper_done_file" ]; then
    echo "gatekeeper-attach: gate script finished before attach became available" >&2
    exit 2
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -gt "$attach_max_attempts" ]; then
    echo "gatekeeper-attach: timed out after __TIMEOUT_SECONDS__ seconds" >&2
    exit 1
  fi
  echo "gatekeeper-attach: waiting for gatekeeper on $expected_branch@$expected_head (attempt $attempt/$attach_max_attempts)..." >&2
  sleep __RETRY_INTERVAL_SECONDS__
done`;

const PERSISTENT_GATEKEEPER_WINDOW_SCRIPT = `combo_chen_idle=1
trap 'combo_chen_idle=0' INT
while [ "$combo_chen_idle" = 1 ]; do
(
__ATTACH_COMMAND__
)
combo_chen_gatekeeper_window_code=$?
printf "\\n[combo-chen] gatekeeper exited with code %s\\n" "$combo_chen_gatekeeper_window_code"
printf "[combo-chen] gatekeeper idle; waiting for the next current-head run.\\n"
if [ "\${COMBO_CHEN_GATEKEEPER_WINDOW_HOLD:-1}" = "0" ]; then
  exit "$combo_chen_gatekeeper_window_code"
fi
sleep 1
done
exec "\${SHELL:-/bin/sh}"`;

function substituteTemplate(template: string, values: Record<string, string>): string {
  let rendered = template;
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.split(key).join(value);
  }
  const unresolved = rendered.match(/__[A-Z0-9_]+__/);
  if (unresolved !== null) {
    throw new Error(`shell template placeholder not rendered: ${unresolved[0]}`);
  }
  return rendered;
}

// -- 1/3 HELPER · Types and constants --
export interface GateDeps {
  out: (line: string) => void;
  git: (args: string[], cwd: string) => { status: number; stdout: string; stderr: string };
}

export interface GatekeeperWindowDeps {
  tmux: (args: string[]) => TmuxResult;
}

export interface GatekeeperAttachOptions {
  timeoutSeconds: number;
  retryIntervalSeconds: number;
  replaceProcess?: boolean;
  stopWhenFileExists?: string;
}

export const GATEKEEPER_WINDOW = "gatekeeper";
export const NO_MISTAKES_CONFIG_FILE = ".no-mistakes.yaml";
// -/ 1/3

// -- 2/3 CORE · Gatekeeper tmux window <- START HERE --
export function buildGatekeeperAttachCommand(combo: ComboRecord, options: GatekeeperAttachOptions): string {
  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0) {
    throw new Error("gatekeeper attach timeout must be > 0 seconds");
  }
  if (!Number.isFinite(options.retryIntervalSeconds) || options.retryIntervalSeconds <= 0) {
    throw new Error("gatekeeper attach retry interval must be > 0 seconds");
  }
  const maxAttempts = Math.ceil(options.timeoutSeconds / options.retryIntervalSeconds);
  return substituteTemplate(GATEKEEPER_ATTACH_SCRIPT, {
    __WORKTREE__: shellQuote(combo.worktree),
    __EXPECTED_BRANCH__: shellQuote(combo.branch),
    __ATTACH_MODE__: options.replaceProcess === false ? "wait" : "exec",
    __DONE_FILE__: shellQuote(options.stopWhenFileExists ?? ""),
    __MAX_ATTEMPTS__: String(maxAttempts),
    __TIMEOUT_SECONDS__: String(options.timeoutSeconds),
    __RETRY_INTERVAL_SECONDS__: String(options.retryIntervalSeconds),
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
// -/ 2/3

// -- 3/3 HELPER · Gate state, git, config, and command rendering --
export function remoteShaForRef(stdout: string, ref: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const [sha, candidate] = line.trim().split(/\s+/, 2);
    if (candidate === ref && sha !== undefined && sha !== "") return sha;
  }
  return undefined;
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

function buildPersistentGatekeeperWindowCommand(command: string): string {
  return substituteTemplate(PERSISTENT_GATEKEEPER_WINDOW_SCRIPT, {
    __ATTACH_COMMAND__: command,
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
// -/ 3/3
