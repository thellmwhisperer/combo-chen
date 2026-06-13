/**
 * Phase derivation and the runner script.
 *
 * The runner is the combo's spine: a generated shell script that lives in
 * the run dir and executes inside the combo's tmux window. It sequences
 * coder → gatekeeper → PR detection and reports every milestone to the journal
 * through `combo-chen emit`, so status/events stay truthful even if the
 * conductor CLI exited long ago. No daemon, no hidden state.
 */
import type { ComboEvent } from "./events.js";
import type { ComboRecord } from "./state.js";

export type Phase = "SETUP" | "ROWING" | "GATING" | "JUDGING" | "STOPPED" | "STALLED";

export interface ComboStatus {
  phase: Phase;
  needsHuman: boolean;
  reason?: string;
  pr?: string;
  lastEvent?: ComboEvent;
}

export function deriveStatus(events: ComboEvent[]): ComboStatus {
  let phase: Phase = "SETUP";
  let needsHuman = false;
  let reason: string | undefined;
  let pr: string | undefined;

  for (const event of events) {
    switch (event.event) {
      case "coder_started":
        phase = "ROWING";
        needsHuman = false;
        break;
      case "gate_started":
        phase = "GATING";
        needsHuman = false;
        break;
      case "pr_opened":
        phase = "JUDGING";
        needsHuman = false;
        pr = typeof event["url"] === "string" ? (event["url"] as string) : pr;
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

/**
 * Single-quote a value for POSIX shell so it stays a literal: paths with
 * spaces, branch names with apostrophes, anything. Trust boundary note:
 * Coder and gatekeeper commands are operator-written config (they ARE
 * shell, like a Makefile recipe). Gatekeeper commands with {placeholders}
 * are expanded with shell-quoted values at generation time; commands
 * without placeholders stay verbatim. Every value combo-chen derives
 * itself (worktree, branch) goes through this.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

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
