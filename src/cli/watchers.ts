/**
 * @overview Watch-loop command helpers. ~93 lines, 4 exports, director watcher shell.
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
 *   REVIEWER_TRANSIENT_FAILURE    Prefix watched as transient failure marker.
 *   reviewerTransientFailure      Format transient reviewer messages.
 *   buildDirectorWatchCommand     Render director-watch shell loop.
 *
 *   INTERNALS
 *   ---------
 *   REVIEWER_TRANSIENT_EXIT_CODE
 *
 * @exports resolvePollMs, REVIEWER_TRANSIENT_FAILURE, reviewerTransientFailure, buildDirectorWatchCommand
 * @deps ../core/combo
 */
import { shellQuote } from "../core/combo.js";

// -- 1/2 HELPER · Poll cadence and transient marker --
/** Poll cadence cascade: COMBO_CHEN_POLL_MS env -> core's in-code fallback. */
export function resolvePollMs(env: Record<string, string | undefined>): number | undefined {
  const raw = env["COMBO_CHEN_POLL_MS"];
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export const REVIEWER_TRANSIENT_FAILURE = "reviewer: transient_failure:";
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
  const emit = `${env} ${input.cli} emit -n ${shellQuote(input.comboId)}`;
  const failureLimit = Math.max(1, Math.trunc(input.watchFailureLimit));
  const maxBackoffSeconds = Math.max(1, Math.ceil(input.watchBackoffMaxSeconds));
  const backoffCapThreshold = Math.ceil(maxBackoffSeconds / 2);
  const initialBackoffSeconds = Math.min(maxBackoffSeconds, Math.max(0, Math.ceil(input.pollSeconds)));
  return [
    "failures=0",
    `backoff=${initialBackoffSeconds}`,
    "while :; do",
    `  output=$(${env} ${input.cli} director-tick -n ${shellQuote(input.comboId)} 2>&1)`,
    "  rc=$?",
    '  printf "%s\\n" "$output"',
    `  printf "%s\\n" "$output" | grep -Eq ${shellQuote("reviewer: (merged|closed|already terminal)")} && exit 0`,
    "  transient=0",
    `  printf "%s\\n" "$output" | grep -Eq ${shellQuote(`^${REVIEWER_TRANSIENT_FAILURE}`)} && transient=1`,
    '  if [ "$rc" -eq 0 ] && [ "$transient" -eq 0 ]; then',
    "    failures=0",
    `    backoff=${initialBackoffSeconds}`,
    `    sleep ${input.pollSeconds}`,
    "    continue",
    "  fi",
    '  failure_rc="$rc"',
    `  [ "$failure_rc" -eq 0 ] && failure_rc=${REVIEWER_TRANSIENT_EXIT_CODE}`,
    "  failures=$((failures + 1))",
    '  output_snippet=$(printf "%s\\n" "$output" | head -c 500)',
    '  output_snippet_escaped=$(printf \'%s\\n\' "$output_snippet" | sed "s/\'/\'\\\\\\\\\'\'/g")',
    `  ${emit} watch_error --field "exit_code=$failure_rc" --field "tick_exit_code=$rc" --field 'stderr='"$output_snippet_escaped" --field "consecutive_failures=$failures" --field "watcher=director" >/dev/null 2>&1 || true`,
    `  if [ "$failures" -ge ${failureLimit} ]; then`,
    `    ${emit} watch_dead --field "exit_code=$failure_rc" --field "tick_exit_code=$rc" --field 'stderr='"$output_snippet_escaped" --field "consecutive_failures=$failures" --field "watcher=director" >/dev/null 2>&1 || true`,
    '    exit "$failure_rc"',
    "  fi",
    '  sleep "$backoff"',
    `  if [ "$backoff" -ge ${backoffCapThreshold} ]; then backoff=${maxBackoffSeconds}; else backoff=$((backoff * 2)); fi`,
    "done",
  ].join("\n");
}
// -/ 2/2
