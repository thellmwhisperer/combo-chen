/**
 * @overview Coder adapter: turns config + combo facts into a gnhf command,
 *   appends the helper-surface preflight, and extracts Codex thread IDs for
 *   resume. ~180 lines, 9 exports.
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
 *   app/capsule/capsule.ts → buildCoderInvocation({coderCommand, combo, prompt?})
 *     → repoHasSurfaceScript chooses pnpm surface or generic helper search
 *     → renderCommand(template, {issue_url, worktree, repo, branch, prompt})
 *     → the capsule runs the command as an owned child (runAgentProcess)
 *     → capsule journals "coder_done" → persistCoderThreadArtifact extracts thread_id
 *
 *   ┌─ PUBLIC API ──────────────────────────────────────────────────────────┐
 *   │ buildCoderInvocation       Render command and append helper preflight │
 *   │ persistCoderThreadArtifact Extract + store thread_id for resume       │
 *   │ extractCodexThreadIdFromJsonl Parse gnhf JSONL → thread_id           │
 *   │ defaultPrompt              Standard issue objective prompt            │
 *   │ defaultWorkPlanPrompt      Standard plan objective prompt             │
 *   │ buildReviewFixPrompt       v1 review-loop code-1 fix-turn prompt      │
 *   │ ReviewFixPromptInput       Findings + dossier facts for the fix turn  │
 *   │ CoderThreadArtifact        {agent, thread_id, source} shape           │
 *   │ CoderInput                 Template vars for the coder command         │
 *   │ CODER_THREAD_ARTIFACT      Coder thread artifact filename              │
 *   │ LEGACY_ROWER_THREAD_ARTIFACT Legacy rower thread artifact filename     │
 *   ├─ INTERNALS ───────────────────────────────────────────────────────────┤
 *   │ repoHasSurfaceScript       Detect target repo support for pnpm surface│
 *   │ validatedGnhfJsonlPath     Constrain the selected JSONL to the run dir│
 *   └────────────────────────────────────────────────────────────────────────┘
 *
 * @exports CODER_THREAD_ARTIFACT, LEGACY_ROWER_THREAD_ARTIFACT, CoderThreadArtifact, defaultPrompt, defaultWorkPlanPrompt, ReviewFixPromptInput, buildReviewFixPrompt, CoderInput, buildCoderInvocation, extractCodexThreadIdFromJsonl, persistCoderThreadArtifact
 * @deps node:fs, node:path, ../infra/config, ../core/state, ../core/verdict, ../core/work-plan
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { renderCommand } from "../infra/config.js";
import type { ComboRecord } from "../core/state.js";
import type { VerdictFinding } from "../core/verdict.js";
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

export interface ReviewFixPromptInput {
  round: number;
  sha: string;
  findings: Array<Pick<VerdictFinding, "id" | "severity" | "file" | "line" | "title" | "body">>;
  dossierPath: string;
}

/**
 * v1 review-loop fix turn (PRD s3): the capsule resumes the implementing
 * thread with this prompt after a code-1 verdict. The no-commit clause is a
 * contract, not advice: the capsule counts commits after the turn's process
 * exits and escalates needs_human on a no-op turn.
 */
export function buildReviewFixPrompt(input: ReviewFixPromptInput): string {
  const findingLines = input.findings.map(
    (finding) =>
      `[${finding.id}] ${finding.severity} ${finding.file}` +
      `${finding.line === undefined ? "" : `:${finding.line}`}: ${finding.title} - ${finding.body}`,
  );
  return [
    `Local review round ${input.round} on your changeset at sha ${input.sha} returned verdict code 1: mechanical fixes required before the gate.`,
    `Findings to fix: ${findingLines.join(" ")}`,
    `Full review dossier: ${input.dossierPath}.`,
    "Work test-first: red test, minimal code to green, refactor.",
    "Address every finding; the harness will re-review after your turn, and the same finding surviving into the next round escalates to a human.",
    "Commit your fixes locally with a short conventional message. Do not push, do not open a PR, and do not amend commits you did not create in this turn.",
    "If every finding is intent-touching or wrong, make no commit and end your turn; a no-commit turn escalates to a human instead of looping.",
  ].join(" ");
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

export function persistCoderThreadArtifact(input: {
  runDir: string;
  worktree: string;
  jsonlPath: string;
}): CoderThreadArtifact {
  const jsonlPath = validatedGnhfJsonlPath(input.worktree, input.jsonlPath);
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

function validatedGnhfJsonlPath(worktree: string, inputPath: string): string {
  const resolvedWorktree = resolve(worktree);
  const runsDir = resolve(resolvedWorktree, ".gnhf", "runs");
  const jsonlPath = resolve(resolvedWorktree, inputPath);
  const withinRuns = relative(runsDir, jsonlPath);
  if (
    withinRuns === "" ||
    withinRuns === ".." ||
    withinRuns.startsWith(`..${sep}`) ||
    isAbsolute(withinRuns)
  ) {
    throw new Error(`gnhf JSONL path must be inside ${runsDir}: ${inputPath}`);
  }
  if (!existsSync(jsonlPath)) {
    throw new Error(`No gnhf JSONL found at ${jsonlPath}`);
  }
  return jsonlPath;
}
// -/ 3/3
