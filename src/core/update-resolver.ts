/**
 * @overview Read-only resolver for GitHub Releases update metadata.
 *   ~310 lines, 19 exports, selects the latest eligible release candidate, compares it with current build metadata,
 *   and resolves the expected release asset when requested.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at resolveLatestReleaseCandidate <- resolver mode and candidate selection.
 *   2. Then resolveReadOnlyUpdatePlan         <- read-only candidate/current comparison and asset planning.
 *   3. Then resolveReleaseAsset               <- U0 asset selection bridge.
 *   4. Then normalizeCandidate                <- U0 tag normalization bridge.
 *   5. Then compareNormalizedCandidates       <- semver ordering for mocked release data.
 *
 *   MAIN FLOW
 *   ---------
 *   GitHub Releases metadata + current build + optional target -> latest candidate -> comparison/asset-backed read-only plan
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
 *   MissingAssetReadOnlyUpdatePlan Missing selected-asset plan result.
 *   UnsupportedPlatformReadOnlyUpdatePlan Unsupported target plan result.
 *   MissingReleaseReadOnlyUpdatePlan Missing-release plan result.
 *   UnversionedCurrentBuildReadOnlyUpdatePlan Dev/unversioned current build result.
 *   ReadOnlyUpdatePlanResolution   Read-only plan result union.
 *
 *   INTERNALS
 *   ---------
 *   currentBuildVersionError, resolveReleaseAsset, normalizeCandidate, compareNormalizedCandidates,
 *   comparePrereleaseIdentifiers, isNumericIdentifier
 *
 * @exports UpdateReleaseResolverMode, GitHubReleaseAssetMetadata, GitHubReleaseMetadata,
 *   ResolvedUpdateReleaseCandidate, UpdateReleaseResolverInput, FoundUpdateReleaseResolution,
 *   MissingUpdateReleaseResolution, UpdateReleaseResolution, ReadOnlyUpdatePlanInput,
 *   ComparedReadOnlyUpdatePlan, MissingAssetReadOnlyUpdatePlan, UnsupportedPlatformReadOnlyUpdatePlan,
 *   MissingReleaseReadOnlyUpdatePlan, UnversionedCurrentBuildReadOnlyUpdatePlan, ReadOnlyUpdatePlanResolution,
 *   resolveLatestReleaseCandidate, resolveReadOnlyUpdatePlan
 * @deps ./update-contract
 */
import {
  compareReleaseCandidate,
  normalizeReleaseVersion,
  selectUpdateAsset,
  type CurrentBuildMetadata,
  type NormalizedReleaseVersion,
  type ReadOnlyUpdatePlan,
  type ReleaseCandidate,
  type UpdateAssetSelection,
  type UpdateAssetTarget,
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
  assetTarget?: UpdateAssetTarget;
  supportedTargets?: readonly UpdateAssetTarget[];
}

/** Successful read-only update plan with current/candidate comparison. */
export interface ComparedReadOnlyUpdatePlan {
  status: UpdateComparisonState;
  mode: UpdateReleaseResolverMode;
  readOnly: true;
  current: CurrentBuildMetadata;
  candidate: ResolvedUpdateReleaseCandidate;
  comparison: UpdateVersionComparison;
  asset?: UpdateAssetSelection;
  releaseAsset?: GitHubReleaseAssetMetadata;
  plan: ReadOnlyUpdatePlan;
}

/** Candidate release selected, but the expected archive is absent from its assets. */
export interface MissingAssetReadOnlyUpdatePlan {
  status: "missing_asset";
  mode: UpdateReleaseResolverMode;
  readOnly: true;
  current: CurrentBuildMetadata;
  candidate: ResolvedUpdateReleaseCandidate;
  comparison: UpdateVersionComparison;
  expectedAsset: UpdateAssetSelection;
  reason: string;
}

/** Requested update target is not supported by the U0 asset contract. */
export interface UnsupportedPlatformReadOnlyUpdatePlan {
  status: "unsupported_platform";
  mode: UpdateReleaseResolverMode;
  readOnly: true;
  current: CurrentBuildMetadata;
  candidate: ResolvedUpdateReleaseCandidate;
  comparison: UpdateVersionComparison;
  asset: UpdateAssetSelection;
  reason: string;
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
  | MissingAssetReadOnlyUpdatePlan
  | UnsupportedPlatformReadOnlyUpdatePlan
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
  if (comparison.state === "update_available" && input.assetTarget !== undefined) {
    const assetResolution = resolveReleaseAsset({
      candidate: releaseResolution.candidate,
      target: input.assetTarget,
      supportedTargets: input.supportedTargets,
    });
    if (assetResolution.status === "unsupported_platform") {
      return {
        status: "unsupported_platform",
        mode: releaseResolution.mode,
        readOnly: true,
        current: input.current,
        candidate: releaseResolution.candidate,
        comparison,
        asset: assetResolution.asset,
        reason: assetResolution.reason,
      };
    }
    if (assetResolution.status === "missing_asset") {
      return {
        status: "missing_asset",
        mode: releaseResolution.mode,
        readOnly: true,
        current: input.current,
        candidate: releaseResolution.candidate,
        comparison,
        expectedAsset: assetResolution.expectedAsset,
        reason: assetResolution.reason,
      };
    }

    plan.asset = assetResolution.asset;
    return {
      status: comparison.state,
      mode: releaseResolution.mode,
      readOnly: true,
      current: input.current,
      candidate: releaseResolution.candidate,
      comparison,
      asset: assetResolution.asset,
      releaseAsset: assetResolution.releaseAsset,
      plan,
    };
  }

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
type ReleaseAssetResolution =
  | {
    status: "found";
    asset: UpdateAssetSelection;
    releaseAsset: GitHubReleaseAssetMetadata;
  }
  | {
    status: "missing_asset";
    expectedAsset: UpdateAssetSelection;
    reason: string;
  }
  | {
    status: "unsupported_platform";
    asset: UpdateAssetSelection;
    reason: string;
  };

function currentBuildVersionError(version: string): string | undefined {
  try {
    normalizeReleaseVersion(version);
    return undefined;
  } catch {
    return `current build version is not a combo-chen release version: ${version}`;
  }
}

function resolveReleaseAsset(input: {
  candidate: ResolvedUpdateReleaseCandidate;
  target: UpdateAssetTarget;
  supportedTargets?: readonly UpdateAssetTarget[];
}): ReleaseAssetResolution {
  const asset = selectUpdateAsset({
    version: input.candidate.normalized.version,
    platform: input.target.platform,
    arch: input.target.arch,
    supportedTargets: input.supportedTargets,
  });

  if (!asset.supported) {
    return {
      status: "unsupported_platform",
      asset,
      reason: asset.reason ?? `unsupported update asset target: ${input.target.platform}-${input.target.arch}`,
    };
  }

  if (asset.fileName === undefined) {
    return {
      status: "missing_asset",
      expectedAsset: asset,
      reason: `release ${input.candidate.tagName} is missing an update asset filename`,
    };
  }

  const releaseAsset = input.candidate.assets.find((candidateAsset) => candidateAsset.name === asset.fileName);
  if (releaseAsset === undefined) {
    return {
      status: "missing_asset",
      expectedAsset: asset,
      reason: `release ${input.candidate.tagName} is missing asset ${asset.fileName}`,
    };
  }

  return { status: "found", asset, releaseAsset };
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
