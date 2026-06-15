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

export const CODER_WINDOW = "coder";
export const REVIEWER_WINDOW = "reviewer";
export const REVIEWER_WATCH_WINDOW = "reviewer-watch";

export interface SessionDeps {
  tmux: (args: string[]) => TmuxResult;
}

export function killComboSession(deps: SessionDeps, combo: ComboRecord): void {
  const killed = deps.tmux(killSessionArgs(combo.tmuxSession));
  if (killed.status !== 0) {
    throw new Error(
      `tmux kill-session failed for "${combo.tmuxSession}": ` +
        `${killed.stderr.trim() || "unknown error"}`,
    );
  }
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
    throw new Error("No running combos. Start one: combo-chen run --issue <url>");
  }
  if (running.length > 1) {
    throw new Error(
      `Several combos are running (${running.map((combo) => combo.id).join(", ")}); pass --name <comboId>`,
    );
  }
  return running[0]!;
}

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
