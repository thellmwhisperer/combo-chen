/**
 * @overview Worker pane monitor. ~570 lines, detects permission prompts,
 *   terminal worker holds, dead panes, and unchanged panes before the director
 *   silently waits.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at inspectWorkerPanes  <- one director-tick inspection pass.
 *   2. Then readSnapshot/writeSnapshot <- persisted unchanged-pane counts.
 *   3. Bottom helpers              <- tmux parsing and escalation guards.
 *
 *   MAIN FLOW
 *   ---------
 *   director-tick -> inspectWorkerPanes -> tmux capture/list-panes
 *     -> needs_human event when a worker is stuck
 *
 *   PUBLIC API
 *   ----------
 *   WorkerMonitorDeps       Minimal deps for tmux capture + output.
 *   WorkerPaneReason        Canonical worker finding reasons.
 *   WorkerPaneFinding       Actionable worker finding returned to director.
 *   WorkerPaneInspection    Summary and findings returned to director.
 *   WorkerPaneMonitorInput  Inputs for one worker-monitor tick.
 *   appendWorkerEscalation  Deduplicated needs_human writer for worker findings.
 *   resetWorkerSnapshot     Clear a worker's unchanged-pane counter after recovery.
 *   inspectWorkerPanes      Inspect active worker windows once.
 *
 *   INTERNALS
 *   ---------
 *   readSnapshot, writeSnapshot, paneFingerprint, compilePermissionPromptPatterns,
 *   hasPermissionPrompt, hasGnhfTerminalFailure, newestGnhfLogPath, coderGnhfProgressAge,
 *   gnhfRunEndRecorded, autoApprovePermissionPrompt, workerRecoveryAttempts, gatekeeperRunActive,
 *   reviewerOrchestratorEvidence,
 *   latestInitialCoderTerminalOutcome, terminalOutcomeSummary, hasEscalation
 *
 * @exports WorkerMonitorDeps, WorkerPaneReason, WorkerPaneFinding, WorkerPaneInspection, WorkerPaneMonitorInput, appendWorkerEscalation, resetWorkerSnapshot, workerRecoveryAttempts, inspectWorkerPanes
 * @deps ../../core/events, ../../core/state, ../../infra/config, ../../infra/tmux, ../reporting/status, ../runtime/sessions, node:crypto, node:fs, node:path
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendEvent, readEvents, type ComboEvent } from "../../core/events.js";
import type { ComboRecord } from "../../core/state.js";
import {
  DEFAULT_WORKER_RECOVERY_ATTEMPTS,
  DEFAULT_PERMISSION_PROMPT_PATTERNS,
  type WorkerPermissionPromptPolicy,
} from "../../infra/config.js";
import {
  captureWindowArgs,
  hasSessionArgs,
  listPanesArgs,
  listWindowsArgs,
  type TmuxResult,
} from "../../infra/tmux.js";
import { idleRoleWindowCommand, windowSet } from "../runtime/sessions.js";
import { noMistakesAxiStatusActive, parseNoMistakesAxiStatus } from "../reporting/status.js";

// -- 1/1 CORE · inspectWorkerPanes <- START HERE --
export interface WorkerMonitorDeps {
  out: (line: string) => void;
  tmux: (args: string[]) => TmuxResult;
  noMistakes?: (args: string[], cwd: string, options?: { timeoutMs?: number }) => TmuxResult;
}

export type WorkerPaneReason = "worker_permission_prompt" | "worker_dead" | "worker_stalled";

export interface WorkerPaneFinding {
  worker: string;
  reason: WorkerPaneReason;
  detail: string;
  needsHumanRecorded: boolean;
}

export interface WorkerPaneInspection {
  escalated: boolean;
  summaries: string[];
  findings: WorkerPaneFinding[];
}

interface WorkerSnapshotEntry {
  fingerprint: string;
  unchangedTicks: number;
}

type WorkerSnapshot = Record<string, WorkerSnapshotEntry>;

const SNAPSHOT_FILE = "worker-panes.json";
const DEFAULT_STALL_TICKS = 3;
function newestGnhfLogPath(worktree: string): string | undefined {
  const runsDir = join(worktree, ".gnhf", "runs");
  if (!existsSync(runsDir)) return undefined;
  let newest = 0;
  let newestPath: string | undefined;
  try {
    for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const logPath = join(runsDir, entry.name, "gnhf.log");
      if (!existsSync(logPath)) continue;
      const mtimeMs = statSync(logPath).mtimeMs;
      if (mtimeMs > newest) {
        newest = mtimeMs;
        newestPath = logPath;
      }
    }
  } catch {
    return undefined;
  }
  return newestPath;
}

function coderGnhfProgressAge(worktree: string): number | undefined {
  const logPath = newestGnhfLogPath(worktree);
  if (logPath === undefined) return undefined;
  try {
    return Date.now() - statSync(logPath).mtimeMs;
  } catch {
    return undefined;
  }
}

//    gnhf appends orchestrator:end in a finally whenever the loop ends; only a
//    hard kill skips it. Its absence in a fresh log means the run is alive.
function gnhfRunEndRecorded(worktree: string): boolean | undefined {
  const logPath = newestGnhfLogPath(worktree);
  if (logPath === undefined) return undefined;
  try {
    return readFileSync(logPath, "utf8").includes('"event":"orchestrator:end"');
  } catch {
    return undefined;
  }
}

function snapshotPath(runDir: string): string {
  return join(runDir, SNAPSHOT_FILE);
}

function readSnapshot(runDir: string): WorkerSnapshot {
  const path = snapshotPath(runDir);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as WorkerSnapshot;
  } catch {
    return {};
  }
}

function writeSnapshot(runDir: string, snapshot: WorkerSnapshot): void {
  writeFileSync(snapshotPath(runDir), `${JSON.stringify(snapshot, null, 2)}\n`);
}

export function resetWorkerSnapshot(runDir: string, worker: string): void {
  const snapshot = readSnapshot(runDir);
  if (snapshot[worker] === undefined) return;
  delete snapshot[worker];
  writeSnapshot(runDir, snapshot);
}

function paneFingerprint(pane: string): string {
  return createHash("sha256").update(pane).digest("hex");
}

function paneLooksLikeIdleRoleWindow(worker: string, pane: string): boolean {
  const idleMessage = `[combo-chen] ${worker} window idle; waiting for combo-chen to prompt it.`;
  if (!pane.includes(idleMessage)) return false;
  const idleLines = new Set(
    [idleMessage, ...idleRoleWindowCommand(worker).split(/\r?\n/)].map((line) => line.trim()).filter(Boolean),
  );
  const paneLines = pane
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return paneLines.length > 0 && paneLines.every((line) => idleLines.has(line));
}

function compilePermissionPromptPatterns(patterns: string[]): RegExp[] {
  return patterns.map((pattern) => new RegExp(pattern, "i"));
}

function hasPermissionPrompt(pane: string, patterns: RegExp[]): boolean {
  return pane.split(/\r?\n/).some((line) => patterns.some((pattern) => pattern.test(line)));
}

function hasGnhfTerminalFailure(pane: string): boolean {
  return /"success"\s*:\s*false/.test(pane) && /gnhf\s+again\s+to\s+resume/i.test(pane);
}

function autoApprovePermissionPrompt(
  deps: WorkerMonitorDeps,
  combo: ComboRecord,
  worker: string,
): { recovered: true } | { recovered: false; detail: string } {
  const result = deps.tmux(["send-keys", "-t", `${combo.tmuxSession}:${worker}`, "y", "C-m"]);
  if (result.status === 0) return { recovered: true };
  return {
    recovered: false,
    detail: result.stderr.trim() || result.stdout.trim() || "tmux send-keys failed",
  };
}

export function workerRecoveryAttempts(events: ComboEvent[], worker: string, reason: string): number {
  return events.filter(
    (event) =>
      (event.event === "worker_recovered" || event.event === "worker_recovery_failed") &&
      event["worker"] === worker &&
      event["reason"] === reason,
  ).length;
}

function latestInitialCoderTerminalOutcome(
  events: ComboEvent[],
): { outcome: "coder_done" | "coder_failed"; index: number } | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.event === "coder_done" || event.event === "coder_failed") {
      return { outcome: event.event, index: i };
    }
    if (event.event === "coder_started") return undefined;
  }
  return undefined;
}

function hasCoderResponsePromptAfter(events: ComboEvent[], index: number): boolean {
  let unresolved = false;
  for (const event of events.slice(index + 1)) {
    if (event.event === "review_comment" || event.event === "pr_conflict") {
      unresolved = true;
    } else if (event.event === "lgtm") {
      unresolved = false;
    }
  }
  return unresolved;
}

function terminalOutcomeSummary(worker: string, outcome: "coder_done" | "coder_failed"): string {
  return `worker ${worker}: terminal_outcome=${outcome}`;
}

function hasEscalation(runDir: string, reason: string, worker: string): boolean {
  return readEvents(runDir).some(
    (event) => event.event === "needs_human" && event["reason"] === reason && event["worker"] === worker,
  );
}

function gatekeeperRunActive(
  deps: WorkerMonitorDeps,
  combo: ComboRecord,
  timeoutMs: number | undefined,
): boolean {
  if (timeoutMs === undefined) return false;
  if (deps.noMistakes === undefined) return false;
  try {
    const status = deps.noMistakes(["axi", "status"], combo.worktree, {
      timeoutMs,
    });
    if (status.status !== 0) return false;
    const facts = parseNoMistakesAxiStatus(status.stdout);
    return facts.branch === combo.branch && noMistakesAxiStatusActive(facts);
  } catch {
    return false;
  }
}

function reviewerOrchestratorEvidence(events: ComboEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.event === "ready_for_merge" || event.event === "lgtm_stale" || event.event === "pr_opened") {
      return undefined;
    }
    if (event.event === "lgtm") return "reviewer artifact recent";
    if (event.event === "external_review_requested") return "external review active";
  }
  return undefined;
}

export function appendWorkerEscalation(
  runDir: string,
  deps: WorkerMonitorDeps,
  worker: string,
  reason: WorkerPaneReason,
  detail: string,
): void {
  if (!hasEscalation(runDir, reason, worker)) {
    appendEvent(runDir, "needs_human", { reason, worker, detail });
  }
  deps.out(`director: worker ${worker} ${detail}`);
}

function recordFinding(input: {
  runDir: string;
  deps: WorkerMonitorDeps;
  worker: string;
  reason: WorkerPaneReason;
  detail: string;
  deferNeedsHuman?: boolean;
}): WorkerPaneFinding {
  if (input.deferNeedsHuman === true) {
    input.deps.out(`director: worker ${input.worker} ${input.detail}`);
    return {
      worker: input.worker,
      reason: input.reason,
      detail: input.detail,
      needsHumanRecorded: false,
    };
  }
  appendWorkerEscalation(input.runDir, input.deps, input.worker, input.reason, input.detail);
  return {
    worker: input.worker,
    reason: input.reason,
    detail: input.detail,
    needsHumanRecorded: true,
  };
}

export interface WorkerPaneMonitorInput {
  deps: WorkerMonitorDeps;
  combo: ComboRecord;
  runDir: string;
  workerWindows: string[];
  stallTicks?: number;
  coderGnhfProgressMaxAgeMs?: number;
  gatekeeperStatusTimeoutMs?: number;
  recoverableDeadWorkers?: string[];
  recoverableStalledWorkers?: string[];
  recoverablePermissionPromptWorkers?: string[];
  autoApprovePermissionPromptMaxAttempts?: number;
  permissionPromptPatterns?: string[];
  permissionPromptPolicy?: WorkerPermissionPromptPolicy;
}

export function inspectWorkerPanes(input: WorkerPaneMonitorInput): WorkerPaneInspection {
  const { deps, combo, runDir } = input;
  const summaries: string[] = [];
  const findings: WorkerPaneFinding[] = [];
  const events = readEvents(runDir);
  const initialCoderOutcome = latestInitialCoderTerminalOutcome(events);
  const recoverableDeadWorkers = new Set(input.recoverableDeadWorkers ?? []);
  const listed = deps.tmux(listWindowsArgs(combo.tmuxSession));
  if (listed.status !== 0) {
    const detail = listed.stderr.trim() || "tmux list-windows failed";
    const session = deps.tmux(hasSessionArgs(combo.tmuxSession));
    if (session.status === 0) {
      summaries.push(`workers unavailable: ${detail}`);
      deps.out(`director: workers unavailable: ${detail}`);
      return { escalated: false, summaries, findings };
    }
    const deadDetail = session.stderr.trim() || detail;
    for (const worker of new Set(input.workerWindows)) {
      if (
        worker === "coder" &&
        initialCoderOutcome?.outcome === "coder_done" &&
        !hasCoderResponsePromptAfter(events, initialCoderOutcome.index)
      ) {
        const summary = terminalOutcomeSummary(worker, initialCoderOutcome.outcome);
        summaries.push(summary);
        deps.out(`director: ${summary}`);
        continue;
      }
      findings.push(
        recordFinding({
          runDir,
          deps,
          worker,
          reason: "worker_dead",
          detail: deadDetail,
          deferNeedsHuman: recoverableDeadWorkers.has(worker),
        }),
      );
    }
    if (findings.length === 0) {
      return { escalated: false, summaries, findings };
    }
    summaries.push(`workers unavailable: ${deadDetail}`);
    return { escalated: true, summaries, findings };
  }

  const active = windowSet(listed.stdout);
  const snapshot = readSnapshot(runDir);
  const stallTicks = input.stallTicks ?? DEFAULT_STALL_TICKS;
  const recoverableStalledWorkers = new Set(input.recoverableStalledWorkers ?? []);
  const recoverablePermissionPromptWorkers = new Set(input.recoverablePermissionPromptWorkers ?? []);
  const autoApprovePermissionPromptMaxAttempts =
    input.autoApprovePermissionPromptMaxAttempts ?? DEFAULT_WORKER_RECOVERY_ATTEMPTS;
  const permissionPromptPatterns = compilePermissionPromptPatterns(
    input.permissionPromptPatterns ?? DEFAULT_PERMISSION_PROMPT_PATTERNS,
  );
  const permissionPromptPolicy = input.permissionPromptPolicy ?? "escalate";
  let escalated = false;

  for (const worker of new Set(input.workerWindows)) {
    if (!active.has(worker)) continue;

    if (
      worker === "coder" &&
      initialCoderOutcome?.outcome === "coder_done" &&
      !hasCoderResponsePromptAfter(events, initialCoderOutcome.index)
    ) {
      summaries.push(terminalOutcomeSummary(worker, initialCoderOutcome.outcome));
      continue;
    }

    const panePids = deps.tmux(listPanesArgs(combo.tmuxSession, worker));
    if (panePids.status !== 0 || panePids.stdout.trim() === "") {
      findings.push(
        recordFinding({
          runDir,
          deps,
          worker,
          reason: "worker_dead",
          detail: "dead pane",
          deferNeedsHuman: recoverableDeadWorkers.has(worker),
        }),
      );
      escalated = true;
      continue;
    }

    const captured = deps.tmux(captureWindowArgs(combo.tmuxSession, worker));
    if (captured.status !== 0) {
      findings.push(
        recordFinding({
          runDir,
          deps,
          worker,
          reason: "worker_dead",
          detail: captured.stderr.trim() || "capture failed",
          deferNeedsHuman: recoverableDeadWorkers.has(worker),
        }),
      );
      escalated = true;
      continue;
    }

    const pane = captured.stdout;
    if (paneLooksLikeIdleRoleWindow(worker, pane)) {
      delete snapshot[worker];
      summaries.push(`worker ${worker}: idle role window`);
      continue;
    }

    if (hasPermissionPrompt(pane, permissionPromptPatterns)) {
      if (permissionPromptPolicy === "auto-approve-known-safe") {
        const attempts = workerRecoveryAttempts(readEvents(runDir), worker, "worker_permission_prompt");
        if (attempts >= autoApprovePermissionPromptMaxAttempts) {
          findings.push(
            recordFinding({
              runDir,
              deps,
              worker,
              reason: "worker_permission_prompt",
              detail: `recovery attempts exhausted after ${autoApprovePermissionPromptMaxAttempts}; permission prompt`,
            }),
          );
          escalated = true;
          continue;
        }
        const recovery = autoApprovePermissionPrompt(deps, combo, worker);
        if (recovery.recovered) {
          appendEvent(runDir, "worker_recovered", {
            worker,
            reason: "worker_permission_prompt",
            detail: "permission prompt auto-approved",
            attempt: attempts + 1,
            max_attempts: autoApprovePermissionPromptMaxAttempts,
          });
          summaries.push(
            `worker ${worker}: permission_prompt=auto-approved attempt=${attempts + 1}/${autoApprovePermissionPromptMaxAttempts}`,
          );
          deps.out(
            `director: worker ${worker} permission prompt auto-approved attempt ${attempts + 1}/${autoApprovePermissionPromptMaxAttempts}`,
          );
          continue;
        }
        findings.push(
          recordFinding({
            runDir,
            deps,
            worker,
            reason: "worker_permission_prompt",
            detail: `permission prompt auto-approve failed: ${recovery.detail}`,
          }),
        );
        escalated = true;
        continue;
      }
      const deferNeedsHuman =
        permissionPromptPolicy === "recreate-non-interactive" &&
        recoverablePermissionPromptWorkers.has(worker);
      findings.push(
        recordFinding({
          runDir,
          deps,
          worker,
          reason: "worker_permission_prompt",
          detail: "permission prompt",
          deferNeedsHuman,
        }),
      );
      escalated = true;
      continue;
    }

    if (worker === "coder" && hasGnhfTerminalFailure(pane)) {
      // The pane fingerprint alone is not terminal evidence: gnhf's footer
      // shows "gnhf again to resume" while healthy, and codex streams interim
      // contract JSON with "success": false throughout an iteration. Only the
      // orchestrator log can confirm the run actually ended.
      const endRecorded = combo.worktree ? gnhfRunEndRecorded(combo.worktree) : undefined;
      const progressAge = combo.worktree ? coderGnhfProgressAge(combo.worktree) : undefined;
      const progressMaxAgeMs = input.coderGnhfProgressMaxAgeMs ?? 10 * 60 * 1000;
      const runStillActive =
        endRecorded === false && progressAge !== undefined && progressAge < progressMaxAgeMs;
      if (runStillActive) {
        summaries.push(
          `worker ${worker}: pane matched gnhf terminal fingerprint but the gnhf run is still active, not dead`,
        );
        continue;
      }
      findings.push(
        recordFinding({
          runDir,
          deps,
          worker,
          reason: "worker_dead",
          detail: "gnhf stopped without success",
          deferNeedsHuman: recoverableDeadWorkers.has(worker),
        }),
      );
      escalated = true;
      continue;
    }

    const fingerprint = paneFingerprint(pane);
    const previous = snapshot[worker];
    const unchangedTicks = previous?.fingerprint === fingerprint ? previous.unchangedTicks + 1 : 1;
    snapshot[worker] = { fingerprint, unchangedTicks };
    if (unchangedTicks < stallTicks) {
      summaries.push(`worker ${worker}: unchanged_ticks=${unchangedTicks}`);
      continue;
    }

    // Before flagging a coder as stalled, check if gnhf is alive and
    // progressing. The gnhf spinner while codex reasons makes the pane
    // appear unchanged, but gnhf.log written by the orchestrator shows
    // real activity.
    const isCoder = worker === "coder";
    const gnhfAlive =
      isCoder && combo.worktree
        ? gnhfRunEndRecorded(combo.worktree) === false &&
          (coderGnhfProgressAge(combo.worktree) ?? Infinity) <
            (input.coderGnhfProgressMaxAgeMs ?? 10 * 60 * 1000)
        : false;
    if (isCoder && gnhfAlive) {
      summaries.push(
        `worker ${worker}: unchanged_ticks=${unchangedTicks}; gnhf run active; gnhf is actively progressing, not stalled`,
      );
      continue;
    }
    if (worker === "gatekeeper" && gatekeeperRunActive(deps, combo, input.gatekeeperStatusTimeoutMs)) {
      summaries.push(`worker ${worker}: unchanged_ticks=${unchangedTicks}; gate run active`);
      continue;
    }
    if (worker === "reviewer") {
      const evidence = reviewerOrchestratorEvidence(events);
      if (evidence !== undefined) {
        summaries.push(`worker ${worker}: unchanged_ticks=${unchangedTicks}; ${evidence}`);
        continue;
      }
    }
    summaries.push(`worker ${worker}: unchanged_ticks=${unchangedTicks}; no orchestrator evidence`);
    findings.push(
      recordFinding({
        runDir,
        deps,
        worker,
        reason: "worker_stalled",
        detail: `unchanged pane for ${unchangedTicks} ticks`,
        deferNeedsHuman: recoverableStalledWorkers.has(worker),
      }),
    );
    escalated = true;
  }

  writeSnapshot(runDir, snapshot);
  for (const summary of summaries) deps.out(`director: ${summary}`);
  return { escalated, summaries, findings };
}
// -/ 1/1
