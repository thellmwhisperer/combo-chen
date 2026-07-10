/**
 * @overview Coder-response application services for review, conflict, worker recovery, and PR-head sync routing.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at activateCoder         <- starts resumed coder worker.
 *   2. Then nudgeReviewComments       <- syncs mirror and routes review comments.
 *   3. Then nudgePrConflict           <- routes base-advanced and local PR-head sync conflicts.
 *   4. Then recoverStuckWorker         <- recreates recoverable coder responding mode.
 *   5. Then recoverDeadCoder          <- restarts the initial pre-PR runner.
 *   6. Dependency interfaces          <- test seams for tmux/git/gh.
 *
 *   MAIN FLOW
 *   ---------
 *   activateCoder -> tmux worker; nudgeReviewComments/nudgePrConflict -> coder responding prompt
 *     -> recoverStuckWorker/recoverDeadCoder -> restart the right worker path
 *
 *   PUBLIC API
 *   ----------
 *   ActivateCoderDeps          Dependencies for activateCoder.
 *   NudgeReviewCommentsDeps    Dependencies for nudgeReviewComments.
 *   PrConflictNudge            PR conflict recovery prompt facts.
 *   activateCoder              Start coder responding mode.
 *   nudgeReviewComments        Route fresh review comments to the coder.
 *   nudgePrConflict            Route a dirty/conflicting or out-of-sync PR to coder responding.
 *   recoverStuckWorker         Recreate coder responding and replay the last prompt.
 *   recoverDeadCoder           Recreate the initial coder runner before a PR exists.
 *
 *   INTERNALS
 *   ---------
 *   worktreeHeadSha, hasUnroutedReviewComments, ensureCoderRespondingWindow, buildPrConflictNudgePrompt, latestRoutedCoderPrompt
 *
 * @exports ActivateCoderDeps, NudgeReviewCommentsDeps, PrConflictNudge, StuckWorkerRecovery, DeadCoderRecovery, activateCoder, nudgeReviewComments, nudgePrConflict, recoverStuckWorker, recoverDeadCoder
 * @deps ../../core/combo, ../../core/events, ../../core/gh-api, ../../core/state, ../../infra/config-snapshot, ../../infra/tmux, ../../roles/coder-responding, ../gate/gate, ../runtime/sessions, node:fs, node:path
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { appendEvent, latestPrUrlFromEvents, readEvents, type ComboEvent } from "../../core/events.js";
import type { GhApiCache } from "../../core/gh-api.js";
import { runDirFor, readCombo } from "../../core/state.js";
import { shellQuote } from "../../core/combo.js";
import { loadRuntimeConfig } from "../../infra/config-snapshot.js";
import {
  hasSessionArgs,
  killWindowArgs,
  listPanesArgs,
  listWindowsArgs,
  newSessionArgs,
  newWindowArgs,
  nudgeWindowArgs,
  type TmuxResult,
} from "../../infra/tmux.js";
import {
  buildCoderRespondingResumeCommand,
  buildReviewNudgePrompt,
  fetchReviewCommentSignals,
  readCoderThreadArtifact,
  routeReviewComments,
} from "../../roles/coder-responding.js";
import { latestPublishedGateSha, syncNoMistakesMirror } from "../gate/gate.js";
import { CODER_WINDOW, ensureWindowPresent, killWindowIfPresent, windowSet } from "../runtime/sessions.js";

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
  publishedSha?: string;
  localSha?: string;
}

export interface StuckWorkerRecovery {
  worker: string;
  reason: "worker_stalled" | "worker_permission_prompt";
  detail: string;
  attempt: number;
  maxAttempts: number;
}

export interface DeadCoderRecovery {
  worker: string;
  reason: "worker_dead";
  detail: string;
  attempt: number;
  maxAttempts: number;
}
// -/ 1/3

function worktreeHeadSha(deps: NudgeReviewCommentsDeps, combo: { id: string; worktree: string }): string {
  const result = deps.git(["rev-parse", "HEAD"], combo.worktree);
  if (result.status !== 0) {
    throw new Error(`git rev-parse HEAD failed for ${combo.id}: ${result.stderr.trim() || "unknown error"}`);
  }
  return result.stdout.trim();
}

function hasUnroutedReviewComments(runDir: string, comments: { url: string }[]): boolean {
  const routed = new Set(
    readEvents(runDir)
      .filter((event) => event.event === "review_comment" && typeof event["url"] === "string")
      .map((event) => event["url"] as string),
  );
  return comments.some((comment) => !routed.has(comment.url));
}

function hasLivePane(paneDeadOutput: string): boolean {
  return paneDeadOutput.split(/\r?\n/).some((line) => line.trim() === "0");
}

function ensureCoderRespondingWindow(input: {
  deps: ActivateCoderDeps;
  combo: { id: string; tmuxSession: string };
  runDir: string;
  windowName: string;
  resumeCommand: string;
}): void {
  const listed = input.deps.tmux(listWindowsArgs(input.combo.tmuxSession));
  if (listed.status !== 0) {
    throw new Error(
      `tmux failed to list windows in "${input.combo.tmuxSession}": ` +
        `${listed.stderr.trim() || "unknown error"}`,
    );
  }
  const windows = windowSet(listed.stdout);
  if (windows.has(input.windowName)) {
    const panes = input.deps.tmux(listPanesArgs(input.combo.tmuxSession, input.windowName, "#{pane_dead}"));
    if (panes.status !== 0) {
      throw new Error(
        `tmux failed to inspect ${input.windowName} panes: ` + `${panes.stderr.trim() || "unknown error"}`,
      );
    }
    if (hasLivePane(panes.stdout)) return;

    const killed = input.deps.tmux(killWindowArgs(input.combo.tmuxSession, input.windowName));
    if (killed.status !== 0) {
      throw new Error(
        `tmux failed to replace dead ${input.windowName}: ` + `${killed.stderr.trim() || "unknown error"}`,
      );
    }
  }

  const artifact = readCoderThreadArtifact(input.runDir);
  const created = input.deps.tmux(
    newWindowArgs(
      input.combo.tmuxSession,
      input.windowName,
      buildCoderRespondingResumeCommand(artifact, input.resumeCommand),
    ),
  );
  if (created.status !== 0) {
    throw new Error(`tmux failed to start ${input.windowName}: ${created.stderr.trim() || "unknown error"}`);
  }
}

function reviewCommentHeadSha(
  deps: NudgeReviewCommentsDeps,
  combo: { id: string; worktree: string },
  events: ReturnType<typeof readEvents>,
): string {
  return latestPublishedGateSha(events) ?? worktreeHeadSha(deps, combo);
}

function stringField(event: ComboEvent, field: string): string | undefined {
  const value = event[field];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function latestRoutedCoderPrompt(events: ComboEvent[], reviewNudgePrompt: string): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.event === "review_comment") {
      const author = stringField(event, "author");
      const kind = stringField(event, "kind");
      const url = stringField(event, "url");
      if (author !== undefined && kind !== undefined && url !== undefined) {
        return buildReviewNudgePrompt({ author, kind, url }, reviewNudgePrompt);
      }
    }
    if (event.event === "pr_conflict") {
      const prUrl = stringField(event, "pr_url");
      const headSha = stringField(event, "sha");
      const mergeState = stringField(event, "merge_state");
      if (prUrl !== undefined && headSha !== undefined && mergeState !== undefined) {
        return buildPrConflictNudgePrompt({
          prUrl,
          headSha,
          mergeState,
          ...(stringField(event, "mergeable") !== undefined
            ? { mergeable: stringField(event, "mergeable") }
            : {}),
          ...(stringField(event, "base_ref") !== undefined
            ? { baseRef: stringField(event, "base_ref") }
            : {}),
          ...(stringField(event, "published_sha") !== undefined
            ? { publishedSha: stringField(event, "published_sha") }
            : {}),
          ...(stringField(event, "local_sha") !== undefined
            ? { localSha: stringField(event, "local_sha") }
            : {}),
        });
      }
    }
  }
  return undefined;
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
  ensureCoderRespondingWindow({
    deps,
    combo,
    runDir,
    windowName: config.coderRespondingWindowName,
    resumeCommand: config.coderResumeCommand,
  });
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
  const prUrl = latestPrUrlFromEvents(readEvents(runDir));
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
    deps.out(`mirror sync failed for ${combo.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const comments = fetchReviewCommentSignals(prUrl, deps.gh, ghApiCache, {
      externalCommentAgents: config.externalCommentAgents,
    });
    const hasUnroutedComments = hasUnroutedReviewComments(runDir, comments);
    if (hasUnroutedComments) {
      ensureCoderRespondingWindow({
        deps,
        combo,
        runDir,
        windowName: config.coderRespondingWindowName,
        resumeCommand: config.coderResumeCommand,
      });
    }
    const headSha = hasUnroutedComments ? reviewCommentHeadSha(deps, combo, readEvents(runDir)) : undefined;
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

function buildPrConflictNudgePrompt(conflict: PrConflictNudge): string {
  if (conflict.mergeState === "LOCAL_OUT_OF_SYNC") {
    return [
      "Local PR head sync recovery for coder responding mode:",
      conflict.prUrl,
      "",
      `published_gate: ${conflict.publishedSha ?? conflict.headSha}`,
      `local_head: ${conflict.localSha ?? conflict.headSha}`,
      "",
      "The coder worktree has local addressing commits, but its HEAD does not include the last published gate head.",
      "Fetch the PR branch/head, rebase or replay the local addressing commits so the published gate SHA is an ancestor of HEAD, resolve mechanical conflicts with TDD, commit local changes, and stop.",
      "Verify with git merge-base --is-ancestor <published_gate> HEAD before finishing.",
      "If the sync needs a product or intent decision, emit needs_human before changing code.",
      "Do not push to origin or the PR branch. Leave committed local changes for gatekeeper/no-mistakes to validate and publish.",
    ].join("\n");
  }

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
  ensureCoderRespondingWindow({
    deps,
    combo,
    runDir,
    windowName: config.coderRespondingWindowName,
    resumeCommand: config.coderResumeCommand,
  });
  const prompt = buildPrConflictNudgePrompt(conflict);
  for (const args of nudgeWindowArgs(combo.tmuxSession, config.coderRespondingWindowName, prompt)) {
    const result = deps.tmux(args);
    if (result.status !== 0) {
      throw new Error(`tmux pr_conflict nudge failed: ${result.stderr.trim() || "unknown error"}`);
    }
  }
  deps.out(`nudged pr_conflict ${conflict.prUrl}`);
}

export function recoverStuckWorker(input: {
  deps: ActivateCoderDeps;
  home: string;
  comboId: string;
  recovery: StuckWorkerRecovery;
}): boolean {
  const { deps, home, comboId, recovery } = input;
  const runDir = runDirFor(home, comboId);
  const combo = readCombo(runDir);
  const config = loadRuntimeConfig(runDir, { repoDir: combo.repoDir, env: deps.env });
  if (recovery.worker !== config.coderRespondingWindowName) return false;

  const prompt = latestRoutedCoderPrompt(readEvents(runDir), config.reviewNudgePrompt);
  if (prompt === undefined) {
    throw new Error(`No routed coder prompt available to recover ${recovery.worker}`);
  }
  readCoderThreadArtifact(runDir);

  const killed = deps.tmux(killWindowArgs(combo.tmuxSession, config.coderRespondingWindowName));
  if (killed.status !== 0) {
    throw new Error(
      `tmux failed to kill ${config.coderRespondingWindowName}: ${killed.stderr.trim() || "unknown error"}`,
    );
  }
  ensureCoderRespondingWindow({
    deps,
    combo,
    runDir,
    windowName: config.coderRespondingWindowName,
    resumeCommand: config.coderResumeCommand,
  });
  for (const args of nudgeWindowArgs(combo.tmuxSession, config.coderRespondingWindowName, prompt)) {
    const result = deps.tmux(args);
    if (result.status !== 0) {
      throw new Error(
        `tmux stalled-worker recovery nudge failed: ${result.stderr.trim() || "unknown error"}`,
      );
    }
  }
  appendEvent(runDir, "worker_recovered", {
    worker: recovery.worker,
    reason: recovery.reason,
    detail: recovery.detail,
    attempt: recovery.attempt,
    max_attempts: recovery.maxAttempts,
  });
  const recoveredDetail =
    recovery.reason === "worker_stalled"
      ? `recovered stalled ${recovery.worker}`
      : `recovered ${recovery.worker} after ${recovery.reason}`;
  deps.out(`director: ${recoveredDetail} attempt ${recovery.attempt}/${recovery.maxAttempts}`);
  return true;
}

export function recoverDeadCoder(input: {
  deps: ActivateCoderDeps;
  home: string;
  comboId: string;
  recovery: DeadCoderRecovery;
}): boolean {
  const { deps, home, comboId, recovery } = input;
  if (recovery.worker !== CODER_WINDOW) return false;

  const runDir = runDirFor(home, comboId);
  const combo = readCombo(runDir);
  const runnerPath = join(runDir, "runner.sh");
  if (!existsSync(runnerPath)) {
    throw new Error(`No runner script available to recover ${recovery.worker}`);
  }
  const command = `COMBO_CHEN_RUNNER_PROGRESS=1 sh ${shellQuote(runnerPath)}`;
  const session = deps.tmux(hasSessionArgs(combo.tmuxSession));
  if (session.status === 0) {
    killWindowIfPresent(deps, combo, CODER_WINDOW);
    ensureWindowPresent(deps, combo, CODER_WINDOW, command);
  } else {
    const created = deps.tmux(newSessionArgs(combo.tmuxSession, CODER_WINDOW, command));
    if (created.status !== 0) {
      throw new Error(`tmux failed to restart ${CODER_WINDOW}: ${created.stderr.trim() || "unknown error"}`);
    }
  }
  appendEvent(runDir, "worker_recovered", {
    worker: recovery.worker,
    reason: recovery.reason,
    detail: recovery.detail,
    attempt: recovery.attempt,
    max_attempts: recovery.maxAttempts,
  });
  deps.out(`director: restarted dead ${recovery.worker} attempt ${recovery.attempt}/${recovery.maxAttempts}`);
  return true;
}
// -/ 3/3
