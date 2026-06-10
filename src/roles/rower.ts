/**
 * The rower adapter: turns config + combo facts into the command that rows.
 * v0 ships a gnhf default; anything else is a config template away.
 */
import { renderCommand } from "../infra/config.js";
import type { ComboRecord } from "../core/state.js";

export function defaultPrompt(issueUrl: string): string {
  return (
    `Implement GitHub issue ${issueUrl}. ` +
    `Read it first with: gh issue view ${issueUrl}. ` +
    `Work test-first: red test, minimal code to green, refactor. ` +
    `Stay strictly within the issue's scope.`
  );
}

export interface RowerInput {
  rowerCommand: string;
  combo: ComboRecord;
  prompt?: string;
}

export function buildRowerInvocation(input: RowerInput): string {
  const prompt = input.prompt ?? defaultPrompt(input.combo.issueUrl);
  return renderCommand(input.rowerCommand, {
    issue_url: input.combo.issueUrl,
    worktree: input.combo.worktree,
    repo: input.combo.repoDir,
    branch: input.combo.branch,
    prompt,
  });
}
