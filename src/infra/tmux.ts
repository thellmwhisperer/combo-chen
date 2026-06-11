/**
 * tmux plumbing. Builders are pure (and pinned by tests); `tmux()` is the
 * only function that touches the system.
 */
import { spawnSync } from "node:child_process";

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
