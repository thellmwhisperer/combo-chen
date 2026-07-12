/**
 * @overview First-class resume routing for persisted combos. ~400 lines,
 *   2 exports, state-machine driven safe actions.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at resumeCombo             <- CLI-facing recovery dispatcher.
 *   2. classifyResumeState              <- single-state precedence contract.
 *   3. ensurePrOpenedForLiveCi          <- bridge PRs opened by no-mistakes.
 *   4. ensureComboSession               <- recreates only tmux monitoring shell.
 *   5. salvageCoderStoppedBeforeHandoff <- explicit salvage/audit guidance.
 *
 *   MAIN FLOW
 *   ---------
 *   resume -n -> read combo+journal -> classifyResumeState -> exactly one transition
 *
 *   PUBLIC API
 *   ----------
 *   ResumeDeps       Dependency subset required by resume.
 *   resumeCombo      Recover a persisted combo without starting a fresh run.
 *
 *   INTERNALS
 *   ---------
 *   classifyResumeState (capsule-engine arm delegates to classifyCapsulePhase),
 *   convergeCapsuleTopology, convergeStableTopology, ensurePrOpenedForLiveCi,
 *   salvageCoderStoppedBeforeHandoff, event field helpers, director-watch window management for initial-gate retry
 *
 * @exports ResumeDeps, resumeCombo
 * @deps ../../core/events, ../../core/shell-quote, ../../core/state, ../../infra/config, ../../infra/config-snapshot, ../../infra/tmux, ../../roles/director-invocation, ../capsule/capsule, ../director/reviewer, ../director/watchers, ../gate/gate, ../github/github, ../reporting/status, ../runtime/sessions, ./closure
 */
import { appendEvent, latestPrUrlFromEvents, readEvents, type ComboEvent } from "../../core/events.js";
import { shellQuote } from "../../core/shell-quote.js";
import { readCombo, runDirFor, type ComboRecord } from "../../core/state.js";
import { isCapsuleEngine } from "../../infra/config.js";
import { loadRuntimeConfig } from "../../infra/config-snapshot.js";
import { classifyCapsulePhase, type CapsulePhase } from "../capsule/capsule.js";
import type { TmuxResult } from "../../infra/tmux.js";
import { buildDirectorInvocation } from "../../roles/director-invocation.js";
import { closeMergedCombo } from "./closure.js";
import {
  ensureGatekeeperWindow,
  GATEKEEPER_WINDOW,
  latestGateStatus,
  shaMatchesHead,
  startInitialGateRetry,
} from "../gate/gate.js";
import { parsePrView, type GhRunner } from "../github/github.js";
import { activateReviewer } from "../director/reviewer.js";
import {
  CAPSULE_WINDOW,
  CODER_WINDOW,
  DIRECTOR_WATCH_WINDOW,
  DIRECTOR_WINDOW,
  REVIEWER_WINDOW,
  capsuleWindowCommand,
  ensureComboSession,
  ensureWindowPresent,
  idleRoleWindowCommand,
  removeLegacyTopologyWindows,
} from "../runtime/sessions.js";
import {
  AWAITING_REVIEW_GATE,
  deepComboStatus,
  NO_MISTAKES_RUNNING,
  PR_READY_FOR_REVIEWER,
  type CommandResult,
} from "../reporting/status.js";
import { buildDirectorWatchCommand } from "../director/watchers.js";

// -- 1/3 HELPER · Dependencies --
export interface ResumeDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  tmux: (args: string[]) => TmuxResult;
  git: (args: string[], cwd: string) => { status: number; stdout: string; stderr: string };
  treehouse: (args: string[], cwd: string) => { status: number; stdout: string; stderr: string };
  gh: GhRunner;
  noMistakes: (args: string[], cwd: string) => CommandResult;
  sleep: (ms: number) => Promise<void>;
}

// -/ 1/3

// -- 2/3 HELPER · Resume state classification --
function lastEvent(events: ComboEvent[], eventName: ComboEvent["event"]): ComboEvent | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.event === eventName) return event;
  }
  return undefined;
}

function eventFieldString(event: ComboEvent | undefined, field: string): string | undefined {
  const value = event?.[field];
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function eventFieldNumber(event: ComboEvent | undefined, field: string): number | undefined {
  const value = event?.[field];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

function hasEvent(events: ComboEvent[], eventName: ComboEvent["event"]): boolean {
  return events.some((event) => event.event === eventName);
}

function hasClosurePendingEvent(events: ComboEvent[]): boolean {
  let pending = false;
  for (const event of events) {
    if (event.event === "merged") pending = true;
    if (event.event === "combo_closed") pending = false;
  }
  return pending;
}

function currentWorktreeHeadSha(deps: Pick<ResumeDeps, "git">, combo: ComboRecord): string | undefined {
  const result = deps.git(["rev-parse", "HEAD"], combo.worktree);
  if (result.status !== 0) return undefined;
  const headSha = result.stdout.trim();
  return headSha === "" ? undefined : headSha;
}

function branchPrUrl(gh: GhRunner, branch: string): string | undefined {
  const result = gh(["pr", "list", "--head", branch, "--json", "url", "--jq", ".[0].url"]);
  if (result.status !== 0) return undefined;
  const url = result.stdout.trim();
  return url === "" || url === "null" ? undefined : url;
}

function githubPrMerged(gh: GhRunner, prUrl: string): boolean {
  const result = gh([
    "pr",
    "view",
    prUrl,
    "--json",
    "headRefOid,state,mergedAt,mergedBy,baseRefName,mergeCommit",
  ]);
  if (result.status !== 0) return false;
  try {
    return parsePrView(result.stdout).state === "MERGED";
  } catch {
    return false;
  }
}

function ensurePrOpenedForLiveCi(input: {
  deps: Pick<ResumeDeps, "gh">;
  combo: ComboRecord;
  runDir: string;
  events: ComboEvent[];
  downstream: string;
}): string | undefined {
  if (!input.downstream.startsWith(NO_MISTAKES_RUNNING)) return undefined;
  const existing = latestPrUrlFromEvents(input.events);
  if (existing !== undefined) return existing;
  const discovered = branchPrUrl(input.deps.gh, input.combo.branch);
  if (discovered === undefined) return undefined;
  appendEvent(input.runDir, "pr_opened", { url: discovered });
  return discovered;
}

type ResumeState =
  | { kind: "reviewer_ready" }
  | { kind: "gate_running"; downstream: string }
  | { kind: "gate_waiting"; downstream: string }
  | { kind: "initial_gate_retry" }
  | { kind: "closure_pending"; reason: "journal" | "github" }
  | { kind: "pr_exists"; prUrl: string }
  | { kind: "capsule"; phase: CapsulePhase }
  | { kind: "coder_salvage"; lines: string[] }
  | { kind: "gate_ambiguous"; state: string }
  | { kind: "unknown_salvage" };

function shouldRetryInitialGate(events: ComboEvent[], headSha: string | undefined): boolean {
  if (!hasEvent(events, "coder_done") || latestPrUrlFromEvents(events) !== undefined) return false;
  if (headSha === undefined) return false;
  const status = latestGateStatus(events);
  if (
    (status?.state === "fix_inflight" || status?.state === "awaiting_approval") &&
    status.headSha !== undefined &&
    headSha !== undefined &&
    !shaMatchesHead(status.headSha, headSha)
  ) {
    return true;
  }
  if (hasEvent(events, "needs_human")) {
    const hasGateFailedExhaustion = events.some(
      (event) => event.event === "needs_human" && event["reason"] === "gate_failed",
    );
    if (hasGateFailedExhaustion) return false;
  }
  return status?.state !== "fix_inflight" && status?.state !== "awaiting_approval";
}

function salvageCoderStoppedBeforeHandoff(input: {
  combo: ComboRecord;
  events: ComboEvent[];
  home: string;
  cli: string;
}): string[] | undefined {
  const { combo, events, home, cli } = input;
  const coderStarted = hasEvent(events, "coder_started") || hasEvent(events, "coder_failed");
  const handedOff = hasEvent(events, "gate_started") || latestPrUrlFromEvents(events) !== undefined;
  if (!coderStarted || handedOff) return undefined;

  const failed = lastEvent(events, "coder_failed");
  const exitCode = eventFieldString(failed, "exit_code") ?? "unknown";
  const commitCount = eventFieldNumber(failed, "new_commit_count");
  const commitSummary =
    commitCount === undefined
      ? "with an unknown number of new commits"
      : `after ${commitCount} new ${commitCount === 1 ? "commit" : "commits"}`;
  const baseSha = eventFieldString(failed, "base_sha");
  const headSha = eventFieldString(failed, "head_sha");
  const detail =
    failed === undefined
      ? "detail: coder started but no handoff event was journaled"
      : `detail: coder failed with exit ${exitCode} ${commitSummary}`;

  const lines = [
    `resume: salvage required for ${combo.id}; coder stopped before handoff`,
    detail,
    `next: cd ${shellQuote(combo.worktree)}`,
    "next: git status --short",
  ];
  if (baseSha !== undefined && headSha !== undefined) {
    lines.push(`next: git log --oneline ${shellQuote(`${baseSha}..${headSha}`)}`);
  }
  lines.push(`next: COMBO_CHEN_HOME=${shellQuote(home)} ${cli} status --deep`);
  return lines;
}

function classifyResumeState(input: {
  combo: ComboRecord;
  events: ComboEvent[];
  downstream: string | undefined;
  headSha: string | undefined;
  home: string;
  cli: string;
  gh: GhRunner;
  engine: "v0" | "capsule";
}): ResumeState {
  const { combo, events, downstream, headSha, home, cli } = input;
  // Capsule-engine combos resume through the capsule's own journal-derived
  // phase; the display-string downstream dispatch below stays v0-only. A dead
  // gnhf after coder_done is healthy here (thread harvested, awaiting the
  // next routed turn), so it must not classify as coder salvage.
  if (input.engine === "capsule") {
    if (hasClosurePendingEvent(events)) return { kind: "closure_pending", reason: "journal" };
    const capsulePrUrl = latestPrUrlFromEvents(events);
    if (capsulePrUrl !== undefined && githubPrMerged(input.gh, capsulePrUrl)) {
      return { kind: "closure_pending", reason: "github" };
    }
    return { kind: "capsule", phase: classifyCapsulePhase(events) };
  }
  if (downstream === PR_READY_FOR_REVIEWER) return { kind: "reviewer_ready" };
  if (downstream?.startsWith(NO_MISTAKES_RUNNING)) {
    return { kind: "gate_running", downstream };
  }
  if (downstream?.startsWith(AWAITING_REVIEW_GATE)) {
    return { kind: "gate_waiting", downstream };
  }

  const prUrl = latestPrUrlFromEvents(events);
  if (hasClosurePendingEvent(events)) return { kind: "closure_pending", reason: "journal" };
  if (prUrl !== undefined && githubPrMerged(input.gh, prUrl)) {
    return { kind: "closure_pending", reason: "github" };
  }
  if (prUrl !== undefined) return { kind: "pr_exists", prUrl };

  if (shouldRetryInitialGate(events, headSha)) return { kind: "initial_gate_retry" };

  const status = latestGateStatus(events);
  if (status?.state === "fix_inflight" || status?.state === "awaiting_approval") {
    return { kind: "gate_ambiguous", state: status.state };
  }

  const salvage = salvageCoderStoppedBeforeHandoff({ combo, events, home, cli });
  if (salvage !== undefined) return { kind: "coder_salvage", lines: salvage };

  return { kind: "unknown_salvage" };
}
// -/ 2/3

// -- 3/3 CORE · resumeCombo <- START HERE --
export async function resumeCombo(input: {
  deps: ResumeDeps;
  home: string;
  comboId: string;
  cli: string;
}): Promise<void> {
  const { deps, home, comboId, cli } = input;
  const runDir = runDirFor(home, comboId);
  const combo = readCombo(runDir);
  const events = readEvents(runDir);
  const config = loadRuntimeConfig(runDir, { repoDir: combo.repoDir, env: deps.env });
  const engine = isCapsuleEngine(config) ? "capsule" : "v0";
  const downstream =
    engine === "capsule"
      ? undefined
      : deepComboStatus(combo, events, deps.noMistakes, deps.gh, {
          requiredCheckNames: config.readyRequiredChecks,
          ambientCheckNames: config.externalCommentAgents,
        });
  const headSha = currentWorktreeHeadSha(deps, combo);
  const state = classifyResumeState({ combo, events, downstream, headSha, home, cli, gh: deps.gh, engine });

  if (state.kind === "capsule") {
    if (state.phase === "closed") {
      deps.out(`resume: ${combo.id} is already combo_closed; nothing to resume`);
      return;
    }
    const recreated = convergeCapsuleTopology({ deps, combo, home, cli, config, runDir });
    pruneLegacyTopology({ deps, combo, config });
    deps.out(
      `resume: capsule engine (${state.phase}); capsule window ensured in ${combo.tmuxSession}` +
        `${recreated ? " (recreated tmux session)" : ""}`,
    );
    return;
  }

  if (state.kind === "reviewer_ready") {
    const recreated = convergeStableTopology({ deps, combo, home, cli, config });
    pruneLegacyTopology({ deps, combo, config });
    activateReviewer({ deps, home, comboId: combo.id, cli });
    deps.out(`resume: ${PR_READY_FOR_REVIEWER}${recreated ? " (recreated tmux session)" : ""}`);
    return;
  }

  if (state.kind === "gate_running") {
    const recreated = convergeStableTopology({ deps, combo, home, cli, config });
    const prUrl = ensurePrOpenedForLiveCi({ deps, combo, runDir, events, downstream: state.downstream });
    if (prUrl !== undefined) {
      activateReviewer({ deps, home, comboId: combo.id, cli });
    }
    deps.out(
      `resume: ${state.downstream}; monitoring in ${combo.tmuxSession}:${GATEKEEPER_WINDOW}` +
        `${prUrl !== undefined ? "; reviewer/director monitoring ensured" : ""}` +
        `${recreated ? " (recreated tmux session)" : ""}`,
    );
    return;
  }

  if (state.kind === "closure_pending") {
    deps.out(`resume: closure pending for ${combo.id} (${state.reason}); running closure`);
    await closeMergedCombo({ deps, home, comboId: combo.id });
    return;
  }

  if (state.kind === "gate_waiting") {
    deps.out(`resume: ${state.downstream}`);
    return;
  }

  if (state.kind === "initial_gate_retry") {
    const recreated = convergeStableTopology({ deps, combo, home, cli, config });
    pruneLegacyTopology({ deps, combo, config });
    const result = startInitialGateRetry({ deps, combo, runDir, cli });
    if (result.started) {
      deps.out(
        `resume: initial gate relaunched for ${combo.id} at ${result.headSha}` +
          `${recreated ? " (recreated tmux session)" : ""}`,
      );
    }
    return;
  }

  if (state.kind === "pr_exists") {
    const recreated = convergeStableTopology({ deps, combo, home, cli, config });
    pruneLegacyTopology({ deps, combo, config });
    activateReviewer({ deps, home, comboId: combo.id, cli });
    deps.out(
      `resume: PR exists at ${state.prUrl}; reviewer/director monitoring ensured` +
        `${recreated ? " (recreated tmux session)" : ""}`,
    );
    return;
  }

  if (state.kind === "coder_salvage") {
    for (const line of state.lines) deps.out(line);
    return;
  }

  if (state.kind === "gate_ambiguous") {
    deps.out(
      `resume: gate journal is ${state.state} for ${combo.id}, but no live gate was confirmed. ` +
        `Inspect ${runDir} and no-mistakes status before relaunching.`,
    );
    return;
  }

  deps.out(
    `resume: salvage required for ${combo.id}; no pr_opened event. ` +
      `Inspect ${runDir} and ${combo.worktree} before continuing coder work.`,
  );
}

function convergeCapsuleTopology(input: {
  deps: Pick<ResumeDeps, "env" | "tmux">;
  combo: ComboRecord;
  home: string;
  cli: string;
  config: ReturnType<typeof loadRuntimeConfig>;
  runDir: string;
}): boolean {
  const { deps, combo, home, cli, config, runDir } = input;
  const recreated = ensureComboSession({ deps, combo, home, cli });
  ensureWindowPresent(
    deps,
    combo,
    DIRECTOR_WINDOW,
    buildDirectorInvocation({ combo, directorCommand: config.directorCommand }),
  );
  ensureWindowPresent(deps, combo, CODER_WINDOW, idleRoleWindowCommand(CODER_WINDOW));
  ensureGatekeeperWindow(deps, combo, {
    timeoutSeconds: config.gatekeeperAttachTimeoutSeconds,
    retryIntervalSeconds: config.gatekeeperAttachRetryIntervalSeconds,
  });
  ensureWindowPresent(deps, combo, REVIEWER_WINDOW, idleRoleWindowCommand(REVIEWER_WINDOW));
  // The relaunched capsule re-derives its own phase from the journal, so the
  // same entry command is correct for gate and supervise resumes alike.
  ensureWindowPresent(deps, combo, CAPSULE_WINDOW, capsuleWindowCommand({ cli, comboHome: home, runDir }));
  return recreated;
}

function convergeStableTopology(input: {
  deps: Pick<ResumeDeps, "env" | "tmux">;
  combo: ComboRecord;
  home: string;
  cli: string;
  config: ReturnType<typeof loadRuntimeConfig>;
}): boolean {
  const { deps, combo, home, cli, config } = input;
  const recreated = ensureComboSession({ deps, combo, home, cli });
  ensureWindowPresent(
    deps,
    combo,
    DIRECTOR_WINDOW,
    buildDirectorInvocation({ combo, directorCommand: config.directorCommand }),
  );
  ensureWindowPresent(deps, combo, CODER_WINDOW, idleRoleWindowCommand(CODER_WINDOW));
  ensureGatekeeperWindow(deps, combo, {
    timeoutSeconds: config.gatekeeperAttachTimeoutSeconds,
    retryIntervalSeconds: config.gatekeeperAttachRetryIntervalSeconds,
  });
  ensureWindowPresent(deps, combo, REVIEWER_WINDOW, idleRoleWindowCommand(REVIEWER_WINDOW));
  ensureWindowPresent(
    deps,
    combo,
    DIRECTOR_WATCH_WINDOW,
    buildDirectorWatchCommand({
      cli,
      comboHome: home,
      comboId: combo.id,
      pollSeconds: config.limits.babysitPollSeconds,
      watchFailureLimit: config.limits.watchFailureLimit,
      watchBackoffMaxSeconds: config.limits.watchBackoffMaxSeconds,
    }),
  );
  return recreated;
}

function pruneLegacyTopology(input: {
  deps: Pick<ResumeDeps, "tmux">;
  combo: ComboRecord;
  config: ReturnType<typeof loadRuntimeConfig>;
}): void {
  const { deps, combo, config } = input;
  removeLegacyTopologyWindows(deps, combo, {
    removeCoderResponding: config.coderRespondingWindowName === CODER_WINDOW,
  });
}
// -/ 3/3
