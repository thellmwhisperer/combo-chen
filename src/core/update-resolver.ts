/**
 * @overview Read-only resolver for GitHub Releases update metadata.
 *   ~250 lines, 15 exports, selects the latest eligible release candidate and compares it with current build metadata.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at resolveLatestReleaseCandidate <- resolver mode and candidate selection.
 *   2. Then resolveReadOnlyUpdatePlan         <- read-only candidate/current comparison.
 *   3. Then normalizeCandidate                <- U0 tag normalization bridge.
 *   4. Then compareNormalizedCandidates       <- semver ordering for mocked release data.
 *
 *   MAIN FLOW
 *   ---------
 *   GitHub Releases metadata + current build -> latest candidate -> comparison-backed read-only plan
 *
 *   PUBLIC API
 *   ----------
 *   resolveLatestReleaseCandidate  Select the latest eligible release candidate.
 *   resolveReadOnlyUpdatePlan      Compose a read-only update decision.
 *   UpdateReleaseResolverMode      Stable-only or beta-inclusive resolver mode.
 *   GitHubReleaseAssetMetadata     Minimal GitHub release asset facts.
 *   GitHubReleaseMetadata          Minimal GitHub release facts.
 *   ResolvedUpdateReleaseCandidate Selected release plus normalized identity.
 *   UpdateReleaseResolverInput     Resolver input facts.
 *   FoundUpdateReleaseResolution   Successful resolver result.
 *   MissingUpdateReleaseResolution Missing-release resolver result.
 *   UpdateReleaseResolution        Resolver result union.
 *   ReadOnlyUpdatePlanInput        Plan input facts.
 *   ComparedReadOnlyUpdatePlan     Successful compared plan result.
 *   MissingReleaseReadOnlyUpdatePlan Missing-release plan result.
 *   UnversionedCurrentBuildReadOnlyUpdatePlan Dev/unversioned current build result.
 *   ReadOnlyUpdatePlanResolution   Read-only plan result union.
 *
 *   INTERNALS
 *   ---------
 *   currentBuildVersionError, normalizeCandidate, compareNormalizedCandidates, comparePrereleaseIdentifiers, isNumericIdentifier
 *
 * @exports UpdateReleaseResolverMode, GitHubReleaseAssetMetadata, GitHubReleaseMetadata,
 *   ResolvedUpdateReleaseCandidate, UpdateReleaseResolverInput, FoundUpdateReleaseResolution,
 *   MissingUpdateReleaseResolution, UpdateReleaseResolution, ReadOnlyUpdatePlanInput,
 *   ComparedReadOnlyUpdatePlan, MissingReleaseReadOnlyUpdatePlan,
 *   UnversionedCurrentBuildReadOnlyUpdatePlan, ReadOnlyUpdatePlanResolution,
 *   resolveLatestReleaseCandidate, resolveReadOnlyUpdatePlan
 * @deps ./update-contract
 */
import {
  compareReleaseCandidate,
  normalizeReleaseVersion,
  type CurrentBuildMetadata,
  type NormalizedReleaseVersion,
  type ReadOnlyUpdatePlan,
  type ReleaseCandidate,
  type UpdateComparisonState,
  type UpdateVersionComparison,
} from "./update-contract.js";

// -- 1/4 HELPER · Resolver metadata types --
/** Resolver mode: stable-only by default, or beta-inclusive for prereleases. */
export type UpdateReleaseResolverMode = "stable" | "beta";

/** Minimal GitHub release asset metadata preserved for later read-only planning. */
export interface GitHubReleaseAssetMetadata {
  name: string;
  browserDownloadUrl?: string;
}

/** Minimal GitHub Releases metadata consumed by the pure resolver. */
export interface GitHubReleaseMetadata {
  tagName: string;
  prerelease: boolean;
  draft?: boolean;
  name?: string;
  publishedAt?: string;
  assets?: readonly GitHubReleaseAssetMetadata[];
}

/** Selected GitHub release mapped through the U0 release-candidate contract. */
export interface ResolvedUpdateReleaseCandidate extends ReleaseCandidate {
  release: GitHubReleaseMetadata;
  normalized: NormalizedReleaseVersion;
  assets: readonly GitHubReleaseAssetMetadata[];
}

/** Input facts for selecting an update release from mocked GitHub metadata. */
export interface UpdateReleaseResolverInput {
  releases: readonly GitHubReleaseMetadata[];
  mode?: UpdateReleaseResolverMode;
}

/** Successful release resolver result. */
export interface FoundUpdateReleaseResolution {
  status: "found";
  mode: UpdateReleaseResolverMode;
  candidate: ResolvedUpdateReleaseCandidate;
}

/** Missing-release result used by user-facing update errors later. */
export interface MissingUpdateReleaseResolution {
  status: "missing_release";
  mode: UpdateReleaseResolverMode;
  reason: string;
}

export type UpdateReleaseResolution = FoundUpdateReleaseResolution | MissingUpdateReleaseResolution;

/** Input facts for a read-only update decision. */
export interface ReadOnlyUpdatePlanInput extends UpdateReleaseResolverInput {
  current: CurrentBuildMetadata;
}

/** Successful read-only update plan with current/candidate comparison. */
export interface ComparedReadOnlyUpdatePlan {
  status: UpdateComparisonState;
  mode: UpdateReleaseResolverMode;
  readOnly: true;
  current: CurrentBuildMetadata;
  candidate: ResolvedUpdateReleaseCandidate;
  comparison: UpdateVersionComparison;
  plan: ReadOnlyUpdatePlan;
}

/** Missing-release result at the read-only update plan boundary. */
export interface MissingReleaseReadOnlyUpdatePlan {
  status: "missing_release";
  mode: UpdateReleaseResolverMode;
  readOnly: true;
  current: CurrentBuildMetadata;
  reason: string;
}

/** Dev or otherwise unversioned current build result. */
export interface UnversionedCurrentBuildReadOnlyUpdatePlan {
  status: "unversioned_current_build";
  mode: UpdateReleaseResolverMode;
  readOnly: true;
  current: CurrentBuildMetadata;
  reason: string;
}

export type ReadOnlyUpdatePlanResolution =
  | ComparedReadOnlyUpdatePlan
  | MissingReleaseReadOnlyUpdatePlan
  | UnversionedCurrentBuildReadOnlyUpdatePlan;
// -/ 1/4

// -- 2/4 CORE · resolveLatestReleaseCandidate <- START HERE --
/** Select the latest eligible GitHub release without downloads or live state inspection. */
export function resolveLatestReleaseCandidate(
  input: UpdateReleaseResolverInput,
): UpdateReleaseResolution {
  const mode = input.mode ?? "stable";
  let latest: ResolvedUpdateReleaseCandidate | undefined;

  for (const release of input.releases) {
    if (release.draft === true) continue;
    if (mode === "stable" && release.prerelease) continue;

    const candidate = normalizeCandidate(release);
    if (
      latest === undefined ||
      compareNormalizedCandidates(candidate.normalized, latest.normalized) > 0
    ) {
      latest = candidate;
    }
  }

  if (latest === undefined) {
    return {
      status: "missing_release",
      mode,
      reason: mode === "stable" ? "no stable GitHub release found" : "no GitHub release found",
    };
  }

  return { status: "found", mode, candidate: latest };
}
// -/ 2/4

// -- 3/4 CORE · resolveReadOnlyUpdatePlan --
/** Compose a read-only update decision from GitHub release metadata and current build facts. */
export function resolveReadOnlyUpdatePlan(
  input: ReadOnlyUpdatePlanInput,
): ReadOnlyUpdatePlanResolution {
  const releaseResolution = resolveLatestReleaseCandidate(input);
  if (releaseResolution.status === "missing_release") {
    return {
      status: "missing_release",
      mode: releaseResolution.mode,
      readOnly: true,
      current: input.current,
      reason: releaseResolution.reason,
    };
  }

  const currentVersionErrorReason = currentBuildVersionError(input.current.version);
  if (currentVersionErrorReason !== undefined) {
    return {
      status: "unversioned_current_build",
      mode: releaseResolution.mode,
      readOnly: true,
      current: input.current,
      reason: currentVersionErrorReason,
    };
  }

  const comparison = compareReleaseCandidate({
    current: input.current,
    candidate: releaseResolution.candidate,
  });
  const plan: ReadOnlyUpdatePlan = {
    readOnly: true,
    current: input.current,
    candidate: releaseResolution.candidate,
    comparison,
  };

  return {
    status: comparison.state,
    mode: releaseResolution.mode,
    readOnly: true,
    current: input.current,
    candidate: releaseResolution.candidate,
    comparison,
    plan,
  };
}
// -/ 3/4

// -- 4/4 HELPER · Normalization and semver ordering --
function currentBuildVersionError(version: string): string | undefined {
  try {
    normalizeReleaseVersion(version);
    return undefined;
  } catch {
    return `current build version is not a combo-chen release version: ${version}`;
  }
}

function normalizeCandidate(release: GitHubReleaseMetadata): ResolvedUpdateReleaseCandidate {
  const normalized = normalizeReleaseVersion(release.tagName);
  if (release.prerelease) normalized.channel = "prerelease";

  return {
    tagName: release.tagName,
    prerelease: release.prerelease,
    name: release.name,
    publishedAt: release.publishedAt,
    release,
    normalized,
    assets: release.assets ?? [],
  };
}

function compareNormalizedCandidates(
  left: NormalizedReleaseVersion,
  right: NormalizedReleaseVersion,
): number {
  const coreOrder =
    left.major - right.major ||
    left.minor - right.minor ||
    left.patch - right.patch;
  if (coreOrder !== 0) return Math.sign(coreOrder);

  if (left.channel === "stable" && right.channel === "stable") return 0;
  if (left.channel === "stable") return 1;
  if (right.channel === "stable") return -1;

  const limit = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < limit; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;

    const order = comparePrereleaseIdentifiers(leftPart, rightPart);
    if (order !== 0) return order;
  }
  return 0;
}

function comparePrereleaseIdentifiers(left: string, right: string): number {
  const leftNumeric = isNumericIdentifier(left);
  const rightNumeric = isNumericIdentifier(right);

  if (leftNumeric && rightNumeric) {
    return Math.sign(Number.parseInt(left, 10) - Number.parseInt(right, 10));
  }
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;

  return Math.sign(left.localeCompare(right, "en", { sensitivity: "variant" }));
}

function isNumericIdentifier(value: string): boolean {
  return /^(0|[1-9]\d*)$/.test(value);
}
// -/ 4/4
