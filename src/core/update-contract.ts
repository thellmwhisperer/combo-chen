/**
 * @overview Read-only updater contract primitives shared by future update slices.
 *   ~180 lines, 14 exports, pure release identity and comparison helpers.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at normalizeReleaseVersion   <- release tag/version normalization.
 *   2. Then compareReleaseCandidate       <- current build versus candidate state.
 *   3. Skim exported types                <- U1/U2/U3/U4 follow-up contracts.
 *
 *   MAIN FLOW
 *   ---------
 *   current build + release candidate -> normalized versions -> comparison state
 *
 *   PUBLIC API
 *   ----------
 *   normalizeReleaseVersion       Normalize v-prefixed and plain release versions.
 *   compareReleaseCandidate       Compare current build metadata to a candidate.
 *   UpdateReleaseChannel          Stable or prerelease channel name.
 *   NormalizedReleaseVersion      Parsed release identity.
 *   CurrentBuildMetadata          Current CLI build facts.
 *   ReleaseCandidate             Candidate GitHub release facts.
 *   UpdateVersionComparison       Read-only candidate comparison result.
 *   UpdateAssetSelection          Future platform asset selection result.
 *   ChecksumVerificationInput     Future checksum verification input.
 *   InstallTargetClassification   Future local install target facts.
 *   ActiveComboState              Future active capsule guard facts.
 *   ReadOnlyUpdatePlan            Future update plan aggregate.
 *
 *   INTERNALS
 *   ---------
 *   parsePrerelease, compareNormalizedReleaseVersions, comparePrereleaseIdentifiers, isNumericIdentifier
 *
 * @exports UpdateReleaseChannel, NormalizedReleaseVersion, CurrentBuildMetadata, ReleaseCandidate,
 *   UpdateComparisonState, UpdateVersionComparison, UpdateAssetSelection, ChecksumVerificationInput,
 *   InstallTargetKind, InstallTargetClassification, ActiveComboState, ReadOnlyUpdatePlan,
 *   normalizeReleaseVersion, compareReleaseCandidate
 * @deps none
 */

// -- 1/3 HELPER · Update contract types --
export type UpdateReleaseChannel = "stable" | "prerelease";
export type UpdateComparisonState = "update_available" | "current" | "candidate_older";
export type InstallTargetKind = "release_archive" | "source_checkout" | "dev_shim" | "unknown";

export interface NormalizedReleaseVersion {
  input: string;
  tagName: string;
  version: string;
  channel: UpdateReleaseChannel;
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export interface CurrentBuildMetadata {
  version: string;
  commit: string;
  date: string;
}

export interface ReleaseCandidate {
  tagName: string;
  prerelease: boolean;
  name?: string;
  publishedAt?: string;
}

export interface UpdateVersionComparison {
  state: UpdateComparisonState;
  current: NormalizedReleaseVersion;
  candidate: NormalizedReleaseVersion;
}

export interface UpdateAssetSelection {
  platform: string;
  arch: string;
  supported: boolean;
  fileName?: string;
}

export interface ChecksumVerificationInput {
  fileName: string;
  expectedSha256: string;
  actualSha256?: string;
}

export interface InstallTargetClassification {
  path: string;
  kind: InstallTargetKind;
  autoReplaceable: boolean;
  reason: string;
}

export interface ActiveComboState {
  active: boolean;
  comboIds: string[];
}

export interface ReadOnlyUpdatePlan {
  current: CurrentBuildMetadata;
  candidate?: ReleaseCandidate;
  comparison?: UpdateVersionComparison;
  asset?: UpdateAssetSelection;
  checksum?: ChecksumVerificationInput;
  installTarget?: InstallTargetClassification;
  activeCombos?: ActiveComboState;
  readOnly: true;
}

const RELEASE_VERSION_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
// -/ 1/3

// -- 2/3 CORE · normalizeReleaseVersion + compareReleaseCandidate <- START HERE --
export function normalizeReleaseVersion(input: string): NormalizedReleaseVersion {
  const trimmed = input.trim();
  const match = RELEASE_VERSION_PATTERN.exec(trimmed);
  if (match === null) {
    throw new Error(`invalid combo-chen release version: ${input}`);
  }

  const major = Number.parseInt(match[1]!, 10);
  const minor = Number.parseInt(match[2]!, 10);
  const patch = Number.parseInt(match[3]!, 10);
  const prerelease = parsePrerelease(match[4]);
  const version = `${major}.${minor}.${patch}${prerelease.length === 0 ? "" : `-${prerelease.join(".")}`}`;

  return {
    input: trimmed,
    tagName: `v${version}`,
    version,
    channel: prerelease.length === 0 ? "stable" : "prerelease",
    major,
    minor,
    patch,
    prerelease,
  };
}

export function compareReleaseCandidate(input: {
  current: CurrentBuildMetadata;
  candidate: ReleaseCandidate;
}): UpdateVersionComparison {
  const current = normalizeReleaseVersion(input.current.version);
  const candidate = normalizeReleaseVersion(input.candidate.tagName);
  const order = compareNormalizedReleaseVersions(candidate, current);

  return {
    state: order > 0 ? "update_available" : order === 0 ? "current" : "candidate_older",
    current,
    candidate,
  };
}
// -/ 2/3

// -- 3/3 HELPER · semver comparison helpers --
function parsePrerelease(value: string | undefined): string[] {
  if (value === undefined || value === "") return [];
  return value.split(".");
}

function compareNormalizedReleaseVersions(
  left: NormalizedReleaseVersion,
  right: NormalizedReleaseVersion,
): number {
  const coreOrder =
    left.major - right.major ||
    left.minor - right.minor ||
    left.patch - right.patch;
  if (coreOrder !== 0) return Math.sign(coreOrder);

  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;

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
// -/ 3/3
