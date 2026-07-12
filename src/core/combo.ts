/**
 * @overview Core logic: phase state machine + runner script generation.
 *   ~340 lines, 10 exports, 1 critical function. All generated shell lives in
 *   src/shell/templates; this module only renders placeholders.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at buildRunnerScript    <- renders runner.sh, the combo spine
 *   2. deriveStatus                  <- event -> phase state machine
 *   3. buildNoMistakesMirrorPublishScript <- gate mirror push with intent
 *   4. buildNoMistakesGatekeeperRunScript <- stale-run guard + config handoff + gate run
 *   5. checksPassedContextCanceledRecoveryScript <- normalizes post-success cancel evidence
 *   6. shellQuote                    <- POSIX-safe shell quoting
 *
 *   MAIN FLOW (called from cli/main.ts)
 *   -----------------------------------
 *   main.run()
 *     -> buildRunnerScript(input)     <- renders the runner template
 *       -> buildNoMistakesMirrorPublishScript() when gate mirror intent exists
 *       -> renderShellTemplate() with src/shell/templates/runner.sh
 *       -> shellQuote() for safety
 *     -> writes runner script to disk
 *     -> tmux executes it
 *
 *   ┌─ CORE ─────────────────────────────────────────────────────────┐
 *   │ buildRunnerScript   Renders the runner shell script            │
 *   │ buildNoMistakesMirrorPublishScript Mirror push with intent     │
 *   │ buildNoMistakesGatekeeperRunScript Stale guard + config + gate │
 *   │ checksPassedContextCanceledRecoveryScript Gate success recovery│
 *   │ guardNoMistakesDaemonStart Re-export from ../shell/templates   │
 *   │ shellQuote           POSIX-safe single-quoting                 │
 *   ├─ PHASE DERIVATION ────────────────────────────────────────────┤
 *   │ deriveStatus         Maps event journal -> ComboStatus         │
 *   │ Phase                "SETUP"|"CODING"|"LOCAL_REVIEW"|...       │
 *   │ ComboStatus          {phase, needsHuman, reason?, pr?}         │
 *   │ RunnerInput          Input shape for buildRunnerScript         │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * @exports buildRunnerScript, buildNoMistakesMirrorPublishScript, buildNoMistakesGatekeeperRunScript, checksPassedContextCanceledRecoveryScript, gateLeaseScriptLines, guardNoMistakesDaemonStart, deriveStatus, shellQuote, Phase, ComboStatus, RunnerInput
 * @deps ../shell/templates, ./events, ./state
 */
import { guardNoMistakesDaemonStart, renderShellTemplate } from "../shell/templates.js";
import type { ComboEvent } from "./events.js";
import type { ComboRecord } from "./state.js";

export { guardNoMistakesDaemonStart } from "../shell/templates.js";

export type Phase =
  | "SETUP"
  | "CODING"
  | "LOCAL_REVIEW"
  | "GATING"
  | "REVIEWING"
  | "READY"
  | "STOPPED"
  | "STALLED";

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
      // v1 pre-publish review loop: LOCAL_REVIEW sits between coder_done and
      // the gate; journals without these events derive exactly as before.
      case "local_review_requested":
        phase = "LOCAL_REVIEW";
        needsHuman = false;
        break;
      case "local_verdict":
        if (phase !== "LOCAL_REVIEW") break;
        if (event["code"] === 0) {
          phase = "GATING";
          needsHuman = false;
        } else if (event["code"] === 1) {
          needsHuman = false;
        } else if (event["code"] === 2 || event["code"] === 3) {
          needsHuman = true;
          reason = `local_verdict_code_${event["code"]}`;
        }
        break;
      case "decision":
        needsHuman = false;
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

// -- 2/3 HELPER · RunnerInput + shellQuote + template-backed builders --

export interface RunnerInput {
  combo: ComboRecord;
  /** Base ref the combo branch tracks before worker execution; defaults to origin/main. */
  baseRef?: string;
  coderCommand: string;
  gatekeeperCommand: string;
  /** One-line push intent for the local gate mirror. */
  gatekeeperMirrorIntent?: string;
  /** Deprecated; coder responding starts lazily only when review signals need it. */
  activateCoder?: string;
  /** Full invocation prefix for emitting events, e.g. "node /x/cli.mjs emit -n <id>". */
  emit: string;
  /** Full invocation for starting the reviewer loop after a PR has been journaled. */
  activateReviewer: string;
  /** Full invocation prefix for ensuring the PR body visibly autocloses the source issue. */
  ensurePrAutoclose?: string;
  /** Full invocation prefix for acquiring the branch-scoped gate lease. */
  gateLeaseAcquire?: string;
  /** Full invocation prefix for releasing the branch-scoped gate lease. */
  gateLeaseRelease?: string;
}

//    POSIX-safe single-quoting. Paths, branch names, anything.
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function expectedBranchValue(expectedBranch: string | undefined): string {
  return expectedBranch === undefined ? '""' : shellQuote(expectedBranch);
}

export function buildNoMistakesGatekeeperRunScript(
  gatekeeperCommand: string,
  options: { expectedBranch?: string } = {},
): string[] {
  const branch = expectedBranchValue(options.expectedBranch);
  return renderShellTemplate("gatekeeper-run", {
    __ABORT_PREVIOUS_RUN__: renderShellTemplate("gate-abort-previous-run", {
      __EXPECTED_BRANCH__: branch,
    }).trimEnd(),
    __CONFIG_COPY__: renderShellTemplate("gate-config-copy", { __EXPECTED_BRANCH__: branch }).trimEnd(),
    __GATEKEEPER_COMMAND__: gatekeeperCommand,
  })
    .trimEnd()
    .split("\n");
}

export function checksPassedContextCanceledRecoveryScript(): string[] {
  return renderShellTemplate("checks-passed-recovery").trimEnd().split("\n");
}

export function buildNoMistakesMirrorPublishScript(combo: ComboRecord, pushIntent: string): string[] {
  return renderShellTemplate("gate-mirror-publish", {
    __MIRROR_BRANCH__: shellQuote(combo.branch),
    __MIRROR_REF__: shellQuote(`refs/heads/${combo.branch}`),
    __MIRROR_INTENT__: pushIntent,
    __ABORT_PREVIOUS_RUN__: renderShellTemplate("gate-abort-previous-run", {
      __EXPECTED_BRANCH__: expectedBranchValue(combo.branch),
    }).trimEnd(),
  })
    .trimEnd()
    .split("\n");
}

export function gateLeaseScriptLines(input: { acquire?: string; release?: string }): string[] {
  if (input.acquire === undefined && input.release === undefined) return [];
  if (input.acquire === undefined || input.release === undefined) {
    throw new Error("gate lease acquire and release commands must be configured together");
  }
  return renderShellTemplate("gate-lease", {
    __GATE_LEASE_ACQUIRE__: input.acquire,
    __GATE_LEASE_RELEASE__: shellQuote(input.release),
  })
    .trimEnd()
    .split("\n");
}

function buildGateLeaseScript(input: Pick<RunnerInput, "gateLeaseAcquire" | "gateLeaseRelease">): string {
  const lines = gateLeaseScriptLines({ acquire: input.gateLeaseAcquire, release: input.gateLeaseRelease });
  if (lines.length === 0) return "";
  return lines.join("\n") + "\n";
}

// -/ 2/3

// -- 3/3 CORE · buildRunnerScript <- START HERE --

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
  const gatekeeperRunCommand =
    gatekeeperMirrorIntent === undefined ? gatekeeperCommand : guardNoMistakesDaemonStart(gatekeeperCommand);
  const originBranch = baseRef.startsWith("origin/") ? baseRef.slice("origin/".length) : undefined;
  return renderShellTemplate("runner", {
    __COMBO_ID__: combo.id,
    __WORKTREE__: shellQuote(combo.worktree),
    __BASE_REF__: shellQuote(baseRef),
    __ORIGIN_BRANCH__: shellQuote(originBranch ?? ""),
    __EMIT__: emit,
    __CODER_COMMAND__: coderCommand,
    __GATE_LEASE_SCRIPT__: buildGateLeaseScript({ gateLeaseAcquire, gateLeaseRelease }),
    __GATEKEEPER_MIRROR_SCRIPT__:
      gatekeeperMirrorIntent === undefined
        ? ":"
        : buildNoMistakesMirrorPublishScript(combo, gatekeeperMirrorIntent).join("\n"),
    // No cosmetic re-indent: the gatekeeper command may span lines inside
    // quotes, and indenting continuations would corrupt the quoted content.
    __GATEKEEPER_RUN_SCRIPT__: buildNoMistakesGatekeeperRunScript(gatekeeperRunCommand, {
      expectedBranch: combo.branch,
    }).join("\n"),
    __GATEKEEPER_RECOVERY_SCRIPT__: checksPassedContextCanceledRecoveryScript().join("\n"),
    __FAILURE_REASON__: renderShellTemplate("gate-failure-reason").trimEnd(),
    __AWAITING_APPROVAL_CHECK__: renderShellTemplate("gate-awaiting-approval", { __EMIT__: emit }).trimEnd(),
    __BRANCH__: shellQuote(combo.branch),
    __ENSURE_PR_AUTOCLOSE__: ensurePrAutoclose,
    __ACTIVATE_REVIEWER__: activateReviewer,
  });
}
// -/ 3/3
