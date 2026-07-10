/**
 * @overview Application handlers for director, reviewer, and resumed-coder control endpoints.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at watchDirector        <- owns the bounded or persistent tick loop.
 *   2. Read the remaining handlers   <- one-shot role activations and prompts.
 *
 *   MAIN FLOW
 *   ---------
 *   CLI options -> role handler -> persisted combo -> tmux/director effect
 *
 *   PUBLIC API
 *   ----------
 *   activateComboReviewer, tickComboReviewer, sendDirectorPrompt, tickComboDirector,
 *   watchDirector, activateComboCoder, nudgeComboReviewComments
 *
 *   INTERNALS
 *   ---------
 *   None.
 *
 * @exports activateComboReviewer, tickComboReviewer, sendDirectorPrompt, tickComboDirector, watchDirector, activateComboCoder, nudgeComboReviewComments
 * @deps ../../core/state, ../../infra/config-snapshot, ../deps, ./coder, ./director, ./prompt, ./reviewer
 */
import { comboHome, readCombo, runDirFor } from "../../core/state.js";
import { loadRuntimeConfig } from "../../infra/config-snapshot.js";
import { activateCoder, nudgeReviewComments } from "./coder.js";
import { tickDirector } from "./director.js";
import { promptDirector } from "./prompt.js";
import { activateReviewer, tickReviewer } from "./reviewer.js";
import type { AppDeps } from "../deps.js";

// -- 1/2 CORE · watchDirector <- START HERE --
export async function watchDirector(
  deps: AppDeps,
  options: { name: string; iterations?: string },
  cli: string,
): Promise<void> {
  const home = comboHome(deps.env);
  const runDir = runDirFor(home, options.name);
  const combo = readCombo(runDir);
  const config = loadRuntimeConfig(runDir, { repoDir: combo.repoDir, env: deps.env });
  const maxTicks = options.iterations === undefined ? undefined : Number(options.iterations);
  if (maxTicks !== undefined && (!Number.isInteger(maxTicks) || maxTicks <= 0)) {
    throw new Error("--iterations must be a positive integer");
  }

  let ticks = 0;
  while (maxTicks === undefined || ticks < maxTicks) {
    await tickDirector({
      deps,
      home,
      comboId: options.name,
      cli,
    });
    ticks += 1;
    if (maxTicks !== undefined && ticks >= maxTicks) break;
    await deps.sleep(config.limits.babysitPollSeconds * 1000);
  }
}
// -/ 1/2

// -- 2/2 HELPER · One-shot role handlers --
export function activateComboReviewer(deps: AppDeps, comboId: string, cli: string): void {
  activateReviewer({
    deps,
    home: comboHome(deps.env),
    comboId,
    cli,
  });
}

export async function tickComboReviewer(deps: AppDeps, comboId: string): Promise<void> {
  await tickReviewer({
    deps,
    home: comboHome(deps.env),
    comboId,
  });
}

export function sendDirectorPrompt(
  deps: AppDeps,
  input: { name: string; reason: string; message: string },
): void {
  promptDirector({
    deps,
    home: comboHome(deps.env),
    comboId: input.name,
    reason: input.reason,
    message: input.message,
  });
}

export async function tickComboDirector(deps: AppDeps, comboId: string, cli: string): Promise<void> {
  await tickDirector({
    deps,
    home: comboHome(deps.env),
    comboId,
    cli,
  });
}

export function activateComboCoder(deps: AppDeps, comboId: string, cli: string): void {
  activateCoder({
    deps,
    home: comboHome(deps.env),
    comboId,
    cli,
  });
}

export function nudgeComboReviewComments(deps: AppDeps, comboId: string): void {
  nudgeReviewComments({
    deps,
    home: comboHome(deps.env),
    comboId,
  });
}
// -/ 2/2
