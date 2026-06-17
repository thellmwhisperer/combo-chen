/**
 * @overview Worker pane monitor. ~180 lines, detects permission prompts,
 *   dead panes, and unchanged panes before the director silently waits.
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
 *   WorkerPaneInspection    Summary returned to director.
 *   WorkerPaneMonitorInput  Inputs for one worker-monitor tick.
 *   inspectWorkerPanes      Inspect active worker windows once.
 *
 *   INTERNALS
 *   ---------
 *   readSnapshot, writeSnapshot, paneFingerprint, compilePermissionPromptPatterns,
 *   hasPermissionPrompt, hasEscalation
 *
 * @exports WorkerMonitorDeps, WorkerPaneInspection, WorkerPaneMonitorInput, inspectWorkerPanes
 * @deps node:{crypto,fs,path}, ../core/{events,state}, ../infra/{config,tmux}
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendEvent, readEvents } from "../core/events.js";
import type { ComboRecord } from "../core/state.js";
import { DEFAULT_PERMISSION_PROMPT_PATTERNS } from "../infra/config.js";
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

export interface WorkerPaneInspection {
  escalated: boolean;
  summaries: string[];
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

function hasEscalation(runDir: string, reason: string, worker: string): boolean {
  return readEvents(runDir).some(
    (event) =>
      event.event === "needs_human" &&
      event["reason"] === reason &&
      event["worker"] === worker,
  );
}

function escalate(runDir: string, deps: WorkerMonitorDeps, worker: string, reason: string, detail: string): void {
  if (!hasEscalation(runDir, reason, worker)) {
    appendEvent(runDir, "needs_human", { reason, worker, detail });
  }
  deps.out(`director: worker ${worker} ${detail}`);
}

export interface WorkerPaneMonitorInput {
  deps: WorkerMonitorDeps;
  combo: ComboRecord;
  runDir: string;
  workerWindows: string[];
  stallTicks?: number;
  permissionPromptPatterns?: string[];
}

export function inspectWorkerPanes(input: WorkerPaneMonitorInput): WorkerPaneInspection {
  const { deps, combo, runDir } = input;
  const summaries: string[] = [];
  const listed = deps.tmux(listWindowsArgs(combo.tmuxSession));
  if (listed.status !== 0) {
    const detail = listed.stderr.trim() || "tmux list-windows failed";
    const session = deps.tmux(hasSessionArgs(combo.tmuxSession));
    if (session.status === 0) {
      summaries.push(`workers unavailable: ${detail}`);
      deps.out(`director: workers unavailable: ${detail}`);
      return { escalated: false, summaries };
    }
    const deadDetail = session.stderr.trim() || detail;
    for (const worker of new Set(input.workerWindows)) {
      escalate(runDir, deps, worker, "worker_dead", deadDetail);
    }
    summaries.push(`workers unavailable: ${deadDetail}`);
    return { escalated: true, summaries };
  }

  const active = activeWindowNames(listed.stdout);
  const snapshot = readSnapshot(runDir);
  const stallTicks = input.stallTicks ?? DEFAULT_STALL_TICKS;
  const permissionPromptPatterns = compilePermissionPromptPatterns(
    input.permissionPromptPatterns ?? DEFAULT_PERMISSION_PROMPT_PATTERNS,
  );
  let escalated = false;

  for (const worker of new Set(input.workerWindows)) {
    if (!active.has(worker)) continue;

    const panePids = deps.tmux(listPanesArgs(combo.tmuxSession, worker));
    if (panePids.status !== 0 || panePids.stdout.trim() === "") {
      escalate(runDir, deps, worker, "worker_dead", "dead pane");
      escalated = true;
      continue;
    }

    const captured = deps.tmux(captureWindowArgs(combo.tmuxSession, worker));
    if (captured.status !== 0) {
      escalate(runDir, deps, worker, "worker_dead", captured.stderr.trim() || "capture failed");
      escalated = true;
      continue;
    }

    const pane = captured.stdout;
    if (hasPermissionPrompt(pane, permissionPromptPatterns)) {
      escalate(runDir, deps, worker, "worker_permission_prompt", "permission prompt");
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
      escalate(runDir, deps, worker, "worker_stalled", `unchanged pane for ${unchangedTicks} ticks`);
      escalated = true;
    }
  }

  writeSnapshot(runDir, snapshot);
  for (const summary of summaries) deps.out(`director: ${summary}`);
  return { escalated, summaries };
}
// -/ 1/1
