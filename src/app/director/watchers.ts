/**
 * @overview Watch-loop command helpers. ~93 lines, 3 exports, director watcher shell.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at buildDirectorWatchCommand <- renders retry/backoff shell loop.
 *   2. Use reviewerTransientFailure       <- marker emitted by reviewer-tick.
 *   3. resolvePollMs                      <- optional events --follow cadence.
 *
 *   MAIN FLOW
 *   ---------
 *   director-tick output -> terminal/transient detection -> watch_error/watch_dead or sleep
 *
 *   PUBLIC API
 *   ----------
 *   resolvePollMs                 Parse COMBO_CHEN_POLL_MS.
 *   reviewerTransientFailure      Format transient reviewer messages.
 *   buildDirectorWatchCommand     Render director-watch shell loop.
 *
 *   INTERNALS
 *   ---------
 *   REVIEWER_TRANSIENT_FAILURE, REVIEWER_TRANSIENT_EXIT_CODE
 *
 * @exports resolvePollMs, reviewerTransientFailure, buildDirectorWatchCommand
 * @deps ../../core/combo, ../../shell/templates
 */
import { shellQuote } from "../../core/combo.js";
import { renderShellTemplate } from "../../shell/templates.js";

// -- 1/2 HELPER · Poll cadence and transient marker --
/** Poll cadence cascade: COMBO_CHEN_POLL_MS env -> core's in-code fallback. */
export function resolvePollMs(env: Record<string, string | undefined>): number | undefined {
  const raw = env["COMBO_CHEN_POLL_MS"];
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

const REVIEWER_TRANSIENT_FAILURE = "reviewer: transient_failure:";
const REVIEWER_TRANSIENT_EXIT_CODE = 75;

export function reviewerTransientFailure(message: string): string {
  return `${REVIEWER_TRANSIENT_FAILURE} ${message}`;
}
// -/ 1/2

// -- 2/2 CORE · buildDirectorWatchCommand <- START HERE --
export function buildDirectorWatchCommand(input: {
  cli: string;
  comboHome: string;
  comboId: string;
  pollSeconds: number;
  watchFailureLimit: number;
  watchBackoffMaxSeconds: number;
}): string {
  const env = `COMBO_CHEN_HOME=${shellQuote(input.comboHome)}`;
  const failureLimit = Math.max(1, Math.trunc(input.watchFailureLimit));
  const maxBackoffSeconds = Math.max(1, Math.ceil(input.watchBackoffMaxSeconds));
  const backoffCapThreshold = Math.ceil(maxBackoffSeconds / 2);
  const initialBackoffSeconds = Math.min(maxBackoffSeconds, Math.max(0, Math.ceil(input.pollSeconds)));
  return renderShellTemplate("director-watch-loop", {
    __INITIAL_BACKOFF__: String(initialBackoffSeconds),
    __TICK_COMMAND__: `${env} ${input.cli} director-tick -n ${shellQuote(input.comboId)}`,
    __TERMINAL_PATTERN__: shellQuote("reviewer: (merged|closed|already terminal)"),
    __TRANSIENT_PATTERN__: shellQuote(`^${REVIEWER_TRANSIENT_FAILURE}`),
    __POLL_SECONDS__: String(input.pollSeconds),
    __TRANSIENT_EXIT_CODE__: String(REVIEWER_TRANSIENT_EXIT_CODE),
    __EMIT__: `${env} ${input.cli} emit -n ${shellQuote(input.comboId)}`,
    __FAILURE_LIMIT__: String(failureLimit),
    __BACKOFF_CAP_THRESHOLD__: String(backoffCapThreshold),
    __MAX_BACKOFF__: String(maxBackoffSeconds),
  }).trimEnd();
}
// -/ 2/2
