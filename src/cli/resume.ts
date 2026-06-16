/**
 * @overview First-class resume routing for persisted combos. ~150 lines,
 *   2 exports, downstream-state driven safe actions.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at resumeCombo             <- CLI-facing recovery dispatcher.
 *   2. ensureResumeSession              <- recreates only tmux monitoring shell.
 *   3. salvageCoderStoppedBeforeHandoff <- explicit salvage/audit guidance.
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
 *   ensureResumeSession, salvageCoderStoppedBeforeHandoff, event field helpers
 *
 * @exports ResumeDeps, resumeCombo
 * @deps ../core/{combo,events,state}, ../infra/{config,tmux}, ./gate, ./github, ./reviewer, ./sessions, ./status
 */
import { shellQuote } from "../core/combo.js";
import { latestPrUrlFromEvents, readEvents, type ComboEvent } from "../core/events.js";
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
function lastEvent(events: ComboEvent[], eventName: ComboEvent["event"]): ComboEvent | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.event === eventName) return event;
  }
  return undefined;
}

function eventFieldString(event: ComboEvent | undefined, field: string): string | undefined {
  const value = event?.[field];
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function eventFieldNumber(event: ComboEvent | undefined, field: string): number | undefined {
  const value = event?.[field];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

function hasEvent(events: ComboEvent[], eventName: ComboEvent["event"]): boolean {
  return events.some((event) => event.event === eventName);
}

function salvageCoderStoppedBeforeHandoff(input: {
  combo: ComboRecord;
  events: ComboEvent[];
  home: string;
  cli: string;
}): string[] | undefined {
  const { combo, events, home, cli } = input;
  const coderStarted = hasEvent(events, "coder_started") || hasEvent(events, "coder_failed");
  const handedOff = hasEvent(events, "gate_started") || latestPrUrlFromEvents(events) !== undefined;
  if (!coderStarted || handedOff) return undefined;

  const failed = lastEvent(events, "coder_failed");
  const exitCode = eventFieldString(failed, "exit_code") ?? "unknown";
  const commitCount = eventFieldNumber(failed, "new_commit_count");
  const commitSummary =
    commitCount === undefined
      ? "with an unknown number of new commits"
      : `after ${commitCount} new ${commitCount === 1 ? "commit" : "commits"}`;
  const baseSha = eventFieldString(failed, "base_sha");
  const headSha = eventFieldString(failed, "head_sha");
  const detail =
    failed === undefined
      ? "detail: coder started but no handoff event was journaled"
      : `detail: coder failed with exit ${exitCode} ${commitSummary}`;

  const lines = [
    `resume: salvage required for ${combo.id}; coder stopped before handoff`,
    detail,
    `next: cd ${shellQuote(combo.worktree)}`,
    "next: git status --short",
  ];
  if (baseSha !== undefined && headSha !== undefined) {
    lines.push(`next: git log --oneline ${shellQuote(`${baseSha}..${headSha}`)}`);
  }
  lines.push(`next: COMBO_CHEN_HOME=${shellQuote(home)} ${cli} status --deep`);
  return lines;
}

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

  const salvage = salvageCoderStoppedBeforeHandoff({ combo, events, home, cli });
  if (salvage !== undefined) {
    for (const line of salvage) deps.out(line);
    return;
  }

  deps.out(
    `resume: salvage required for ${combo.id}; no pr_opened event. ` +
      `Inspect ${runDir} and ${combo.worktree} before continuing coder work.`,
  );
}
// -/ 2/2
