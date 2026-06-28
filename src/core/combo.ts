/**
 * @overview Core logic: phase state machine + runner script generator.
 *   ~435 lines, 10 exports, 1 critical function.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at buildRunnerScript    ← generates runner.sh, the combo spine
 *   2. deriveStatus                  ← event → phase state machine
 *   3. buildNoMistakesMirrorPublishScript ← gate mirror push with intent
 *   4. buildNoMistakesGatekeeperRunScript ← config handoff + gate run
 *   5. checksPassedContextCanceledRecoveryScript ← normalizes post-success cancel evidence
 *   6. guardNoMistakesDaemonStart    ← avoids double-starting mirror gates
 *   7. shellQuote                    ← POSIX-safe shell quoting
 *
 *   MAIN FLOW (called from cli/main.ts)
 *   ───────────────────────────────────
 *   main.run()
 *     → buildRunnerScript(input)     ← generates the shell script
 *       → buildNoMistakesMirrorPublishScript() when gate mirror intent exists
 *       → renderRunnerTemplate() with src/core/runner-template.sh
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
 *   │ checksPassedContextCanceledRecoveryScript Gate success recovery│
 *   │ guardNoMistakesDaemonStart Avoid duplicate no-mistakes starts  │
 *   │ shellQuote           POSIX-safe single-quoting                 │
 *   ├─ PHASE DERIVATION ────────────────────────────────────────────┤
 *   │ deriveStatus         Maps event journal → ComboStatus          │
 *   │ Phase                "SETUP"|"CODING"|"GATING"|"REVIEWING"...  │
 *   │ ComboStatus          {phase, needsHuman, reason?, pr?}         │
 *   │ RunnerInput          Input shape for buildRunnerScript         │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * @exports buildRunnerScript, buildNoMistakesMirrorPublishScript, buildNoMistakesGatekeeperRunScript, checksPassedContextCanceledRecoveryScript, gateLeaseScriptLines, guardNoMistakesDaemonStart, deriveStatus, shellQuote, Phase, ComboStatus, RunnerInput
 * @deps node:fs, ./events, ./state
 */
import { readFileSync } from "node:fs";

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

export function checksPassedContextCanceledRecoveryScript(): string[] {
  return [
    "gatekeeper_recovery_reason=${gatekeeper_recovery_reason:-}",
    "if [ \"$gatekeeper_code\" -ne 0 ] && grep -Eiq '^outcome:[[:space:]]*checks-passed[[:space:]]*$' \"$gatekeeper_log\" && grep -Eiq 'context[[:space:]]+canceled' \"$gatekeeper_log\"; then",
    "  gatekeeper_recovery_reason=checks_passed_context_canceled",
    "  gatekeeper_code=0",
    "fi",
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

const RUNNER_TEMPLATE = readFileSync(new URL("./runner-template.sh", import.meta.url), "utf8");

function renderRunnerTemplate(values: Record<string, string>): string {
  let rendered = RUNNER_TEMPLATE;
  for (const [placeholder, value] of Object.entries(values)) {
    rendered = rendered.split(placeholder).join(value);
  }
  const unresolved = rendered.match(/__[A-Z0-9_]+__/);
  if (unresolved !== null) {
    throw new Error(`runner template placeholder not rendered: ${unresolved[0]}`);
  }
  return rendered;
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
  return renderRunnerTemplate({
    "__COMBO_ID__": combo.id,
    "__WORKTREE__": shellQuote(combo.worktree),
    "__RUNNER_STATUS_SYNC__": runnerStatus(`syncing worktree with ${baseRef}`),
    "__BASE_FETCH__": baseFetch,
    "__BASE_REF__": shellQuote(baseRef),
    "__RUNNER_STATUS_STARTING_CODER__": runnerStatus("starting coder"),
    "__EMIT__": emit,
    "__CODER_COMMAND__": coderCommand,
    "__RUNNER_STATUS_STOP_CONDITION__": runnerStatus("coder stop condition met; starting gatekeeper"),
    "__RUNNER_STATUS_CODER_FINISHED__": runnerStatus("coder finished; starting gatekeeper"),
    "__GATE_LEASE_SCRIPT__": buildGateLeaseScript({ gateLeaseAcquire, gateLeaseRelease }),
    "__GATEKEEPER_MIRROR_SCRIPT__": gatekeeperMirrorIntent === undefined
      ? ":"
      : buildNoMistakesMirrorPublishScript(combo, gatekeeperMirrorIntent).join("\n"),
    "__GATEKEEPER_RUN_SCRIPT__": buildNoMistakesGatekeeperRunScript(gatekeeperRunCommand, {
      expectedBranch: combo.branch,
    }).map((line) => `  ${line}`).join("\n"),
    "__GATEKEEPER_RECOVERY_SCRIPT__": checksPassedContextCanceledRecoveryScript().join("\n"),
    "__RUNNER_STATUS_GATEKEEPER_FINISHED__": runnerStatus("gatekeeper finished; detecting PR"),
    "__BRANCH__": shellQuote(combo.branch),
    "__ENSURE_PR_AUTOCLOSE__": ensurePrAutoclose,
    "__RUNNER_STATUS_PR_DETECTED__": runnerStatus("PR detected; starting reviewer"),
    "__ACTIVATE_REVIEWER__": activateReviewer,
    "__RUNNER_STATUS_NO_PR__": runnerStatus("no PR detected; needs human"),
  });
}
// -/ 3/3
