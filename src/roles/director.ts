/**
 * @overview Director adapter: renders the interactive director command with
 *   the frozen "promptable but non-polling" capsule contract.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at buildDirectorInvocation <- command the director window runs.
 *   2. Then defaultDirectorPrompt       <- launch-time director contract.
 *   3. Types are support                <- prompt/invocation inputs.
 *
 *   MAIN FLOW
 *   ---------
 *   cli/main.ts -> buildDirectorInvocation -> renderCommand -> tmux director window
 *
 *   PUBLIC API
 *   ----------
 *   DirectorPromptInput    Facts needed to render the launch contract.
 *   defaultDirectorPrompt  Standard promptable director contract.
 *   DirectorInput          Shape for buildDirectorInvocation.
 *   buildDirectorInvocation Render director command from template.
 *
 *   INTERNALS
 *   ---------
 *   none
 *
 * @exports DirectorPromptInput, defaultDirectorPrompt, DirectorInput, buildDirectorInvocation
 * @deps ../core/{state,work-plan}, ../infra/config
 */
import { describeWorkItem, type ComboRecord } from "../core/state.js";
import { renderWorkPlanMarkdown, type WorkPlan } from "../core/work-plan.js";
import { renderCommand } from "../infra/config.js";

// -- 1/1 CORE · Director contract + invocation <- START HERE --
export interface DirectorPromptInput {
  combo: ComboRecord;
  workPlan?: WorkPlan;
}

export function defaultDirectorPrompt(input: DirectorPromptInput): string {
  const workItem = describeWorkItem(input.combo);
  const workPlanContext = input.workPlan === undefined
    ? undefined
    : `Work plan context:\n${renderWorkPlanMarkdown(input.workPlan).trim()}`;
  return [
    "Combo director contract",
    "",
    `Combo: ${input.combo.id}`,
    `Branch: ${input.combo.branch}`,
    `Worktree: ${input.combo.worktree}`,
    `Work item: ${workItem.label}`,
    "",
    "You are the promptable director inside this combo capsule.",
    "Do not poll. The deterministic director-watch script polls hard signals and prompts you only for ambiguity, malformed signals, intent-touching decisions, or uncoded recovery.",
    "Wait for prompts pasted into this tmux window. Reply with the next concrete action.",
    "If the action touches user intent, answer needs_human with the exact decision needed.",
    "Do not edit code, answer review threads, approve PRs, push, merge, or deploy.",
    "Keep role boundaries intact: reviewer != coder.",
    ...(workPlanContext === undefined ? [] : ["", workPlanContext]),
  ].join("\n");
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
