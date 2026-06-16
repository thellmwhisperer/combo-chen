/**
 * @overview Core logic: phase state machine + runner script generator.
 *   275 lines, 7 exports, 1 critical function.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at buildRunnerScript    ← generates runner.sh, the combo spine
 *   2. deriveStatus                  ← event → phase state machine
 *   3. buildNoMistakesMirrorPublishScript ← gate mirror push with intent
 *   4. shellQuote                    ← POSIX-safe shell quoting
 *
 *   MAIN FLOW (called from cli/main.ts)
 *   ───────────────────────────────────
 *   main.run()
 *     → buildRunnerScript(input)     ← generates the shell script
 *       → buildNoMistakesMirrorPublishScript() when gate mirror intent exists
 *       → shellQuote() for safety
 *     → writes runner.sh to disk
 *     → tmux executes it
 *
 *   runner.sh lifecycle (what buildRunnerScript generates):
 *     fetch/rebase origin/main → coder_started → coderCommand → coder_done
 *     → gate_started → mirror publish → gatekeeperCommand → pr_opened
 *     → activateCoder + activateReviewer → needs_human
 *
 *   ┌─ CORE ─────────────────────────────────────────────────────────┐
 *   │ buildRunnerScript   Generates the runner shell script          │
 *   │ buildNoMistakesMirrorPublishScript Git push to local gate repo │
 *   │ shellQuote           POSIX-safe single-quoting                 │
 *   ├─ PHASE DERIVATION ────────────────────────────────────────────┤
 *   │ deriveStatus         Maps event journal → ComboStatus          │
 *   │ Phase                "SETUP"|"CODING"|"GATING"|"REVIEWING"...  │
 *   │ ComboStatus          {phase, needsHuman, reason?, pr?}         │
 *   │ RunnerInput          Input shape for buildRunnerScript         │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * @exports buildRunnerScript, buildNoMistakesMirrorPublishScript, deriveStatus, shellQuote, Phase, ComboStatus, RunnerInput
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
      case "rebase_failed":
      case "rebase_conflict":
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
  /** One-line no-mistakes.intent push option for the local gate mirror. */
  gatekeeperMirrorIntent?: string;
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

export function buildNoMistakesMirrorPublishScript(combo: ComboRecord, pushIntent: string): string[] {
  return [
    "if git remote get-url no-mistakes >/dev/null 2>&1; then",
    `  mirror_branch=${shellQuote(combo.branch)}`,
    `  mirror_ref=${shellQuote(`refs/heads/${combo.branch}`)}`,
    `  mirror_intent=${shellQuote(`no-mistakes.intent=${pushIntent}`)}`,
    "  no-mistakes daemon start || exit 1",
    "  COMBO_CHEN_NO_MISTAKES_DAEMON_STARTED=1",
    `  if mirror_line=$(git ls-remote --heads no-mistakes "$mirror_branch" 2>/dev/null); then`,
    "    mirror_sha=",
    `    if [ -n "$mirror_line" ]; then`,
    "      set -- $mirror_line",
    `      mirror_sha=\${1:-}`,
    "    fi",
    `    if [ -n "$mirror_sha" ]; then`,
    `      git push -o "$mirror_intent" no-mistakes --force-with-lease="$mirror_ref:$mirror_sha" "HEAD:$mirror_ref"`,
    "    else",
    `      git push -o "$mirror_intent" no-mistakes "HEAD:$mirror_ref"`,
    "    fi",
    "  else",
    `    printf '%s\\n' "no-mistakes mirror lookup failed for $mirror_branch" >&2`,
    "    exit 1",
    "  fi",
    "fi",
  ];
}

// -/ 2/3

// -- 3/3 CORE · buildRunnerScript ← START HERE --

export function buildRunnerScript(input: RunnerInput): string {
  const {
    combo,
    coderCommand,
    gatekeeperCommand,
    gatekeeperMirrorIntent,
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
rebase_log="$(dirname "$0")/rebase.log"

cd ${shellQuote(combo.worktree)}
if ! git fetch origin main > "$rebase_log" 2>&1; then
  ${emit} rebase_failed --field base="$(git merge-base HEAD origin/main 2>/dev/null || true)"
  exit 1
fi
if ! git rebase origin/main >> "$rebase_log" 2>&1; then
  ${emit} rebase_conflict --field base="$(git merge-base HEAD origin/main 2>/dev/null || true)"
  exit 1
fi
coder_base_sha=$(git rev-parse HEAD 2>/dev/null || true)

${emit} coder_started

if (
  ${coderCommand}
) < /dev/null > "$coder_log" 2>&1; then
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
${gatekeeperMirrorIntent === undefined ? ":" : buildNoMistakesMirrorPublishScript(combo, gatekeeperMirrorIntent).join("\n")}
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
