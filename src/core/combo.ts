/**
 * @overview Core logic: phase state machine + runner script generator.
 *   188 lines, 3 exports, 1 critical function.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at buildRunnerScript    ← generates runner.sh, the combo spine
 *   2. deriveStatus                  ← event → phase state machine
 *   3. shellQuote                    ← POSIX-safe shell quoting
 *
 *   MAIN FLOW (called from cli/main.ts)
 *   ───────────────────────────────────
 *   main.run()
 *     → buildRunnerScript(input)     ← generates the shell script
 *       → shellQuote() for safety
 *     → writes runner.sh to disk
 *     → tmux executes it
 *
 *   runner.sh lifecycle (what buildRunnerScript generates):
 *     coder_started → coderCommand → coder_done
 *     → gate_started → gatekeeperCommand → pr_opened
 *     → activateCoder + activateReviewer → needs_human
 *
 *   ┌─ CORE ─────────────────────────────────────────────────────────┐
 *   │ buildRunnerScript   Generates the runner shell script          │
 *   │ shellQuote           POSIX-safe single-quoting                 │
 *   ├─ PHASE DERIVATION ────────────────────────────────────────────┤
 *   │ deriveStatus         Maps event journal → ComboStatus          │
 *   │ Phase                "SETUP"|"CODING"|"GATING"|"REVIEWING"...  │
 *   │ ComboStatus          {phase, needsHuman, reason?, pr?}         │
 *   │ RunnerInput          Input shape for buildRunnerScript         │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * @exports buildRunnerScript, deriveStatus, shellQuote, Phase, ComboStatus, RunnerInput
 * @deps ./events, ./state
 */
import type { ComboEvent } from "./events.js";
import type { ComboRecord } from "./state.js";

export type Phase = "SETUP" | "CODING" | "GATING" | "REVIEWING" | "READY" | "STOPPED" | "STALLED";

export interface ComboStatus {
  phase: Phase;
  needsHuman: boolean;
  reason?: string;
  pr?: string;
  lastEvent?: ComboEvent;
}

// -- 1/3 HELPER · Phase derivation + types --

export function deriveStatus(events: ComboEvent[]): ComboStatus {
  let phase: Phase = "SETUP";
  let needsHuman = false;
  let reason: string | undefined;
  let pr: string | undefined;

  for (const event of events) {
    switch (event.event) {
      case "coder_started":
        phase = "CODING";
        needsHuman = false;
        break;
      case "gate_started":
        phase = "GATING";
        needsHuman = false;
        break;
      case "pr_opened":
        phase = "REVIEWING";
        needsHuman = false;
        pr = typeof event["url"] === "string" ? (event["url"] as string) : pr;
        break;
      case "address_done":
      case "address_noop":
      case "gate_stale":
      case "lgtm_stale":
        if (phase === "READY") {
          phase = "REVIEWING";
          needsHuman = false;
        }
        break;
      case "ready_for_merge":
        phase = "READY";
        needsHuman = false;
        pr = typeof event["pr_url"] === "string" ? (event["pr_url"] as string) : pr;
        break;
      case "coder_failed":
      case "gate_failed":
        phase = "STALLED";
        needsHuman = true;
        reason = event.event;
        break;
      case "needs_human":
        needsHuman = true;
        reason = typeof event["reason"] === "string" ? (event["reason"] as string) : undefined;
        break;
      case "stopped":
      case "merged":
      case "combo_closed":
        phase = "STOPPED";
        needsHuman = false;
        break;
      default:
        break;
    }
  }

  const status: ComboStatus = { phase, needsHuman };
  if (reason !== undefined && needsHuman) status.reason = reason;
  if (pr !== undefined) status.pr = pr;
  const last = events[events.length - 1];
  if (last !== undefined) status.lastEvent = last;
  return status;
}

// -/ 1/3

// -- 2/3 HELPER · RunnerInput + shellQuote --

export interface RunnerInput {
  combo: ComboRecord;
  coderCommand: string;
  gatekeeperCommand: string;
  /** Full invocation for creating the resumed coder and its comment watcher. */
  activateCoder: string;
  /** Full invocation prefix for emitting events, e.g. "node /x/cli.mjs emit -n <id>". */
  emit: string;
  /** Full invocation for starting the reviewer loop after a PR has been journaled. */
  activateReviewer: string;
  /** Full invocation prefix for ensuring the PR body visibly autocloses the source issue. */
  ensurePrAutoclose?: string;
}

//    POSIX-safe single-quoting. Paths, branch names, anything.
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// -/ 2/3

// -- 3/3 CORE · buildRunnerScript ← START HERE --

export function buildRunnerScript(input: RunnerInput): string {
  const {
    combo,
    coderCommand,
    gatekeeperCommand,
    emit,
    activateCoder,
    activateReviewer,
    ensurePrAutoclose = ":",
  } = input;
  return `#!/bin/sh
# combo-chen runner for ${combo.id} — generated, do not edit.
# Sequencing is mechanics; judgment stays with agents and humans.
set -u
coder_log="$(dirname "$0")/coder.log"
gatekeeper_log="$(dirname "$0")/gatekeeper.log"
autoclose_log="$(dirname "$0")/autoclose.log"

cd ${shellQuote(combo.worktree)}
coder_base_sha=$(git rev-parse HEAD 2>/dev/null || true)

${emit} coder_started

if (
  ${coderCommand}
) > "$coder_log" 2>&1; then
  ${emit} coder_done
else
  code=$?
  coder_head_sha=$(git rev-parse HEAD 2>/dev/null || true)
  new_commit_count=0
  if [ -n "$coder_base_sha" ] && [ -n "$coder_head_sha" ]; then
    new_commit_count=$(git rev-list --count "$coder_base_sha..$coder_head_sha" 2>/dev/null || printf '0')
  fi
  case "$new_commit_count" in
    ""|*[!0-9]*) new_commit_count=0 ;;
  esac
  if [ "$new_commit_count" -gt 0 ]; then
    has_new_commits=true
  else
    has_new_commits=false
  fi
  ${emit} coder_failed --field exit_code=$code --field has_new_commits=$has_new_commits --field base_sha=$coder_base_sha --field head_sha=$coder_head_sha --field new_commit_count=$new_commit_count
  exit $code
fi

${emit} gate_started
gatekeeper_start_sha=$(git rev-parse HEAD 2>/dev/null || true)
${emit} gate_status --field state=fix_inflight --field head_sha="$gatekeeper_start_sha"

gatekeeper_code=0
(
  ${gatekeeperCommand}
) > "$gatekeeper_log" 2>&1 || gatekeeper_code=$?

if grep -Eq '^outcome:[[:space:]]*awaiting_approval[[:space:]]*$' "$gatekeeper_log"; then
  gatekeeper_head_sha=$(git rev-parse HEAD 2>/dev/null || true)
  ${emit} gate_status --field state=awaiting_approval --field head_sha="$gatekeeper_head_sha"
  ${emit} needs_human --field reason=gate_waiting
  exit 0
fi

if [ "$gatekeeper_code" -ne 0 ]; then
  gatekeeper_head_sha=$(git rev-parse HEAD 2>/dev/null || true)
  ${emit} gate_status --field state=failed --field head_sha="$gatekeeper_head_sha"
  ${emit} gate_failed --field exit_code=$gatekeeper_code
  exit $gatekeeper_code
fi

gatekeeper_head_sha=$(git rev-parse HEAD 2>/dev/null || true)
${emit} gate_status --field state=idle --field head_sha="$gatekeeper_head_sha"

pr_url=$(gh pr list --head ${shellQuote(combo.branch)} --json url --jq '.[0].url' 2>/dev/null || true)
if [ -n "\${pr_url:-}" ]; then
  if ${ensurePrAutoclose} "$pr_url" > "$autoclose_log" 2>&1; then
    :
  else
    autoclose_code=$?
    printf '%s\\n' "autoclose guard skipped with exit code $autoclose_code" >> "$autoclose_log"
  fi
  ${emit} pr_opened --field url="$pr_url"
  ${activateCoder}
  ${activateReviewer}
  ${emit} needs_human --field reason=pr_ready
else
  ${emit} needs_human --field reason=pr_missing
fi
`;
}
// -/ 3/3
