/**
 * @overview tmux session helpers. ~220 lines, 17 exports, attach/recovery and idempotent cleanup utilities.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at resolveAttachCombo    <- resolves explicit or sole running combo.
 *   2. Then ensureComboSession        <- recreates a visible room from persisted state.
 *   3. Then ensureJournalPane         <- creates dedicated journal window, not a pane.
 *   4. Use kill helpers on demand     <- stop/reviewer cleanup paths.
 *
 *   MAIN FLOW
 *   ---------
 *   resume/gate recovery -> ensureComboSession -> ensure journal role window
 *
 *   PUBLIC API
 *   ----------
 *   CODER_WINDOW, JOURNAL_WINDOW, DIRECTOR_WINDOW, REVIEWER_WINDOW, REVIEWER_WATCH_WINDOW (legacy; killed but never created), DIRECTOR_WATCH_WINDOW, GATE_RUNNER_WINDOW, CAPSULE_WINDOW, SessionDeps
 *   KillComboSessionResult, windowSet
 *   killComboSession, killWindowIfPresent, ensureWindowPresent, idleRoleWindowCommand, capsuleWindowCommand, removeLegacyTopologyWindows, ensureComboSession, ensureCapsuleComboSession, resolveAttachCombo, ensureJournalPane
 *
 *   INTERNALS
 *   ---------
 *   tmuxFailureText, isMissingSession
 *
 * @exports CODER_WINDOW, JOURNAL_WINDOW, DIRECTOR_WINDOW, REVIEWER_WINDOW, REVIEWER_WATCH_WINDOW, DIRECTOR_WATCH_WINDOW, GATE_RUNNER_WINDOW, CAPSULE_WINDOW, SessionDeps, KillComboSessionResult, windowSet, killComboSession, killWindowIfPresent, ensureWindowPresent, idleRoleWindowCommand, capsuleWindowCommand, removeLegacyTopologyWindows, ensureComboSession, ensureCapsuleComboSession, resolveAttachCombo, ensureJournalPane
 * @deps ../../core/guards, ../../core/shell-quote, ../../core/state, ../../infra/tmux, ../../shell/templates
 */
import { errorMessage } from "../../core/guards.js";
import { shellQuote } from "../../core/shell-quote.js";
import { renderShellTemplate } from "../../shell/templates.js";
import { type ComboRecord, listCombos } from "../../core/state.js";
import {
  hasSessionArgs,
  killSessionArgs,
  killWindowArgs,
  listWindowsArgs,
  newSessionArgs,
  newWindowArgs,
  type TmuxResult,
} from "../../infra/tmux.js";

// -- 1/3 HELPER · Window constants and kill helpers --
export const CODER_WINDOW = "coder";
export const JOURNAL_WINDOW = "journal";
export const DIRECTOR_WINDOW = "director";
export const REVIEWER_WINDOW = "reviewer";
export const REVIEWER_WATCH_WINDOW = "reviewer-watch";
export const DIRECTOR_WATCH_WINDOW = "director-watch";
export const GATE_RUNNER_WINDOW = "gate-runner";
export const CAPSULE_WINDOW = "capsule";
const CODER_RESPONDING_WINDOW = "coder-responding";

/** Plain tmux entry command for the v1 capsule sequencer pane (PRD §6). */
export function capsuleWindowCommand(input: { cli: string; comboHome: string; runDir: string }): string {
  return `COMBO_CHEN_HOME=${shellQuote(input.comboHome)} ${input.cli} capsule ${shellQuote(input.runDir)}`;
}

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
      `tmux kill-session failed for "${combo.tmuxSession}": ` + `${killed.stderr.trim() || "unknown error"}`,
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

export function killWindowIfPresent(deps: SessionDeps, combo: ComboRecord, windowName: string): void {
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

export function windowSet(stdout: string): Set<string> {
  return new Set(
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

export function ensureWindowPresent(
  deps: SessionDeps,
  combo: ComboRecord,
  windowName: string,
  command: string,
): boolean {
  const listed = deps.tmux(listWindowsArgs(combo.tmuxSession));
  if (listed.status !== 0) {
    throw new Error(
      `tmux failed to list windows in "${combo.tmuxSession}": ` +
        `${listed.stderr.trim() || "unknown error"}`,
    );
  }
  if (windowSet(listed.stdout).has(windowName)) return false;

  const created = deps.tmux(newWindowArgs(combo.tmuxSession, windowName, command));
  if (created.status !== 0) {
    throw new Error(
      `tmux failed to start "${windowName}" in "${combo.tmuxSession}": ` +
        `${created.stderr.trim() || "unknown error"}`,
    );
  }
  return true;
}

export function idleRoleWindowCommand(role: string): string {
  return renderShellTemplate("idle-role-window", { __ROLE__: role }).trimEnd();
}

export function removeLegacyTopologyWindows(
  deps: SessionDeps,
  combo: ComboRecord,
  options: { removeCoderResponding?: boolean } = {},
): void {
  const windows = [
    REVIEWER_WATCH_WINDOW,
    GATE_RUNNER_WINDOW,
    ...(options.removeCoderResponding === true ? [CODER_RESPONDING_WINDOW] : []),
  ];
  for (const windowName of windows) {
    killWindowIfPresent(deps, combo, windowName);
  }
}

export function ensureComboSession(input: {
  deps: SessionDeps;
  combo: ComboRecord;
  home: string;
  cli: string;
}): boolean {
  const { deps, combo, home, cli } = input;
  const command = `COMBO_CHEN_HOME=${shellQuote(home)} ${cli} events --follow -n ${shellQuote(combo.id)}`;
  if (deps.tmux(hasSessionArgs(combo.tmuxSession)).status === 0) {
    ensureWindowPresent(deps, combo, JOURNAL_WINDOW, command);
    return false;
  }

  const created = deps.tmux(newSessionArgs(combo.tmuxSession, JOURNAL_WINDOW, command));
  if (created.status !== 0) {
    throw new Error(
      `tmux failed to recreate combo session "${combo.tmuxSession}": ` +
        `${created.stderr.trim() || "unknown error"}`,
    );
  }
  return true;
}

/**
 * Capsule-engine session recovery: pane 0 must be the capsule sequencer, so a
 * missing session is recreated with CAPSULE_WINDOW as the initial window (the
 * launch contract), never the generic journal-first shell.
 */
export function ensureCapsuleComboSession(input: {
  deps: SessionDeps;
  combo: ComboRecord;
  home: string;
  cli: string;
  runDir: string;
}): boolean {
  const { deps, combo, home, cli, runDir } = input;
  const command = capsuleWindowCommand({ cli, comboHome: home, runDir });
  if (deps.tmux(hasSessionArgs(combo.tmuxSession)).status === 0) {
    ensureWindowPresent(deps, combo, CAPSULE_WINDOW, command);
    return false;
  }

  const created = deps.tmux(newSessionArgs(combo.tmuxSession, CAPSULE_WINDOW, command));
  if (created.status !== 0) {
    throw new Error(
      `tmux failed to recreate capsule combo session "${combo.tmuxSession}": ` +
        `${created.stderr.trim() || "unknown error"}`,
    );
  }
  return true;
}
// -/ 1/3

// -- 2/3 CORE · resolveAttachCombo <- START HERE --
export function resolveAttachCombo(deps: SessionDeps, home: string, name: string | undefined): ComboRecord {
  const combos = listCombos(home, (id, error) =>
    process.stderr.write(`combo-chen: skipped corrupt combo ${id}: ${errorMessage(error)}\n`),
  );
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
export function ensureJournalPane(deps: SessionDeps, combo: ComboRecord, cliInvocation: string): void {
  ensureWindowPresent(
    deps,
    combo,
    JOURNAL_WINDOW,
    `${cliInvocation} events --follow -n ${shellQuote(combo.id)}`,
  );
}
// -/ 3/3
