/**
 * @overview In-process no-mistakes gate orchestration with awaited children and direct journal writes.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at runInProcessGate              <- complete initial/post gate entry point.
 *   2. Then runGatekeeperAndConfigCopy        <- deterministic two-promise race.
 *   3. publishGateMirror / abortPreviousRun   <- daemon and mirror preparation.
 *   4. Pure predicates                        <- status, recovery, and failure classification.
 *
 *   MAIN FLOW
 *   ---------
 *   runInProcessGate -> lease -> mirror -> gate + config watcher -> classify -> appendEvent
 *
 *   PUBLIC API
 *   ----------
 *   GateProcessRequest, GateProcessResult, GateProcessRunner, AxiStatus, ConfigCopyOutcome
 *   InProcessGateInput, InProcessGateResult
 *   buildInProcessGateInvocation
 *   runChildProcess, parseAxiStatus, axiHeadMatches, isAxiRunActive, isAxiRunAttachable
 *   resolveConfigCopyRace, runGatekeeperAndConfigCopy, copyConfigToActiveRun
 *   abortPreviousRun, daemonStartSucceeded, publishGateMirror, findAttachableRun
 *   shouldRecoverChecksPassed, gateIsAwaitingApproval, gateFailureReason
 *   appendGateIdle, withGateLease, runInProcessGate
 *
 *   INTERNALS
 *   ---------
 *   outputOf, delay, successful, finishSuccessfulGate
 *
 * @exports GateProcessRequest, GateProcessResult, GateProcessRunner, AxiStatus, ConfigCopyOutcome, InProcessGateInput, InProcessGateResult, buildInProcessGateInvocation, runChildProcess, parseAxiStatus, axiHeadMatches, isAxiRunActive, isAxiRunAttachable, resolveConfigCopyRace, runGatekeeperAndConfigCopy, copyConfigToActiveRun, abortPreviousRun, daemonStartSucceeded, publishGateMirror, findAttachableRun, shouldRecoverChecksPassed, gateIsAwaitingApproval, gateFailureReason, appendGateIdle, withGateLease, runInProcessGate
 * @deps node:{child_process,fs,path}, ../../core/events, ../../core/state, ../../roles/gatekeeper, ./lease
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { appendEvent } from "../../core/events.js";
import type { ComboRecord } from "../../core/state.js";
import { buildGatekeeperInvocation, parseAxiOutcome, type GatekeeperInput } from "../../roles/gatekeeper.js";
import {
  acquireGateLeaseForCombo,
  GATE_LEASE_CONFLICT_EXIT_CODE,
  releaseGateLeaseForCombo,
} from "./lease.js";

// -- 1/5 HELPER · awaited process boundary and axi status predicates --
export interface GateProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

export interface GateProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GateProcessRunner = (request: GateProcessRequest) => Promise<GateProcessResult>;

export function buildInProcessGateInvocation(input: GatekeeperInput): string {
  return buildGatekeeperInvocation(input);
}

export function runChildProcess(request: GateProcessRequest): Promise<GateProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      signal: request.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (request.signal?.aborted) {
        resolve({ exitCode: 143, stdout, stderr });
        return;
      }
      reject(error);
    });
    child.on("close", (code, signal) => {
      resolve({ exitCode: code ?? (signal === null ? 1 : 128), stdout, stderr });
    });
  });
}

export interface AxiStatus {
  id?: string;
  branch?: string;
  head?: string;
  status?: string;
  gate?: string;
}

export function parseAxiStatus(raw: string): AxiStatus {
  const result: AxiStatus = {};
  const fields = new Set<keyof AxiStatus>(["id", "branch", "head", "status", "gate"]);
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*([a-z]+):\s*(.*?)\s*$/.exec(line);
    if (match === null || !fields.has(match[1] as keyof AxiStatus)) continue;
    const key = match[1] as keyof AxiStatus;
    const rawValue = match[2] ?? "";
    const value = rawValue.startsWith('"') && rawValue.endsWith('"') ? rawValue.slice(1, -1) : rawValue;
    if (value !== "") result[key] = value;
  }
  return result;
}

export function isAxiRunActive(status: string | undefined): boolean {
  return status !== undefined && ["active", "in_progress", "pending", "running"].includes(status);
}

export function isAxiRunAttachable(status: string | undefined): boolean {
  return status !== undefined && ["active", "in_progress", "running"].includes(status);
}

export function axiHeadMatches(candidate: string | undefined, expected: string | undefined): boolean {
  if (candidate === undefined || expected === undefined || candidate === "" || expected === "") return false;
  return candidate.startsWith(expected) || expected.startsWith(candidate);
}
// -/ 1/5

// -- 2/5 CORE · config copy watcher and race <- START HERE --
export type ConfigCopyOutcome = "copied" | "failed" | "killed" | "not_started";

export function resolveConfigCopyRace(input: {
  configPresent: boolean;
  gateFinishedBeforeConfig: boolean;
  gateExitCode: number;
  configOutcome: ConfigCopyOutcome;
}): { exitCode: number; rawExitCode: number; configFailed: boolean } {
  const watcherFailed = input.configOutcome === "failed";
  const configFailed = input.configPresent && (input.gateFinishedBeforeConfig || watcherFailed);
  return {
    exitCode: configFailed ? 1 : input.gateExitCode,
    rawExitCode: input.gateExitCode,
    configFailed,
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

export async function copyConfigToActiveRun(input: {
  combo: Pick<ComboRecord, "branch" | "worktree">;
  runProcess: GateProcessRunner;
  env?: Record<string, string | undefined>;
  attempts?: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
}): Promise<ConfigCopyOutcome> {
  const source = join(input.combo.worktree, ".no-mistakes.yaml");
  if (!existsSync(source)) return "not_started";
  const attempts = input.attempts ?? 120;
  const retryDelayMs = input.retryDelayMs ?? 1000;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (input.signal?.aborted) return "killed";
    const [repoStatus, axiStatus] = await Promise.all([
      input.runProcess({
        command: "no-mistakes",
        args: ["status"],
        cwd: input.combo.worktree,
        env: input.env,
        signal: input.signal,
      }),
      input.runProcess({
        command: "no-mistakes",
        args: ["axi", "status"],
        cwd: input.combo.worktree,
        env: input.env,
        signal: input.signal,
      }),
    ]);
    if (input.signal?.aborted) return "killed";
    const repo = parseAxiStatus(outputOf(repoStatus));
    const run = parseAxiStatus(outputOf(axiStatus));
    if (
      run.id !== undefined &&
      repo.gate !== undefined &&
      run.branch === input.combo.branch &&
      isAxiRunActive(run.status)
    ) {
      const dataDir = dirname(dirname(repo.gate));
      const repoId = basename(repo.gate, ".git");
      const runDir = join(dataDir, "worktrees", repoId, run.id);
      if (existsSync(runDir)) {
        try {
          copyFileSync(source, join(runDir, ".no-mistakes.yaml"));
          return "copied";
        } catch {
          return "failed";
        }
      }
    }
    await delay(retryDelayMs, input.signal);
  }
  return input.signal?.aborted ? "killed" : "failed";
}

export async function runGatekeeperAndConfigCopy(input: {
  gate: () => Promise<GateProcessResult>;
  configPresent: boolean;
  copyConfig?: (signal: AbortSignal) => Promise<ConfigCopyOutcome>;
}): Promise<GateProcessResult & { rawExitCode: number; configFailed: boolean }> {
  const gatePromise = input.gate();
  if (!input.configPresent || input.copyConfig === undefined) {
    const gate = await gatePromise;
    return { ...gate, rawExitCode: gate.exitCode, configFailed: false };
  }

  const controller = new AbortController();
  const copyPromise = input.copyConfig(controller.signal);
  const first = await Promise.race([
    gatePromise.then((result) => ({ kind: "gate" as const, result })),
    copyPromise.then((outcome) => ({ kind: "copy" as const, outcome })),
  ]);
  let gate: GateProcessResult;
  let configOutcome: ConfigCopyOutcome;
  let gateFinishedBeforeConfig = false;
  if (first.kind === "gate") {
    gate = first.result;
    gateFinishedBeforeConfig = true;
    if (gate.exitCode !== 0) controller.abort();
    configOutcome = await copyPromise;
  } else {
    configOutcome = first.outcome;
    gate = await gatePromise;
  }
  const resolved = resolveConfigCopyRace({
    configPresent: true,
    gateFinishedBeforeConfig,
    gateExitCode: gate.exitCode,
    configOutcome,
  });
  return { ...gate, ...resolved };
}
// -/ 2/5

// -- 3/5 CORE · daemon, abort, mirror, and already-running guards --
function outputOf(result: GateProcessResult): string {
  return `${result.stdout}${result.stderr}`;
}

function successful(result: GateProcessResult): boolean {
  return result.exitCode === 0;
}

export function daemonStartSucceeded(start: GateProcessResult, status?: GateProcessResult): boolean {
  return successful(start) || (status !== undefined && /daemon:.*running/i.test(outputOf(status)));
}

export async function abortPreviousRun(input: {
  combo: Pick<ComboRecord, "branch" | "worktree">;
  runProcess: GateProcessRunner;
  env?: Record<string, string | undefined>;
  attempts?: number;
  retryDelayMs?: number;
}): Promise<boolean> {
  const attempts = input.attempts ?? 3;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const statusResult = await input.runProcess({
      command: "no-mistakes",
      args: ["axi", "status"],
      cwd: input.combo.worktree,
      env: input.env,
    });
    const status = parseAxiStatus(outputOf(statusResult));
    if (status.id === undefined || status.branch !== input.combo.branch || !isAxiRunActive(status.status)) {
      return true;
    }
    const aborted = await input.runProcess({
      command: "no-mistakes",
      args: ["axi", "abort"],
      cwd: input.combo.worktree,
      env: input.env,
    });
    if (!successful(aborted)) return false;
    await delay(input.retryDelayMs ?? 1000);
  }
  const finalStatus = await input.runProcess({
    command: "no-mistakes",
    args: ["axi", "status"],
    cwd: input.combo.worktree,
    env: input.env,
  });
  const parsed = parseAxiStatus(outputOf(finalStatus));
  return parsed.id === undefined || parsed.branch !== input.combo.branch || !isAxiRunActive(parsed.status);
}

export function findAttachableRun(
  rawStatus: string,
  expected: { branch: string; head: string },
): string | undefined {
  const status = parseAxiStatus(rawStatus);
  return status.id !== undefined &&
    status.branch === expected.branch &&
    axiHeadMatches(status.head, expected.head) &&
    isAxiRunAttachable(status.status)
    ? status.id
    : undefined;
}

export async function publishGateMirror(input: {
  combo: Pick<ComboRecord, "branch" | "worktree">;
  intent: string;
  runProcess: GateProcessRunner;
  env?: Record<string, string | undefined>;
}): Promise<GateProcessResult & { daemonStarted: boolean; previousRunAborted: boolean; published: boolean }> {
  const run = (command: string, args: string[]) =>
    input.runProcess({ command, args, cwd: input.combo.worktree, env: input.env });
  const remote = await run("git", ["remote", "get-url", "no-mistakes"]);
  if (!successful(remote)) {
    return {
      ...remote,
      exitCode: 0,
      daemonStarted: false,
      previousRunAborted: false,
      published: false,
    };
  }

  const daemonStart = await run("no-mistakes", ["daemon", "start"]);
  let daemonStatus: GateProcessResult | undefined;
  if (!successful(daemonStart)) daemonStatus = await run("no-mistakes", ["status"]);
  if (!daemonStartSucceeded(daemonStart, daemonStatus)) {
    return { ...daemonStart, daemonStarted: false, previousRunAborted: false, published: false };
  }
  if (!(await abortPreviousRun(input))) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "previous no-mistakes run remains active",
      daemonStarted: true,
      previousRunAborted: false,
      published: false,
    };
  }

  const mirrorRef = `refs/heads/${input.combo.branch}`;
  const lookup = await run("git", ["ls-remote", "--heads", "no-mistakes", input.combo.branch]);
  if (!successful(lookup)) {
    return { ...lookup, daemonStarted: true, previousRunAborted: true, published: false };
  }
  const mirrorSha = lookup.stdout.trim().split(/\s+/, 1)[0] || undefined;
  const args = ["push", "-o", `no-mistakes.intent=${input.intent}`, "no-mistakes"];
  if (mirrorSha !== undefined) args.push(`--force-with-lease=${mirrorRef}:${mirrorSha}`);
  args.push(`HEAD:${mirrorRef}`);
  const pushed = await run("git", args);
  return {
    ...pushed,
    daemonStarted: true,
    previousRunAborted: true,
    published: successful(pushed),
  };
}
// -/ 3/5

// -- 4/5 HELPER · outcome classification, journal tail, and lease scope --
export function gateIsAwaitingApproval(output: string): boolean {
  return parseAxiOutcome(output)?.toLowerCase() === "awaiting_approval";
}

export function shouldRecoverChecksPassed(exitCode: number, output: string, configFailed: boolean): boolean {
  if (exitCode === 0 || configFailed) return false;
  if (parseAxiOutcome(output)?.toLowerCase() !== "checks-passed") return false;
  const lines = output.split(/\r?\n/);
  const outcomeIndex = lines.findIndex((line) => /^outcome:\s*checks-passed\s*$/i.test(line));
  return outcomeIndex >= 0 && lines.slice(outcomeIndex + 1).some((line) => /context\s+canceled/i.test(line));
}

export function gateFailureReason(output: string): "daemon_dead" | "gate_failed" {
  return /daemon.*(dead|died|exited|not running)|connection refused|ECONNREFUSED/i.test(output)
    ? "daemon_dead"
    : "gate_failed";
}

export function appendGateIdle(runDir: string, headSha?: string, recovery?: string): void {
  appendEvent(runDir, "gate_status", {
    state: "idle",
    ...(headSha !== undefined && headSha !== "" ? { head_sha: headSha } : {}),
    ...(recovery !== undefined && recovery !== "" ? { recovery } : {}),
  });
}

export async function withGateLease<T>(input: {
  home: string;
  comboId: string;
  headSha: string;
  out?: (line: string) => void;
  action: () => Promise<T>;
}): Promise<{ acquired: true; value: T } | { acquired: false; exitCode: number }> {
  const out = input.out ?? (() => undefined);
  const acquired = acquireGateLeaseForCombo({
    home: input.home,
    comboId: input.comboId,
    headSha: input.headSha,
    out,
  });
  if (acquired.exitCode === GATE_LEASE_CONFLICT_EXIT_CODE) {
    return { acquired: false, exitCode: acquired.exitCode };
  }
  try {
    return { acquired: true, value: await input.action() };
  } finally {
    releaseGateLeaseForCombo({ home: input.home, comboId: input.comboId, out });
  }
}
// -/ 4/5

// -- 5/5 CORE · runInProcessGate --
export type InProcessGateResult =
  | { status: "validated"; exitCode: 0; headSha: string }
  | {
      status: "awaiting_approval" | "already_running" | "no_pr" | "lease_unavailable";
      exitCode: number;
      headSha: string;
      runId?: string;
    }
  | { status: "failed"; exitCode: number; headSha: string };

export interface InProcessGateInput {
  combo: ComboRecord;
  runDir: string;
  kind: "initial" | "post";
  gatekeeperCommand: string;
  mirrorIntent?: string;
  prUrl?: string;
  runProcess?: GateProcessRunner;
  env?: Record<string, string | undefined>;
  leaseHome?: string;
  resolvePrHead?: (prUrl: string) => Promise<string | undefined>;
  findPrUrl?: () => Promise<string | undefined>;
  ensurePrAutoclose?: (prUrl: string) => Promise<GateProcessResult>;
  activateReviewer?: () => Promise<void> | void;
  configCopyAttempts?: number;
  configCopyRetryDelayMs?: number;
  out?: (line: string) => void;
}

async function finishSuccessfulGate(
  input: InProcessGateInput,
  headSha: string,
  recovery: string | undefined,
): Promise<InProcessGateResult> {
  const prUrl = input.prUrl ?? (await input.findPrUrl?.());
  if (prUrl === undefined || prUrl === "") {
    appendGateIdle(input.runDir, headSha, recovery);
    appendEvent(input.runDir, "needs_human", { reason: "pr_missing" });
    return { status: "no_pr", exitCode: 0, headSha };
  }
  const publishedHead = (await input.resolvePrHead?.(prUrl)) || headSha;
  const autoclose = await input.ensurePrAutoclose?.(prUrl);
  if (autoclose !== undefined && !successful(autoclose)) {
    appendEvent(input.runDir, "gate_status", { state: "failed", head_sha: publishedHead });
    appendEvent(input.runDir, "gate_failed", { exit_code: autoclose.exitCode });
    appendEvent(input.runDir, "pr_autoclose_failed", { exit_code: autoclose.exitCode, url: prUrl });
    return { status: "failed", exitCode: autoclose.exitCode, headSha: publishedHead };
  }
  appendGateIdle(input.runDir, publishedHead, recovery);
  if (input.kind === "post") {
    appendEvent(input.runDir, "gate_validated", { sha: publishedHead });
  } else {
    appendEvent(input.runDir, "pr_opened", { url: prUrl });
    await input.activateReviewer?.();
  }
  return { status: "validated", exitCode: 0, headSha: publishedHead };
}

export async function runInProcessGate(input: InProcessGateInput): Promise<InProcessGateResult> {
  const runProcess = input.runProcess ?? runChildProcess;
  const headResult = await runProcess({
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd: input.combo.worktree,
    env: input.env,
  });
  const headSha = headResult.stdout.trim();
  if (!successful(headResult) || headSha === "") {
    throw new Error(
      `git rev-parse HEAD failed for ${input.combo.id}: ${headResult.stderr.trim() || "empty head"}`,
    );
  }
  appendEvent(input.runDir, "gate_started", {});

  const action = async (): Promise<InProcessGateResult> => {
    appendEvent(input.runDir, "gate_status", { state: "fix_inflight", head_sha: headSha });
    let daemonStarted = false;
    let previousRunAborted = false;
    if (input.mirrorIntent !== undefined) {
      const mirror = await publishGateMirror({
        combo: input.combo,
        intent: input.mirrorIntent,
        runProcess,
        env: input.env,
      });
      daemonStarted = mirror.daemonStarted;
      previousRunAborted = mirror.previousRunAborted;
      if (mirror.exitCode !== 0) {
        appendEvent(input.runDir, "gate_status", { state: "failed", head_sha: headSha });
        appendEvent(input.runDir, "gate_failed", {
          exit_code: mirror.exitCode,
          reason: gateFailureReason(outputOf(mirror)),
        });
        return { status: "failed", exitCode: mirror.exitCode, headSha };
      }
    }

    if (
      !previousRunAborted &&
      !(await abortPreviousRun({ combo: input.combo, runProcess, env: input.env }))
    ) {
      appendEvent(input.runDir, "gate_status", { state: "failed", head_sha: headSha });
      appendEvent(input.runDir, "gate_failed", { exit_code: 1, reason: "gate_failed" });
      return { status: "failed", exitCode: 1, headSha };
    }

    if (!daemonStarted) {
      const start = await runProcess({
        command: "no-mistakes",
        args: ["daemon", "start"],
        cwd: input.combo.worktree,
        env: input.env,
      });
      let status: GateProcessResult | undefined;
      if (!successful(start)) {
        status = await runProcess({
          command: "no-mistakes",
          args: ["status"],
          cwd: input.combo.worktree,
          env: input.env,
        });
      }
      if (!daemonStartSucceeded(start, status)) {
        const output = `${outputOf(start)}${status === undefined ? "" : outputOf(status)}`;
        appendEvent(input.runDir, "gate_status", { state: "failed", head_sha: headSha });
        appendEvent(input.runDir, "gate_failed", {
          exit_code: start.exitCode || 1,
          reason: gateFailureReason(output),
        });
        return { status: "failed", exitCode: start.exitCode || 1, headSha };
      }
    }

    const configPresent = existsSync(join(input.combo.worktree, ".no-mistakes.yaml"));
    const gate = await runGatekeeperAndConfigCopy({
      configPresent,
      gate: () =>
        runProcess({
          command: "sh",
          args: ["-c", input.gatekeeperCommand],
          cwd: input.combo.worktree,
          env: input.env,
        }),
      ...(configPresent
        ? {
            copyConfig: (signal: AbortSignal) =>
              copyConfigToActiveRun({
                combo: input.combo,
                runProcess,
                env: input.env,
                attempts: input.configCopyAttempts,
                retryDelayMs: input.configCopyRetryDelayMs,
                signal,
              }),
          }
        : {}),
    });
    const output = outputOf(gate);
    if (gateIsAwaitingApproval(output)) {
      appendEvent(input.runDir, "gate_status", { state: "awaiting_approval", head_sha: headSha });
      appendEvent(input.runDir, "needs_human", { reason: "gate_waiting" });
      return { status: "awaiting_approval", exitCode: 0, headSha };
    }
    const recovery = shouldRecoverChecksPassed(gate.rawExitCode, output, gate.configFailed)
      ? "checks_passed_context_canceled"
      : undefined;
    const exitCode = recovery === undefined ? gate.exitCode : 0;
    if (exitCode !== 0) {
      const statusProbe = await runProcess({
        command: "no-mistakes",
        args: ["axi", "status"],
        cwd: input.combo.worktree,
        env: input.env,
      });
      const runId = findAttachableRun(outputOf(statusProbe), { branch: input.combo.branch, head: headSha });
      if (runId !== undefined) {
        appendEvent(input.runDir, "gate_status", { state: "fix_inflight", head_sha: headSha });
        return { status: "already_running", exitCode: 0, headSha, runId };
      }
      appendEvent(input.runDir, "gate_status", { state: "failed", head_sha: headSha });
      appendEvent(input.runDir, "gate_failed", {
        exit_code: exitCode,
        reason: gateFailureReason(`${output}${outputOf(statusProbe)}`),
      });
      return { status: "failed", exitCode, headSha };
    }
    return finishSuccessfulGate(input, headSha, recovery);
  };

  if (input.leaseHome === undefined) return action();
  const leased = await withGateLease({
    home: input.leaseHome,
    comboId: input.combo.id,
    headSha,
    out: input.out,
    action,
  });
  return leased.acquired ? leased.value : { status: "lease_unavailable", exitCode: 0, headSha };
}
// -/ 5/5
