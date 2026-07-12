/**
 * @overview Director adapter: renders the persistent promptable director
 *   command used as the code-2 verdict target. ~55 lines, 4 exports.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at defaultDirectorPrompt  <- persistent director window contract.
 *   2. Then buildDirectorInvocation   <- command template rendering.
 *
 *   MAIN FLOW
 *   ---------
 *   cli launch/activate -> buildDirectorInvocation -> tmux director window
 *
 * @exports DirectorPromptInput, DirectorInput, defaultDirectorPrompt, buildDirectorInvocation
 * @deps ../core/state, ../infra/config
 */
import type { ComboRecord } from "../core/state.js";
import { renderCommand } from "../infra/config.js";

// -- 1/1 CORE · Director prompt + invocation <- START HERE --
export interface DirectorPromptInput {
  combo: ComboRecord;
}

export function defaultDirectorPrompt(input: DirectorPromptInput): string {
  return [
    `Combo director for ${input.combo.id}.`,
    `Branch: ${input.combo.branch}.`,
    `Worktree: ${input.combo.worktree}.`,
    "Stay in this tmux window as the promptable director.",
    "The in-process supervisor in the capsule pane owns deterministic observation; do not run a watch loop here.",
    "When routed prompts arrive, reply with the next concrete action.",
    "If the decision touches user intent, answer needs_human with the exact decision needed.",
    "Do not edit code, push commits, merge, approve, or deploy.",
    "Do not review or answer review threads, post comments, or perform other GitHub writes; route those actions to the reviewer or gatekeeper.",
  ].join(" ");
}

export interface DirectorInput extends DirectorPromptInput {
  directorCommand: string;
  prompt?: string;
}

export function buildDirectorInvocation(input: DirectorInput): string {
  const prompt = input.prompt ?? defaultDirectorPrompt(input);
  return renderCommand(input.directorCommand, {
    issue_url: input.combo.issueUrl,
    worktree: input.combo.worktree,
    repo: input.combo.repoDir,
    branch: input.combo.branch,
    prompt,
  });
}
// -/ 1/1
