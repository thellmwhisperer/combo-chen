/**
 * @overview v1 capsule sequencer: rebase, owned coder process, local
 *   pre-publish V-C-V review loop, in-process gate, and PR tail.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at runCapsule             <- complete persisted-run sequence.
 *   2. Then runCoderPhase              <- commits-first completion and thread bridge.
 *   3. Then runLocalReviewPhase        <- the V-C-V loop, guards, and loop-state.
 *   4. Read runAgentProcess            <- production child/seat custody boundary.
 *   5. Everything else is artifact and git support.
 *
 *   MAIN FLOW
 *   ---------
 *   runCapsule -> rebase -> runCoderPhase -> runLocalReviewPhase
 *     verdict round -> artifact lands -> journal -> reap reviewer child
 *       -> code 0: pinLocalLgtm -> runInProcessGate (+ bounded retry)
 *                -> validated: applyLgtmCarryOver (D3 patch-id carry or re-review round)
 *       -> code 1: coder fix commit artifact -> reap resumed child -> re-review
 *          guards: fingerprint surviving 2 rounds | no-op fix turn | round cap
 *       -> code 2/3, guard fire, or defective verdict: needs_human
 *     invariant: the loop opens and closes with a verdict, never a coder turn
 *   Resume: classifyCapsulePhase derives the entry point from the journal
 *   (review_fix coder events stay loop-internal); startAtGate skips rebase
 *   and coder, and resolveLoopEntry folds journal + loop-state.json into the
 *   exact next loop action: round numbers are never reused, orphan verdict
 *   artifacts are consumed, interrupted fix turns are judged by commits, and
 *   pending escalations stay parked until a retry decision.
 *
 *   PUBLIC API
 *   ----------
 *   CapsuleDeps          Injectable process, gate, and PR boundary.
 *   CapsuleResult        Terminal result returned to the CLI adapter.
 *   CapsulePhase         Journal-derived resume position for a capsule run.
 *   AgentCompletionArtifact Optional artifact-first completion contract for an owned child.
 *   AgentProcessRequest  Owned interactive agent invocation (bounded by timeoutMs, seated by seatTty).
 *   AgentTurnResult      Exit facts plus timeout/artifact custody markers.
 *   runAgentProcess      Own child until declared file/state artifact or exit, seated on its role pty.
 *   classifyCapsulePhase Sequence/gate/supervise/closed resume classification.
 *   runCapsule           Sequence one frozen run directory (optionally from the gate).
 *
 *   INTERNALS
 *   ---------
 *   readBaseRef, runRebasePhase, runCoderPhase, snapshotIterations,
 *   freshIterationJsonl, containsStopCondition, runLocalReviewPhase,
 *   resolveLoopEntry, routeFixTurn, escalateWithGuard, runBoundedAgentTurn,
 *   runVerdictRound, ingestVerdictArtifact, runCoderFixTurn, hasCleanFixCommit, resolveAgentSeat,
 *   escalateSeatUnavailable, SeatOpenError, openSeatFd, waitForVerdictFile,
 *   verdictAttributionDefects, hasCompleteCurrentVerdict, reviewerIdentity,
 *   findingsProjection, escalate, LOOP_ESCALATION_REASONS,
 *   buildGateFacts
 *
 * @exports AgentCompletionArtifact, AgentProcessRequest, AgentTurnResult, CapsuleDeps, CapsuleResult, CapsulePhase, runAgentProcess, classifyCapsulePhase, runCapsule
 * @deps node:{child_process,fs,path}, ../../core/{events,loop-state,review-dossier,state,verdict,work-plan}, ../../infra/{config,config-snapshot}, ../../roles/{coder-invocation,coder-responding,gatekeeper,reviewer-invocation}, ../gate/in-process-gate, ../runtime/sessions, ../work-items/persisted-work-plan, ./ready
 */
import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { appendEvent, readEvents, sleep, type ComboEvent } from "../../core/events.js";
import {
  findingsSurvivingRound,
  initialLoopState,
  readLoopState,
  recordLoopRound,
  withLoopGuard,
  writeLoopState,
  type LoopState,
} from "../../core/loop-state.js";
import { renderReviewDossier, reviewDossierPath } from "../../core/review-dossier.js";
import { readCombo, type ComboRecord } from "../../core/state.js";
import {
  VerdictError,
  findingFingerprints,
  missingChecklistIds,
  readVerdictFile,
  verdictFileName,
  verdictFilePath,
  type ProducingIdentity,
  type VerdictFile,
  type VerdictFinding,
} from "../../core/verdict.js";
import type { WorkPlan } from "../../core/work-plan.js";
import { assertSafeCoderInvocation } from "../../infra/config.js";
import { readConfigSnapshot, type ConfigSnapshot } from "../../infra/config-snapshot.js";
import {
  buildCoderInvocation,
  buildReviewFixPrompt,
  defaultWorkPlanPrompt,
  persistCoderThreadArtifact,
} from "../../roles/coder-invocation.js";
import { buildCoderFixTurnCommand, readCoderThreadArtifact } from "../../roles/coder-responding.js";
import { buildLocalReviewerInvocation } from "../../roles/reviewer-invocation.js";
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
import { CODER_WINDOW, REVIEWER_WINDOW } from "../runtime/sessions.js";
import { isGitHubIssueWorkItem, readPersistedWorkPlan } from "../work-items/persisted-work-plan.js";
import { applyLgtmCarryOver, nextLocalReviewRound, pinLocalLgtm } from "./ready.js";

// -- 1/5 HELPER · process and dependency contracts --
export interface AgentCompletionArtifact {
  /** Final atomically-renamed file path, when the artifact is file-backed. */
  path?: string;
  /** Bounded polling cadence while the owned child remains alive. */
  pollMs: number;
  /** Validate and collect the file/state artifact before custody reaps the child. */
  validateAndCollect: () => boolean | Promise<boolean>;
}

export interface AgentProcessRequest {
  command: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Wall-clock bound: production custody terminates the child on expiry. */
  timeoutMs?: number;
  /** Optional artifact-first completion; absent means the child must exit as before. */
  completionArtifact?: AgentCompletionArtifact;
  /**
   * D1 seat: pty of the role window's pane. The owned child runs its stdio on
   * this tty, so it is visible and interactive in its named tmux window while
   * the capsule keeps the parent/child exit-code contract.
   */
  seatTty?: string;
  /**
   * Observer for the owned child's launch facts. The pid is the active-child
   * leg of seat occupancy (sessions.seatOccupancy): evidence that flips when
   * the role child starts and exits.
   */
  onSpawn?: (facts: { pid: number }) => void;
}

/** GateProcessResult plus custody completion facts for a terminated child. */
export interface AgentTurnResult extends GateProcessResult {
  timedOut?: boolean;
  completedBy?: "artifact";
  reapFailed?: boolean;
}

export interface CapsuleDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  git: GateProcessRunner;
  runAgent: (request: AgentProcessRequest) => Promise<AgentTurnResult>;
  runGate?: (input: InProcessGateInput) => Promise<InProcessGateResult>;
  gateProcess?: GateProcessRunner;
  findPrUrl: () => Promise<string | undefined>;
  resolvePrHead: (prUrl: string) => Promise<string | undefined>;
  ensurePrAutoclose?: (prUrl: string) => Promise<GateProcessResult>;
  activateReviewer: () => Promise<void> | void;
  attachGate?: (runId: string) => Promise<void> | void;
  leaseHome?: string;
  /** Abortable delay used between initial-gate retries; defaults to core sleep. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Resolve the seat tty of a role window so owned children run seated there.
   * A missing resolver means the embedder owns seating (tests, non-tmux
   * harnesses); a present resolver that cannot produce a seat fails the turn
   * to needs_human seat_unavailable after bounded retries. The child never
   * runs unseated in the capsule pane.
   */
  resolveSeatTty?: (windowName: string) => string | undefined;
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
    | "coder_failed"
    | "seat_unavailable"
    | "local_review_escalated";
  exitCode: number;
};

/** Grace between SIGTERM and SIGKILL for a timed-out owned child. */
const DEFAULT_AGENT_KILL_GRACE_MS = 10_000;
/** Bounded seat retries before a role turn escalates seat_unavailable. */
const DEFAULT_SEAT_RESOLVE_ATTEMPTS = 3;
const DEFAULT_SEAT_RESOLVE_RETRY_MS = 500;

function positiveIntEnv(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const parsed = Number(env[key]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function agentKillGraceMs(env: Record<string, string | undefined>): number {
  return positiveIntEnv(env, "COMBO_CHEN_AGENT_KILL_GRACE_MS", DEFAULT_AGENT_KILL_GRACE_MS);
}

/** A resolved seat that cannot be opened is a seat failure, never an inherit fallback. */
class SeatOpenError extends Error {}

function openSeatFd(seatTty: string | undefined): number | undefined {
  if (seatTty === undefined) return undefined;
  try {
    // O_NOCTTY: the seat renders the child; it must never become the
    // capsule's controlling terminal.
    return openSync(seatTty, constants.O_RDWR | constants.O_NOCTTY);
  } catch (error) {
    throw new SeatOpenError(
      `seat tty ${seatTty} cannot be opened: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function runAgentProcess(request: AgentProcessRequest): Promise<AgentTurnResult> {
  return new Promise((resolveResult, reject) => {
    // D1 custody: the capsule owns the child (real exit code, timeout kill, no
    // marker files) while the child's stdio sits on the seat tty of its role
    // window, so the agent is visible and interactive in that window. A seat
    // that cannot be opened rejects (SeatOpenError): running the child
    // unseated in the capsule pane is the blind-watchdog incident and is
    // never a fallback. Only a request without a seat (embedder-owned
    // seating) inherits.
    const seatFd = openSeatFd(request.seatTty);
    const child = spawn("sh", ["-c", request.command], {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      stdio: seatFd === undefined ? "inherit" : [seatFd, seatFd, seatFd],
    });
    if (seatFd !== undefined) closeSync(seatFd);
    if (child.pid !== undefined) request.onSpawn?.({ pid: child.pid });
    let timedOut = false;
    let completedByArtifact = false;
    let terminationStarted = false;
    let settled = false;
    let termTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let artifactTimer: NodeJS.Timeout | undefined;
    let reapFailureTimer: NodeJS.Timeout | undefined;
    const clearTimers = (): void => {
      if (termTimer !== undefined) clearTimeout(termTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (artifactTimer !== undefined) clearTimeout(artifactTimer);
      if (reapFailureTimer !== undefined) clearTimeout(reapFailureTimer);
    };
    const finish = (result: AgentTurnResult): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolveResult(result);
    };
    const terminate = (timeout: boolean): void => {
      if (terminationStarted) return;
      terminationStarted = true;
      timedOut = timeout;
      child.kill("SIGTERM");
      killTimer = setTimeout(
        () => {
          child.kill("SIGKILL");
          if (completedByArtifact) {
            reapFailureTimer = setTimeout(
              () =>
                finish({
                  exitCode: 1,
                  stdout: "",
                  stderr: "owned child did not exit after SIGKILL",
                  completedBy: "artifact",
                  reapFailed: true,
                }),
              1_000,
            );
          }
        },
        agentKillGraceMs(request.env ?? process.env),
      );
    };
    if (request.timeoutMs !== undefined) {
      termTimer = setTimeout(() => terminate(true), request.timeoutMs);
    }
    child.once("error", (error) => {
      clearTimers();
      reject(error);
    });
    child.once("close", (code, signal) => {
      finish({
        exitCode: code ?? (signal === null ? 1 : 128),
        stdout: "",
        stderr: "",
        ...(timedOut ? { timedOut: true } : {}),
        ...(completedByArtifact ? { completedBy: "artifact" } : {}),
      });
    });
    const pollCompletionArtifact = async (): Promise<void> => {
      const artifact = request.completionArtifact;
      if (artifact === undefined || settled || terminationStarted) return;
      let complete = false;
      if (artifact.path === undefined || existsSync(artifact.path)) {
        try {
          complete = await artifact.validateAndCollect();
        } catch {
          complete = false;
        }
      }
      if (settled || terminationStarted) return;
      if (complete) {
        completedByArtifact = true;
        terminate(false);
        return;
      }
      artifactTimer = setTimeout(() => void pollCompletionArtifact(), artifact.pollMs);
    };
    void pollCompletionArtifact();
  });
}

type SeatResolution = { seatTty?: string } | { failure: string };

/**
 * D1 seat resolution with bounded retries (the resolver itself recreates a
 * missing role window per attempt). A missing resolver means the embedder
 * owns seating (tests, non-tmux harnesses). A present resolver that cannot
 * produce a live seat is a hard turn failure: running the child unseated in
 * the capsule pane is the blind-watchdog incident, never a fallback.
 */
async function resolveAgentSeat(deps: CapsuleDeps, windowName: string): Promise<SeatResolution> {
  if (deps.resolveSeatTty === undefined) return {};
  const attempts = positiveIntEnv(
    deps.env,
    "COMBO_CHEN_SEAT_RESOLVE_ATTEMPTS",
    DEFAULT_SEAT_RESOLVE_ATTEMPTS,
  );
  const retryMs = positiveIntEnv(deps.env, "COMBO_CHEN_SEAT_RESOLVE_RETRY_MS", DEFAULT_SEAT_RESOLVE_RETRY_MS);
  const delay = deps.sleep ?? sleep;
  for (let attempt = 1; ; attempt += 1) {
    const seatTty = deps.resolveSeatTty(windowName);
    if (seatTty !== undefined) return { seatTty };
    if (attempt >= attempts) {
      return { failure: `no live pane tty for ${windowName} after ${attempts} attempts` };
    }
    await delay(retryMs);
  }
}

/** Pre-loop seat escalation: needs_human is journaled and the capsule stops. */
function escalateSeatUnavailable(runDir: string, payload: Record<string, unknown>): CapsuleResult {
  appendEvent(runDir, "needs_human", { reason: "seat_unavailable", ...payload });
  return { status: "seat_unavailable", exitCode: 0 };
}

type AgentTurnOutcome =
  | { kind: "exited"; result: AgentTurnResult }
  | { kind: "timeout" }
  | { kind: "seat_error"; detail: string }
  | { kind: "spawn_error"; detail: string };

/**
 * Bounded custody for one owned agent turn: production custody terminates the
 * child at request.timeoutMs, and this harness-side race guarantees the loop
 * itself converges even when the injected runAgent never settles. Spawn
 * rejection routes to an outcome instead of crashing the capsule.
 */
async function runBoundedAgentTurn(
  deps: CapsuleDeps,
  request: AgentProcessRequest,
): Promise<AgentTurnOutcome> {
  let raceTimer: NodeJS.Timeout | undefined;
  try {
    const turn = deps.runAgent(request).then(
      (result): AgentTurnOutcome =>
        result.timedOut === true ? { kind: "timeout" } : { kind: "exited", result },
      (error: unknown): AgentTurnOutcome =>
        error instanceof SeatOpenError
          ? { kind: "seat_error", detail: error.message }
          : { kind: "spawn_error", detail: error instanceof Error ? error.message : String(error) },
    );
    const races: Array<Promise<AgentTurnOutcome>> = [turn];
    if (request.timeoutMs !== undefined) {
      races.push(
        new Promise<AgentTurnOutcome>((resolveExpiry) => {
          raceTimer = setTimeout(() => resolveExpiry({ kind: "timeout" }), request.timeoutMs);
        }),
      );
    }
    return await Promise.race(races);
  } finally {
    if (raceTimer !== undefined) clearTimeout(raceTimer);
  }
}
// -/ 1/5

// -- 2/5 HELPER · frozen base and rebase phase --
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
// -/ 2/5

// -- 3/5 CORE · runCoderPhase and optional gnhf context bridge --
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
  const seat = await resolveAgentSeat(deps, CODER_WINDOW);
  if ("failure" in seat) {
    return escalateSeatUnavailable(runDir, { window: CODER_WINDOW, detail: seat.failure });
  }
  const baseSha = await gitHead(deps, combo);
  const before = snapshotIterations(combo.worktree);
  appendEvent(runDir, "coder_started", {});
  let coder: AgentTurnResult;
  try {
    coder = await deps.runAgent({ command, cwd: combo.worktree, env: deps.env, ...seat });
  } catch (error) {
    if (error instanceof SeatOpenError) {
      return escalateSeatUnavailable(runDir, { window: CODER_WINDOW, detail: error.message });
    }
    throw error;
  }
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
// -/ 3/5

// -- 4/5 CORE · local pre-publish V-C-V review loop (PRD s3) --
async function waitForVerdictFile(runDir: string, round: number, timeoutMs: number): Promise<boolean> {
  const path = verdictFilePath(runDir, round);
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, Math.min(50, remainingMs)));
  }
  return true;
}

function verdictAttributionDefects(verdict: VerdictFile, round: number, sha: string): string[] {
  const missingIds = missingChecklistIds(verdict);
  return [
    ...(verdict.round === round ? [] : [`round is ${verdict.round}, expected ${round}`]),
    ...(verdict.reviewed.sha === sha ? [] : [`reviewed.sha is ${verdict.reviewed.sha}, expected ${sha}`]),
    ...(missingIds.length === 0 ? [] : [`checklist missing ids: ${missingIds.join(", ")}`]),
  ];
}

/** Poll probe: malformed/torn/wrong-attribution files are never routable. */
function hasCompleteCurrentVerdict(runDir: string, round: number, sha: string): boolean {
  try {
    return verdictAttributionDefects(readVerdictFile(runDir, round), round, sha).length === 0;
  } catch {
    return false;
  }
}

function reviewerIdentity(config: ConfigSnapshot): ProducingIdentity | undefined {
  const reviewer = config.resolvedTeam?.reviewer;
  if (reviewer === undefined) return undefined;
  return { model: reviewer.model, runtime: reviewer.binary };
}

/** Compact journal projection of findings; the verdict file stays the source of truth. */
function findingsProjection(findings: VerdictFinding[]): Array<Record<string, unknown>> {
  return findings.map((finding) => ({
    id: finding.id,
    severity: finding.severity,
    file: finding.file,
    ...(finding.line === undefined ? {} : { line: finding.line }),
    title: finding.title,
    fingerprints: findingFingerprints(finding),
  }));
}

function escalate(runDir: string, reason: string, payload: Record<string, unknown>): CapsuleResult {
  appendEvent(runDir, "needs_human", { reason, ...payload });
  return { status: "local_review_escalated", exitCode: 0 };
}

type VerdictRoundOutcome =
  { verdict: VerdictFile; sha: string } | { escalation: CapsuleResult; reason: string };

async function runVerdictRound(
  deps: CapsuleDeps,
  combo: ComboRecord,
  runDir: string,
  config: ConfigSnapshot,
  baseRef: string,
  workPlan: WorkPlan,
  round: number,
): Promise<VerdictRoundOutcome> {
  const sha = await gitHead(deps, combo);
  const seat = await resolveAgentSeat(deps, REVIEWER_WINDOW);
  if ("failure" in seat) {
    return {
      escalation: escalate(runDir, "seat_unavailable", {
        round,
        sha,
        window: REVIEWER_WINDOW,
        detail: seat.failure,
      }),
      reason: "seat_unavailable",
    };
  }
  appendEvent(runDir, "local_review_requested", { round, sha });
  const identity = reviewerIdentity(config);
  const command = buildLocalReviewerInvocation({
    combo,
    runDir,
    round,
    sha,
    baseRef,
    reviewerInstructions: config.reviewerPrompt,
    reviewerCommand: config.reviewerCommand,
    workPlan,
    ...(identity === undefined ? {} : { identity }),
  });
  let collected: VerdictRoundOutcome | undefined;
  const turn = await runBoundedAgentTurn(deps, {
    command,
    cwd: combo.worktree,
    env: deps.env,
    timeoutMs: config.reviewerTurnTimeoutMinutes * 60_000,
    completionArtifact: {
      path: verdictFilePath(runDir, round),
      pollMs: Math.min(50, config.reviewVerdictWaitMs),
      validateAndCollect: () => {
        if (!hasCompleteCurrentVerdict(runDir, round, sha)) return false;
        collected = ingestVerdictArtifact(deps, combo, runDir, round, sha);
        return true;
      },
    },
    ...seat,
  });
  if (turn.kind === "seat_error") {
    return {
      escalation: escalate(runDir, "seat_unavailable", {
        round,
        sha,
        window: REVIEWER_WINDOW,
        detail: turn.detail,
      }),
      reason: "seat_unavailable",
    };
  }
  if (turn.kind === "timeout") {
    return {
      escalation: escalate(runDir, "local_review_timeout", {
        round,
        sha,
        timeout_minutes: config.reviewerTurnTimeoutMinutes,
      }),
      reason: "local_review_timeout",
    };
  }
  if (turn.kind === "spawn_error") {
    return {
      escalation: escalate(runDir, "local_review_spawn_failed", { round, sha, detail: turn.detail }),
      reason: "local_review_spawn_failed",
    };
  }
  if (turn.result.reapFailed === true) {
    return {
      escalation: escalate(runDir, "local_review_reap_failed", { round, sha }),
      reason: "local_review_reap_failed",
    };
  }
  if (turn.result.completedBy === "artifact") {
    return (
      collected ?? {
        escalation: escalate(runDir, "local_review_spawn_failed", {
          round,
          sha,
          detail: "artifact completion resolved without a collected verdict",
        }),
        reason: "local_review_spawn_failed",
      }
    );
  }
  const reviewer = turn.result;
  const appeared = await waitForVerdictFile(runDir, round, config.reviewVerdictWaitMs);
  if (!appeared) {
    return {
      escalation: escalate(runDir, "local_verdict_missing", {
        round,
        sha,
        reviewer_exit_code: reviewer.exitCode,
      }),
      reason: "local_verdict_missing",
    };
  }
  return ingestVerdictArtifact(deps, combo, runDir, round, sha);
}

/**
 * Validate, journal, and project one verdict artifact. Shared by the live
 * round (after the reviewer exits) and by resume, which consumes an orphan
 * artifact whose rename landed before the crash killed the journal append.
 */
function ingestVerdictArtifact(
  deps: CapsuleDeps,
  combo: ComboRecord,
  runDir: string,
  round: number,
  sha: string,
): VerdictRoundOutcome {
  let verdict: VerdictFile;
  try {
    verdict = readVerdictFile(runDir, round);
  } catch (error) {
    const detail = error instanceof VerdictError ? error.message : String(error);
    return {
      escalation: escalate(runDir, "local_verdict_malformed", { round, sha, detail }),
      reason: "local_verdict_malformed",
    };
  }
  const attributionDefects = verdictAttributionDefects(verdict, round, sha);
  if (attributionDefects.length > 0) {
    return {
      escalation: escalate(runDir, "local_verdict_malformed", {
        round,
        sha,
        detail: attributionDefects.join("; "),
      }),
      reason: "local_verdict_malformed",
    };
  }
  appendEvent(runDir, "local_verdict", {
    round,
    code: verdict.code,
    verdict_path: verdictFileName(round),
    identity: verdict.identity,
    sha,
    findings: findingsProjection(verdict.findings),
  });
  try {
    writeFileSync(reviewDossierPath(runDir, round, sha), renderReviewDossier(verdict));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    deps.out(`capsule: review dossier unavailable for ${combo.id}: ${detail}`);
  }
  if (verdict.followUps.length > 0) {
    appendEvent(runDir, "follow_ups", { round, items: verdict.followUps });
  }
  return { verdict, sha };
}

type FixTurnOutcome =
  | { kind: "commits"; count: number }
  | { kind: "noop"; exitCode: number }
  | { kind: "thread_unavailable"; detail: string }
  | { kind: "timeout"; timeoutMinutes: number }
  | { kind: "seat_unavailable"; detail: string }
  | { kind: "spawn_error"; detail: string }
  | { kind: "reap_failed" }
  | { kind: "count_failed"; detail: string };

/** Commit-backed completion artifact: new HEAD plus a completely clean worktree. */
async function hasCleanFixCommit(
  deps: CapsuleDeps,
  combo: ComboRecord,
  baseSha: string,
): Promise<string | undefined> {
  const headSha = await gitHead(deps, combo);
  if (headSha === baseSha) return undefined;
  const status = await deps.git({
    command: "git",
    args: ["status", "--porcelain"],
    cwd: combo.worktree,
    env: deps.env,
  });
  return status.exitCode === 0 && status.stdout.trim() === "" ? headSha : undefined;
}

/**
 * One code-1 fix turn: resume the implementing thread as an owned child of
 * the capsule (never a fresh gnhf loop) and judge the turn by observables
 * only, per D1 custody: a new clean commit is collected while the child is
 * alive, then custody reaps it. Child exit remains the cleanup/fallback path.
 */
async function runCoderFixTurn(
  deps: CapsuleDeps,
  combo: ComboRecord,
  runDir: string,
  config: ConfigSnapshot,
  round: number,
  verdict: VerdictFile,
): Promise<FixTurnOutcome> {
  let command: string;
  try {
    const artifact = readCoderThreadArtifact(runDir);
    const prompt = buildReviewFixPrompt({
      round,
      sha: verdict.reviewed.sha,
      findings: verdict.findings,
      dossierPath: reviewDossierPath(runDir, round, verdict.reviewed.sha),
    });
    command = buildCoderFixTurnCommand(artifact, config.coderResumeCommand, prompt);
  } catch (error) {
    return { kind: "thread_unavailable", detail: error instanceof Error ? error.message : String(error) };
  }
  const seat = await resolveAgentSeat(deps, CODER_WINDOW);
  if ("failure" in seat) return { kind: "seat_unavailable", detail: seat.failure };
  const baseSha = await gitHead(deps, combo);
  let artifactHeadSha: string | undefined;
  appendEvent(runDir, "coder_started", { round, mode: "review_fix" });
  const turn = await runBoundedAgentTurn(deps, {
    command,
    cwd: combo.worktree,
    env: deps.env,
    timeoutMs: config.fixTurnTimeoutMinutes * 60_000,
    completionArtifact: {
      pollMs: Math.min(50, config.reviewVerdictWaitMs),
      validateAndCollect: async () => {
        artifactHeadSha = await hasCleanFixCommit(deps, combo, baseSha);
        return artifactHeadSha !== undefined;
      },
    },
    ...seat,
  });
  if (turn.kind === "seat_error") return { kind: "seat_unavailable", detail: turn.detail };
  if (turn.kind === "timeout") return { kind: "timeout", timeoutMinutes: config.fixTurnTimeoutMinutes };
  if (turn.kind === "spawn_error") return { kind: "spawn_error", detail: turn.detail };
  if (turn.result.reapFailed === true) return { kind: "reap_failed" };
  const headSha = artifactHeadSha ?? (await gitHead(deps, combo));
  const counted = await deps.git({
    command: "git",
    args: ["rev-list", "--count", `${baseSha}..${headSha}`],
    cwd: combo.worktree,
    env: deps.env,
  });
  // A failed count is missing evidence, not a no-op turn: git errors must
  // never be read as "the coder committed nothing".
  if (counted.exitCode !== 0 || !/^\d+$/.test(counted.stdout.trim())) {
    return {
      kind: "count_failed",
      detail: counted.stderr.trim() || `git rev-list exited ${counted.exitCode}`,
    };
  }
  const count = Number(counted.stdout.trim());
  if (count === 0) return { kind: "noop", exitCode: turn.result.exitCode };
  appendEvent(runDir, "coder_done", { round, mode: "review_fix", new_commit_count: count });
  return { kind: "commits", count };
}

/** Every needs_human reason the review loop can emit; drives resume folding. */
const LOOP_ESCALATION_REASONS = new Set([
  "local_verdict_missing",
  "local_verdict_malformed",
  "local_verdict_code_2",
  "local_verdict_code_3",
  "local_review_timeout",
  "local_review_reap_failed",
  "local_review_spawn_failed",
  "review_no_progress",
  "review_max_rounds",
  "review_fix_thread_unavailable",
  "review_fix_noop",
  "review_fix_timeout",
  "review_fix_spawn_failed",
  "review_fix_reap_failed",
  "review_fix_commit_count_failed",
  "seat_unavailable",
  "loop_state_malformed",
]);

/** Journal-first escalation: needs_human is ground truth, guard converges after. */
function escalateWithGuard(
  runDir: string,
  state: LoopState,
  round: number,
  reason: string,
  payload: Record<string, unknown>,
): CapsuleResult {
  const result = escalate(runDir, reason, { round, ...payload });
  writeLoopState(runDir, withLoopGuard(state, { state: "escalated", round, reason }));
  return result;
}

/** Run one fix turn and escalate its failure modes; undefined means commits landed. */
async function routeFixTurn(
  deps: CapsuleDeps,
  combo: ComboRecord,
  runDir: string,
  config: ConfigSnapshot,
  state: LoopState,
  verdict: VerdictFile,
): Promise<CapsuleResult | undefined> {
  const round = verdict.round;
  const roundFacts = { sha: verdict.reviewed.sha, verdict_path: verdictFileName(round) };
  const findings = findingsProjection(verdict.findings);
  const fix = await runCoderFixTurn(deps, combo, runDir, config, round, verdict);
  switch (fix.kind) {
    case "commits":
      return undefined;
    case "thread_unavailable":
      return escalateWithGuard(runDir, state, round, "review_fix_thread_unavailable", {
        ...roundFacts,
        detail: fix.detail,
        findings,
      });
    case "timeout":
      return escalateWithGuard(runDir, state, round, "review_fix_timeout", {
        ...roundFacts,
        timeout_minutes: fix.timeoutMinutes,
        findings,
      });
    case "seat_unavailable":
      return escalateWithGuard(runDir, state, round, "seat_unavailable", {
        ...roundFacts,
        window: CODER_WINDOW,
        mode: "review_fix",
        detail: fix.detail,
        findings,
      });
    case "spawn_error":
      return escalateWithGuard(runDir, state, round, "review_fix_spawn_failed", {
        ...roundFacts,
        detail: fix.detail,
        findings,
      });
    case "reap_failed":
      return escalateWithGuard(runDir, state, round, "review_fix_reap_failed", {
        ...roundFacts,
        findings,
      });
    case "count_failed":
      return escalateWithGuard(runDir, state, round, "review_fix_commit_count_failed", {
        ...roundFacts,
        detail: fix.detail,
        findings,
      });
    case "noop":
      return escalateWithGuard(runDir, state, round, "review_fix_noop", {
        ...roundFacts,
        coder_exit_code: fix.exitCode,
        findings,
      });
  }
}

type LoopEntry =
  | { kind: "proceed" }
  | { kind: "done"; result: CapsuleResult }
  | {
      kind: "iterate";
      state: LoopState;
      nextRound: number;
      pendingFix?: VerdictFile;
      consumeArtifact: boolean;
    };

/**
 * Resume fold (recon R1 round attribution + reviewer crash sequence): derive
 * the exact next loop action from journal + validated loop-state instead of
 * restarting at round 1. Verdict round numbers are never reused, guard and
 * fingerprint history are preserved, and an interrupted fix turn is judged
 * by its commit observables.
 */
async function resolveLoopEntry(
  deps: CapsuleDeps,
  combo: ComboRecord,
  runDir: string,
  initial: LoopState,
): Promise<LoopEntry> {
  const journal = readEvents(runDir);
  let state = initial;
  // Reconcile verdict rounds the journal knows but a lost write dropped from
  // loop-state; the artifact must exist because local_verdict follows the rename.
  for (const event of journal) {
    if (event.event !== "local_verdict") continue;
    const round = typeof event["round"] === "number" ? event["round"] : undefined;
    if (round === undefined || round <= state.currentRound) continue;
    try {
      state = recordLoopRound(state, readVerdictFile(runDir, round));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        kind: "done",
        result: escalateWithGuard(runDir, state, round, "loop_state_malformed", {
          detail: `journaled round ${round} cannot be reconciled: ${detail}`,
        }),
      };
    }
  }

  // Pending loop escalations are journal truth: a needs_human without a
  // decision keeps the loop parked; only a retry decision re-enters it.
  let pendingEscalation: ComboEvent | undefined;
  let decidedVerb: string | undefined;
  for (const event of journal) {
    if (
      event.event === "needs_human" &&
      typeof event["reason"] === "string" &&
      LOOP_ESCALATION_REASONS.has(event["reason"])
    ) {
      pendingEscalation = event;
      decidedVerb = undefined;
    } else if (
      event.event === "decision" &&
      pendingEscalation !== undefined &&
      String(event["needs_human_ref"]) === pendingEscalation.t
    ) {
      decidedVerb = typeof event["verb"] === "string" ? event["verb"] : undefined;
      pendingEscalation = undefined;
    } else if (event.event === "local_review_requested") {
      pendingEscalation = undefined;
      decidedVerb = undefined;
    } else if (event.event === "coder_started" && event["mode"] !== "review_fix") {
      // A rerun initial pass supersedes a pre-loop (coder seat) escalation.
      // Loop escalations always follow coder_done, and a pending one resumes
      // at the gate without a fresh initial pass, so none can be lost here.
      pendingEscalation = undefined;
      decidedVerb = undefined;
    }
  }
  if (pendingEscalation !== undefined) {
    if (state.guard.state !== "escalated") {
      const round =
        typeof pendingEscalation["round"] === "number" ? pendingEscalation["round"] : state.currentRound || 1;
      writeLoopState(
        runDir,
        withLoopGuard(state, { state: "escalated", round, reason: String(pendingEscalation["reason"]) }),
      );
    }
    return { kind: "done", result: { status: "local_review_escalated", exitCode: 0 } };
  }
  if (decidedVerb !== undefined && decidedVerb !== "retry") {
    // skip / ignore / take_over: the human owns the combo from here; the
    // loop neither iterates nor lets an unapproved changeset reach the gate.
    return { kind: "done", result: { status: "local_review_escalated", exitCode: 0 } };
  }

  const lastRound = state.rounds.at(-1);
  if (state.guard.state === "cleared" || lastRound?.code === 0) return { kind: "proceed" };
  if (lastRound === undefined) {
    return { kind: "iterate", state, nextRound: 1, consumeArtifact: existsSync(verdictFilePath(runDir, 1)) };
  }
  if (decidedVerb === "retry") {
    state = withLoopGuard(state, { state: "iterating" });
    writeLoopState(runDir, state);
    return {
      kind: "iterate",
      state,
      nextRound: lastRound.round + 1,
      consumeArtifact: existsSync(verdictFilePath(runDir, lastRound.round + 1)),
    };
  }
  if (lastRound.code === 2 || lastRound.code === 3) {
    // Crash landed between the verdict journal and its escalation append.
    let findings: Array<Record<string, unknown>> = [];
    try {
      findings = findingsProjection(readVerdictFile(runDir, lastRound.round).findings);
    } catch {
      // The escalation stands even when the artifact went unreadable.
    }
    return {
      kind: "done",
      result: escalateWithGuard(runDir, state, lastRound.round, `local_verdict_code_${lastRound.code}`, {
        sha: lastRound.sha,
        verdict_path: lastRound.verdictPath,
        findings,
      }),
    };
  }
  const fixDone = journal.some(
    (event) =>
      event.event === "coder_done" && event["mode"] === "review_fix" && event["round"] === lastRound.round,
  );
  const fixStarted = journal.some(
    (event) =>
      event.event === "coder_started" && event["mode"] === "review_fix" && event["round"] === lastRound.round,
  );
  if (fixDone) {
    return {
      kind: "iterate",
      state,
      nextRound: lastRound.round + 1,
      consumeArtifact: existsSync(verdictFilePath(runDir, lastRound.round + 1)),
    };
  }
  if (fixStarted) {
    // D1 custody after a crash: the fix process is gone, so its commits are
    // the only completion evidence.
    const headSha = await gitHead(deps, combo);
    const counted = await deps.git({
      command: "git",
      args: ["rev-list", "--count", `${lastRound.sha}..${headSha}`],
      cwd: combo.worktree,
      env: deps.env,
    });
    if (counted.exitCode !== 0 || !/^\d+$/.test(counted.stdout.trim())) {
      return {
        kind: "done",
        result: escalateWithGuard(runDir, state, lastRound.round, "review_fix_commit_count_failed", {
          detail: counted.stderr.trim() || `git rev-list exited ${counted.exitCode}`,
        }),
      };
    }
    const count = Number(counted.stdout.trim());
    if (count > 0) {
      appendEvent(runDir, "coder_done", {
        round: lastRound.round,
        mode: "review_fix",
        new_commit_count: count,
        recovered: true,
      });
      return {
        kind: "iterate",
        state,
        nextRound: lastRound.round + 1,
        consumeArtifact: existsSync(verdictFilePath(runDir, lastRound.round + 1)),
      };
    }
  }
  // No fix turn ran (or it died without committing): re-run it.
  try {
    const pendingFix = readVerdictFile(runDir, lastRound.round);
    return { kind: "iterate", state, nextRound: lastRound.round + 1, pendingFix, consumeArtifact: false };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      kind: "done",
      result: escalateWithGuard(runDir, state, lastRound.round, "loop_state_malformed", {
        detail: `recorded round ${lastRound.round} has no readable verdict: ${detail}`,
      }),
    };
  }
}

/**
 * The V-C-V loop (PRD s3): every iteration opens with a verdict round and
 * only a verdict closes the loop toward the gate; a coder turn can at most
 * trigger the next round or an escalation, never the gate. Loop position is
 * persisted to loop-state.json after every transition, and entry always
 * resumes from journal + loop-state instead of restarting at round 1.
 */
async function runLocalReviewPhase(
  deps: CapsuleDeps,
  combo: ComboRecord,
  runDir: string,
  config: ConfigSnapshot,
  baseRef: string,
  workPlan: WorkPlan,
): Promise<CapsuleResult | undefined> {
  let entryState: LoopState;
  try {
    entryState = readLoopState(runDir) ?? initialLoopState();
  } catch (error) {
    return escalate(runDir, "loop_state_malformed", {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  const entry = await resolveLoopEntry(deps, combo, runDir, entryState);
  if (entry.kind === "proceed") return undefined;
  if (entry.kind === "done") return entry.result;
  let state = entry.state;
  let pendingFix = entry.pendingFix;
  let consumeArtifact = entry.consumeArtifact;
  for (let round = entry.nextRound; ; round += 1) {
    // Every continuing iteration reassigns pendingFix at its end, so the
    // value here is always this round's intended predecessor turn.
    if (pendingFix !== undefined) {
      const failure = await routeFixTurn(deps, combo, runDir, config, state, pendingFix);
      if (failure !== undefined) return failure;
    }
    const outcome = consumeArtifact
      ? ingestVerdictArtifact(deps, combo, runDir, round, await gitHead(deps, combo))
      : await runVerdictRound(deps, combo, runDir, config, baseRef, workPlan, round);
    consumeArtifact = false;
    if ("escalation" in outcome) {
      writeLoopState(runDir, withLoopGuard(state, { state: "escalated", round, reason: outcome.reason }));
      return outcome.escalation;
    }
    const { verdict, sha } = outcome;
    state = recordLoopRound(state, verdict);
    if (verdict.code === 0) {
      writeLoopState(runDir, withLoopGuard(state, { state: "cleared", round }));
      return undefined;
    }
    const roundFacts = { sha, verdict_path: verdictFileName(round) };
    if (verdict.code !== 1) {
      return escalateWithGuard(runDir, state, round, `local_verdict_code_${verdict.code}`, {
        ...roundFacts,
        findings: findingsProjection(verdict.findings),
      });
    }
    const survivors = findingsSurvivingRound(state, verdict.findings, round - 1);
    if (survivors.length > 0) {
      return escalateWithGuard(runDir, state, round, "review_no_progress", {
        ...roundFacts,
        findings: findingsProjection(survivors),
      });
    }
    if (round >= config.reviewMaxRounds) {
      return escalateWithGuard(runDir, state, round, "review_max_rounds", {
        ...roundFacts,
        max_rounds: config.reviewMaxRounds,
        findings: findingsProjection(verdict.findings),
      });
    }
    writeLoopState(runDir, state);
    pendingFix = verdict;
  }
}
// -/ 4/5

// -- 5/5 CORE · runCapsule <- START HERE --
export type CapsulePhase = "sequence" | "gate" | "supervise" | "closed";

/**
 * Journal-derived resume position for a capsule run. A dead gnhf process
 * after coder_done is healthy under the coder dual-contract: the initial
 * turn is over and the thread waits for the next routed prompt.
 */
export function classifyCapsulePhase(events: ComboEvent[]): CapsulePhase {
  let phase: CapsulePhase = "sequence";
  for (const event of events) {
    if (event.event === "combo_closed") {
      phase = "closed";
      continue;
    }
    if (phase === "closed") continue;
    if (event.event === "pr_opened") phase = "supervise";
    if (phase === "supervise") continue;
    // Review-fix coder turns are loop-internal: the entry point stays "gate"
    // and the review-loop resume fold owns their interrupted state.
    if (event["mode"] === "review_fix") continue;
    if (event.event === "coder_done") phase = "gate";
    if (event.event === "coder_failed") phase = "sequence";
  }
  return phase;
}

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

export async function runCapsule(
  runDir: string,
  deps: CapsuleDeps,
  options: { startAtGate?: boolean } = {},
): Promise<CapsuleResult> {
  const combo = readCombo(runDir);
  const config = readConfigSnapshot(runDir);
  assertSafeCoderInvocation(config.coderCommand, { requireGnhf: config.roles.coder === "codex" });
  const baseRef = readBaseRef(runDir);
  const gateFacts = buildGateFacts(runDir, combo, config.gatekeeperCommand);
  // startAtGate resumes a run whose coder already finished: skip rebase and
  // coder, but keep the pre-publish review so no PR is born unreviewed.
  if (options.startAtGate !== true) {
    const rebase = await runRebasePhase(deps, combo, runDir, baseRef);
    if (rebase !== undefined) return rebase;

    const coderCommand = buildCoderInvocation({
      coderCommand: config.coderCommand,
      combo,
      ...(isGitHubIssueWorkItem(combo)
        ? {}
        : { prompt: defaultWorkPlanPrompt(gateFacts.plan, join(runDir, "work-plan.md")) }),
    });
    const coder = await runCoderPhase(deps, combo, runDir, coderCommand);
    if (coder !== undefined) return coder;
  }

  const review = await runLocalReviewPhase(deps, combo, runDir, config, baseRef, gateFacts.plan);
  if (review !== undefined) return review;
  try {
    await pinLocalLgtm({
      git: deps.git,
      cwd: combo.worktree,
      runDir,
      baseRef,
      sha: await gitHead(deps, combo),
      round: Math.max(1, nextLocalReviewRound(readEvents(runDir)) - 1),
      env: deps.env,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    deps.out(`capsule: local lgtm pin unavailable for ${combo.id}: ${detail}`);
  }

  const runGate = deps.runGate ?? runInProcessGate;
  const gateInput: InProcessGateInput = {
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
  };
  const delay = deps.sleep ?? sleep;
  let gate = await runGate(gateInput);
  // The capsule owns the initial-gate retry that director-watch performed for
  // v0 runs: bounded relaunches with the snapshot-frozen backoff, then a
  // needs_human gate_failed escalation.
  for (
    let attempt = 1;
    gate.status === "failed" && attempt <= config.gatekeeperInitialGateRetryAttempts;
    attempt += 1
  ) {
    deps.out(
      `capsule: retrying initial gate for ${combo.id} after gate_failed ` +
        `(attempt ${attempt}/${config.gatekeeperInitialGateRetryAttempts})`,
    );
    if (config.gatekeeperInitialGateRetryBackoffSeconds > 0) {
      await delay(config.gatekeeperInitialGateRetryBackoffSeconds * 1000);
    }
    gate = await runGate(gateInput);
  }
  if (gate.status === "failed") {
    appendEvent(runDir, "needs_human", { reason: "gate_failed" });
    deps.out(
      `capsule: initial gate retries exhausted for ${combo.id} ` +
        `after ${config.gatekeeperInitialGateRetryAttempts}`,
    );
  }
  if (gate.status === "already_running" && gate.runId !== undefined) {
    await deps.attachGate?.(gate.runId);
  }
  if (gate.status === "validated") {
    // D3 carry-over: the gate may have rebased (or autofixed) the reviewed
    // changeset before publishing; the lgtm follows the patch-id, and a
    // changed changeset routes a local re-review round, never needs_human.
    const carry = await applyLgtmCarryOver({
      git: deps.git,
      cwd: combo.worktree,
      runDir,
      baseRef,
      publishedSha: gate.headSha,
      env: deps.env,
    });
    if (carry.outcome === "re_review_requested") {
      deps.out(
        `capsule: lgtm did not carry to ${gate.headSha} (${carry.reason}); ` +
          `local re-review round ${carry.round} requested`,
      );
    }
  }
  return { status: gate.status, exitCode: gate.exitCode };
}
// -/ 5/5
