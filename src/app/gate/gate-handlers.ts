/**
 * @overview Application handlers for gate lease control and deterministic gate restart.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at restartGate          <- selects initial or post-address gate.
 *   2. Then handleGateLease          <- hidden runner-facing lease endpoint.
 *
 *   MAIN FLOW
 *   ---------
 *   CLI options -> persisted combo -> gate operation -> operator output
 *
 *   PUBLIC API
 *   ----------
 *   restartGate         Restart the correct gate for current PR state.
 *   handleGateLease     Acquire or release a branch-scoped gate lease.
 *
 *   INTERNALS
 *   ---------
 *   None.
 *
 * @exports restartGate, handleGateLease
 * @deps ../../core/events, ../../core/state, ../deps, ../runtime/sessions, ./gate, ./lease
 */
import { comboHome, readCombo, runDirFor } from "../../core/state.js";
import { acquireGateLeaseForCombo, releaseGateLeaseForCombo } from "./lease.js";
import { ensureComboSession } from "../runtime/sessions.js";
import type { AppDeps } from "../deps.js";

// -- 1/2 CORE · restartGate <- START HERE --
export function restartGate(deps: AppDeps, comboId: string, cli: string): void {
  const home = comboHome(deps.env);
  const runDir = runDirFor(home, comboId);
  const combo = readCombo(runDir);
  ensureComboSession({ deps, combo, home, cli });
  deps.out("gate-restart: " + comboId + " — gate restart not available in this version");
}
// -/ 1/2

// -- 2/2 CORE · handleGateLease --
export function handleGateLease(
  deps: Pick<AppDeps, "env" | "out">,
  action: string,
  options: { name: string; headSha?: string },
): void {
  const home = comboHome(deps.env);
  if (action !== "acquire" && action !== "release") {
    throw new Error("gate-lease action must be acquire or release");
  }
  const result =
    action === "acquire"
      ? acquireGateLeaseForCombo({
          home,
          comboId: options.name,
          headSha: options.headSha,
          out: deps.out,
        })
      : releaseGateLeaseForCombo({
          home,
          comboId: options.name,
          out: deps.out,
        });
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}
// -/ 2/2
