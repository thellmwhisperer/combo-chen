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

export function buildRunnerScript(input: RunnerInput): string {
  const { combo, rowerCommand, hodorCommand, emit } = input;
  return `#!/bin/sh
# combo-chen runner for ${combo.id} — generated, do not edit.
# Sequencing is mechanics; judgment stays with agents and humans.
set -u

cd "${combo.worktree}"

${emit} rower_started

if ${rowerCommand}; then
  ${emit} rower_done
else
  code=$?
  ${emit} rower_failed --field exit_code=$code
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

pr_url=$(gh pr list --head "${combo.branch}" --json url --jq '.[0].url' 2>/dev/null || true)
if [ -n "\${pr_url:-}" ]; then
  ${emit} pr_opened --field url="$pr_url"
fi

${emit} needs_human --field reason=pr_ready
`;
}
