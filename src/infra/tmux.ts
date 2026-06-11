/**
 * tmux plumbing. Builders are pure (and pinned by tests); `tmux()` is the
 * only function that touches the system.
 */
import { spawnSync } from "node:child_process";

export class TmuxError extends Error {}

export function newSessionArgs(session: string, windowName: string, command: string): string[] {
  return ["new-session", "-d", "-s", session, "-n", windowName, command];
}

export function newWindowArgs(session: string, windowName: string, command: string): string[] {
  return ["new-window", "-t", session, "-n", windowName, command];
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
  return [
    ["send-keys", "-l", "-t", target, prompt],
    ["send-keys", "-t", target, "Enter"],
  ];
}

export interface TmuxResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function tmux(args: string[]): TmuxResult {
  const result = spawnSync("tmux", args, { encoding: "utf8" });
  if (result.error) {
    throw new TmuxError(`tmux not available: ${result.error.message}`);
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function hasSession(session: string): boolean {
  return tmux(hasSessionArgs(session)).status === 0;
}
