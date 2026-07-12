/**
 * @overview In-process event-driven supervisor for capsule-engine combos. It
 *   replaces the generated director-watch shell loop: the process sleeps on
 *   journal file events, keeps a GitHub sampling timer, and derives terminal
 *   exit from the journal instead of grepping tick stdout.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at superviseCapsuleCombo  <- tick/wake loop with watch_error accounting.
 *   2. Then waitForJournalWake         <- fs.watch wake with the poll fallback.
 *
 *   MAIN FLOW
 *   ---------
 *   capsule CLI -> superviseCapsuleCombo -> tickDirector -> combo_closed exit
 *     tick failure -> watch_error journal + backoff -> watch_dead at the limit
 *
 *   PUBLIC API
 *   ----------
 *   SuperviseCapsuleInput   Inputs and injectable tick/wake seams.
 *   superviseCapsuleCombo   Supervise one capsule combo until terminal.
 *   waitForJournalWake      Sleep until the journal changes or the timer fires.
 *
 *   INTERNALS
 *   ---------
 *   failureDetail. Reviewer transient-failure markers are ordinary tick output
 *   here: only a thrown tick counts as a watch failure, so the v0 stdout
 *   marker/regex contract has no in-process equivalent.
 *
 * @exports SuperviseCapsuleInput, superviseCapsuleCombo, waitForJournalWake
 * @deps node:fs, ../../core/events, ../../core/state, ../../infra/config-snapshot, ./director, ./reviewer
 */
import { statSync, watch, type FSWatcher } from "node:fs";

import { appendEvent, journalPath, readEvents } from "../../core/events.js";
import { readCombo, runDirFor } from "../../core/state.js";
import { loadRuntimeConfig } from "../../infra/config-snapshot.js";
import { tickDirector, type DirectorDeps } from "./director.js";
import { terminalReviewerEvent } from "./reviewer.js";

// -- 1/2 CORE · superviseCapsuleCombo <- START HERE --
export interface SuperviseCapsuleInput {
  deps: DirectorDeps;
  home: string;
  comboId: string;
  cli: string;
  /** One observer pass; defaults to tickDirector. */
  tick?: (input: { deps: DirectorDeps; home: string; comboId: string; cli: string }) => Promise<void>;
  /** Sleep until the journal changes or the GitHub sampling timer fires. */
  waitForWake?: (input: { runDir: string; timeoutMs: number }) => Promise<void>;
}

function failureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

export async function superviseCapsuleCombo(input: SuperviseCapsuleInput): Promise<number> {
  const { deps, home, comboId, cli } = input;
  const tick = input.tick ?? tickDirector;
  const waitForWake = input.waitForWake ?? waitForJournalWake;
  const runDir = runDirFor(home, comboId);
  const combo = readCombo(runDir);
  const config = loadRuntimeConfig(runDir, { repoDir: combo.repoDir, env: deps.env });

  // Retry/backoff parity with the retired director-watch-loop.sh template.
  const failureLimit = Math.max(1, Math.trunc(config.limits.watchFailureLimit));
  const maxBackoffSeconds = Math.max(1, Math.ceil(config.limits.watchBackoffMaxSeconds));
  const backoffCapThreshold = Math.ceil(maxBackoffSeconds / 2);
  const initialBackoffSeconds = Math.min(
    maxBackoffSeconds,
    Math.max(0, Math.ceil(config.limits.babysitPollSeconds)),
  );

  if (terminalReviewerEvent(readEvents(runDir)) !== undefined) {
    deps.out(`supervisor: ${comboId} already terminal (combo_closed); nothing to supervise`);
    return 0;
  }

  let failures = 0;
  let backoffSeconds = initialBackoffSeconds;
  while (true) {
    try {
      await tick({ deps, home, comboId, cli });
    } catch (error) {
      failures += 1;
      const detail = failureDetail(error);
      appendEvent(runDir, "watch_error", {
        exit_code: 1,
        stderr: detail,
        consecutive_failures: failures,
        watcher: "director",
      });
      deps.out(`supervisor: director tick failed (${failures}/${failureLimit}): ${detail}`);
      if (failures >= failureLimit) {
        appendEvent(runDir, "watch_dead", {
          exit_code: 1,
          stderr: detail,
          consecutive_failures: failures,
          watcher: "director",
        });
        deps.out(`supervisor: watch_dead for ${comboId} after ${failures} consecutive tick failures`);
        return 1;
      }
      await deps.sleep(backoffSeconds * 1000);
      backoffSeconds = backoffSeconds >= backoffCapThreshold ? maxBackoffSeconds : backoffSeconds * 2;
      continue;
    }
    failures = 0;
    backoffSeconds = initialBackoffSeconds;
    if (terminalReviewerEvent(readEvents(runDir)) !== undefined) {
      deps.out(`supervisor: ${comboId} terminal (combo_closed); exiting`);
      return 0;
    }
    await waitForWake({ runDir, timeoutMs: config.limits.babysitPollSeconds * 1000 });
  }
}
// -/ 1/2

// -- 2/2 HELPER · waitForJournalWake --
/**
 * Resolve when the journal file changes or after timeoutMs (the GitHub
 * sampling timer; GitHub has no push channel, so a bounded tick cadence
 * legitimately remains). Prefers fs.watch; where fs.watch is unavailable or
 * errors (network volumes; see the followEvents portability note in
 * core/events), it falls back to the same 500 ms size poll.
 */
export function waitForJournalWake(input: {
  runDir: string;
  timeoutMs: number;
  pollMs?: number;
}): Promise<void> {
  const pollMs = input.pollMs ?? 500;
  const path = journalPath(input.runDir);
  const sizeOf = (): number => {
    try {
      return statSync(path).size;
    } catch {
      return -1;
    }
  };
  return new Promise((resolve) => {
    let watcher: FSWatcher | undefined;
    let poller: ReturnType<typeof setInterval> | undefined;
    const timer = setTimeout(finish, input.timeoutMs);
    function finish(): void {
      clearTimeout(timer);
      if (poller !== undefined) clearInterval(poller);
      watcher?.close();
      resolve();
    }
    function startPolling(): void {
      const initialSize = sizeOf();
      poller = setInterval(() => {
        if (sizeOf() !== initialSize) finish();
      }, pollMs);
    }
    try {
      watcher = watch(path, finish);
      watcher.on("error", () => {
        watcher?.close();
        watcher = undefined;
        startPolling();
      });
    } catch {
      startPolling();
    }
  });
}
// -/ 2/2
