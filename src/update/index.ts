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
 *   ReleaseMetadata, releaseMetadata, formatReleaseMetadata Release build identity and rendering.
 *   RELEASE_CHECKSUMS_FILE, RELEASE_TARGETS    Release artifact constants.
 *   ReleaseTarget, ReleaseArchiveEntry, ReleaseChecksum Release artifact data contracts.
 *   releaseAssetFileName, releaseAssetFileNames Release archive naming helpers.
 *   releaseArchiveRoot, releaseArchiveEntries  Release archive layout helpers.
 *   formatChecksums                            Release checksum renderer.
 *   produceReleaseAssets                       Reproducible release asset producer.
 *   ProduceReleaseAssetsOptions, ProducedReleaseAsset, ProduceReleaseAssetsResult Producer contracts.
 *   runReleaseAssetsCommand                    Runnable release-assets command.
 *   RunReleaseAssetsCommandOptions             Release command options contract.
 *   PASSIVE_UPDATE_CACHE_FILE                  Shared test fixture constant.
 *   PASSIVE_UPDATE_DISABLE_ENV                 Passive-check process policy constant.
 *   refreshPostUpdateLocalState                Shared test harness refresh seam.
 *   classifyInstallTarget                     Install-channel integration seam.
 *
 *   INTERNALS
 *   ---------
 *   All implementation modules re-exported below remain private to src/update.
 *
 * @exports runSelfUpdate, checkForPassiveUpdate, UpdateCommandDeps, PassiveUpdateCliDeps, defaultUpdateCommandDeps, runUpdateCommand, ReleaseMetadata, releaseMetadata, formatReleaseMetadata, RELEASE_CHECKSUMS_FILE, RELEASE_TARGETS, ReleaseTarget, ReleaseArchiveEntry, ReleaseChecksum, releaseAssetFileName, releaseAssetFileNames, releaseArchiveRoot, releaseArchiveEntries, formatChecksums, ProduceReleaseAssetsOptions, ProducedReleaseAsset, ProduceReleaseAssetsResult, produceReleaseAssets, RunReleaseAssetsCommandOptions, runReleaseAssetsCommand, PASSIVE_UPDATE_CACHE_FILE, PASSIVE_UPDATE_DISABLE_ENV, refreshPostUpdateLocalState, classifyInstallTarget
 * @deps ./command, ./handler, ./passive, ./passive-handler, ./passive-update, ./refresh, ./release-artifacts, ./release-command, ./release-metadata, ./release-producer, ./update-contract
 */

// -- 1/1 CORE · declared update entry point <- START HERE --
export { defaultUpdateCommandDeps, runUpdateCommand, type UpdateCommandDeps } from "./command.js";
export { runSelfUpdate } from "./handler.js";
export { PASSIVE_UPDATE_CACHE_FILE, type PassiveUpdateCliDeps } from "./passive.js";
export { checkForPassiveUpdate } from "./passive-handler.js";
export { refreshPostUpdateLocalState } from "./refresh.js";
export {
  RELEASE_CHECKSUMS_FILE,
  RELEASE_TARGETS,
  formatChecksums,
  releaseArchiveEntries,
  releaseArchiveRoot,
  releaseAssetFileName,
  releaseAssetFileNames,
  type ReleaseArchiveEntry,
  type ReleaseChecksum,
  type ReleaseTarget,
} from "./release-artifacts.js";
export { runReleaseAssetsCommand, type RunReleaseAssetsCommandOptions } from "./release-command.js";
export { formatReleaseMetadata, releaseMetadata, type ReleaseMetadata } from "./release-metadata.js";
export {
  produceReleaseAssets,
  type ProduceReleaseAssetsOptions,
  type ProducedReleaseAsset,
  type ProduceReleaseAssetsResult,
} from "./release-producer.js";
export { PASSIVE_UPDATE_DISABLE_ENV } from "./passive-update.js";
export { classifyInstallTarget } from "./update-contract.js";
// -/ 1/1
