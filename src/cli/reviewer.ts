import { readEvents, type ComboEvent } from "../core/events.js";
import { runDirFor, readCombo } from "../core/state.js";
import { loadConfig } from "../infra/config.js";
import { newWindowArgs, type TmuxResult } from "../infra/tmux.js";
import { buildReviewerInvocation } from "../roles/reviewer.js";
import {
  REVIEWER_WATCH_WINDOW,
  REVIEWER_WINDOW,
  killWindowIfPresent,
} from "./sessions.js";
import { buildReviewerWatchCommand } from "./watchers.js";

export interface ActivateReviewerDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  tmux: (args: string[]) => TmuxResult;
}

export function activateReviewer(input: {
  deps: ActivateReviewerDeps;
  home: string;
  comboId: string;
  cli: string;
}): void {
  const { deps, home, comboId, cli } = input;
  const runDir = runDirFor(home, comboId);
  const combo = readCombo(runDir);
  const prUrl = latestOpenedPrUrl(runDir);
  if (!prUrl) {
    throw new Error(`Cannot activate reviewer for ${combo.id}: no pr_opened event in the journal`);
  }

  const config = loadConfig({ repoDir: combo.repoDir, env: deps.env });
  const reviewerCommand = buildReviewerInvocation({
    combo,
    prUrl,
    protocol: config.reviewerProtocol,
    reviewerCommand: config.reviewerCommand,
  });

  killWindowIfPresent(deps, combo, REVIEWER_WINDOW);
  killWindowIfPresent(deps, combo, REVIEWER_WATCH_WINDOW);

  const created = deps.tmux(newWindowArgs(combo.tmuxSession, REVIEWER_WINDOW, reviewerCommand));
  if (created.status !== 0) {
    throw new Error(
      `tmux failed to start reviewer in "${combo.tmuxSession}": ` +
        `${created.stderr.trim() || "unknown error"}`,
    );
  }

  const watcher = deps.tmux(
    newWindowArgs(
      combo.tmuxSession,
      REVIEWER_WATCH_WINDOW,
      buildReviewerWatchCommand({
        cli,
        comboHome: home,
        comboId: combo.id,
        pollSeconds: config.limits.babysitPollSeconds,
      }),
    ),
  );
  if (watcher.status !== 0) {
    throw new Error(
      `tmux failed to start reviewer watcher in "${combo.tmuxSession}": ` +
        `${watcher.stderr.trim() || "unknown error"}`,
    );
  }

  deps.out(`reviewer: ${config.reviewerAgent} reviewing ${prUrl} in ${combo.tmuxSession}:${REVIEWER_WINDOW}`);
  deps.out(`${REVIEWER_WATCH_WINDOW}: polling reviewer hard signals every ${config.limits.babysitPollSeconds}s`);
}

export function latestOpenedPrUrl(runDir: string): string | undefined {
  const events = readEvents(runDir);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.event === "pr_opened" && typeof event["url"] === "string") {
      return event["url"];
    }
  }
  return undefined;
}

export function livePinnedLgtmSha(events: ComboEvent[]): string | undefined {
  let sha: string | undefined;
  for (const event of events) {
    if (event.event === "lgtm" && typeof event["sha"] === "string") {
      sha = event["sha"];
    }
    if (event.event === "lgtm_stale" && event["old_sha"] === sha) {
      sha = undefined;
    }
  }
  return sha;
}

export function hasJournaledLgtm(events: ComboEvent[], sha: string): boolean {
  return events.some((event) => event.event === "lgtm" && event["sha"] === sha);
}

export function canonicalLgtmShaForHead(pinSha: string, headSha: string): string {
  return headSha.toLowerCase().startsWith(pinSha.toLowerCase()) ? headSha : pinSha;
}

export function terminalReviewerEvent(events: ComboEvent[]): ComboEvent | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.event === "combo_closed") return event;
  }
  return undefined;
}

export function hasMergedEvent(events: ComboEvent[], shas: string[]): boolean {
  const accepted = new Set(shas);
  return events.some((event) => event.event === "merged" && accepted.has(String(event["sha"])));
}
