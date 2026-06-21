/**
 * @overview tmux session helpers. ~160 lines, 10 exports, attach and idempotent cleanup utilities.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at resolveAttachCombo    <- resolves explicit or sole running combo.
 *   2. Then ensureJournalPane         <- keeps event tail visible in coder window.
 *   3. Use kill helpers on demand     <- stop/reviewer cleanup paths.
 *
 *   MAIN FLOW
 *   ---------
 *   resolveAttachCombo -> running combo; ensureJournalPane -> inspect panes -> split event tail
 *
 *   PUBLIC API
 *   ----------
 *   CODER_WINDOW, REVIEWER_WINDOW, REVIEWER_WATCH_WINDOW, DIRECTOR_WATCH_WINDOW, SessionDeps
 *   KillComboSessionResult
 *   killComboSession, killWindowIfPresent, resolveAttachCombo, ensureJournalPane
 *
 *   INTERNALS
 *   ---------
 *   paneCount, tmuxFailureText, isMissingSession
 *
 * @exports CODER_WINDOW, REVIEWER_WINDOW, REVIEWER_WATCH_WINDOW, DIRECTOR_WATCH_WINDOW, SessionDeps, KillComboSessionResult, killComboSession, killWindowIfPresent, resolveAttachCombo, ensureJournalPane
 * @deps ../core/state, ../infra/tmux
 */
import { type ComboRecord, listCombos } from "../core/state.js";
import {
  hasSessionArgs,
  killSessionArgs,
  killWindowArgs,
  listPanesArgs,
  listWindowsArgs,
  splitWindowArgs,
  type TmuxResult,
} from "../infra/tmux.js";

// -- 1/3 HELPER · Window constants and kill helpers --
export const CODER_WINDOW = "coder";
export const REVIEWER_WINDOW = "reviewer";
export const REVIEWER_WATCH_WINDOW = "reviewer-watch";
export const DIRECTOR_WATCH_WINDOW = "director-watch";

export interface SessionDeps {
  tmux: (args: string[]) => TmuxResult;
}

export type KillComboSessionResult = "killed" | "already_missing";

export function killComboSession(deps: SessionDeps, combo: ComboRecord): KillComboSessionResult {
  const killed = deps.tmux(killSessionArgs(combo.tmuxSession));
  if (killed.status === 0) return "killed";
  if (isMissingSession(killed)) return "already_missing";
  if (killed.status !== 0) {
    throw new Error(
      `tmux kill-session failed for "${combo.tmuxSession}": ` +
        `${killed.stderr.trim() || "unknown error"}`,
    );
  }
  return "killed";
}

function tmuxFailureText(result: TmuxResult): string {
  return `${result.stderr}\n${result.stdout}`.toLowerCase();
}

function isMissingSession(result: TmuxResult): boolean {
  const text = tmuxFailureText(result);
  return text.includes("can't find session") || text.includes("no server running");
}

export function killWindowIfPresent(
  deps: SessionDeps,
  combo: ComboRecord,
  windowName: string,
): void {
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
// -/ 1/3

// -- 2/3 CORE · resolveAttachCombo <- START HERE --
export function resolveAttachCombo(
  deps: SessionDeps,
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
    throw new Error("No running combos. Start one: combo-chen run --issue <url> or --plan <file>");
  }
  if (running.length > 1) {
    throw new Error(
      `Several combos are running (${running.map((combo) => combo.id).join(", ")}); pass --name <comboId>`,
    );
  }
  return running[0]!;
}
// -/ 2/3

// -- 3/3 CORE · ensureJournalPane --
function paneCount(stdout: string): number {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean).length;
}

export function ensureJournalPane(
  deps: SessionDeps,
  combo: ComboRecord,
  cliInvocation: string,
): void {
  const listed = deps.tmux(listPanesArgs(combo.tmuxSession, CODER_WINDOW));
  if (listed.status !== 0) {
    throw new Error(
      `tmux failed to inspect coder panes in "${combo.tmuxSession}": ` +
        `${listed.stderr.trim() || "unknown error"}`,
    );
  }
  if (paneCount(listed.stdout) >= 2) return;

  const split = deps.tmux(
    splitWindowArgs(combo.tmuxSession, CODER_WINDOW, `${cliInvocation} events --follow -n ${combo.id}`),
  );
  if (split.status !== 0) {
    throw new Error(
      `tmux failed to recreate the journal pane in "${combo.tmuxSession}": ` +
        `${split.stderr.trim() || "unknown error"}`,
    );
  }
}
// -/ 3/3
