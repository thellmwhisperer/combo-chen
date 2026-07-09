/**
 * @overview Application handler for non-blocking passive release checks.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at checkForPassiveUpdate <- filters commands and isolates failures.
 *
 *   MAIN FLOW
 *   ---------
 *   command name -> eligibility -> passive release check -> ignored failure
 *
 *   PUBLIC API
 *   ----------
 *   checkForPassiveUpdate    Run an eligible passive check without affecting the command.
 *
 *   INTERNALS
 *   ---------
 *   None.
 *
 * @exports checkForPassiveUpdate
 * @deps ../app/deps, ../cli/passive-update
 */
import type { AppDeps } from "../app/deps.js";
import {
  defaultPassiveUpdateCommandDeps,
  runPassiveUpdateCheck,
  shouldRunPassiveUpdateForCommand,
} from "../cli/passive-update.js";

// -- 1/1 CORE · checkForPassiveUpdate <- START HERE --
export async function checkForPassiveUpdate(
  deps: Pick<AppDeps, "env" | "gh" | "passiveUpdate">,
  commandName: string,
): Promise<void> {
  if (!shouldRunPassiveUpdateForCommand(commandName)) return;
  try {
    await runPassiveUpdateCheck({
      ...defaultPassiveUpdateCommandDeps({ env: deps.env, gh: deps.gh }),
      ...deps.passiveUpdate,
    });
  } catch {
    // Passive update checks must never affect the command they shadow.
  }
}
// -/ 1/1
