/**
 * @overview Worker pane monitor. ~335 lines, detects permission prompts,
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
 *   hasPermissionPrompt, autoApprovePermissionPrompt, hasEscalation
 *
 * @exports WorkerMonitorDeps, WorkerPaneReason, WorkerPaneFinding, WorkerPaneInspection, WorkerPaneMonitorInput, appendWorkerEscalation, resetWorkerSnapshot, inspectWorkerPanes
 * @deps node:{crypto,fs,path}, ../core/{events,state}, ../infra/{config,tmux}
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendEvent, readEvents } from "../core/events.js";
import type { ComboRecord } from "../core/state.js";
import {
  DEFAULT_PERMISSION_PROMPT_PATTERNS,
  type WorkerPermissionPromptPolicy,
} from "../infra/config.js";
import {
  captureWindowArgs,
  hasSessionArgs,
  listPanesArgs,
  listWindowsArgs,
  type TmuxResult,
} from "../infra/tmux.js";

// -- 1/1 CORE · inspectWorkerPanes <- START HERE --
export interface WorkerMonitorDeps {
  out: (line: string) => void;
  tmux: (args: string[]) => TmuxResult;
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

function activeWindowNames(stdout: string): Set<string> {
  return new Set(stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
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

function hasEscalation(runDir: string, reason: string, worker: string): boolean {
  return readEvents(runDir).some(
    (event) =>
      event.event === "needs_human" &&
      event["reason"] === reason &&
      event["worker"] === worker,
  );
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
  recoverableDeadWorkers?: string[];
  recoverableStalledWorkers?: string[];
  recoverablePermissionPromptWorkers?: string[];
  permissionPromptPatterns?: string[];
  permissionPromptPolicy?: WorkerPermissionPromptPolicy;
}

export function inspectWorkerPanes(input: WorkerPaneMonitorInput): WorkerPaneInspection {
  const { deps, combo, runDir } = input;
  const summaries: string[] = [];
  const findings: WorkerPaneFinding[] = [];
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
      findings.push(recordFinding({
        runDir,
        deps,
        worker,
        reason: "worker_dead",
        detail: deadDetail,
        deferNeedsHuman: recoverableDeadWorkers.has(worker),
      }));
    }
    summaries.push(`workers unavailable: ${deadDetail}`);
    return { escalated: true, summaries, findings };
  }

  const active = activeWindowNames(listed.stdout);
  const snapshot = readSnapshot(runDir);
  const stallTicks = input.stallTicks ?? DEFAULT_STALL_TICKS;
  const recoverableStalledWorkers = new Set(input.recoverableStalledWorkers ?? []);
  const recoverablePermissionPromptWorkers = new Set(input.recoverablePermissionPromptWorkers ?? []);
  const permissionPromptPatterns = compilePermissionPromptPatterns(
    input.permissionPromptPatterns ?? DEFAULT_PERMISSION_PROMPT_PATTERNS,
  );
  const permissionPromptPolicy = input.permissionPromptPolicy ?? "escalate";
  let escalated = false;

  for (const worker of new Set(input.workerWindows)) {
    if (!active.has(worker)) continue;

    const panePids = deps.tmux(listPanesArgs(combo.tmuxSession, worker));
    if (panePids.status !== 0 || panePids.stdout.trim() === "") {
      findings.push(recordFinding({
        runDir,
        deps,
        worker,
        reason: "worker_dead",
        detail: "dead pane",
        deferNeedsHuman: recoverableDeadWorkers.has(worker),
      }));
      escalated = true;
      continue;
    }

    const captured = deps.tmux(captureWindowArgs(combo.tmuxSession, worker));
    if (captured.status !== 0) {
      findings.push(recordFinding({
        runDir,
        deps,
        worker,
        reason: "worker_dead",
        detail: captured.stderr.trim() || "capture failed",
        deferNeedsHuman: recoverableDeadWorkers.has(worker),
      }));
      escalated = true;
      continue;
    }

    const pane = captured.stdout;
    if (hasPermissionPrompt(pane, permissionPromptPatterns)) {
      if (permissionPromptPolicy === "auto-approve-known-safe") {
        const recovery = autoApprovePermissionPrompt(deps, combo, worker);
        if (recovery.recovered) {
          summaries.push(`worker ${worker}: permission_prompt=auto-approved`);
          deps.out(`director: worker ${worker} permission prompt auto-approved`);
          continue;
        }
        findings.push(recordFinding({
          runDir,
          deps,
          worker,
          reason: "worker_permission_prompt",
          detail: `permission prompt auto-approve failed: ${recovery.detail}`,
        }));
        escalated = true;
        continue;
      }
      const deferNeedsHuman =
        permissionPromptPolicy === "recreate-non-interactive" &&
        recoverablePermissionPromptWorkers.has(worker);
      findings.push(recordFinding({
        runDir,
        deps,
        worker,
        reason: "worker_permission_prompt",
        detail: "permission prompt",
        deferNeedsHuman,
      }));
      escalated = true;
      continue;
    }

    if (worker === "coder" && hasGnhfTerminalFailure(pane)) {
      findings.push(recordFinding({
        runDir,
        deps,
        worker,
        reason: "worker_dead",
        detail: "gnhf stopped without success",
        deferNeedsHuman: recoverableDeadWorkers.has(worker),
      }));
      escalated = true;
      continue;
    }

    const fingerprint = paneFingerprint(pane);
    const previous = snapshot[worker];
    const unchangedTicks = previous?.fingerprint === fingerprint
      ? previous.unchangedTicks + 1
      : 1;
    snapshot[worker] = { fingerprint, unchangedTicks };
    summaries.push(`worker ${worker}: unchanged_ticks=${unchangedTicks}`);

    if (unchangedTicks >= stallTicks) {
      findings.push(recordFinding({
        runDir,
        deps,
        worker,
        reason: "worker_stalled",
        detail: `unchanged pane for ${unchangedTicks} ticks`,
        deferNeedsHuman: recoverableStalledWorkers.has(worker),
      }));
      escalated = true;
    }
  }

  writeSnapshot(runDir, snapshot);
  for (const summary of summaries) deps.out(`director: ${summary}`);
  return { escalated, summaries, findings };
}
// -/ 1/1
