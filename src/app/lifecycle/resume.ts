/**
 * @overview First-class resume routing for persisted capsule combos. ~170 lines,
 *   2 exports, journal-derived safe actions.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at resumeCombo             <- CLI-facing recovery dispatcher.
 *   2. classifyResumeState              <- closure-pending vs capsule phase.
 *   3. convergeCapsuleTopology          <- recreates the capsule role windows.
 *
 *   MAIN FLOW
 *   ---------
 *   resume -n -> migrate frozen engine -> read combo+journal -> classifyResumeState
 *     -> closure convergence or capsule topology convergence
 *
 *   PUBLIC API
 *   ----------
 *   ResumeDeps       Dependency subset required by resume.
 *   resumeCombo      Recover a persisted combo without starting a fresh run.
 *
 *   INTERNALS
 *   ---------
 *   classifyResumeState (delegates to classifyCapsulePhase), convergeCapsuleTopology,
 *   pruneLegacyTopology, hasClosurePendingEvent, githubPrMerged
 *
 * @exports ResumeDeps, resumeCombo
 * @deps ../../core/events, ../../core/shell-quote, ../../core/state, ../../infra/config-snapshot, ../../infra/tmux, ../../roles/director-invocation, ../capsule/capsule, ../gate/gate, ../github/github, ../reporting/status, ../runtime/sessions, ./closure
 */
import { latestPrUrlFromEvents, readEvents, type ComboEvent } from "../../core/events.js";
import { shellQuote } from "../../core/shell-quote.js";
import { readCombo, runDirFor, type ComboRecord } from "../../core/state.js";
import { loadRuntimeConfig, migrateConfigSnapshotEngine } from "../../infra/config-snapshot.js";
import { classifyCapsulePhase, type CapsulePhase } from "../capsule/capsule.js";
import type { TmuxResult } from "../../infra/tmux.js";
import { buildDirectorInvocation } from "../../roles/director-invocation.js";
import { closeMergedCombo } from "./closure.js";
import { ensureGatekeeperWindow } from "../gate/gate.js";
import { parsePrView, type GhRunner } from "../github/github.js";
import {
  CODER_WINDOW,
  DIRECTOR_WATCH_WINDOW,
  DIRECTOR_WINDOW,
  JOURNAL_WINDOW,
  REVIEWER_WINDOW,
  ensureCapsuleComboSession,
  ensureWindowPresent,
  idleRoleWindowCommand,
  killWindowIfPresent,
  removeLegacyTopologyWindows,
} from "../runtime/sessions.js";
import type { CommandResult } from "../reporting/status.js";

// -- 1/3 HELPER · Dependencies --
export interface ResumeDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  tmux: (args: string[]) => TmuxResult;
  git: (args: string[], cwd: string) => { status: number; stdout: string; stderr: string };
  treehouse: (args: string[], cwd: string) => { status: number; stdout: string; stderr: string };
  gh: GhRunner;
  noMistakes: (args: string[], cwd: string) => CommandResult;
  sleep: (ms: number) => Promise<void>;
}

// -/ 1/3

// -- 2/3 HELPER · Resume state classification --
function hasClosurePendingEvent(events: ComboEvent[]): boolean {
  let pending = false;
  for (const event of events) {
    if (event.event === "merged") pending = true;
    if (event.event === "combo_closed") pending = false;
  }
  return pending;
}

function githubPrMerged(gh: GhRunner, prUrl: string): boolean {
  const result = gh([
    "pr",
    "view",
    prUrl,
    "--json",
    "headRefOid,state,mergedAt,mergedBy,baseRefName,mergeCommit",
  ]);
  if (result.status !== 0) return false;
  try {
    return parsePrView(result.stdout).state === "MERGED";
  } catch {
    return false;
  }
}

type ResumeState =
  { kind: "closure_pending"; reason: "journal" | "github" } | { kind: "capsule"; phase: CapsulePhase };

function classifyResumeState(input: { events: ComboEvent[]; gh: GhRunner }): ResumeState {
  const { events } = input;
  if (hasClosurePendingEvent(events)) return { kind: "closure_pending", reason: "journal" };
  const prUrl = latestPrUrlFromEvents(events);
  if (prUrl !== undefined && githubPrMerged(input.gh, prUrl)) {
    return { kind: "closure_pending", reason: "github" };
  }
  return { kind: "capsule", phase: classifyCapsulePhase(events) };
}
// -/ 2/3

// -- 3/3 CORE · resumeCombo <- START HERE --
export async function resumeCombo(input: {
  deps: ResumeDeps;
  home: string;
  comboId: string;
  cli: string;
}): Promise<void> {
  const { deps, home, comboId, cli } = input;
  const runDir = runDirFor(home, comboId);
  const combo = readCombo(runDir);
  const events = readEvents(runDir);
  // Deterministic engine migration happens before any topology change: a
  // frozen v0 artifact is rewritten to capsule (or the read fails closed on
  // an unknown engine), so the artifact and the runtime never disagree.
  if (migrateConfigSnapshotEngine(runDir)) {
    deps.out(`resume: migrated frozen v0 engine snapshot to capsule for ${combo.id}`);
  }
  const config = loadRuntimeConfig(runDir, { repoDir: combo.repoDir, env: deps.env });
  const state = classifyResumeState({ events, gh: deps.gh });

  if (state.kind === "closure_pending") {
    deps.out(`resume: closure pending for ${combo.id} (${state.reason}); running closure`);
    await closeMergedCombo({ deps, home, comboId: combo.id });
    return;
  }

  if (state.phase === "closed") {
    deps.out(`resume: ${combo.id} is already combo_closed; nothing to resume`);
    return;
  }
  const recreated = convergeCapsuleTopology({ deps, combo, home, cli, config, runDir });
  pruneLegacyTopology({ deps, combo });
  deps.out(
    `resume: capsule engine (${state.phase}); capsule window ensured in ${combo.tmuxSession}` +
      `${recreated ? " (recreated tmux session)" : ""}`,
  );
}

function convergeCapsuleTopology(input: {
  deps: Pick<ResumeDeps, "env" | "tmux">;
  combo: ComboRecord;
  home: string;
  cli: string;
  config: ReturnType<typeof loadRuntimeConfig>;
  runDir: string;
}): boolean {
  const { deps, combo, home, cli, config, runDir } = input;
  // Pane 0 must be the capsule sequencer (the launch contract); the relaunched
  // capsule re-derives its own phase from the journal, so the same entry
  // command is correct for gate and supervise resumes alike.
  const recreated = ensureCapsuleComboSession({ deps, combo, home, cli, runDir });
  ensureWindowPresent(
    deps,
    combo,
    JOURNAL_WINDOW,
    `COMBO_CHEN_HOME=${shellQuote(home)} ${cli} events --follow -n ${shellQuote(combo.id)}`,
  );
  ensureWindowPresent(
    deps,
    combo,
    DIRECTOR_WINDOW,
    buildDirectorInvocation({ combo, directorCommand: config.directorCommand }),
  );
  ensureWindowPresent(deps, combo, CODER_WINDOW, idleRoleWindowCommand(CODER_WINDOW));
  ensureGatekeeperWindow(deps, combo);
  ensureWindowPresent(deps, combo, REVIEWER_WINDOW, idleRoleWindowCommand(REVIEWER_WINDOW));
  // A stale v0 shell watcher must not survive on a capsule run: the capsule
  // pane's in-process supervisor is the only observer.
  killWindowIfPresent(deps, combo, DIRECTOR_WATCH_WINDOW);
  return recreated;
}

function pruneLegacyTopology(input: { deps: Pick<ResumeDeps, "tmux">; combo: ComboRecord }): void {
  const { deps, combo } = input;
  removeLegacyTopologyWindows(deps, combo, {
    removeCoderResponding: true,
  });
}
// -/ 3/3
