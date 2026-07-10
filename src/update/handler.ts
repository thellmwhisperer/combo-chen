/**
 * @overview Application handler for the active self-update command.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at runSelfUpdate         <- composes injected update dependencies and executes.
 *
 *   MAIN FLOW
 *   ---------
 *   CLI flags -> update dependency composition -> runUpdateCommand -> result
 *
 *   PUBLIC API
 *   ----------
 *   runSelfUpdate    Execute stable or beta self-update with confirmation policy.
 *
 *   INTERNALS
 *   ---------
 *   None.
 *
 * @exports runSelfUpdate
 * @deps ../app/deps, ./command
 */
import type { AppDeps } from "../app/deps.js";
import { defaultUpdateCommandDeps, runUpdateCommand, type UpdateCommandDeps } from "./command.js";

// -- 1/1 CORE · runSelfUpdate <- START HERE --
export async function runSelfUpdate(
  deps: Pick<AppDeps, "env" | "gh" | "out" | "update">,
  options: { beta?: boolean; yes?: boolean },
): Promise<void> {
  const updateDeps: UpdateCommandDeps = {
    ...defaultUpdateCommandDeps({ gh: deps.gh, out: deps.out, env: deps.env }),
    ...deps.update,
  };
  await runUpdateCommand({
    beta: options.beta === true,
    yes: options.yes === true,
    deps: updateDeps,
  });
}
// -/ 1/1
