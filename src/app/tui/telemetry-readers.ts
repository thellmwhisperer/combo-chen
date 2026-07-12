/**
 * @overview Live-actor telemetry readers: best-effort I/O wrappers that read
 *   worktree + run-dir observables (gnhf.log, iteration-*.jsonl, overture.json,
 *   git rev-list, no-mistakes axi status) and return raw facts the pure folds
 *   in live-telemetry.ts format. The readers NEVER read tmux panes — only
 *   files and git/no-mistakes command output. Every read is defensive: a
 *   missing or torn file yields undefined fields, never a throw.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at pure parsers           <- parseGnhfLogIterations, parseJsonlTokenUsage.
 *   2. Then gate step parser           <- parseGateStepsFromAxiStatus.
 *   3. Then I/O wrappers               <- readCoderTelemetry, readGateTelemetry.
 *
 *   MAIN FLOW
 *   ---------
 *   loadTuiData -> readCoderTelemetry / readGateTelemetry -> LiveTelemetryFacts
 *   -> deriveFleetRow / deriveThread (pure folds format the facts)
 *
 *   PUBLIC API
 *   ----------
 *   TelemetryDeps           Injected git + noMistakes command runners.
 *   parseGnhfLogIterations  Pure: gnhf.log content -> highest iteration.
 *   parseJsonlTokenUsage    Pure: iteration JSONL content -> token sums.
 *   parseGateStepsFromAxiStatus  Pure: no-mistakes status -> gate step facts.
 *   readCoderTelemetry      I/O: worktree + run-dir + git -> CoderTelemetryFact.
 *   readGateTelemetry       I/O: no-mistakes status -> GateTelemetryFact | undefined.
 *
 *   INTERNALS
 *   ---------
 *   newestGnhfRunDir, iterationFiles, readOvertureBaseRef, extractUsageFields,
 *   mapStepState, DONE_STATUSES, LIVE_STATUSES.
 *
 * @exports TelemetryDeps, parseGnhfLogIterations, parseJsonlTokenUsage, parseGateStepsFromAxiStatus, readCoderTelemetry, readGateTelemetry
 * @deps node:fs, node:path, ./live-telemetry
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { CoderTelemetryFact, GateStepFact, GateTelemetryFact } from "./live-telemetry.js";

// -- 1/4 CORE · types + pure parsers <- START HERE --
export interface TelemetryDeps {
  readonly git: (args: string[], cwd: string) => { status: number; stdout: string; stderr: string };
  readonly noMistakes?: (
    args: string[],
    cwd: string,
    options?: { timeoutMs?: number },
  ) => { status: number; stdout: string; stderr: string };
}

export function parseGnhfLogIterations(
  content: string,
): { iteration: number; maxIterations?: number } | undefined {
  let highest: number | undefined;
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event === null || typeof event !== "object") continue;
    const obj = event as Record<string, unknown>;
    if (obj.event === "iteration:start" && typeof obj.iteration === "number") {
      highest = highest === undefined ? obj.iteration : Math.max(highest, obj.iteration);
    }
  }
  return highest === undefined ? undefined : { iteration: highest };
}

export function parseJsonlTokenUsage(
  content: string,
): { inputTokens: number; outputTokens: number } | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let found = false;
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event === null || typeof event !== "object") continue;
    const usage = extractUsageFields(event);
    if (usage === undefined) continue;
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    found = true;
  }
  return found ? { inputTokens, outputTokens } : undefined;
}

function extractUsageFields(event: unknown): { inputTokens: number; outputTokens: number } | undefined {
  if (event === null || typeof event !== "object") return undefined;
  const obj = event as Record<string, unknown>;
  const response = obj.response;
  const usageHolder =
    response !== null && typeof response === "object"
      ? (response as Record<string, unknown>).usage
      : obj.usage;
  if (usageHolder === null || typeof usageHolder !== "object") return undefined;
  const usage = usageHolder as Record<string, unknown>;
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
}
// -/ 1/4

// -- 2/4 CORE · gate step parsing from no-mistakes axi status --
const DONE_STATUSES = new Set(["completed", "done", "passed", "succeeded", "success"]);
const LIVE_STATUSES = new Set(["running", "active", "in_progress", "started"]);

function mapStepState(raw: string): GateStepFact["state"] {
  const lower = raw.trim().toLowerCase();
  if (DONE_STATUSES.has(lower)) return "done";
  if (LIVE_STATUSES.has(lower)) return "live";
  return "pending";
}

export function parseGateStepsFromAxiStatus(raw: string): GateTelemetryFact | undefined {
  const steps: GateStepFact[] = [];
  let inSteps = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^steps\[\d+\]\{/.test(trimmed)) {
      inSteps = true;
      continue;
    }
    if (/^findings\[\d+\]\{/.test(trimmed)) {
      inSteps = false;
      continue;
    }
    // A non-indented line (starts at column 0) ends the steps table.
    if (inSteps && /^\S/.test(line)) {
      inSteps = false;
    }
    if (!inSteps) continue;
    const row = /^\s+([^,\s]+)\s*,\s*([^,\s]+)\s*,?/.exec(line);
    if (row?.[1] === undefined || row[2] === undefined) continue;
    steps.push({ name: row[1].trim(), state: mapStepState(row[2]) });
  }
  return steps.length > 0 ? { steps } : undefined;
}
// -/ 2/4

// -- 3/4 CORE · I/O wrappers · readCoderTelemetry --
function newestGnhfRunDir(worktree: string): string | undefined {
  const runsDir = join(worktree, ".gnhf", "runs");
  if (!existsSync(runsDir)) return undefined;
  let newest = 0;
  let newestPath: string | undefined;
  try {
    for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const logPath = join(runsDir, entry.name, "gnhf.log");
      if (!existsSync(logPath)) continue;
      const mtime = statSync(logPath).mtimeMs;
      if (mtime > newest) {
        newest = mtime;
        newestPath = join(runsDir, entry.name);
      }
    }
  } catch {
    return undefined;
  }
  return newestPath;
}

function iterationFiles(runDir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(runDir, { withFileTypes: true })) {
      if (entry.isDirectory()) continue;
      if (/^iteration-\d+\.jsonl$/.test(entry.name)) files.push(join(runDir, entry.name));
    }
  } catch {
    return [];
  }
  return files.sort((a, b) => {
    const na = Number(/iteration-(\d+)\.jsonl/.exec(a)?.[1] ?? 0);
    const nb = Number(/iteration-(\d+)\.jsonl/.exec(b)?.[1] ?? 0);
    return na - nb;
  });
}

function readOvertureBaseRef(runDir: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(runDir, "overture.json"), "utf8"));
    if (parsed === null || typeof parsed !== "object") return undefined;
    const resources = (parsed as { resources?: unknown }).resources;
    if (resources === null || typeof resources !== "object") return undefined;
    const base = (resources as { base?: unknown; baseRef?: unknown }).base;
    const fallback = (resources as { baseRef?: unknown }).baseRef;
    const value = typeof base === "string" ? base : fallback;
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function readCoderTelemetry(
  worktree: string,
  runDir: string,
  deps: TelemetryDeps,
): CoderTelemetryFact {
  const fact: {
    iteration?: number;
    inputTokens?: number;
    outputTokens?: number;
    commitCount?: number;
    lastCommitSubject?: string;
  } = {};

  const runPath = newestGnhfRunDir(worktree);
  if (runPath !== undefined) {
    try {
      const logContent = readFileSync(join(runPath, "gnhf.log"), "utf8");
      const parsed = parseGnhfLogIterations(logContent);
      if (parsed !== undefined) fact.iteration = parsed.iteration;
    } catch {
      // missing gnhf.log is non-fatal
    }

    const files = iterationFiles(runPath);
    const newestJsonl = files[files.length - 1];
    if (newestJsonl !== undefined) {
      try {
        const usage = parseJsonlTokenUsage(readFileSync(newestJsonl, "utf8"));
        if (usage !== undefined) {
          fact.inputTokens = usage.inputTokens;
          fact.outputTokens = usage.outputTokens;
        }
      } catch {
        // torn JSONL is non-fatal
      }
    }
  }

  const baseRef = readOvertureBaseRef(runDir);
  if (baseRef !== undefined) {
    const mergeBase = deps.git(["merge-base", "HEAD", baseRef], worktree);
    if (mergeBase.status === 0) {
      const mb = mergeBase.stdout.trim();
      if (mb !== "") {
        const count = deps.git(["rev-list", "--count", `${mb}..HEAD`], worktree);
        if (count.status === 0) {
          const n = Number(count.stdout.trim());
          if (Number.isFinite(n)) fact.commitCount = n;
        }
        const log = deps.git(["log", "-1", "--format=%s", `${mb}..HEAD`], worktree);
        if (log.status === 0) {
          const subject = log.stdout.trim();
          if (subject !== "") fact.lastCommitSubject = subject;
        }
      }
    }
  }

  return fact;
}
// -/ 3/4

// -- 4/4 CORE · I/O wrappers · readGateTelemetry --
export function readGateTelemetry(
  combo: { readonly repoDir: string },
  deps: { readonly noMistakes?: TelemetryDeps["noMistakes"] },
): GateTelemetryFact | undefined {
  if (deps.noMistakes === undefined) return undefined;
  try {
    const result = deps.noMistakes(["axi", "status"], combo.repoDir, { timeoutMs: 2000 });
    if (result.status !== 0) return undefined;
    return parseGateStepsFromAxiStatus(result.stdout);
  } catch {
    return undefined;
  }
}
// -/ 4/4
