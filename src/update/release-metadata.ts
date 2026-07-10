/**
 * @overview Release metadata constants and formatting for inspectable builds.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at releaseMetadata       <- build defines land in this object.
 *   2. Then formatReleaseMetadata     <- the CLI --version rendering contract.
 *   3. Everything else is fallback plumbing for source/test runs.
 *
 *   MAIN FLOW
 *   ---------
 *   tsdown define values -> releaseMetadata -> formatReleaseMetadata -> CLI --version
 *
 *   PUBLIC API
 *   ----------
 *   ReleaseMetadata         Version, commit, and build date carried by releases.
 *   releaseMetadata         Resolved build metadata with source-run fallbacks.
 *   formatReleaseMetadata   Render the human-inspectable version line.
 *
 *   INTERNALS
 *   ---------
 *   buildDefinedString.
 *
 * @exports ReleaseMetadata, releaseMetadata, formatReleaseMetadata
 * @deps tsdown build defines
 */
declare const __COMBO_CHEN_VERSION__: string | undefined;
declare const __COMBO_CHEN_COMMIT__: string | undefined;
declare const __COMBO_CHEN_BUILD_DATE__: string | undefined;

// -- 1/2 HELPER · buildDefinedString --
function buildDefinedString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
// -/ 1/2

// -- 2/2 CORE · releaseMetadata + formatReleaseMetadata <- START HERE --
export interface ReleaseMetadata {
  version: string;
  commit: string;
  date: string;
}

export const releaseMetadata: ReleaseMetadata = {
  version: buildDefinedString(
    typeof __COMBO_CHEN_VERSION__ === "string" ? __COMBO_CHEN_VERSION__ : undefined,
    "0.0.0-dev",
  ),
  commit: buildDefinedString(
    typeof __COMBO_CHEN_COMMIT__ === "string" ? __COMBO_CHEN_COMMIT__ : undefined,
    "unknown",
  ),
  date: buildDefinedString(
    typeof __COMBO_CHEN_BUILD_DATE__ === "string" ? __COMBO_CHEN_BUILD_DATE__ : undefined,
    "unknown",
  ),
};

export function formatReleaseMetadata(metadata: ReleaseMetadata): string {
  return `combo-chen ${metadata.version} (commit ${metadata.commit}, built ${metadata.date})`;
}
// -/ 2/2
