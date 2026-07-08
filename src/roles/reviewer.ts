/**
 * @overview Reviewer adapter: renders the configured reviewer command with
 *   PR facts plus the frozen review and anti-slop contract. The loop mechanics
 *   live in the orchestrator; this module owns the reviewer instructions.
 *   ~135 lines, 8 exports.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at buildReviewerInvocation  ← main entry: renders the command
 *   2. assertReviewerCommandSafe         ← prevents prompt-stalling shells
 *   3. defaultReviewerPrompt             ← the frozen review contract
 *   4. incrementalReviewerPrompt         ← delta-only re-review prompt
 *
 *   MAIN FLOW
 *   ─────────
 *   cli/main.ts → buildReviewerInvocation({combo, prUrl, reviewerInstructions, reviewerCommand})
 *     → defaultReviewerPrompt / incrementalReviewerPrompt → renderCommand
 *     → executed in reviewer tmux window
 *
 *   ┌─ PUBLIC API ─────────────────────────────────────────────────────┐
 *   │ buildReviewerInvocation   Render reviewer command from template    │
 *   │ assertReviewerCommandSafe Reject compound reviewer shell commands │
 *   │ defaultReviewerPrompt     Standard review + anti-slop prompt      │
 *   │ incrementalReviewerPrompt Delta-only re-review prompt             │
 *   │ ReviewerInvocationError   Reviewer command safety error           │
 *   │ ReviewerInput             Shape for buildReviewerInvocation       │
 *   │ ReviewerPromptInput       Shape for defaultReviewerPrompt         │
 *   │ IncrementalReviewerPromptInput Shape for incrementalReviewerPrompt │
 *   ├─ INTERNALS ──────────────────────────────────────────────────────┤
 *   │ (none — all exports are public)                                  │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * @exports ReviewerInvocationError, ReviewerPromptInput, defaultReviewerPrompt, IncrementalReviewerPromptInput, incrementalReviewerPrompt, ReviewerInput, assertReviewerCommandSafe, buildReviewerInvocation
 * @deps ../core/{state,work-plan}, ../infra/config
 */
import type { ComboRecord } from "../core/state.js";
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

function hasUnquotedShellControl(command: string): boolean {
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i]!;
    if (c === "\\" && quote === '"') {
      i += 1;
      continue;
    }
    if ((c === "'" || c === '"') && quote === undefined) {
      quote = c;
      continue;
    }
    if (quote === c) {
      quote = undefined;
      continue;
    }
    if (quote !== undefined) continue;
    if (c === ";" || c === "|" || c === "<" || c === ">") return true;
    if ((c === "&" && command[i + 1] === "&") || (c === "|" && command[i + 1] === "|")) return true;
  }
  return false;
}

export function assertReviewerCommandSafe(command: string): void {
  if (!hasUnquotedShellControl(command)) return;
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
// -/ 1/1
