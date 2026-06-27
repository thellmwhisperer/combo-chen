/**
 * @overview Core logic: phase state machine + runner script generator.
 *   ~640 lines, 9 exports, 1 critical function.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at buildRunnerScript    ← generates runner.sh, the combo spine
 *   2. deriveStatus                  ← event → phase state machine
 *   3. buildNoMistakesMirrorPublishScript ← gate mirror push with intent
 *   4. buildNoMistakesGatekeeperRunScript ← config handoff + gate run
 *   5. guardNoMistakesDaemonStart    ← avoids double-starting mirror gates
 *   6. shellQuote                    ← POSIX-safe shell quoting
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
 *     fetch/rebase baseRef → snapshot existing gnhf iteration files → coder_started → coderCommand →
 *       coder_done (success) | coder_failed + exit $code (failure/log failure, exit sanitized)
 *     → gate_started → optional gate lease → mirror publish → config handoff + gatekeeperCommand → pr_opened
 *     → activateReviewer; missing PRs emit needs_human
 *
 *   ┌─ CORE ─────────────────────────────────────────────────────────┐
 *   │ buildRunnerScript   Generates the runner shell script          │
 *   │ buildNoMistakesMirrorPublishScript Git push to gate mirror     │
 *   │ buildNoMistakesGatekeeperRunScript Config handoff + gate run   │
 *   │ guardNoMistakesDaemonStart Avoid duplicate no-mistakes starts  │
 *   │ shellQuote           POSIX-safe single-quoting                 │
 *   ├─ PHASE DERIVATION ────────────────────────────────────────────┤
 *   │ deriveStatus         Maps event journal → ComboStatus          │
 *   │ Phase                "SETUP"|"CODING"|"GATING"|"REVIEWING"...  │
 *   │ ComboStatus          {phase, needsHuman, reason?, pr?}         │
 *   │ RunnerInput          Input shape for buildRunnerScript         │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * @exports buildRunnerScript, buildNoMistakesMirrorPublishScript, buildNoMistakesGatekeeperRunScript, gateLeaseScriptLines, guardNoMistakesDaemonStart, deriveStatus, shellQuote, Phase, ComboStatus, RunnerInput
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
      case "coder_done":
        if (phase === "SETUP" || phase === "CODING") {
          phase = "GATING";
          needsHuman = false;
        }
        break;
      case "gate_started":
        phase = "GATING";
        needsHuman = false;
        break;
      case "gate_status":
        if (event["state"] === "idle" && phase === "GATING" && pr !== undefined) {
          phase = "REVIEWING";
          needsHuman = false;
        }
        break;
      case "gate_validated":
        if (phase === "GATING" && pr !== undefined) {
          phase = "REVIEWING";
          needsHuman = false;
        }
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
      case "pr_conflict":
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
      case "pr_autoclose_failed":
      case "rebase_failed":
      case "rebase_conflict":
        phase = "STALLED";
        needsHuman = true;
        reason = event.event;
        if (event.event === "pr_autoclose_failed" && typeof event["url"] === "string") {
          pr = event["url"];
        }
        break;
      case "needs_human":
        needsHuman = true;
        reason = typeof event["reason"] === "string" ? (event["reason"] as string) : undefined;
        break;
      case "merged":
        phase = "STALLED";
        needsHuman = true;
        reason = "closure_pending";
        break;
      case "stopped":
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
  /** Base ref the combo branch tracks before worker execution; defaults to origin/main. */
  baseRef?: string;
  coderCommand: string;
  gatekeeperCommand: string;
  /** One-line no-mistakes.intent push option for the local gate mirror. */
  gatekeeperMirrorIntent?: string;
  /** Deprecated; coder responding starts lazily only when review signals need it. */
  activateCoder?: string;
  /** Full invocation prefix for emitting events, e.g. "node /x/cli.mjs emit -n <id>". */
  emit: string;
  /** Full invocation for starting the reviewer loop after a PR has been journaled. */
  activateReviewer: string;
  /** Full invocation prefix for ensuring the PR body visibly autocloses the source issue. */
  ensurePrAutoclose?: string;
  /** Full invocation prefix for acquiring the branch-scoped no-mistakes gate lease. */
  gateLeaseAcquire?: string;
  /** Full invocation prefix for releasing the branch-scoped no-mistakes gate lease. */
  gateLeaseRelease?: string;
}

//    POSIX-safe single-quoting. Paths, branch names, anything.
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function runnerStatus(message: string): string {
  return `runner_status ${shellQuote(`runner: ${message}`)}`;
}

function noMistakesDaemonConfigCopyScript(expectedBranch?: string): string[] {
  return [
    `no_mistakes_expected_branch=${expectedBranch === undefined ? "\"\"" : shellQuote(expectedBranch)}`,
    "if [ -z \"$no_mistakes_expected_branch\" ]; then",
    "  no_mistakes_expected_branch=$(git branch --show-current 2>/dev/null || true)",
    "fi",
    "no_mistakes_config_copied=0",
    "no_mistakes_config_attempt=0",
    "no_mistakes_config_attempt_limit=${COMBO_CHEN_NO_MISTAKES_CONFIG_COPY_ATTEMPTS:-120}",
    "while [ \"$no_mistakes_config_attempt\" -lt \"$no_mistakes_config_attempt_limit\" ]; do",
    "  no_mistakes_repo_status=$(no-mistakes status 2>/dev/null || true)",
    "  no_mistakes_axi_status=$(no-mistakes axi status 2>/dev/null || true)",
    "  no_mistakes_run_id=$(printf '%s\\n' \"$no_mistakes_axi_status\" | sed -n 's/^[[:space:]]*id:[[:space:]]*//p' | sed -n '1p')",
    "  no_mistakes_run_id=$(printf '%s' \"$no_mistakes_run_id\" | sed 's/^\"//; s/\"$//')",
    "  no_mistakes_run_branch=$(printf '%s\\n' \"$no_mistakes_axi_status\" | sed -n 's/^[[:space:]]*branch:[[:space:]]*//p' | sed -n '1p')",
    "  no_mistakes_run_status=$(printf '%s\\n' \"$no_mistakes_axi_status\" | sed -n 's/^[[:space:]]*status:[[:space:]]*//p' | sed -n '1p')",
    "  no_mistakes_gate_path=$(printf '%s\\n' \"$no_mistakes_repo_status\" | sed -n 's/^[[:space:]]*gate:[[:space:]]*//p' | sed -n '1p')",
    "  case \"$no_mistakes_run_status\" in",
    "    active|in_progress|pending|running) no_mistakes_run_is_active=1 ;;",
    "    *) no_mistakes_run_is_active=0 ;;",
    "  esac",
    "  if [ -n \"$no_mistakes_run_id\" ] && [ -n \"$no_mistakes_gate_path\" ] && [ \"$no_mistakes_run_branch\" = \"$no_mistakes_expected_branch\" ] && [ \"$no_mistakes_run_is_active\" = \"1\" ]; then",
    "    no_mistakes_data_dir=$(dirname \"$(dirname \"$no_mistakes_gate_path\")\")",
    "    no_mistakes_repo_id=$(basename \"$no_mistakes_gate_path\" .git)",
    "    no_mistakes_run_dir=\"$no_mistakes_data_dir/worktrees/$no_mistakes_repo_id/$no_mistakes_run_id\"",
    "    if [ -d \"$no_mistakes_run_dir\" ]; then",
    "      cp -p .no-mistakes.yaml \"$no_mistakes_run_dir/.no-mistakes.yaml\" || exit 1",
    "      no_mistakes_config_copied=1",
    "      printf '%s\\n' \"copied .no-mistakes.yaml to $no_mistakes_run_dir/.no-mistakes.yaml\"",
    "      break",
    "    fi",
    "  fi",
    "  no_mistakes_config_attempt=$((no_mistakes_config_attempt + 1))",
    "  sleep 1",
    "done",
    "if [ \"$no_mistakes_config_copied\" != \"1\" ]; then",
    "  printf '%s\\n' \"no-mistakes config copy failed: active run worktree not found\" >&2",
    "  exit 1",
    "fi",
  ];
}

export function buildNoMistakesGatekeeperRunScript(
  gatekeeperCommand: string,
  options: { expectedBranch?: string } = {},
): string[] {
  return [
    "no_mistakes_config_copy_pid=",
    "no_mistakes_config_copy_status=",
    "no_mistakes_config_copy_done=.combo-chen-no-mistakes-config-copy.$$",
    "gatekeeper_status_file=.combo-chen-gatekeeper-status.$$",
    "rm -f \"$no_mistakes_config_copy_done\" \"$gatekeeper_status_file\"",
    "if [ -f .no-mistakes.yaml ]; then",
    "  (",
    ...noMistakesDaemonConfigCopyScript(options.expectedBranch).map((line) => `    ${line}`),
    "    printf '%s\\n' ok > \"$no_mistakes_config_copy_done\"",
    "  ) &",
    "  no_mistakes_config_copy_pid=$!",
    "fi",
    "# no-mistakes creates the active run worktree from inside axi run, so run",
    "# the gate in parallel with the watcher but do not accept a successful gate",
    "# until the watcher has copied the repo config into that worktree.",
    "(",
    `  ${gatekeeperCommand}`,
    "  printf '%s\\n' \"$?\" > \"$gatekeeper_status_file\"",
    ") &",
    "gatekeeper_command_pid=$!",
    "gatekeeper_finished_before_config=0",
    "if [ -n \"$no_mistakes_config_copy_pid\" ]; then",
    "  while [ ! -f \"$no_mistakes_config_copy_done\" ]; do",
    "    if [ -f \"$gatekeeper_status_file\" ]; then",
    "      gatekeeper_finished_before_config=1",
    "      break",
    "    fi",
    "    if ! kill -0 \"$no_mistakes_config_copy_pid\" 2>/dev/null; then",
    "      break",
    "    fi",
    "    sleep 1",
    "  done",
    "  if [ \"$gatekeeper_finished_before_config\" = \"1\" ]; then",
    "    gatekeeper_precheck_code=$(cat \"$gatekeeper_status_file\" 2>/dev/null || printf '1')",
    "    if [ \"$gatekeeper_precheck_code\" != \"0\" ]; then",
    "      kill \"$no_mistakes_config_copy_pid\" 2>/dev/null || true",
    "    fi",
    "  fi",
    "  wait \"$no_mistakes_config_copy_pid\" || no_mistakes_config_copy_status=1",
    "fi",
    "wait \"$gatekeeper_command_pid\" || true",
    "gatekeeper_inner_code=$(cat \"$gatekeeper_status_file\" 2>/dev/null || printf '1')",
    "if [ \"$gatekeeper_finished_before_config\" = \"1\" ] && [ \"$gatekeeper_inner_code\" = \"0\" ]; then",
    "  printf '%s\\n' \"no-mistakes config copy failed: gatekeeper finished before config copy\" >&2",
    "  gatekeeper_inner_code=1",
    "fi",
    "if [ -n \"$no_mistakes_config_copy_status\" ]; then",
    "  gatekeeper_inner_code=1",
    "fi",
    "rm -f \"$no_mistakes_config_copy_done\" \"$gatekeeper_status_file\"",
    "exit \"$gatekeeper_inner_code\"",
  ];
}

export function buildNoMistakesMirrorPublishScript(combo: ComboRecord, pushIntent: string): string[] {
  return [
    "if git remote get-url no-mistakes >/dev/null 2>&1; then",
    `  mirror_branch=${shellQuote(combo.branch)}`,
    `  mirror_ref=${shellQuote(`refs/heads/${combo.branch}`)}`,
    `  mirror_intent=${shellQuote(`no-mistakes.intent=${pushIntent}`)}`,
    "  no-mistakes daemon start 2>/dev/null || no-mistakes status 2>/dev/null | grep -Eq 'daemon:.*running' || exit 1",
    "  export COMBO_CHEN_NO_MISTAKES_DAEMON_STARTED=1",
    "  trap 'no-mistakes daemon stop 2>/dev/null || true' EXIT",
    `  if mirror_line=$(git ls-remote --heads no-mistakes "$mirror_branch" 2>/dev/null); then`,
    "    mirror_sha=",
    `    if [ -n "$mirror_line" ]; then`,
    "      set -- $mirror_line",
    `      mirror_sha=\${1:-}`,
    "    fi",
    `    if [ -n "$mirror_sha" ]; then`,
    `      git push -o "$mirror_intent" no-mistakes --force-with-lease="$mirror_ref:$mirror_sha" "HEAD:$mirror_ref" || exit 1`,
    "    else",
    `      git push -o "$mirror_intent" no-mistakes "HEAD:$mirror_ref" || exit 1`,
    "    fi",
    "  else",
    `    printf '%s\\n' "no-mistakes mirror lookup failed for $mirror_branch" >&2`,
    "    exit 1",
    "  fi",
    "fi",
  ];
}

const DAEMON_START_PREFIX = "no-mistakes daemon start && ";

export function guardNoMistakesDaemonStart(gatekeeperCommand: string): string {
  if (!gatekeeperCommand.startsWith(DAEMON_START_PREFIX)) return gatekeeperCommand;
  const remainder = gatekeeperCommand.slice(DAEMON_START_PREFIX.length);
  return 'if [ "${COMBO_CHEN_NO_MISTAKES_DAEMON_STARTED:-0}" = "1" ]; then ' +
    `${remainder}; ` +
    `else no-mistakes daemon start && ${remainder}; fi`;
}

export function gateLeaseScriptLines(input: {
  acquire?: string;
  release?: string;
}): string[] {
  if (input.acquire === undefined && input.release === undefined) return [];
  if (input.acquire === undefined || input.release === undefined) {
    throw new Error("gate lease acquire and release commands must be configured together");
  }
  return [
    `${input.acquire} --head-sha "$gatekeeper_start_sha" || gate_lease_code=$?`,
    'if [ "$gate_lease_code" -eq 75 ]; then exit 0; fi',
    'if [ "$gate_lease_code" -eq 76 ]; then exit 0; fi',
    'if [ "$gate_lease_code" -ne 0 ]; then exit "$gate_lease_code"; fi',
    `gate_lease_release_cmd=${shellQuote(input.release)}`,
    "gate_lease_release() {",
    '  sh -c "$gate_lease_release_cmd" >/dev/null 2>&1 || true',
    "}",
    "trap gate_lease_release EXIT",
  ];
}

function buildGateLeaseScript(input: Pick<RunnerInput, "gateLeaseAcquire" | "gateLeaseRelease">): string {
  const lines = gateLeaseScriptLines({ acquire: input.gateLeaseAcquire, release: input.gateLeaseRelease });
  if (lines.length === 0) return "";
  return lines.join("\n") + "\n";
}

// -/ 2/3

// -- 3/3 CORE · buildRunnerScript ← START HERE --

export function buildRunnerScript(input: RunnerInput): string {
  const {
    combo,
    baseRef = "origin/main",
    coderCommand,
    gatekeeperCommand,
    gatekeeperMirrorIntent,
    emit,
    activateReviewer,
    ensurePrAutoclose = ":",
    gateLeaseAcquire,
    gateLeaseRelease,
  } = input;
  const gatekeeperRunCommand = gatekeeperMirrorIntent === undefined
    ? gatekeeperCommand
    : guardNoMistakesDaemonStart(gatekeeperCommand);
  const originBranch = baseRef.startsWith("origin/") ? baseRef.slice("origin/".length) : undefined;
  const baseFetch = originBranch === undefined
    ? ": > \"$rebase_log\""
    : `if ! git fetch origin ${shellQuote(originBranch)} > "$rebase_log" 2>&1; then
  ${emit} rebase_failed --field base="$(git merge-base HEAD ${shellQuote(baseRef)} 2>/dev/null || true)"
  exit 1
fi`;
  return `#!/bin/sh
# combo-chen runner for ${combo.id} — generated, do not edit.
# Sequencing is mechanics; judgment stays with agents and humans.
set -u
coder_status="$(dirname "$0")/coder.exit"
coder_start_marker="$(dirname "$0")/coder-started.$$"
gnhf_iteration_snapshot="$(dirname "$0")/gnhf-iterations.$$"
gatekeeper_log="$(dirname "$0")/gatekeeper.log"
autoclose_log="$(dirname "$0")/autoclose.log"
rebase_log="$(dirname "$0")/rebase.log"
runner_progress="\${COMBO_CHEN_RUNNER_PROGRESS:-0}"
runner_status() {
  if [ "$runner_progress" = "1" ]; then
    printf '%s\\n' "$1"
  fi
}
gnhf_snapshot_iterations() {
  rm -f "$gnhf_iteration_snapshot"
  if [ ! -d .gnhf/runs ]; then
    : > "$gnhf_iteration_snapshot"
    return 0
  fi
  node - "$gnhf_iteration_snapshot" <<'NODE'
const fs = require("fs");
const path = require("path");

const snapshotPath = process.argv[2];
const runsDir = path.join(process.cwd(), ".gnhf", "runs");

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(entryPath);
    } else {
      yield entryPath;
    }
  }
}

try {
  const rows = [];
  for (const file of walk(runsDir)) {
    const name = path.basename(file);
    if (!name.startsWith("iteration-") || !name.endsWith(".jsonl")) continue;
    const stat = fs.statSync(file);
    rows.push(JSON.stringify({ path: path.resolve(file), size: stat.size }));
  }
  fs.writeFileSync(snapshotPath, rows.join("\\n") + (rows.length > 0 ? "\\n" : ""));
} catch {
  process.exit(1);
}
NODE
  if [ "$?" -ne 0 ]; then
    rm -f "$gnhf_iteration_snapshot"
  fi
}
gnhf_stop_condition_met() {
  if [ ! -d .gnhf/runs ]; then
    return 1
  fi
  node - "$coder_start_marker" "$gnhf_iteration_snapshot" <<'NODE'
const fs = require("fs");
const path = require("path");

let markerMs = 0;
try {
  markerMs = fs.statSync(process.argv[2]).mtimeMs;
} catch {
  process.exit(1);
}

const runsDir = path.join(process.cwd(), ".gnhf", "runs");
const preRunSizes = new Map();

try {
  const snapshot = fs.readFileSync(process.argv[3], "utf8");
  for (const line of snapshot.split(/\\r?\\n/)) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line);
    if (typeof row?.path !== "string" || typeof row?.size !== "number") process.exit(1);
    preRunSizes.set(path.resolve(row.path), row.size);
  }
} catch {
  process.exit(1);
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(entryPath);
    } else {
      yield entryPath;
    }
  }
}

function isStopConditionResult(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed !== null &&
      typeof parsed === "object" &&
      parsed.success === true &&
      parsed.should_fully_stop === true;
  } catch {
    return false;
  }
}

try {
  for (const file of walk(runsDir)) {
    const name = path.basename(file);
    if (!name.startsWith("iteration-") || !name.endsWith(".jsonl")) continue;
    const resolved = path.resolve(file);
    const stat = fs.statSync(file);
    const priorSize = preRunSizes.get(resolved);
    const content = fs.readFileSync(file);
    let resultText;
    if (priorSize !== undefined) {
      if (stat.size <= priorSize) continue;
      resultText = content.subarray(priorSize).toString("utf8");
    } else {
      if (stat.mtimeMs < markerMs) continue;
      resultText = content.toString("utf8");
    }
    const lines = resultText.split(/\\r?\\n/);
    for (const line of lines) {
      if (line.trim() === "") continue;
      if (isStopConditionResult(line)) process.exit(0);
      try {
        const event = JSON.parse(line);
        const text = event?.item?.type === "agent_message" ? event.item.text : undefined;
        if (typeof text === "string" && isStopConditionResult(text)) process.exit(0);
      } catch {}
    }
  }
} catch {
  process.exit(1);
}

process.exit(1);
NODE
}

cd ${shellQuote(combo.worktree)}
${runnerStatus(`syncing worktree with ${baseRef}`)}
${baseFetch}
if ! git rebase ${shellQuote(baseRef)} >> "$rebase_log" 2>&1; then
  ${emit} rebase_conflict --field base="$(git merge-base HEAD ${shellQuote(baseRef)} 2>/dev/null || true)"
  exit 1
fi
coder_base_sha=$(git rev-parse HEAD 2>/dev/null || true)

${runnerStatus("starting coder")}
${emit} coder_started

rm -f "$coder_status" "$coder_start_marker" "$gnhf_iteration_snapshot"
: > "$coder_start_marker"
gnhf_snapshot_iterations
(
  coder_code=0
  ${coderCommand} || coder_code=$?
  printf '%s\\n' "$coder_code" > "$coder_status"
)
code=$(cat "$coder_status" 2>/dev/null || printf '1')
case "$code" in
  ""|*[!0-9]*) code=1 ;;
esac
rm -f "$coder_status"

if [ "$code" -ne 0 ] && gnhf_stop_condition_met; then
  ${runnerStatus("coder stop condition met; starting gatekeeper")}
  code=0
fi
rm -f "$coder_start_marker" "$gnhf_iteration_snapshot"

if [ "$code" -eq 0 ]; then
  ${emit} coder_done
else
  if [ "$runner_progress" = "1" ]; then
    printf '%s\\n' "runner: coder failed with exit $code; stopping runner"
  fi
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

${runnerStatus("coder finished; starting gatekeeper")}
${emit} gate_started
gatekeeper_start_sha=$(git rev-parse HEAD 2>/dev/null || true)
gate_lease_code=0
${buildGateLeaseScript({ gateLeaseAcquire, gateLeaseRelease })}${emit} gate_status --field state=fix_inflight --field head_sha="$gatekeeper_start_sha"

gatekeeper_code=0
(
${gatekeeperMirrorIntent === undefined ? ":" : buildNoMistakesMirrorPublishScript(combo, gatekeeperMirrorIntent).join("\n")}
${buildNoMistakesGatekeeperRunScript(gatekeeperRunCommand, { expectedBranch: combo.branch }).map((line) => `  ${line}`).join("\n")}
) < /dev/null > "$gatekeeper_log" 2>&1 || gatekeeper_code=$?

if grep -Eq '^outcome:[[:space:]]*awaiting_approval[[:space:]]*$' "$gatekeeper_log"; then
  gatekeeper_head_sha=$(git rev-parse HEAD 2>/dev/null || true)
  ${emit} gate_status --field state=awaiting_approval --field head_sha="$gatekeeper_head_sha"
  ${emit} needs_human --field reason=gate_waiting
  exit 0
fi

if [ "$gatekeeper_code" -ne 0 ]; then
  gatekeeper_head_sha=$(git rev-parse HEAD 2>/dev/null || true)
  gatekeeper_failure_reason=gate_failed
  if grep -Eiq 'daemon.*(dead|died|exited|not running)|connection refused|ECONNREFUSED' "$gatekeeper_log"; then
    gatekeeper_failure_reason=daemon_dead
  fi
  ${emit} gate_status --field state=failed --field head_sha="$gatekeeper_head_sha"
  ${emit} gate_failed --field exit_code=$gatekeeper_code --field reason="$gatekeeper_failure_reason"
  exit $gatekeeper_code
fi

${runnerStatus("gatekeeper finished; detecting PR")}
gatekeeper_head_sha=$(git rev-parse HEAD 2>/dev/null || true)

pr_url=$(gh pr list --head ${shellQuote(combo.branch)} --json url --jq '.[0].url' 2>/dev/null || true)
if [ -n "\${pr_url:-}" ]; then
  pr_head_sha=$(gh pr view "$pr_url" --json headRefOid --jq '.headRefOid' 2>/dev/null || true)
  if [ -n "\${pr_head_sha:-}" ]; then
    gatekeeper_head_sha="$pr_head_sha"
  fi
  if ${ensurePrAutoclose} "$pr_url" > "$autoclose_log" 2>&1; then
    :
  else
    autoclose_code=$?
    ${emit} gate_status --field state=failed --field head_sha="$gatekeeper_head_sha"
    ${emit} gate_failed --field exit_code="$autoclose_code"
    ${emit} pr_autoclose_failed --field exit_code="$autoclose_code" --field url="$pr_url"
    exit "$autoclose_code"
  fi
  ${emit} gate_status --field state=idle --field head_sha="$gatekeeper_head_sha"
  ${emit} pr_opened --field url="$pr_url"
  ${runnerStatus("PR detected; starting reviewer")}
  ${activateReviewer}
else
  ${runnerStatus("no PR detected; needs human")}
  ${emit} gate_status --field state=idle --field head_sha="$gatekeeper_head_sha"
  ${emit} needs_human --field reason=pr_missing
fi
`;
}
// -/ 3/3
