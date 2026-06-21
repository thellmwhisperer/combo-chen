/**
 * @overview Reviewer CLI helpers. ~335 lines, 11 exports, reviewer activation and poll tick.
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
 *   closurePendingReviewerEvent
 *
 *   INTERNALS
 *   ---------
 *   reviewerWorkPlan, hasCompleteWorkItemMetadata
 *
 * @exports ActivateReviewerDeps, TickReviewerDeps, activateReviewer, tickReviewer, latestOpenedPrUrl, livePinnedLgtmSha, hasJournaledLgtm, canonicalLgtmShaForHead, terminalReviewerEvent, hasMergedEvent, closurePendingReviewerEvent
 * @deps ../core/{events,gh-api,state,work-plan}, ../infra/{config-snapshot,tmux}, ../roles/reviewer, ./github, ./sessions, ./watchers, ./work-plan
 */
import { appendEvent, latestPrUrlFromEvents, readEvents, type ComboEvent } from "../core/events.js";
import type { GhApiCache } from "../core/gh-api.js";
import { cleanOptional, runDirFor, readCombo, type ComboRecord } from "../core/state.js";
import type { WorkPlan } from "../core/work-plan.js";
import { loadRuntimeConfig } from "../infra/config-snapshot.js";
import { newWindowArgs, type TmuxResult } from "../infra/tmux.js";
import { buildReviewerInvocation, incrementalReviewerPrompt } from "../roles/reviewer.js";
import { latestGitHubLgtmSha, parsePrView, type PrView } from "./github.js";
import {
  REVIEWER_WATCH_WINDOW,
  DIRECTOR_WATCH_WINDOW,
  REVIEWER_WINDOW,
  killComboSession,
  killWindowIfPresent,
} from "./sessions.js";
import { buildDirectorWatchCommand, reviewerTransientFailure } from "./watchers.js";
import { readPersistedWorkPlan } from "./work-plan.js";

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

  const config = loadRuntimeConfig(runDir, { repoDir: combo.repoDir, env: deps.env });
  const workPlan = reviewerWorkPlan(runDir, combo);
  const reviewerCommand = buildReviewerInvocation({
    combo,
    prUrl,
    reviewerInstructions: config.reviewerPrompt,
    reviewerCommand: config.reviewerCommand,
    workPlan,
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
    try {
      killWindowIfPresent(deps, combo, REVIEWER_WINDOW);
    } catch {
      // Preserve the watcher-start failure as the primary error.
    }
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
  ghApiCache?: GhApiCache;
}): Promise<void> {
  const { deps, home, comboId, ghApiCache } = input;
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

  const pr = deps.gh(["pr", "view", prUrl, "--json", "headRefOid,state,mergedAt,mergedBy,mergeCommit"]);
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
      throw new Error(`Cannot report merged ${combo.id}: merged PR did not report mergeCommit.oid`);
    }
    if (!hasMergedEvent(events, [mergeSha, headSha])) {
      appendEvent(runDir, "merged", {
        sha: mergeSha,
        by,
        ...(prView.mergedAt !== undefined ? { mergedAt: prView.mergedAt } : {}),
        source: "reviewer",
      });
    }
    deps.out(`reviewer: merged ${mergeSha} by ${by}; closure pending: combo-chen closure -n ${combo.id}`);
    return;
  }

  if (prView.state === "CLOSED") {
    appendEvent(runDir, "needs_human", { reason: "pr_closed" });
    appendEvent(runDir, "combo_closed", {});
    deps.out(`reviewer: closed`);
    killComboSession(deps, combo);
    return;
  }

  const config = loadRuntimeConfig(runDir, { repoDir: combo.repoDir, env: deps.env });
  let githubPinnedSha: string | undefined;
  try {
    githubPinnedSha = latestGitHubLgtmSha(deps.gh, prUrl, ghApiCache, {
      allowedAuthors: config.reviewerLogins,
    });
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

  const reviewerCommand = buildReviewerInvocation({
    combo,
    prUrl,
    reviewerInstructions: config.reviewerPrompt,
    reviewerCommand: config.reviewerCommand,
    prompt: incrementalReviewerPrompt({
      combo,
      prUrl,
      reviewerInstructions: config.reviewerPrompt,
      workPlan: reviewerWorkPlan(runDir, combo),
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
function reviewerWorkPlan(runDir: string, combo: ComboRecord): WorkPlan | undefined {
  const hasWorkItemMetadata = hasCompleteWorkItemMetadata(combo);
  try {
    return readPersistedWorkPlan(runDir, combo);
  } catch (error) {
    if (!hasWorkItemMetadata) return undefined;
    throw error;
  }
}

function hasCompleteWorkItemMetadata(combo: ComboRecord): boolean {
  const reference = cleanOptional(combo.workItemSourceReference) ?? (
    combo.workItemSourceType === "github_issue" ? cleanOptional(combo.issueUrl) : undefined
  );
  return combo.workItemSourceType !== undefined && reference !== undefined;
}

export function latestOpenedPrUrl(runDir: string): string | undefined {
  return latestPrUrlFromEvents(readEvents(runDir));
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

export function closurePendingReviewerEvent(events: ComboEvent[]): ComboEvent | undefined {
  let pending: ComboEvent | undefined;
  for (const event of events) {
    if (event.event === "merged") pending = event;
    if (event.event === "combo_closed") pending = undefined;
  }
  return pending;
}

export function hasMergedEvent(events: ComboEvent[], shas: string[]): boolean {
  const accepted = new Set(shas);
  return events.some((event) => event.event === "merged" && accepted.has(String(event["sha"])));
}
// -/ 4/4
