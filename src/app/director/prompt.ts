/**
 * @overview Director prompt application service. ~170 lines, 6 exports, deterministic
 *   prompt rendering plus tmux paste-buffer delivery and journaling.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at promptDirector       <- reviewer/director routing entry point.
 *   2. Then buildDirectorPrompt      <- exact prompt text sent to the director.
 *   3. Then sendPromptToTarget       <- tmux window check + paste-buffer calls.
 *   4. Helpers are target/preview    <- small deterministic formatters.
 *
 *   MAIN FLOW
 *   ---------
 *   reviewer signal -> promptDirector -> buildDirectorPrompt -> director_prompted event -> sendPromptToTarget
 *
 *   PUBLIC API
 *   ----------
 *   PromptTarget          Stable tmux destination shape.
 *   DirectorPromptDeps    Output and tmux dependencies for promptDirector.
 *   buildDirectorPrompt   Render the deterministic director intervention prompt.
 *   directorPromptTarget  Convert a combo + window name into a tmux target.
 *   sendPromptToTarget    Verify target window and paste prompt into tmux.
 *   promptDirector        Read combo state, send prompt, and journal event.
 *
 *   INTERNALS
 *   ---------
 *   requiredText, promptSha, promptPreview
 *
 * @exports PromptTarget, DirectorPromptDeps, buildDirectorPrompt, directorPromptTarget, sendPromptToTarget, promptDirector
 * @deps ../../core/combo, ../../core/events, ../../core/runtime-ledger, ../../core/state, ../../infra/tmux, ../runtime/sessions, node:crypto
 */
import { createHash } from "node:crypto";

import { deriveStatus } from "../../core/combo.js";
import { appendEvent, readEvents } from "../../core/events.js";
import { readRuntimeLedger } from "../../core/runtime-ledger.js";
import { describeWorkItem, readCombo, runDirFor, type ComboRecord } from "../../core/state.js";
import { listWindowsArgs, nudgeWindowArgs, type TmuxResult } from "../../infra/tmux.js";
import { DIRECTOR_WINDOW, windowSet } from "../runtime/sessions.js";

// -- 1/3 HELPER · Types and deterministic prompt text --
export interface PromptTarget {
  name: string;
  tmuxSession: string;
  windowName: string;
  tmuxTarget: string;
}

export interface DirectorPromptDeps {
  out: (line: string) => void;
  tmux: (args: string[]) => TmuxResult;
}

export function buildDirectorPrompt(input: {
  combo: ComboRecord;
  reason: string;
  message: string;
  phase: string;
}): string {
  const reason = requiredText("reason", input.reason);
  const message = requiredText("message", input.message);
  return [
    "Combo director intervention request",
    "",
    `Combo: ${input.combo.id}`,
    `Branch: ${input.combo.branch}`,
    `Worktree: ${input.combo.worktree}`,
    `Work item: ${describeWorkItem(input.combo).label}`,
    `Current phase: ${requiredText("phase", input.phase)}`,
    `Reason: ${reason}`,
    "",
    "Request:",
    message,
    "",
    "Reply with the next concrete action. If this touches user intent, answer needs_human with the decision needed.",
  ].join("\n");
}

function requiredText(field: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new Error(`director prompt ${field} must not be empty`);
  return trimmed;
}
// -/ 1/3

// -- 2/3 CORE · prompt target + tmux delivery <- START HERE --
export function directorPromptTarget(
  combo: Pick<ComboRecord, "tmuxSession">,
  windowName = DIRECTOR_WINDOW,
): PromptTarget {
  return {
    name: "director",
    tmuxSession: combo.tmuxSession,
    windowName,
    tmuxTarget: `${combo.tmuxSession}:${windowName}`,
  };
}

export function sendPromptToTarget(input: {
  target: PromptTarget;
  prompt: string;
  tmux: (args: string[]) => TmuxResult;
}): void {
  const listed = input.tmux(listWindowsArgs(input.target.tmuxSession));
  if (listed.status !== 0) {
    throw new Error(
      `tmux failed to list windows in "${input.target.tmuxSession}": ` +
        `${listed.stderr.trim() || "unknown error"}`,
    );
  }
  if (!windowSet(listed.stdout).has(input.target.windowName)) {
    throw new Error(`director prompt target "${input.target.tmuxTarget}" is not present`);
  }

  for (const args of nudgeWindowArgs(input.target.tmuxSession, input.target.windowName, input.prompt)) {
    const result = input.tmux(args);
    if (result.status !== 0) {
      throw new Error(
        `tmux prompt failed for "${input.target.tmuxTarget}": ` +
          `${result.stderr.trim() || "unknown error"}`,
      );
    }
  }
}

// -/ 2/3

// -- 3/3 CORE · promptDirector command integration --
export function promptDirector(input: {
  deps: DirectorPromptDeps;
  home: string;
  comboId: string;
  reason: string;
  message: string;
  sha?: string;
}): void {
  const runDir = runDirFor(input.home, input.comboId);
  const combo = readCombo(runDir);
  const events = readEvents(runDir);
  const status = deriveStatus(events);
  const ledger = readRuntimeLedger(runDir);
  const target = directorPromptTarget(combo, ledger.roleWindows.director ?? DIRECTOR_WINDOW);
  const reason = requiredText("reason", input.reason);
  const prompt = buildDirectorPrompt({
    combo,
    phase: status.phase,
    reason,
    message: input.message,
  });

  sendPromptToTarget({
    target,
    prompt,
    tmux: input.deps.tmux,
  });

  appendEvent(runDir, "director_prompted", {
    reason,
    target: target.tmuxTarget,
    window: target.windowName,
    phase: status.phase,
    prompt_sha: promptSha(prompt),
    prompt_preview: promptPreview(prompt),
    ...(input.sha !== undefined ? { sha: input.sha } : {}),
  });

  input.deps.out(`director-prompt: prompted ${target.tmuxTarget} for ${combo.id} (${reason})`);
}

function promptSha(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

function promptPreview(prompt: string): string {
  const preview = prompt.replace(/\s+/g, " ").trim();
  if (preview.length <= 512) return preview;
  return `${preview.slice(0, 509)}...`;
}
// -/ 3/3
