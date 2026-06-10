/**
 * Phase derivation and the runner script.
 *
 * The runner is the combo's spine: a generated shell script that lives in
 * the run dir and executes inside the combo's tmux window. It sequences
 * rower → hodor → PR detection and reports every milestone to the journal
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
      case "rower_started":
        phase = "ROWING";
        needsHuman = false;
        break;
      case "hodor_started":
        phase = "GATING";
        needsHuman = false;
        break;
      case "pr_opened":
        phase = "JUDGING";
        needsHuman = false;
        pr = typeof event["url"] === "string" ? (event["url"] as string) : pr;
        break;
      case "rower_failed":
      case "hodor_failed":
        phase = "STALLED";
        needsHuman = true;
        reason = event.event;
        break;
      case "needs_human":
        needsHuman = true;
        reason = typeof event["reason"] === "string" ? (event["reason"] as string) : undefined;
        break;
      case "stopped":
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
  rowerCommand: string;
  hodorCommand: string;
  /** Full invocation prefix for emitting events, e.g. "node /x/cli.mjs emit -n <id>". */
  emit: string;
}

/**
 * Single-quote a value for POSIX shell so it stays a literal: paths with
 * spaces, branch names with apostrophes, anything. Trust boundary note:
 * rowerCommand/hodorCommand are operator-written config (they ARE shell,
 * like a Makefile recipe) and are inserted verbatim by design; every value
 * combo-chen derives itself (worktree, branch) goes through this.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function buildRunnerScript(input: RunnerInput): string {
  const { combo, rowerCommand, hodorCommand, emit } = input;
  return `#!/bin/sh
# combo-chen runner for ${combo.id} — generated, do not edit.
# Sequencing is mechanics; judgment stays with agents and humans.
set -u

cd ${shellQuote(combo.worktree)}

base_sha=$(git rev-parse HEAD)

${emit} rower_started

# stdin from /dev/null: interactive rower UIs key their keep-alive on a TTY
# (gnhf's final "ctrl+c to exit" screen). Without one, the rower finishes its
# work and exits with code 0 on its own, so the pipeline advances unattended.
if ${rowerCommand} < /dev/null; then
  ${emit} rower_done
else
  code=$?
  new_commits=$(git rev-list --count "$base_sha"..HEAD 2>/dev/null || echo 0)
  ${emit} rower_failed --field exit_code=$code --field new_commits=$new_commits
  exit $code
fi

${emit} hodor_started

if ${hodorCommand}; then
  :
else
  code=$?
  ${emit} hodor_failed --field exit_code=$code
  exit $code
fi

pr_url=$(gh pr list --head ${shellQuote(combo.branch)} --json url --jq '.[0].url' 2>/dev/null || true)
if [ -n "\${pr_url:-}" ]; then
  ${emit} pr_opened --field url="$pr_url"
  ${emit} needs_human --field reason=pr_ready
else
  ${emit} needs_human --field reason=pr_missing
fi
`;
}
