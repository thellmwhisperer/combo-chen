/**
 * @overview tmux plumbing: pure argument builders + one system-calling
 *   executor. Builders are pinned by tests; tmux() touches the OS. ~105
 *   lines, 17 exports.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at tmux                     ← the only function that calls tmux
 *   2. newSessionArgs / newWindowArgs    ← the builders that feed it
 *   3. nudgeWindowArgs                   ← paste-buffer nudge path
 *   4. Everything else is arg builders   ← read on demand
 *
 *   MAIN FLOW
 *   ─────────
 *   cli/main.ts → deps.tmux(newSessionArgs(...)) → spawnSync("tmux", args)
 *     → TmuxResult {status, stdout, stderr}
 *
 *   ┌─ PUBLIC API ───────────────────────────────────────────────────────┐
 *   │ tmux                    Execute a tmux command, return TmuxResult   │
 *   │ hasSession              Convenience: tmux has-session → boolean     │
 *   │ newSessionArgs          Build args for new-session -d              │
 *   │ newWindowArgs           Build args for new-window                  │
 *   │ splitWindowArgs         Build args for split-window (journal pane) │
 *   │ attachSessionArgs       Build args for attach                     │
 *   │ hasSessionArgs          Build args for has-session                │
 *   │ killSessionArgs         Build args for kill-session               │
 *   │ killWindowArgs          Build args for kill-window                │
 *   │ listWindowsArgs         Build args for list-windows               │
 *   │ listPanesArgs           Build args for list-panes                 │
 *   │ captureWindowArgs       Build args for capture-pane               │
 *   │ renameWindowArgs        Build args for rename-window              │
 *   │ nudgeWindowArgs         Build paste-buffer nudge command list      │
 *   │ TmuxResult              {status, stdout, stderr} shape             │
 *   │ TmuxError               Thrown when tmux binary is absent          │
 *   ├─ INTERNALS ────────────────────────────────────────────────────────┤
 *   │ nudgeBufferName         Namespaced buffer name for nudgeWindowArgs │
 *   │ JOURNAL_PANE_HEIGHT     Split height for the journal pane          │
 *   └────────────────────────────────────────────────────────────────────┘
 *
 * @exports TmuxError, JOURNAL_PANE_HEIGHT, attachSessionArgs, newSessionArgs, newWindowArgs, splitWindowArgs, hasSessionArgs, killSessionArgs, killWindowArgs, listWindowsArgs, listPanesArgs, captureWindowArgs, renameWindowArgs, nudgeWindowArgs, TmuxResult, tmux, hasSession
 * @deps node:child_process
 */
import { spawnSync } from "node:child_process";

// -- 1/3 HELPER · Pure arg builders --
export class TmuxError extends Error {}

export const JOURNAL_PANE_HEIGHT = 12;

export function attachSessionArgs(session: string): string[] {
  return ["attach", "-t", session];
}

export function newSessionArgs(session: string, windowName: string, command: string): string[] {
  return ["new-session", "-d", "-s", session, "-n", windowName, command];
}

export function newWindowArgs(session: string, windowName: string, command: string): string[] {
  return ["new-window", "-t", session, "-n", windowName, command];
}

export function splitWindowArgs(session: string, windowName: string, command: string): string[] {
  return [
    "split-window",
    "-d",
    "-v",
    "-l",
    String(JOURNAL_PANE_HEIGHT),
    "-t",
    `${session}:${windowName}`,
    command,
  ];
}

export function hasSessionArgs(session: string): string[] {
  return ["has-session", "-t", session];
}

export function killSessionArgs(session: string): string[] {
  return ["kill-session", "-t", session];
}

export function killWindowArgs(session: string, windowName: string): string[] {
  return ["kill-window", "-t", `${session}:${windowName}`];
}

export function listWindowsArgs(session: string): string[] {
  return ["list-windows", "-t", session, "-F", "#{window_name}"];
}

export function listPanesArgs(session: string, windowName: string): string[] {
  return ["list-panes", "-t", `${session}:${windowName}`, "-F", "#{pane_index}"];
}

export function captureWindowArgs(session: string, windowName: string): string[] {
  return ["capture-pane", "-p", "-t", `${session}:${windowName}`];
}

export function renameWindowArgs(session: string, windowName: string, title: string): string[] {
  return ["rename-window", "-t", `${session}:${windowName}`, title];
}
// -/ 1/3

// -- 2/3 HELPER · nudgeWindowArgs (paste-buffer path) --
export function nudgeWindowArgs(
  session: string,
  windowName: string,
  prompt: string,
): string[][] {
  const target = `${session}:${windowName}`;
  const buffer = nudgeBufferName(session, windowName);
  return [
    ["set-buffer", "-b", buffer, prompt],
    ["paste-buffer", "-d", "-b", buffer, "-t", target],
    ["send-keys", "-t", target, "C-m"],
  ];
}

function nudgeBufferName(session: string, windowName: string): string {
  return `combo-chen-nudge-${`${session}-${windowName}`.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
}
// -/ 2/3

// -- 3/3 CORE · tmux execution ← START HERE --
export interface TmuxResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function tmux(args: string[]): TmuxResult {
  const result =
    args[0] === "attach"
      ? spawnSync("tmux", args, { stdio: "inherit" })
      : spawnSync("tmux", args, { encoding: "utf8" });
  if (result.error) {
    throw new TmuxError(`tmux not available: ${result.error.message}`);
  }
  return {
    status: result.status ?? 1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

export function hasSession(session: string): boolean {
  return tmux(hasSessionArgs(session)).status === 0;
}
// -/ 3/3
