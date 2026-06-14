/**
 * @overview Reviewer adapter: renders the configured reviewer command with
 *   PR facts and the frozen review contract. The loop mechanics live in the
 *   orchestrator; this module owns what a reviewer session is told to do.
 *   ~57 lines, 6 exports.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at buildReviewerInvocation  ← main entry: renders the command
 *   2. defaultReviewerPrompt             ← the frozen review contract
 *   3. incrementalReviewerPrompt         ← delta-only re-review prompt
 *
 *   MAIN FLOW
 *   ─────────
 *   cli/main.ts → buildReviewerInvocation({combo, prUrl, protocol, reviewerCommand})
 *     → defaultReviewerPrompt / incrementalReviewerPrompt → renderCommand
 *     → executed in reviewer tmux window
 *
 *   ┌─ PUBLIC API ─────────────────────────────────────────────────────┐
 *   │ buildReviewerInvocation   Render reviewer command from template    │
 *   │ defaultReviewerPrompt     Standard review contract prompt         │
 *   │ incrementalReviewerPrompt Delta-only re-review prompt             │
 *   │ ReviewerInput             Shape for buildReviewerInvocation       │
 *   │ ReviewerPromptInput       Shape for defaultReviewerPrompt         │
 *   │ IncrementalReviewerPromptInput Shape for incrementalReviewerPrompt│
 *   ├─ INTERNALS ──────────────────────────────────────────────────────┤
 *   │ (none — all exports are public)                                  │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * @exports ReviewerPromptInput, defaultReviewerPrompt, IncrementalReviewerPromptInput, incrementalReviewerPrompt, ReviewerInput, buildReviewerInvocation
 * @deps ../core/state, ../infra/config
 */
import type { ComboRecord } from "../core/state.js";
import { renderCommand } from "../infra/config.js";

// -- 1/1 CORE · Prompt definitions + invocation ← START HERE --
export interface ReviewerPromptInput {
  combo: ComboRecord;
  prUrl: string;
  protocol: string;
}

export function defaultReviewerPrompt(input: ReviewerPromptInput): string {
  return [
    `Review PR ${input.prUrl} for combo ${input.combo.id}.`,
    `Use this review protocol: ${input.protocol}.`,
    "Hard rules: reviewer != coder; never write code, push commits, merge, or deploy.",
    "All GitHub writes must be COMMENT reviews or issue comments; never APPROVE or submit formal approvals.",
    'Pin every verdict to the current PR head SHA as "lgtm @ <sha>" only when that HEAD is acceptable.',
    "On a new push, treat any earlier LGTM as stale and re-review only the delta since the last reviewed SHA.",
    "If anything is intent-touching, emit needs_human instead of deciding product intent.",
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
  const prompt = input.prompt ?? defaultReviewerPrompt(input);
  return renderCommand(input.reviewerCommand, {
    issue_url: input.combo.issueUrl,
    pr_url: input.prUrl,
    worktree: input.combo.worktree,
    repo: input.combo.repoDir,
    branch: input.combo.branch,
    protocol: input.protocol,
    prompt,
  });
}
// -/ 1/1
