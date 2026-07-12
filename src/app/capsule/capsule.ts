/**
 * @overview v1 capsule sequencer: rebase, owned coder process, in-process gate, and PR tail.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at runCapsule             <- complete persisted-run sequence.
 *   2. Then runCoderPhase              <- commits-first completion and thread bridge.
 *   3. Read runAgentProcess            <- production child/PTY custody boundary.
 *   4. Everything else is artifact and git support.
 *
 *   MAIN FLOW
 *   ---------
 *   runCapsule -> rebase -> runCoderPhase -> runInProcessGate -> PR/reviewer outcome
 *
 *   PUBLIC API
 *   ----------
 *   CapsuleDeps          Injectable process, gate, and PR boundary.
 *   CapsuleResult        Terminal result returned to the CLI adapter.
 *   AgentProcessRequest  Owned interactive agent invocation.
 *   runAgentProcess      Spawn an agent as a child on the capsule pane's PTY.
 *   runCapsule           Sequence one frozen run directory.
 *
 *   INTERNALS
 *   ---------
 *   readBaseRef, runRebasePhase, runCoderPhase, snapshotIterations,
 *   freshIterationJsonl, containsStopCondition, buildGateFacts
 *
 * @exports AgentProcessRequest, CapsuleDeps, CapsuleResult, runAgentProcess, runCapsule
 * @deps node:{child_process,fs,path}, ../../core/{events,state}, ../../infra/{config,config-snapshot}, ../../roles/{coder-invocation,gatekeeper}, ../gate/in-process-gate, ../work-items/persisted-work-plan
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { appendEvent } from "../../core/events.js";
import { readCombo, type ComboRecord } from "../../core/state.js";
import { assertSafeCoderInvocation } from "../../infra/config.js";
import { readConfigSnapshot } from "../../infra/config-snapshot.js";
import {
  buildCoderInvocation,
  defaultWorkPlanPrompt,
  persistCoderThreadArtifact,
} from "../../roles/coder-invocation.js";
import {
  buildGatekeeperInvocation,
  buildIssuePrIntent,
  buildNoMistakesPushIntent,
  buildWorkPlanPrIntent,
} from "../../roles/gatekeeper.js";
import {
  runInProcessGate,
  type GateProcessResult,
  type GateProcessRunner,
  type InProcessGateInput,
  type InProcessGateResult,
} from "../gate/in-process-gate.js";
import { isGitHubIssueWorkItem, readPersistedWorkPlan } from "../work-items/persisted-work-plan.js";

// -- 1/4 HELPER · process and dependency contracts --
export interface AgentProcessRequest {
  command: string;
  cwd: string;
  env?: Record<string, string | undefined>;
}

export interface CapsuleDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  git: GateProcessRunner;
  runAgent: (request: AgentProcessRequest) => Promise<GateProcessResult>;
  runGate?: (input: InProcessGateInput) => Promise<InProcessGateResult>;
  gateProcess?: GateProcessRunner;
  findPrUrl: () => Promise<string | undefined>;
  resolvePrHead: (prUrl: string) => Promise<string | undefined>;
  ensurePrAutoclose?: (prUrl: string) => Promise<GateProcessResult>;
  activateReviewer: () => Promise<void> | void;
  attachGate?: (runId: string) => Promise<void> | void;
  leaseHome?: string;
}

export type CapsuleResult = {
  status:
    | "validated"
    | "already_running"
    | "awaiting_approval"
    | "no_pr"
    | "lease_unavailable"
    | "failed"
    | "rebase_failed"
    | "rebase_conflict"
    | "coder_failed";
  exitCode: number;
};

export function runAgentProcess(request: AgentProcessRequest): Promise<GateProcessResult> {
  return new Promise((resolveResult, reject) => {
    // In the capsule topology the parent already owns the tmux pane PTY. Inheriting
    // all three descriptors keeps the child interactive while preserving a real
    // parent/child exit-code contract with no pane reads or marker files.
    const child = spawn("sh", ["-c", request.command], {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolveResult({ exitCode: code ?? (signal === null ? 1 : 128), stdout: "", stderr: "" });
    });
  });
}
// -/ 1/4

// -- 2/4 HELPER · frozen base and rebase phase --
function readBaseRef(runDir: string): string {
  const parsed: unknown = JSON.parse(readFileSync(join(runDir, "overture.json"), "utf8"));
  if (parsed === null || typeof parsed !== "object") throw new Error("overture.json is not an object");
  const resources = (parsed as { resources?: unknown }).resources;
  if (resources === null || typeof resources !== "object") {
    throw new Error("overture.json lacks resources");
  }
  const base = (resources as { base?: unknown; baseRef?: unknown }).base;
  const fallback = (resources as { baseRef?: unknown }).baseRef;
  const value = typeof base === "string" ? base : fallback;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("overture.json lacks a frozen base ref");
  }
  return value;
}

async function mergeBase(deps: CapsuleDeps, combo: ComboRecord, baseRef: string): Promise<string> {
  const result = await deps.git({
    command: "git",
    args: ["merge-base", "HEAD", baseRef],
    cwd: combo.worktree,
    env: deps.env,
  });
  return result.stdout.trim();
}

async function runRebasePhase(
  deps: CapsuleDeps,
  combo: ComboRecord,
  runDir: string,
  baseRef: string,
): Promise<CapsuleResult | undefined> {
  if (baseRef.startsWith("origin/")) {
    const branch = baseRef.slice("origin/".length);
    const fetched = await deps.git({
      command: "git",
      args: ["fetch", "origin", branch],
      cwd: combo.worktree,
      env: deps.env,
    });
    if (fetched.exitCode !== 0) {
      appendEvent(runDir, "rebase_failed", { base: await mergeBase(deps, combo, baseRef) });
      return { status: "rebase_failed", exitCode: fetched.exitCode || 1 };
    }
  }
  const rebased = await deps.git({
    command: "git",
    args: ["rebase", baseRef],
    cwd: combo.worktree,
    env: deps.env,
  });
  if (rebased.exitCode !== 0) {
    appendEvent(runDir, "rebase_conflict", { base: await mergeBase(deps, combo, baseRef) });
    return { status: "rebase_conflict", exitCode: rebased.exitCode || 1 };
  }
  return undefined;
}
// -/ 2/4

// -- 3/4 CORE · runCoderPhase and optional gnhf context bridge --
type IterationSnapshot = Map<string, number>;

function iterationFiles(worktree: string): string[] {
  const runsDir = join(worktree, ".gnhf", "runs");
  if (!existsSync(runsDir)) return [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/^iteration-\d+\.jsonl$/.test(entry.name)) files.push(resolve(path));
    }
  };
  walk(runsDir);
  return files;
}

function snapshotIterations(worktree: string): IterationSnapshot {
  return new Map(iterationFiles(worktree).map((path) => [path, statSync(path).size]));
}

function isStopObject(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { success?: unknown }).success === true &&
    (value as { should_fully_stop?: unknown }).should_fully_stop === true
  );
}

function containsStopCondition(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const event: unknown = JSON.parse(line);
      if (isStopObject(event)) return true;
      const item = (event as { item?: unknown }).item;
      if (item !== null && typeof item === "object") {
        const message = (item as { type?: unknown; text?: unknown }).text;
        if ((item as { type?: unknown }).type === "agent_message" && typeof message === "string") {
          try {
            if (isStopObject(JSON.parse(message) as unknown)) return true;
          } catch {
            // Non-JSON agent prose is not stop-condition evidence.
          }
        }
      }
    } catch {
      // A torn/debug line is ignored; the journal bridge is optional enrichment.
    }
  }
  return false;
}

function freshIterationJsonl(
  worktree: string,
  before: IterationSnapshot,
): { path: string; stopCondition: boolean } | undefined {
  const candidates = new Map<string, boolean>();
  for (const path of iterationFiles(worktree)) {
    const oldSize = before.get(path);
    const current = readFileSync(path);
    if (oldSize !== undefined && current.byteLength <= oldSize) continue;
    const fresh =
      oldSize === undefined ? current.toString("utf8") : current.subarray(oldSize).toString("utf8");
    candidates.set(dirname(path), (candidates.get(dirname(path)) ?? false) || containsStopCondition(fresh));
  }
  if (candidates.size !== 1) return undefined;
  const [runPath, stopCondition] = [...candidates.entries()][0]!;
  const iterationOne = join(runPath, "iteration-1.jsonl");
  if (!existsSync(iterationOne)) return undefined;
  const path = relative(worktree, iterationOne).split(sep).join("/");
  return { path, stopCondition };
}

async function gitHead(deps: CapsuleDeps, combo: ComboRecord): Promise<string> {
  const result = await deps.git({
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd: combo.worktree,
    env: deps.env,
  });
  const head = result.stdout.trim();
  if (result.exitCode !== 0 || head === "") throw new Error(`git rev-parse HEAD failed for ${combo.id}`);
  return head;
}

async function runCoderPhase(
  deps: CapsuleDeps,
  combo: ComboRecord,
  runDir: string,
  command: string,
): Promise<CapsuleResult | undefined> {
  const baseSha = await gitHead(deps, combo);
  const before = snapshotIterations(combo.worktree);
  appendEvent(runDir, "coder_started", {});
  const coder = await deps.runAgent({ command, cwd: combo.worktree, env: deps.env });
  const headSha = await gitHead(deps, combo);
  const countResult = await deps.git({
    command: "git",
    args: ["rev-list", "--count", `${baseSha}..${headSha}`],
    cwd: combo.worktree,
    env: deps.env,
  });
  const count = /^\d+$/.test(countResult.stdout.trim()) ? Number(countResult.stdout.trim()) : 0;
  const fresh = freshIterationJsonl(combo.worktree, before);
  if (count > 0) {
    appendEvent(runDir, "coder_done", fresh === undefined ? {} : { gnhf_iteration_jsonl: fresh.path });
    if (fresh !== undefined) {
      try {
        persistCoderThreadArtifact({ runDir, worktree: combo.worktree, jsonlPath: fresh.path });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        deps.out(`capsule: coder thread bridge unavailable for ${combo.id}: ${detail}`);
      }
    }
    return undefined;
  }
  appendEvent(runDir, "coder_failed", {
    exit_code: coder.exitCode,
    has_new_commits: false,
    base_sha: baseSha,
    head_sha: headSha,
    new_commit_count: count,
  });
  return { status: "coder_failed", exitCode: coder.exitCode || 1 };
}
// -/ 3/4

// -- 4/4 CORE · runCapsule <- START HERE --
function buildGateFacts(runDir: string, combo: ComboRecord, gatekeeperCommand: string) {
  const plan = readPersistedWorkPlan(runDir, combo);
  if (isGitHubIssueWorkItem(combo)) {
    const issueBody = plan.rawMarkdown;
    const intent = buildIssuePrIntent({ combo, issueTitle: plan.title, issueBody });
    return {
      command: buildGatekeeperInvocation({
        gatekeeperCommand,
        combo,
        issueTitle: plan.title,
        issueBody,
      }),
      mirrorIntent: buildNoMistakesPushIntent(intent),
      plan,
    };
  }
  const intent = buildWorkPlanPrIntent(plan);
  return {
    command: buildGatekeeperInvocation({ gatekeeperCommand, combo, workPlan: plan }),
    mirrorIntent: buildNoMistakesPushIntent(intent),
    plan,
  };
}

export async function runCapsule(runDir: string, deps: CapsuleDeps): Promise<CapsuleResult> {
  const combo = readCombo(runDir);
  const config = readConfigSnapshot(runDir);
  assertSafeCoderInvocation(config.coderCommand, { requireGnhf: config.roles.coder === "codex" });
  const baseRef = readBaseRef(runDir);
  const rebase = await runRebasePhase(deps, combo, runDir, baseRef);
  if (rebase !== undefined) return rebase;

  const gateFacts = buildGateFacts(runDir, combo, config.gatekeeperCommand);
  const coderCommand = buildCoderInvocation({
    coderCommand: config.coderCommand,
    combo,
    ...(isGitHubIssueWorkItem(combo)
      ? {}
      : { prompt: defaultWorkPlanPrompt(gateFacts.plan, join(runDir, "work-plan.md")) }),
  });
  const coder = await runCoderPhase(deps, combo, runDir, coderCommand);
  if (coder !== undefined) return coder;

  const runGate = deps.runGate ?? runInProcessGate;
  const gate = await runGate({
    combo,
    runDir,
    kind: "initial",
    gatekeeperCommand: gateFacts.command,
    mirrorIntent: gateFacts.mirrorIntent,
    env: deps.env,
    ...(deps.gateProcess === undefined ? {} : { runProcess: deps.gateProcess }),
    ...(deps.leaseHome === undefined ? {} : { leaseHome: deps.leaseHome }),
    findPrUrl: deps.findPrUrl,
    resolvePrHead: deps.resolvePrHead,
    ...(isGitHubIssueWorkItem(combo) && deps.ensurePrAutoclose !== undefined
      ? { ensurePrAutoclose: deps.ensurePrAutoclose }
      : {}),
    activateReviewer: deps.activateReviewer,
    out: deps.out,
  });
  if (gate.status === "already_running" && gate.runId !== undefined) {
    await deps.attachGate?.(gate.runId);
  }
  return { status: gate.status, exitCode: gate.exitCode };
}
// -/ 4/4
