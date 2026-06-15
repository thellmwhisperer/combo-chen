import { runDirFor, readCombo } from "../core/state.js";
import { loadConfig } from "../infra/config.js";
import { killWindowArgs, newWindowArgs, type TmuxResult } from "../infra/tmux.js";
import {
  buildCoderRespondingResumeCommand,
  buildReviewWatchCommand,
  readCoderThreadArtifact,
} from "../roles/coder-responding.js";

export interface ActivateCoderDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  tmux: (args: string[]) => TmuxResult;
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
