/**
 * @overview Coder-response CLI helpers. ~185 lines, 7 exports, review and conflict routing.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at activateCoder         <- starts resumed coder worker.
 *   2. Then nudgeReviewComments       <- syncs mirror and routes review comments.
 *   3. Then nudgePrConflict           <- routes base-advanced PR conflicts.
 *   4. Dependency interfaces          <- test seams for tmux/git/gh.
 *
 *   MAIN FLOW
 *   ---------
 *   activateCoder -> tmux worker; nudgeReviewComments/nudgePrConflict -> coder responding prompt
 *
 *   PUBLIC API
 *   ----------
 *   ActivateCoderDeps          Dependencies for activateCoder.
 *   NudgeReviewCommentsDeps    Dependencies for nudgeReviewComments.
 *   PrConflictNudge            PR conflict recovery prompt facts.
 *   activateCoder              Start coder responding mode.
 *   nudgeReviewComments        Route fresh review comments to the coder.
 *   buildPrConflictNudgePrompt Render deterministic conflict-recovery prompt.
 *   nudgePrConflict            Route a dirty/conflicting PR to coder responding.
 *
 *   INTERNALS
 *   ---------
 *   worktreeHeadSha
 *
 * @exports ActivateCoderDeps, NudgeReviewCommentsDeps, PrConflictNudge, activateCoder, nudgeReviewComments, buildPrConflictNudgePrompt, nudgePrConflict
 * @deps ../core/{events,gh-api,state}, ../infra/{config-snapshot,tmux}, ../roles/coder-responding, ./gate
 */
import { readEvents } from "../core/events.js";
import type { GhApiCache } from "../core/gh-api.js";
import { runDirFor, readCombo } from "../core/state.js";
import { loadRuntimeConfig } from "../infra/config-snapshot.js";
import { newWindowArgs, nudgeWindowArgs, type TmuxResult } from "../infra/tmux.js";
import {
  buildCoderRespondingResumeCommand,
  fetchReviewCommentSignals,
  latestPrUrl,
  readCoderThreadArtifact,
  routeReviewComments,
} from "../roles/coder-responding.js";
import { syncNoMistakesMirror } from "./gate.js";

// -- 1/3 HELPER · Dependency contracts --
export interface ActivateCoderDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  tmux: (args: string[]) => TmuxResult;
}

export interface NudgeReviewCommentsDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  tmux: (args: string[]) => TmuxResult;
  git: (args: string[], cwd: string) => { status: number; stdout: string; stderr: string };
  gh: (args: string[]) => { status: number; stdout: string; stderr: string };
}

export interface PrConflictNudge {
  prUrl: string;
  headSha: string;
  mergeState: string;
  mergeable?: string;
  baseRef?: string;
}
// -/ 1/3

function worktreeHeadSha(deps: NudgeReviewCommentsDeps, combo: { id: string; worktree: string }): string {
  const result = deps.git(["rev-parse", "HEAD"], combo.worktree);
  if (result.status !== 0) {
    throw new Error(`git rev-parse HEAD failed for ${combo.id}: ${result.stderr.trim() || "unknown error"}`);
  }
  return result.stdout.trim();
}

// -- 2/3 CORE · activateCoder <- START HERE --
export function activateCoder(input: {
  deps: ActivateCoderDeps;
  home: string;
  comboId: string;
  cli: string;
}): void {
  const { deps, home, comboId } = input;
  const runDir = runDirFor(home, comboId);
  const combo = readCombo(runDir);
  const config = loadRuntimeConfig(runDir, { repoDir: combo.repoDir, env: deps.env });
  const artifact = readCoderThreadArtifact(runDir);
  const coderResponding = deps.tmux(
    newWindowArgs(
      combo.tmuxSession,
      config.coderRespondingWindowName,
      buildCoderRespondingResumeCommand(artifact, config.coderResumeCommand),
    ),
  );
  if (coderResponding.status !== 0) {
    throw new Error(
      `tmux failed to start ${config.coderRespondingWindowName}: ${coderResponding.stderr.trim() || "unknown error"}`,
    );
  }
  deps.out(`coder responding active for ${combo.id}`);
}
// -/ 2/3

// -- 3/3 CORE · nudgeReviewComments --
export function nudgeReviewComments(input: {
  deps: NudgeReviewCommentsDeps;
  home: string;
  comboId: string;
  ghApiCache?: GhApiCache;
}): void {
  const { deps, home, comboId, ghApiCache } = input;
  const runDir = runDirFor(home, comboId);
  const combo = readCombo(runDir);
  const prUrl = latestPrUrl(readEvents(runDir));
  if (prUrl === undefined) {
    throw new Error(`No pr_opened event for combo "${comboId}"`);
  }
  const config = loadRuntimeConfig(runDir, { repoDir: combo.repoDir, env: deps.env });
  try {
    const synced = syncNoMistakesMirror(deps, combo, runDir);
    if (synced) {
      deps.out(`mirror synced for ${combo.id}`);
    }
  } catch (err) {
    deps.out(
      `mirror sync failed for ${combo.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    const comments = fetchReviewCommentSignals(prUrl, deps.gh, ghApiCache, {
      externalCommentAgents: config.externalCommentAgents,
    });
    const headSha = comments.length === 0 ? undefined : worktreeHeadSha(deps, combo);
    const routed = routeReviewComments({
      runDir,
      tmuxSession: combo.tmuxSession,
      comments,
      headSha,
      reviewNudgePrompt: config.reviewNudgePrompt,
      windowName: config.coderRespondingWindowName,
      tmux: deps.tmux,
    });
    for (const comment of routed) {
      deps.out(`nudged ${comment.url}`);
    }
  } catch (err) {
    deps.out(
      `review comment fetch failed for ${combo.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function buildPrConflictNudgePrompt(conflict: PrConflictNudge): string {
  return [
    "PR conflict recovery for coder responding mode:",
    conflict.prUrl,
    "",
    `head: ${conflict.headSha}`,
    `merge_state: ${conflict.mergeState}`,
    ...(conflict.mergeable !== undefined ? [`mergeable: ${conflict.mergeable}`] : []),
    ...(conflict.baseRef !== undefined ? [`base: ${conflict.baseRef}`] : []),
    "",
    "GitHub reports this READY PR is dirty or conflicting after the base advanced.",
    "Rebase the combo worktree onto the current base, resolve mechanical conflicts with TDD, commit local changes, and stop.",
    "If the conflict needs a product or intent decision, emit needs_human before changing code.",
    "Do not push to origin or the PR branch. Leave committed local changes for gatekeeper/no-mistakes to validate and publish.",
  ].join("\n");
}

export function nudgePrConflict(input: {
  deps: ActivateCoderDeps;
  home: string;
  comboId: string;
  conflict: PrConflictNudge;
}): void {
  const { deps, home, comboId, conflict } = input;
  const runDir = runDirFor(home, comboId);
  const combo = readCombo(runDir);
  const config = loadRuntimeConfig(runDir, { repoDir: combo.repoDir, env: deps.env });
  const prompt = buildPrConflictNudgePrompt(conflict);
  for (const args of nudgeWindowArgs(combo.tmuxSession, config.coderRespondingWindowName, prompt)) {
    const result = deps.tmux(args);
    if (result.status !== 0) {
      throw new Error(`tmux pr_conflict nudge failed: ${result.stderr.trim() || "unknown error"}`);
    }
  }
  deps.out(`nudged pr_conflict ${conflict.prUrl}`);
}
// -/ 3/3
