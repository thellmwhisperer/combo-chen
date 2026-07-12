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
 *   ensureGatekeeperWindow -> startGatekeeperWindow -> static no-mistakes attach entry
 *     refreshGatekeeperWindow -> kill + recreate window (TypeScript process control)
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
 *   none
 *
 * @exports GateDeps, GatekeeperWindowDeps, GATEKEEPER_WINDOW, NO_MISTAKES_CONFIG_FILE, buildGatekeeperAttachCommand, startGatekeeperWindow, ensureGatekeeperWindow, refreshGatekeeperWindow, remoteShaForRef, latestGateStatus, latestPublishedGateSha, shaMatchesHead, propagateNoMistakesConfig
 * @deps ../../core/events, ../../core/shell-quote, ../../core/state, ../../infra/tmux, ../runtime/sessions, node:fs, node:path
 */
import { chmodSync, copyFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

import type { ComboEvent } from "../../core/events.js";
import { shellQuote } from "../../core/shell-quote.js";
import type { ComboRecord } from "../../core/state.js";
import { killWindowArgs, listWindowsArgs, newWindowArgs, type TmuxResult } from "../../infra/tmux.js";
import { GATE_RUNNER_WINDOW, windowSet } from "../runtime/sessions.js";

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
/**
 * The complete gatekeeper window entry: cd into the worktree and attach.
 * This static one-liner is the ONLY shell that reaches tmux; every retry,
 * conditional, and status decision lives in TypeScript process control
 * (ensure/refresh below recreate the window instead of scripting the pane).
 */
export function buildGatekeeperAttachCommand(combo: ComboRecord): string {
  return `cd ${shellQuote(combo.worktree)} && no-mistakes attach`;
}

export function startGatekeeperWindow(deps: GatekeeperWindowDeps, combo: ComboRecord): void {
  const created = deps.tmux(
    newWindowArgs(combo.tmuxSession, GATEKEEPER_WINDOW, buildGatekeeperAttachCommand(combo)),
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

/**
 * Re-attach by recreating the window with the same static entry command.
 * Deliberately no send-keys/paste-buffer pane reinjection: a stale or dead
 * attach pane is killed and replaced, so the pane never receives scripted
 * input. Also removes the legacy v0 gate-runner window when present.
 */
export function refreshGatekeeperWindow(deps: GatekeeperWindowDeps, combo: ComboRecord): void {
  const listed = deps.tmux(listWindowsArgs(combo.tmuxSession));
  if (listed.status !== 0) {
    throw new Error(
      `tmux failed to list windows in "${combo.tmuxSession}": ` +
        `${listed.stderr.trim() || "unknown error"}`,
    );
  }
  const windows = windowSet(listed.stdout);
  for (const stale of [GATE_RUNNER_WINDOW, GATEKEEPER_WINDOW]) {
    if (!windows.has(stale)) continue;
    const killed = deps.tmux(killWindowArgs(combo.tmuxSession, stale));
    if (killed.status !== 0) {
      throw new Error(
        `tmux failed to remove "${stale}" in "${combo.tmuxSession}": ` +
          `${killed.stderr.trim() || "unknown error"}`,
      );
    }
  }
  startGatekeeperWindow(deps, combo);
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

// -/ 3/3
