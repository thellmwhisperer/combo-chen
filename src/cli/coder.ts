import { readEvents } from "../core/events.js";
import { runDirFor, readCombo } from "../core/state.js";
import { loadConfig } from "../infra/config.js";
import { killWindowArgs, newWindowArgs, type TmuxResult } from "../infra/tmux.js";
import {
  buildCoderRespondingResumeCommand,
  buildReviewWatchCommand,
  fetchReviewCommentSignals,
  latestPrUrl,
  readCoderThreadArtifact,
  routeReviewComments,
} from "../roles/coder-responding.js";
import { syncNoMistakesMirror } from "./gate.js";

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

export function activateCoder(input: {
  deps: ActivateCoderDeps;
  home: string;
  comboId: string;
  cli: string;
}): void {
  const { deps, home, comboId, cli } = input;
  const runDir = runDirFor(home, comboId);
  const combo = readCombo(runDir);
  const config = loadConfig({ repoDir: combo.repoDir, env: deps.env });
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
  const watcher = deps.tmux(
    newWindowArgs(
      combo.tmuxSession,
      config.coderRespondingWatchWindowName,
      buildReviewWatchCommand({
        cli,
        comboId: combo.id,
        pollSeconds: config.limits.babysitPollSeconds,
      }),
    ),
  );
  if (watcher.status !== 0) {
    try {
      deps.tmux(killWindowArgs(combo.tmuxSession, config.coderRespondingWindowName));
    } catch {
      // Preserve the watcher startup failure; cleanup errors are secondary.
    }
    throw new Error(
      `tmux failed to start ${config.coderRespondingWatchWindowName}: ${watcher.stderr.trim() || "unknown error"}`,
    );
  }
  deps.out(`coder responding active for ${combo.id}`);
}

export function nudgeReviewComments(input: {
  deps: NudgeReviewCommentsDeps;
  home: string;
  comboId: string;
}): void {
  const { deps, home, comboId } = input;
  const runDir = runDirFor(home, comboId);
  const combo = readCombo(runDir);
  const prUrl = latestPrUrl(readEvents(runDir));
  if (prUrl === undefined) {
    throw new Error(`No pr_opened event for combo "${comboId}"`);
  }
  const config = loadConfig({ repoDir: combo.repoDir, env: deps.env });
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
  const routed = routeReviewComments({
    runDir,
    tmuxSession: combo.tmuxSession,
    comments: fetchReviewCommentSignals(prUrl, deps.gh),
    reviewNudgePrompt: config.reviewNudgePrompt,
    windowName: config.coderRespondingWindowName,
    tmux: deps.tmux,
  });
  for (const comment of routed) {
    deps.out(`nudged ${comment.url}`);
  }
}
