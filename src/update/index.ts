/**
 * @overview Declared public entry point for the self-update subsystem.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start with the handler exports <- production CLI command wiring.
 *   2. Use supporting exports         <- dependency contracts and integration-test seams.
 *
 *   MAIN FLOW
 *   ---------
 *   outside caller -> update/index -> owned update implementation
 *
 *   PUBLIC API
 *   ----------
 *   runSelfUpdate, checkForPassiveUpdate       CLI handler entry points.
 *   UpdateCommandDeps, PassiveUpdateCliDeps    Injectable application contracts.
 *   defaultUpdateCommandDeps, runUpdateCommand Update integration-test seam.
 *   PASSIVE_UPDATE_CACHE_FILE                  Shared test fixture constant.
 *   PASSIVE_UPDATE_DISABLE_ENV                 Passive-check process policy constant.
 *   refreshPostUpdateLocalState                Shared test harness refresh seam.
 *   classifyInstallTarget                     Install-channel integration seam.
 *
 *   INTERNALS
 *   ---------
 *   All implementation modules re-exported below remain private to src/update.
 *
 * @exports runSelfUpdate, checkForPassiveUpdate, UpdateCommandDeps, PassiveUpdateCliDeps, defaultUpdateCommandDeps, runUpdateCommand, PASSIVE_UPDATE_CACHE_FILE, PASSIVE_UPDATE_DISABLE_ENV, refreshPostUpdateLocalState, classifyInstallTarget
 * @deps ./command, ./handler, ./passive, ./passive-handler, ./refresh, ../core/passive-update, ../core/update-contract
 */

// -- 1/1 CORE · declared update entry point <- START HERE --
export { defaultUpdateCommandDeps, runUpdateCommand, type UpdateCommandDeps } from "./command.js";
export { runSelfUpdate } from "./handler.js";
export { PASSIVE_UPDATE_CACHE_FILE, type PassiveUpdateCliDeps } from "./passive.js";
export { checkForPassiveUpdate } from "./passive-handler.js";
export { refreshPostUpdateLocalState } from "./refresh.js";
export { PASSIVE_UPDATE_DISABLE_ENV } from "../core/passive-update.js";
export { classifyInstallTarget } from "../core/update-contract.js";
// -/ 1/1
