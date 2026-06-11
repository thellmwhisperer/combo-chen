/**
 * The judge adapter: renders the configured gordon command with the PR facts
 * and the frozen review contract. The loop mechanics will live in the
 * orchestrator; this module owns what a judge session is told to do.
 */
import type { ComboRecord } from "../core/state.js";
import { renderCommand } from "../infra/config.js";

export interface JudgePromptInput {
  combo: ComboRecord;
  prUrl: string;
  protocol: string;
}

export function defaultJudgePrompt(input: JudgePromptInput): string {
  return [
    `Review PR ${input.prUrl} for combo ${input.combo.id}.`,
    `Use this review protocol: ${input.protocol}.`,
    "Hard rules: judge != rower; never write code, push commits, merge, or deploy.",
    "All GitHub writes must be COMMENT reviews or issue comments; never APPROVE or submit formal approvals.",
    'Pin every verdict to the current PR head SHA as "lgtm @ <sha>" only when that HEAD is acceptable.',
    "On a new push, treat any earlier LGTM as stale and re-review only the delta since the last reviewed SHA.",
    "If anything is intent-touching, emit needs_human instead of deciding product intent.",
  ].join(" ");
}

export interface IncrementalJudgePromptInput extends JudgePromptInput {
  oldSha: string;
  newSha: string;
}

export function incrementalJudgePrompt(input: IncrementalJudgePromptInput): string {
  return [
    defaultJudgePrompt(input),
    `Previous LGTM at ${input.oldSha} is stale because the PR head is now ${input.newSha}.`,
    `Review only the incremental delta ${input.oldSha}..${input.newSha}.`,
    `If the new head is acceptable, pin the verdict exactly as "lgtm @ ${input.newSha}".`,
  ].join(" ");
}

export interface JudgeInput extends JudgePromptInput {
  judgeCommand: string;
  prompt?: string;
}

export function buildJudgeInvocation(input: JudgeInput): string {
  const prompt = input.prompt ?? defaultJudgePrompt(input);
  return renderCommand(input.judgeCommand, {
    issue_url: input.combo.issueUrl,
    pr_url: input.prUrl,
    worktree: input.combo.worktree,
    repo: input.combo.repoDir,
    branch: input.combo.branch,
    protocol: input.protocol,
    prompt,
  });
}
