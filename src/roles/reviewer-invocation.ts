/**
 * @overview Reviewer adapter: renders the configured reviewer command with
 *   changeset facts plus the frozen review and anti-slop contract. The loop
 *   mechanics live in the orchestrator; this module owns the reviewer
 *   instructions. v0 reviews an open PR and posts to GitHub; the v1 local
 *   pre-publish prompt reviews the local changeset and writes the verdict
 *   artifact instead. ~280 lines, 13 exports.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at buildReviewerInvocation  ← v0 entry: renders the PR command
 *   2. assertReviewerCommandSafe         ← prevents prompt-stalling shells
 *   3. defaultReviewerPrompt             ← the frozen v0 review contract
 *   4. localReviewerPrompt               ← v1 verdict-file review contract
 *   5. buildLocalReviewerInvocation      ← v1 entry used by the capsule
 *
 *   MAIN FLOW
 *   ─────────
 *   v0: cli/main.ts → buildReviewerInvocation → defaultReviewerPrompt
 *     → renderCommand → executed in reviewer tmux window
 *   v1: capsule → buildLocalReviewerInvocation → localReviewerPrompt
 *     → renderCommand → owned reviewer child in the capsule pane
 *
 *   ┌─ PUBLIC API ─────────────────────────────────────────────────────┐
 *   │ buildReviewerInvocation   Render v0 reviewer command from template │
 *   │ assertReviewerCommandSafe Reject compound reviewer shell commands │
 *   │ defaultReviewerPrompt     v0 review + anti-slop prompt            │
 *   │ incrementalReviewerPrompt v0 delta-only re-review prompt          │
 *   │ localReviewerPrompt       v1 verdict-file review prompt           │
 *   │ buildLocalReviewerInvocation v1 reviewer command for the capsule  │
 *   │ LOCAL_REVIEW_PROMPT_VERSION  Versioned in-repo prompt template    │
 *   │ CRITICAL_SURFACES         Minimum-code-1 calibration list         │
 *   │ ReviewerInvocationError   Reviewer command safety error           │
 *   │ ReviewerPromptInput / ReviewerInput / IncrementalReviewerPromptInput │
 *   │ LocalReviewPromptInput / LocalReviewerInput                       │
 *   ├─ INTERNALS ──────────────────────────────────────────────────────┤
 *   │ hasUnsupportedShellSyntax  Conservative plain-command lexer      │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * @exports ReviewerInvocationError, ReviewerPromptInput, defaultReviewerPrompt, IncrementalReviewerPromptInput, incrementalReviewerPrompt, ReviewerInput, assertReviewerCommandSafe, buildReviewerInvocation, LOCAL_REVIEW_PROMPT_VERSION, CRITICAL_SURFACES, LocalReviewPromptInput, localReviewerPrompt, LocalReviewerInput, buildLocalReviewerInvocation
 * @deps ../core/{state,verdict,work-plan}, ../infra/config
 */
import type { ComboRecord } from "../core/state.js";
import { LOCAL_REVIEW_CHECKLIST, verdictFilePath, type ProducingIdentity } from "../core/verdict.js";
import { renderWorkPlanMarkdown, type WorkPlan } from "../core/work-plan.js";
import { renderCommand } from "../infra/config.js";

// -- 1/1 CORE · Prompt definitions + invocation ← START HERE --
export class ReviewerInvocationError extends Error {}

export interface ReviewerPromptInput {
  combo: ComboRecord;
  prUrl: string;
  reviewerInstructions: string;
  workPlan?: WorkPlan;
}

function hasUnsupportedShellSyntax(command: string): boolean {
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i]!;
    if (c === "\n" || c === "\r") return true;
    if (quote === "'") {
      if (c === "'") quote = undefined;
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= command.length) return true;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (c === '"') {
        quote = undefined;
        continue;
      }
      if (c === "`" || (c === "$" && (command[i + 1] === "(" || command[i + 1] === "{"))) return true;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === ";" || c === "|" || c === "<" || c === ">" || c === "&") return true;
    if (c === "(" || c === ")" || c === "`") return true;
    if (c === "$" && (command[i + 1] === "(" || command[i + 1] === "{")) return true;
    if (c === "#" && (i === 0 || /\s/.test(command[i - 1]!))) return true;
  }
  return quote !== undefined;
}

export function assertReviewerCommandSafe(command: string): void {
  if (!hasUnsupportedShellSyntax(command)) return;
  throw new ReviewerInvocationError(
    "reviewer command must be one plain command; shell compounds stall on permission prompts",
  );
}

export function defaultReviewerPrompt(input: ReviewerPromptInput): string {
  const reviewerInstructions = input.reviewerInstructions.trim();
  const workPlanContext =
    input.workPlan === undefined
      ? undefined
      : `Work plan context:\n${renderWorkPlanMarkdown(input.workPlan).trim()}`;
  return [
    `Review PR ${input.prUrl} for combo ${input.combo.id}.`,
    ...(reviewerInstructions.length > 0 ? [`Reviewer instructions: ${reviewerInstructions}.`] : []),
    ...(workPlanContext === undefined ? [] : [workPlanContext]),
    "Hard rules: reviewer != coder; never write code, push commits, merge, or deploy.",
    "All GitHub writes must be COMMENT reviews or issue comments; never APPROVE or submit formal approvals.",
    "Every review body must include exactly one machine-readable verdict block:",
    "combo-chen-reviewer-verdict:\nhead: <current PR head SHA>\ncode: <0|1|2|3>",
    "Verdict codes: 0 = OK, current-head LGTM; 1 = mechanical fix required; 2 = ambiguous or intent-sensitive; 3 = needs human.",
    'Pin every acceptable verdict on its own line as "lgtm @ <sha>" using at least seven hex characters; prefer the full current PR head SHA.',
    "On a new push, treat any earlier LGTM as stale and re-review only the delta since the last reviewed SHA.",
    "If anything is intent-touching, emit needs_human instead of deciding product intent.",
    "Anti-slop checks: if a helper was added, verify pnpm surface or an equivalent repo search was consulted and route code 1 when an equivalent helper already exists.",
    "Route code 1 for new config without who/when/why in the PR, any compatibility path without a removal issue or date, and script-string assertions that should be contract tests.",
    "Treat many new top-level functions or exports in one module as a surface budget breach unless the PR justifies the shape.",
    'Submit reviews with one allowlist-friendly command: gh pr review <pr-url> --comment --body "<body>".',
    "Do not use heredocs, temp files, cat, rm, shell redirection, pipes, semicolons, or &&/||.",
    "Run one plain command per tool call; if a command fails, inspect that single failure and continue with the next plain command.",
  ].join(" ");
}

export interface IncrementalReviewerPromptInput extends ReviewerPromptInput {
  oldSha: string;
  newSha: string;
}

export function incrementalReviewerPrompt(input: IncrementalReviewerPromptInput): string {
  return [
    defaultReviewerPrompt(input),
    `Previous LGTM at ${input.oldSha} is stale because the PR head is now ${input.newSha}.`,
    `Review only the incremental delta ${input.oldSha}..${input.newSha}.`,
    `If the new head is acceptable, pin the verdict exactly as "lgtm @ ${input.newSha}".`,
  ].join(" ");
}

export interface ReviewerInput extends ReviewerPromptInput {
  reviewerCommand: string;
  prompt?: string;
}

export function buildReviewerInvocation(input: ReviewerInput): string {
  assertReviewerCommandSafe(input.reviewerCommand);
  const prompt = input.prompt ?? defaultReviewerPrompt(input);
  return renderCommand(input.reviewerCommand, {
    issue_url: input.combo.issueUrl,
    pr_url: input.prUrl,
    worktree: input.combo.worktree,
    repo: input.combo.repoDir,
    branch: input.combo.branch,
    prompt,
  });
}
// -/ 1/2

// -- 2/2 CORE · v1 local pre-publish review prompt (PRD s3) --
/**
 * Versioned in-repo review template (recon 4.2 item 4): bump on any
 * calibration or contract change so run transcripts identify the prompt
 * revision that produced a verdict.
 */
export const LOCAL_REVIEW_PROMPT_VERSION = 1;

/**
 * PRD s3 calibration contract: any finding on one of these surfaces is
 * minimum code 1, even if pre-existing.
 */
export const CRITICAL_SURFACES = [
  { id: "journal integrity", description: "append-only journal.jsonl writes and the event schema" },
  { id: "coder_done trust signals", description: "evidence used to trust coder completion" },
  { id: "role boundaries", description: "no role gains publishing, merging, or another role's authority" },
  { id: "publishing", description: "pushes, PR creation, and anything else that leaves the machine" },
] as const satisfies ReadonlyArray<{ id: string; description: string }>;

export interface LocalReviewPromptInput {
  combo: ComboRecord;
  runDir: string;
  round: number;
  sha: string;
  baseRef: string;
  reviewerInstructions: string;
  identity?: ProducingIdentity;
  workPlan?: WorkPlan;
}

export function localReviewerPrompt(input: LocalReviewPromptInput): string {
  const reviewerInstructions = input.reviewerInstructions.trim();
  const workPlanContext =
    input.workPlan === undefined
      ? undefined
      : `Work plan context:\n${renderWorkPlanMarkdown(input.workPlan).trim()}`;
  const verdictPath = verdictFilePath(input.runDir, input.round);
  const identityHint =
    input.identity === undefined
      ? "declaring the model and runtime that produced this review"
      : `declaring the model and runtime that produced this review (expected: model ${input.identity.model}, runtime ${input.identity.runtime})`;
  const surfaces = CRITICAL_SURFACES.map((surface) => `${surface.id} (${surface.description})`).join("; ");
  const checklist = LOCAL_REVIEW_CHECKLIST.map((item) => `${item.id} (${item.requirement})`).join("; ");
  return [
    `Local pre-publish review (prompt v${LOCAL_REVIEW_PROMPT_VERSION}), round ${input.round}, for combo ${input.combo.id}.`,
    `Review the local changeset ${input.baseRef}..HEAD at sha ${input.sha} in worktree ${input.combo.worktree}. There is no PR yet.`,
    ...(reviewerInstructions.length > 0 ? [`Reviewer instructions: ${reviewerInstructions}.`] : []),
    ...(workPlanContext === undefined ? [] : [workPlanContext]),
    "Hard rules: reviewer != coder; never write code, commit, push, merge, or deploy.",
    "Do not write to GitHub at all: no comments, no reviews, no approvals. Your only output is the verdict artifact below.",
    `Write exactly one verdict artifact: first write ${verdictPath}.tmp, then rename it to ${verdictPath} in one mv. Never write the final path directly; the rename is the completeness signal the harness waits for.`,
    `The verdict JSON must contain: schemaVersion 1; round ${input.round}; code 0|1|2|3; reviewed {"sha": "${input.sha}"} pinning the full reviewed sha; identity {"model", "runtime"} ${identityHint}; findings; followUps; checklist; and optional attackTable and notVerified blocks.`,
    "Each finding: id (a stable kebab-case slug you assign; carry the exact same id for the same finding in later rounds even when line numbers move), severity blocker|major|minor|note, file, optional line, title, body, optional criticalSurface.",
    "Verdict codes: 0 = OK, changeset LGTM; 1 = mechanical fix required; 2 = ambiguous or intent-sensitive; 3 = needs human.",
    `Critical surfaces of this repo: ${surfaces}.`,
    "Any finding touching a critical surface is minimum code 1, even if pre-existing and even if the happy path avoids it; set that finding's criticalSurface field.",
    "Real-but-deferable findings go in the followUps block as {title, body?, findingId?}; prose is never the only home of a finding.",
    `The checklist must contain every one of these ids with status pass, fail, or n_a plus a note for fail or n_a: ${checklist}.`,
    "A verdict missing any checklist id is malformed and will not be routed; you will be re-prompted.",
    "Record the attacks you attempted as attackTable rows {attack, result clean|finding|not_verified, findingId?, note?} and anything you could not verify in notVerified; reference findings by id, never restate them.",
    "Anti-slop checks: if a helper was added, verify pnpm surface or an equivalent repo search was consulted and route code 1 when an equivalent helper already exists.",
    "Route code 1 for new config without who/when/why in the changeset, any compatibility path without a removal issue or date, and script-string assertions that should be contract tests.",
    "Treat many new top-level functions or exports in one module as a surface budget breach unless the changeset justifies the shape.",
    "If anything is intent-touching, use code 2 or 3 instead of deciding product intent.",
  ].join(" ");
}

export interface LocalReviewerInput extends LocalReviewPromptInput {
  reviewerCommand: string;
}

export function buildLocalReviewerInvocation(input: LocalReviewerInput): string {
  assertReviewerCommandSafe(input.reviewerCommand);
  return renderCommand(input.reviewerCommand, {
    issue_url: input.combo.issueUrl,
    worktree: input.combo.worktree,
    repo: input.combo.repoDir,
    branch: input.combo.branch,
    run_dir: input.runDir,
    prompt: localReviewerPrompt(input),
  });
}
// -/ 2/2
