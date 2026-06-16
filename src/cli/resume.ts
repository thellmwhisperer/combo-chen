/**
 * @overview First-class resume routing for persisted combos. ~110 lines,
 *   2 exports, downstream-state driven safe actions.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at resumeCombo             <- CLI-facing recovery dispatcher.
 *   2. ensureResumeSession              <- recreates only tmux monitoring shell.
 *   3. Output fallbacks                 <- explicit salvage/audit guidance.
 *
 *   MAIN FLOW
 *   ---------
 *   resume -n -> read combo+journal -> deepComboStatus -> reviewer/gate monitor/salvage
 *
 *   PUBLIC API
 *   ----------
 *   ResumeDeps       Dependency subset required by resume.
 *   resumeCombo      Recover a persisted combo without starting a fresh run.
 *
 *   INTERNALS
 *   ---------
 *   ensureResumeSession
 *
 * @exports ResumeDeps, resumeCombo
 * @deps ../core/{combo,events,state}, ../infra/{config,tmux}, ./gate, ./github, ./reviewer, ./sessions, ./status
 */
import { shellQuote } from "../core/combo.js";
import { latestPrUrlFromEvents, readEvents } from "../core/events.js";
import { readCombo, runDirFor, type ComboRecord } from "../core/state.js";
import { loadConfig } from "../infra/config.js";
import { hasSessionArgs, newSessionArgs, type TmuxResult } from "../infra/tmux.js";
import { ensureGatekeeperWindow, GATEKEEPER_WINDOW } from "./gate.js";
import type { GhRunner } from "./github.js";
import { activateReviewer } from "./reviewer.js";
import { CODER_WINDOW } from "./sessions.js";
import { deepComboStatus, type CommandResult } from "./status.js";

// -- 1/2 HELPER · Dependencies and tmux session recovery --
export interface ResumeDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  tmux: (args: string[]) => TmuxResult;
  gh: GhRunner;
  noMistakes: (args: string[], cwd: string) => CommandResult;
}

function ensureResumeSession(input: {
  deps: Pick<ResumeDeps, "tmux">;
  combo: ComboRecord;
  home: string;
  cli: string;
}): boolean {
  const { deps, combo, home, cli } = input;
  if (deps.tmux(hasSessionArgs(combo.tmuxSession)).status === 0) return false;

  const command = `COMBO_CHEN_HOME=${shellQuote(home)} ${cli} events --follow -n ${shellQuote(combo.id)}`;
  const created = deps.tmux(newSessionArgs(combo.tmuxSession, CODER_WINDOW, command));
  if (created.status !== 0) {
    throw new Error(
      `tmux failed to recreate resume session "${combo.tmuxSession}": ` +
        `${created.stderr.trim() || "unknown error"}`,
    );
  }
  return true;
}
// -/ 1/2

// -- 2/2 CORE · resumeCombo <- START HERE --
export function resumeCombo(input: {
  deps: ResumeDeps;
  home: string;
  comboId: string;
  cli: string;
}): void {
  const { deps, home, comboId, cli } = input;
  const runDir = runDirFor(home, comboId);
  const combo = readCombo(runDir);
  const events = readEvents(runDir);
  const downstream = deepComboStatus(combo, events, deps.noMistakes, deps.gh);

  if (downstream === "PR ready for reviewer") {
    const recreated = ensureResumeSession({ deps, combo, home, cli });
    activateReviewer({ deps, home, comboId: combo.id, cli });
    deps.out(`resume: PR ready for reviewer${recreated ? " (recreated tmux session)" : ""}`);
    return;
  }

  if (downstream?.startsWith("no-mistakes running")) {
    const recreated = ensureResumeSession({ deps, combo, home, cli });
    const config = loadConfig({ repoDir: combo.repoDir, env: deps.env });
    ensureGatekeeperWindow(deps, combo, {
      timeoutSeconds: config.gatekeeperAttachTimeoutSeconds,
      retryIntervalSeconds: config.gatekeeperAttachRetryIntervalSeconds,
    });
    deps.out(
      `resume: ${downstream}; monitoring in ${combo.tmuxSession}:${GATEKEEPER_WINDOW}` +
        `${recreated ? " (recreated tmux session)" : ""}`,
    );
    return;
  }

  if (downstream?.startsWith("awaiting review gate")) {
    deps.out(`resume: ${downstream}`);
    return;
  }

  const prUrl = latestPrUrlFromEvents(events);
  if (prUrl !== undefined) {
    deps.out(`resume: PR already exists at ${prUrl}; inspect combo-chen status --deep before relaunching work`);
    return;
  }

  deps.out(
    `resume: salvage required for ${combo.id}; no pr_opened event. ` +
      `Inspect ${runDir} and ${combo.worktree} before continuing coder work.`,
  );
}
// -/ 2/2
