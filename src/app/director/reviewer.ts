/**
 * @overview Reviewer lifecycle services for activation and terminal PR observation.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at activateReviewer      <- starts lifecycle observation, never a GitHub reviewer.
 *   2. Then tickReviewer              <- observes merge/close only; local files own verdicts.
 *   3. Bottom helpers                 <- journal-derived PR/LGTM predicates.
 *
 *   MAIN FLOW
 *   ---------
 *   activateReviewer -> director-watch; tickReviewer -> gh pr view -> terminal lifecycle events
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
 *   journal-derived lifecycle and local-LGTM predicates
 *
 * @exports ActivateReviewerDeps, TickReviewerDeps, activateReviewer, tickReviewer, latestOpenedPrUrl, livePinnedLgtmSha, hasJournaledLgtm, canonicalLgtmShaForHead, terminalReviewerEvent, hasMergedEvent, closurePendingReviewerEvent
 * @deps ../../core/events, ../../core/runtime-ledger, ../../core/state, ../../infra/config, ../../infra/config-snapshot, ../../infra/tmux, ../../roles/director-invocation, ../github/github, ../runtime/sessions, ./watchers
 */
import { appendEvent, latestPrUrlFromEvents, readEvents, type ComboEvent } from "../../core/events.js";
import { updateRuntimeLedger } from "../../core/runtime-ledger.js";
import { runDirFor, readCombo } from "../../core/state.js";
import { isCapsuleEngine } from "../../infra/config.js";
import { loadRuntimeConfig } from "../../infra/config-snapshot.js";
import type { TmuxResult } from "../../infra/tmux.js";
import { buildDirectorInvocation } from "../../roles/director-invocation.js";
import { parsePrView, type PrView } from "../github/github.js";
import {
  REVIEWER_WATCH_WINDOW,
  DIRECTOR_WINDOW,
  DIRECTOR_WATCH_WINDOW,
  ensureWindowPresent,
  killComboSession,
  killWindowIfPresent,
} from "../runtime/sessions.js";
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

  const config = loadRuntimeConfig(runDir, { repoDir: combo.repoDir, env: deps.env });
  ensureWindowPresent(
    deps,
    combo,
    DIRECTOR_WINDOW,
    buildDirectorInvocation({ combo, directorCommand: config.directorCommand }),
  );
  killWindowIfPresent(deps, combo, REVIEWER_WATCH_WINDOW);

  // Capsule-engine combos are supervised by the in-process supervisor in the
  // capsule pane; only v0 combos get the generated director-watch shell loop.
  const capsuleEngine = isCapsuleEngine(config);
  if (!capsuleEngine) {
    ensureWindowPresent(
      deps,
      combo,
      DIRECTOR_WATCH_WINDOW,
      buildDirectorWatchCommand({
        cli,
        comboHome: home,
        comboId: combo.id,
        pollSeconds: config.limits.babysitPollSeconds,
        watchFailureLimit: config.limits.watchFailureLimit,
        watchBackoffMaxSeconds: config.limits.watchBackoffMaxSeconds,
      }),
    );
  }

  updateRuntimeLedger(runDir, {
    cli,
    prUrl,
    roleWindows: {
      director: DIRECTOR_WINDOW,
      ...(capsuleEngine ? {} : { directorWatch: DIRECTOR_WATCH_WINDOW }),
    },
  });
  deps.out(`reviewer: local review complete; observing ${prUrl}`);
}
// -/ 2/4

// -- 3/4 CORE · tickReviewer --
export async function tickReviewer(input: {
  deps: TickReviewerDeps;
  home: string;
  comboId: string;
  ghApiCache?: unknown;
}): Promise<void> {
  const { deps, home, comboId } = input;
  const runDir = runDirFor(home, comboId);
  const combo = readCombo(runDir);
  const prUrl = latestOpenedPrUrl(runDir);
  if (!prUrl) {
    throw new Error(`Cannot tick reviewer for ${combo.id}: no pr_opened event in the journal`);
  }

  const events = readEvents(runDir);
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
      deps.out(
        reviewerTransientFailure(
          `merged PR data missing mergeCommit.oid for ${combo.id}; will retry on next tick`,
        ),
      );
      return;
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

  const pinnedSha = livePinnedLgtmSha(events);
  if (!pinnedSha) {
    deps.out(`reviewer: awaiting local verdict for ${combo.id}`);
    return;
  }
  if (pinnedSha === headSha) {
    deps.out(`reviewer: local lgtm current at ${headSha}`);
    return;
  }
  deps.out(`reviewer: local lgtm stale ${pinnedSha} -> ${headSha}`);
}
// -/ 3/4

// -- 4/4 HELPER · Journal and LGTM predicates --
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
