/**
 * @overview Parking command for reboot-safe combo handoff. ~112 lines,
 *   2 exports, non-terminal shutdown semantics.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at parkCombo        <- CLI-facing park operation.
 *   2. buildParkSummary          <- handoff-style recovery text.
 *   3. Dependencies are minimal  <- tmux kill plus downstream probes.
 *
 *   MAIN FLOW
 *   ---------
 *   park -n -> read combo+journal -> stop/confirm tmux gone -> write summary -> journal parked
 *
 *   PUBLIC API
 *   ----------
 *   ParkDeps       Dependency subset required by park.
 *   parkCombo      Stop local tmux and write resumable handoff state.
 *
 *   INTERNALS
 *   ---------
 *   buildParkSummary
 *
 * @exports ParkDeps, parkCombo
 * @deps ../../core/combo, ../../core/events, ../../core/shell-quote, ../../core/state, ../../infra/config-snapshot, ../../infra/tmux, ../github/github, ../reporting/status, node:fs, node:path
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { deriveStatus } from "../../core/combo.js";
import { appendEvent, readEvents, type ComboEvent } from "../../core/events.js";
import { shellQuote } from "../../core/shell-quote.js";
import { readCombo, runDirFor, type ComboRecord } from "../../core/state.js";
import { loadRuntimeConfig } from "../../infra/config-snapshot.js";
import { hasSessionArgs, killSessionArgs, type TmuxResult } from "../../infra/tmux.js";
import type { GhRunner } from "../github/github.js";
import { deepComboStatus, type CommandResult } from "../reporting/status.js";

// -- 1/2 HELPER · Dependencies and summary rendering --
export interface ParkDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  tmux: (args: string[]) => TmuxResult;
  gh: GhRunner;
  noMistakes: (args: string[], cwd: string) => CommandResult;
}

function buildParkSummary(input: {
  combo: ComboRecord;
  events: ComboEvent[];
  home: string;
  cli: string;
  by: string;
  downstream?: string;
}): string {
  const { combo, events, home, cli, by, downstream } = input;
  const status = deriveStatus(events);
  const lastEvent = events.at(-1)?.event ?? "none";
  const lines = [
    `# Parked combo ${combo.id}`,
    "",
    `by: ${by}`,
    `branch: ${combo.branch}`,
    `worktree: ${combo.worktree}`,
    `tmux session: ${combo.tmuxSession}`,
    `phase: ${status.phase}`,
    `needs human: ${status.needsHuman ? (status.reason ?? "yes") : "no"}`,
    `pr: ${status.pr ?? "none"}`,
    `downstream: ${downstream ?? "unknown"}`,
    `last event: ${lastEvent}`,
    "",
    "Resume commands:",
    `COMBO_CHEN_HOME=${shellQuote(home)} ${cli} resume -n ${shellQuote(combo.id)}`,
    `COMBO_CHEN_HOME=${shellQuote(home)} ${cli} status --deep`,
    "",
  ];
  return lines.join("\n");
}
// -/ 1/2

// -- 2/2 CORE · parkCombo <- START HERE --
export function parkCombo(input: {
  deps: ParkDeps;
  home: string;
  comboId: string;
  cli: string;
  by: string;
}): void {
  const { deps, home, comboId, cli, by } = input;
  const runDir = runDirFor(home, comboId);
  const combo = readCombo(runDir);
  const events = readEvents(runDir);
  const config = loadRuntimeConfig(runDir, { repoDir: combo.repoDir, env: deps.env });
  const downstream = deepComboStatus(combo, events, deps.noMistakes, deps.gh, {
    requiredCheckNames: config.readyRequiredChecks,
    ambientCheckNames: config.externalCommentAgents,
  });
  const summaryPath = join(runDir, "park-handoff.md");

  const killed = deps.tmux(killSessionArgs(combo.tmuxSession));
  if (killed.status !== 0) {
    const stillAlive = deps.tmux(hasSessionArgs(combo.tmuxSession));
    if (stillAlive.status === 0) {
      throw new Error(
        `tmux kill-session failed for "${combo.tmuxSession}": ${killed.stderr.trim() || "unknown error"}`,
      );
    }
  }

  writeFileSync(summaryPath, buildParkSummary({ combo, events, home, cli, by, downstream }));
  appendEvent(runDir, "parked", { by, summary_path: summaryPath });
  deps.out(`parked ${combo.id} (handoff ${summaryPath}; resume with combo-chen resume -n ${combo.id})`);
}
// -/ 2/2
