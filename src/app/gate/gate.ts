/**
 * @overview Gatekeeper window, gate state services, and no-mistakes config propagation.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at ensureGatekeeperWindow  <- live no-mistakes window with static entry command.
 *   2. Then latestGateStatus            <- gate state from journal events.
 *   3. Then propagateNoMistakesConfig   <- local config artifact copy.
 *
 *   MAIN FLOW
 *   ---------
 *   ensureGatekeeperWindow -> startGatekeeperWindow -> persistent polling loop -> no-mistakes attach
 *
 *   PUBLIC API
 *   ----------
 *   GateDeps, GatekeeperWindowDeps
 *   GATEKEEPER_WINDOW, NO_MISTAKES_CONFIG_FILE
 *   buildGatekeeperAttachCommand, startGatekeeperWindow
 *   ensureGatekeeperWindow, refreshGatekeeperWindow, remoteShaForRef
 *   latestGateStatus, latestPublishedGateSha, shaMatchesHead, propagateNoMistakesConfig
 *
 *   INTERNALS
 *   ---------
 *   runCommandInGatekeeperWindow
 *
 * @exports GateDeps, GatekeeperWindowDeps, GATEKEEPER_WINDOW, NO_MISTAKES_CONFIG_FILE, buildGatekeeperAttachCommand, startGatekeeperWindow, ensureGatekeeperWindow, refreshGatekeeperWindow, remoteShaForRef, latestGateStatus, latestPublishedGateSha, shaMatchesHead, propagateNoMistakesConfig
 * @deps ../../core/events, ../../core/shell-quote, ../../core/state, ../../infra/tmux, ../runtime/sessions, node:fs, node:path
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

// Minimal shell wrapper: polls no-mistakes attach in a loop so the gatekeeper
// window stays alive and self-attaches when a run appears. INT drops to shell.
const GATEKEEPER_ENTRY_COMMAND = (attach: string) =>
  `combo_chen_idle=1; trap 'combo_chen_idle=0' INT; while [ "$combo_chen_idle" = 1 ]; do (${attach}); sleep 1; done; exec "\${SHELL:-/bin/sh}"`;

// -- 1/3 HELPER · Types and constants --
export interface GateDeps {
  out: (line: string) => void;
  git: (args: string[], cwd: string) => { status: number; stdout: string; stderr: string };
}

export interface GatekeeperWindowDeps {
  tmux: (args: string[]) => TmuxResult;
}

export const GATEKEEPER_WINDOW = "gatekeeper";
export const NO_MISTAKES_CONFIG_FILE = ".no-mistakes.yaml";
// -/ 1/3

// -- 2/3 CORE · Gatekeeper tmux window <- START HERE --
/** Static entry command: cd into the worktree and attach. No sed/retry/sleep inside. */
export function buildGatekeeperAttachCommand(combo: ComboRecord): string {
  return `cd ${shellQuote(combo.worktree)} && no-mistakes attach`;
}

function gatekeeperWindowEntry(combo: ComboRecord): string {
  return GATEKEEPER_ENTRY_COMMAND(buildGatekeeperAttachCommand(combo));
}

export function startGatekeeperWindow(deps: GatekeeperWindowDeps, combo: ComboRecord): void {
  const created = deps.tmux(
    newWindowArgs(combo.tmuxSession, GATEKEEPER_WINDOW, gatekeeperWindowEntry(combo)),
  );
  if (created.status !== 0) {
    throw new Error(
      `tmux failed to start gatekeeper watcher in "${combo.tmuxSession}": ` +
        `${created.stderr.trim() || "unknown error"}`,
    );
  }
}

export function ensureGatekeeperWindow(deps: GatekeeperWindowDeps, combo: ComboRecord): void {
  const listed = deps.tmux(listWindowsArgs(combo.tmuxSession));
  if (listed.status !== 0) {
    throw new Error(
      `tmux failed to list windows in "${combo.tmuxSession}": ` +
        `${listed.stderr.trim() || "unknown error"}`,
    );
  }
  if (listed.stdout.split(/\r?\n/).includes(GATEKEEPER_WINDOW)) return;

  startGatekeeperWindow(deps, combo);
}

export function refreshGatekeeperWindow(deps: GatekeeperWindowDeps, combo: ComboRecord): void {
  runCommandInGatekeeperWindow(deps, combo, gatekeeperWindowEntry(combo));
}
// -/ 2/3

// -- 3/3 HELPER · Gate state, config, and command rendering --
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
