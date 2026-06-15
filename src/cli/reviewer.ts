/**
 * @overview Reviewer CLI helpers. ~312 lines, 10 exports, reviewer activation and poll tick.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at activateReviewer      <- starts reviewer and director-watch windows.
 *   2. Then tickReviewer              <- one merge/close/LGTM/re-review poll.
 *   3. Bottom helpers                 <- journal-derived PR/LGTM predicates.
 *
 *   MAIN FLOW
 *   ---------
 *   activateReviewer -> reviewer + director-watch windows; tickReviewer -> gh pr view -> journal events or re-review
 *
 *   PUBLIC API
 *   ----------
 *   ActivateReviewerDeps, TickReviewerDeps, activateReviewer, tickReviewer
 *   latestOpenedPrUrl, livePinnedLgtmSha, hasJournaledLgtm
 *   canonicalLgtmShaForHead, terminalReviewerEvent, hasMergedEvent
 *
 *   INTERNALS
 *   ---------
 *   none
 *
 * @exports ActivateReviewerDeps, TickReviewerDeps, activateReviewer, tickReviewer, latestOpenedPrUrl, livePinnedLgtmSha, hasJournaledLgtm, canonicalLgtmShaForHead, terminalReviewerEvent, hasMergedEvent
 * @deps ../core/{events,state}, ../infra/{config,tmux}, ../roles/reviewer, ./github, ./lifecycle, ./sessions, ./watchers
 */
import { appendEvent, readEvents, type ComboEvent } from "../core/events.js";
import { runDirFor, readCombo } from "../core/state.js";
import { loadConfig } from "../infra/config.js";
import { newWindowArgs, type TmuxResult } from "../infra/tmux.js";
import { buildReviewerInvocation, incrementalReviewerPrompt } from "../roles/reviewer.js";
import { latestGitHubLgtmSha, parsePrView, type PrView } from "./github.js";
import { teardownMergedCombo } from "./lifecycle.js";
import {
  REVIEWER_WATCH_WINDOW,
  DIRECTOR_WATCH_WINDOW,
  REVIEWER_WINDOW,
  killComboSession,
  killWindowIfPresent,
} from "./sessions.js";
import { buildDirectorWatchCommand, reviewerTransientFailure } from "./watchers.js";

// -- 1/4 HELPER · Dependency contracts --
export interface ActivateReviewerDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  tmux: (args: string[]) => TmuxResult;
}

export interface TickReviewerDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  tmux: (args: string[]) => TmuxResult;
  git: (args: string[], cwd: string) => { status: number; stdout: string; stderr: string };
  gh: (args: string[]) => { status: number; stdout: string; stderr: string };
  sleep: (ms: number) => Promise<void>;
}
// -/ 1/4

// -- 2/4 CORE · activateReviewer <- START HERE --
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
  killWindowIfPresent(deps, combo, DIRECTOR_WATCH_WINDOW);

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
      DIRECTOR_WATCH_WINDOW,
      buildDirectorWatchCommand({
        cli,
        comboHome: home,
        comboId: combo.id,
        pollSeconds: config.limits.babysitPollSeconds,
        watchFailureLimit: config.limits.watchFailureLimit,
        watchBackoffMaxSeconds: config.limits.watchBackoffMaxSeconds,
      }),
    ),
  );
  if (watcher.status !== 0) {
    throw new Error(
      `tmux failed to start director watcher in "${combo.tmuxSession}": ` +
        `${watcher.stderr.trim() || "unknown error"}`,
    );
  }

  deps.out(`reviewer: ${config.reviewerAgent} reviewing ${prUrl} in ${combo.tmuxSession}:${REVIEWER_WINDOW}`);
  deps.out(`${DIRECTOR_WATCH_WINDOW}: polling combo hard signals every ${config.limits.babysitPollSeconds}s`);
}
// -/ 2/4

// -- 3/4 CORE · tickReviewer --
export async function tickReviewer(input: {
  deps: TickReviewerDeps;
  home: string;
  comboId: string;
}): Promise<void> {
  const { deps, home, comboId } = input;
  const runDir = runDirFor(home, comboId);
  const combo = readCombo(runDir);
  const prUrl = latestOpenedPrUrl(runDir);
  if (!prUrl) {
    throw new Error(`Cannot tick reviewer for ${combo.id}: no pr_opened event in the journal`);
  }

  let events = readEvents(runDir);
  const terminalEvent = terminalReviewerEvent(events);
  if (terminalEvent) {
    deps.out(`reviewer: already terminal at ${terminalEvent.event}`);
    return;
  }

  const pr = deps.gh(["pr", "view", prUrl, "--json", "headRefOid,state,mergedBy,baseRefName,mergeCommit"]);
  if (pr.status !== 0) {
    deps.out(
      reviewerTransientFailure(
        `gh pr view failed for ${combo.id} (status ${pr.status}): ${pr.stderr.trim() || "unknown error"}`,
      ),
    );
    return;
  }

  let prView: PrView;
  try {
    prView = parsePrView(pr.stdout);
  } catch (error) {
    deps.out(
      reviewerTransientFailure(
        `failed to parse PR data for ${combo.id}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return;
  }
  const headSha = prView.headSha;

  if (prView.state === "MERGED") {
    const by = prView.mergedBy ?? "unknown";
    const mergeSha = prView.mergeSha;
    if (!mergeSha) {
      throw new Error(`Cannot tear down ${combo.id}: merged PR did not report mergeCommit.oid`);
    }
    const baseRefName = prView.baseRefName;
    if (!baseRefName) {
      throw new Error(`Cannot tear down ${combo.id}: merged PR did not report baseRefName`);
    }
    if (!hasMergedEvent(events, [mergeSha, headSha])) {
      appendEvent(runDir, "merged", { sha: mergeSha, by });
    }
    const config = loadConfig({ repoDir: combo.repoDir });
    try {
      await teardownMergedCombo({
        deps,
        combo,
        mergeSha,
        baseRefName,
        retries: config.limits.teardownGitRetries,
        backoffSeconds: config.limits.teardownGitBackoffSeconds,
      });
    } catch (error) {
      deps.out(
        `reviewer: teardown pending for ${combo.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    appendEvent(runDir, "combo_closed", {});
    deps.out(`reviewer: merged ${mergeSha} by ${by}`);
    killComboSession(deps, combo);
    return;
  }

  if (prView.state === "CLOSED") {
    appendEvent(runDir, "needs_human", { reason: "pr_closed" });
    appendEvent(runDir, "combo_closed", {});
    deps.out(`reviewer: closed`);
    killComboSession(deps, combo);
    return;
  }

  let githubPinnedSha: string | undefined;
  try {
    githubPinnedSha = latestGitHubLgtmSha(deps.gh, prUrl);
  } catch (error) {
    deps.out(
      reviewerTransientFailure(
        `failed to read LGTM pins for ${combo.id}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return;
  }
  if (githubPinnedSha) {
    const canonicalPinnedSha = canonicalLgtmShaForHead(githubPinnedSha, headSha);
    if (!hasJournaledLgtm(events, canonicalPinnedSha)) {
      appendEvent(runDir, "lgtm", { sha: canonicalPinnedSha });
      events = readEvents(runDir);
    }
  }

  const pinnedSha = livePinnedLgtmSha(events);
  if (!pinnedSha) {
    deps.out(`reviewer: no pinned lgtm for ${combo.id}`);
    return;
  }
  if (pinnedSha === headSha) {
    deps.out(`reviewer: lgtm current at ${headSha}`);
    return;
  }

  const config = loadConfig({ repoDir: combo.repoDir, env: deps.env });
  const reviewerCommand = buildReviewerInvocation({
    combo,
    prUrl,
    protocol: config.reviewerProtocol,
    reviewerCommand: config.reviewerCommand,
    prompt: incrementalReviewerPrompt({
      combo,
      prUrl,
      protocol: config.reviewerProtocol,
      oldSha: pinnedSha,
      newSha: headSha,
    }),
  });

  killWindowIfPresent(deps, combo, REVIEWER_WINDOW);

  const created = deps.tmux(newWindowArgs(combo.tmuxSession, REVIEWER_WINDOW, reviewerCommand));
  if (created.status !== 0) {
    throw new Error(
      `tmux failed to start reviewer re-review in "${combo.tmuxSession}": ` +
        `${created.stderr.trim() || "unknown error"}`,
    );
  }

  appendEvent(runDir, "lgtm_stale", { old_sha: pinnedSha, new_sha: headSha });
  deps.out(`reviewer: lgtm_stale ${pinnedSha} -> ${headSha}; re-reviewing ${prUrl}`);
}
// -/ 3/4

// -- 4/4 HELPER · Journal and LGTM predicates --
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
// -/ 4/4
