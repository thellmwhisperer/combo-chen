/**
 * @overview Coder adapter: turns config + combo facts into a gnhf command,
 *   appends the helper-surface preflight, and extracts Codex thread IDs for
 *   resume. ~195 lines, 9 exports.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at buildCoderInvocation     ← command rendering + helper preflight
 *   2. persistCoderThreadArtifact         ← captures thread_id for resume
 *   3. extractCodexThreadIdFromJsonl      ← parses gnhf JSONL for thread
 *   4. defaultPrompt / defaultWorkPlanPrompt ← read when tracing prompt shape
 *
 *   MAIN FLOW
 *   ─────────
 *   cli/main.ts → buildCoderInvocation({coderCommand, combo, prompt?})
 *     → repoHasSurfaceScript chooses pnpm surface or generic helper search
 *     → renderCommand(template, {issue_url, worktree, repo, branch, prompt})
 *     → runner.sh executes the command
 *     → emit "coder_done" → persistCoderThreadArtifact extracts thread_id
 *
 *   ┌─ PUBLIC API ──────────────────────────────────────────────────────────┐
 *   │ buildCoderInvocation       Render command and append helper preflight │
 *   │ persistCoderThreadArtifact Extract + store thread_id for resume       │
 *   │ extractCodexThreadIdFromJsonl Parse gnhf JSONL → thread_id           │
 *   │ defaultPrompt              Standard issue objective prompt            │
 *   │ defaultWorkPlanPrompt      Standard plan objective prompt             │
 *   │ CoderThreadArtifact        {agent, thread_id, source} shape           │
 *   │ CoderInput                 Template vars for the coder command         │
 *   │ CODER_THREAD_ARTIFACT      Coder thread artifact filename              │
 *   │ LEGACY_ROWER_THREAD_ARTIFACT Legacy rower thread artifact filename     │
 *   ├─ INTERNALS ───────────────────────────────────────────────────────────┤
 *   │ repoHasSurfaceScript       Detect target repo support for pnpm surface│
 *   │ latestGnhfIterationJsonl   Find newest iteration-1.jsonl in .gnhf    │
 *   └────────────────────────────────────────────────────────────────────────┘
 *
 * @exports CODER_THREAD_ARTIFACT, LEGACY_ROWER_THREAD_ARTIFACT, CoderThreadArtifact, defaultPrompt, defaultWorkPlanPrompt, CoderInput, buildCoderInvocation, extractCodexThreadIdFromJsonl, persistCoderThreadArtifact
 * @deps node:fs, node:path, ../infra/config, ../core/state, ../core/work-plan
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { renderCommand } from "../infra/config.js";
import type { ComboRecord } from "../core/state.js";
import type { WorkPlan } from "../core/work-plan.js";

// -- 1/3 HELPER · Types + constants + defaultPrompt --
export const CODER_THREAD_ARTIFACT = "coder-thread.json";
export const LEGACY_ROWER_THREAD_ARTIFACT = "rower-thread.json";
const SURFACE_PREFLIGHT =
  "Before writing any new helper, run pnpm surface. " +
  "If the helper exists as private in another module, export it and reuse it; do not rewrite it.";
const GENERIC_HELPER_PREFLIGHT =
  "Before writing any new helper, search the repo for an equivalent helper. " +
  "If an equivalent private helper exists in another module, export it and reuse it; do not rewrite it.";

export interface CoderThreadArtifact {
  agent: "codex";
  thread_id: string;
  source: string;
}

export function defaultPrompt(issueUrl: string): string {
  return (
    `Implement GitHub issue ${issueUrl}. ` +
    `Read it first with: gh issue view ${issueUrl}. ` +
    `Work test-first: red test, minimal code to green, refactor. ` +
    `Stay strictly within the issue's scope.`
  );
}

export function defaultWorkPlanPrompt(plan: WorkPlan, artifactPath: string): string {
  return (
    `Implement work plan ${plan.title}. ` +
    `Read the normalized work plan artifact first: ${artifactPath}. ` +
    `Source: ${plan.source.type} ${plan.source.reference}. ` +
    `Work test-first: red test, minimal code to green, refactor. ` +
    `Stay strictly within the work plan's scope and acceptance criteria.`
  );
}

export interface CoderInput {
  coderCommand: string;
  combo: ComboRecord;
  prompt?: string;
}
// -/ 1/3

// -- 2/3 CORE · buildCoderInvocation ← START HERE --
export function buildCoderInvocation(input: CoderInput): string {
  if (input.prompt === undefined && input.combo.issueUrl.trim() === "") {
    throw new Error(
      "buildCoderInvocation requires an explicit prompt for plan-backed combos (issueUrl is empty); pass a prompt override",
    );
  }
  const preflight = repoHasSurfaceScript(input.combo.worktree) ? SURFACE_PREFLIGHT : GENERIC_HELPER_PREFLIGHT;
  const prompt = `${input.prompt ?? defaultPrompt(input.combo.issueUrl)} ${preflight}`;
  return renderCommand(input.coderCommand, {
    issue_url: input.combo.issueUrl,
    worktree: input.combo.worktree,
    repo: input.combo.repoDir,
    branch: input.combo.branch,
    prompt,
  });
}
// -/ 2/3

function repoHasSurfaceScript(worktree: string): boolean {
  const packageJsonPath = join(worktree, "package.json");
  if (!existsSync(packageJsonPath)) return false;
  try {
    const packageJson: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (packageJson === null || typeof packageJson !== "object") return false;
    const scripts = (packageJson as { scripts?: unknown }).scripts;
    if (scripts === null || typeof scripts !== "object") return false;
    return typeof (scripts as Record<string, unknown>)["surface"] === "string";
  } catch {
    return false;
  }
}

// -- 3/3 CORE · Thread artifact extraction + persistence --
export function extractCodexThreadIdFromJsonl(jsonlPath: string): string | undefined {
  let latestThreadId: string | undefined;
  for (const line of readFileSync(jsonlPath, "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      event !== null &&
      typeof event === "object" &&
      "type" in event &&
      "thread_id" in event &&
      event.type === "thread.started" &&
      typeof event.thread_id === "string" &&
      event.thread_id.trim() !== ""
    ) {
      latestThreadId = event.thread_id;
    }
  }
  return latestThreadId;
}

export function persistCoderThreadArtifact(input: { runDir: string; worktree: string }): CoderThreadArtifact {
  const jsonlPath = latestGnhfIterationJsonl(input.worktree);
  if (jsonlPath === undefined) {
    throw new Error(`No gnhf JSONL found in ${input.worktree}/.gnhf/runs`);
  }
  const threadId = extractCodexThreadIdFromJsonl(jsonlPath);
  if (threadId === undefined) {
    throw new Error(`No thread.started event found in ${jsonlPath}`);
  }

  const artifact: CoderThreadArtifact = {
    agent: "codex",
    thread_id: threadId,
    source: relative(input.worktree, jsonlPath).split(sep).join("/"),
  };
  mkdirSync(input.runDir, { recursive: true });
  writeFileSync(join(input.runDir, CODER_THREAD_ARTIFACT), `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}

function latestGnhfIterationJsonl(worktree: string): string | undefined {
  const runsDir = join(worktree, ".gnhf", "runs");
  if (!existsSync(runsDir)) return undefined;

  let latest: { path: string; mtimeMs: number } | undefined;
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(runsDir, entry.name, "iteration-1.jsonl");
    if (!existsSync(candidate)) continue;
    const mtimeMs = statSync(candidate).mtimeMs;
    if (latest === undefined || mtimeMs > latest.mtimeMs) {
      latest = { path: candidate, mtimeMs };
    }
  }
  return latest?.path;
}
// -/ 3/3
