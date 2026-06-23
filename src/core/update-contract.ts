/**
 * @overview Read-only updater contract primitives shared by U1/U2/U3/U4 update slices.
 *   ~390 lines, 25 exports, pure release identity, asset/checksum/install selection, and comparison helpers.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at normalizeReleaseVersion   <- release tag/version normalization.
 *   2. Then selectUpdateAsset             <- platform archive selection.
 *   3. Then parseUpdateChecksums          <- checksums.txt parser and lookup.
 *   4. Then classifyInstallTarget         <- read-only local install classification.
 *   5. Then compareReleaseCandidate       <- current build versus candidate state.
 *   6. Skim exported types                <- U1/U2/U3/U4 shared contracts.
 *
 *   MAIN FLOW
 *   ---------
 *   current build + release candidate + local path -> normalized versions -> asset/checksum/install/comparison state
 *
 *   PUBLIC API
 *   ----------
 *   normalizeReleaseVersion       Normalize v-prefixed and plain release versions.
 *   selectUpdateAsset             Select the expected archive for a target platform.
 *   parseUpdateChecksums          Parse sha256sum-compatible checksums.txt text.
 *   lookupUpdateChecksum          Look up an expected checksum by exact asset filename.
 *   classifyInstallTarget         Classify a local executable path without mutating it.
 *   compareReleaseCandidate       Compare current build metadata to a candidate.
 *   compareNormalizedReleaseVersions Compare two normalized combo-chen release versions.
 *   UpdateReleaseChannel          Stable or prerelease channel name.
 *   UpdateComparisonState         Candidate comparison state.
 *   NormalizedReleaseVersion      Parsed release identity.
 *   CurrentBuildMetadata          Current CLI build facts.
 *   ReleaseCandidate             Candidate GitHub release facts.
 *   UpdateVersionComparison       Read-only candidate comparison result.
 *   UpdateAssetTarget             Platform/architecture pair used for asset lookup.
 *   UpdateAssetSelectionInput     Input facts for pure archive selection.
 *   UpdateAssetSelection          Platform asset selection result consumed by the resolver and updater.
 *   UpdateChecksumEntry           Parsed checksums.txt row.
 *   UpdateChecksumLookupInput     Input facts for exact checksum lookup.
 *   UpdateChecksumLookup          Exact checksum lookup result.
 *   ChecksumVerificationInput     Checksum verification input consumed by U2 staging and the updater.
 *   InstallTargetKind             Local install target class.
 *   InstallTargetClassificationInput Input facts for local install classification.
 *   InstallTargetClassification   Local install target facts.
 *   ActiveComboState              Future active capsule guard facts.
 *   ReadOnlyUpdatePlan            Aggregate update plan consumed by the active update command.
 *
 *   INTERNALS
 *   ---------
 *   normalizeInstallTargetPath, releaseArchiveVersionFromPath, isSourceCheckoutPath, parsePrerelease,
 *   comparePrereleaseIdentifiers, isNumericIdentifier
 *
 * @exports UpdateReleaseChannel, NormalizedReleaseVersion, CurrentBuildMetadata, ReleaseCandidate,
 *   UpdateComparisonState, UpdateVersionComparison, UpdateAssetTarget, UpdateAssetSelectionInput,
 *   UpdateAssetSelection, UpdateChecksumEntry, UpdateChecksumLookupInput, UpdateChecksumLookup,
 *   ChecksumVerificationInput, InstallTargetKind, InstallTargetClassificationInput,
 *   InstallTargetClassification, ActiveComboState, ReadOnlyUpdatePlan, normalizeReleaseVersion,
 *   selectUpdateAsset, parseUpdateChecksums, lookupUpdateChecksum, classifyInstallTarget,
 *   compareReleaseCandidate, compareNormalizedReleaseVersions
 * @deps node:fs, ../infra/release-artifacts
 */
import { realpathSync } from "node:fs";

import { RELEASE_TARGETS, releaseAssetFileName } from "../infra/release-artifacts.js";

// -- 1/3 HELPER · Update contract types --
/** Release channel after tag parsing plus GitHub prerelease flag normalization. */
export type UpdateReleaseChannel = "stable" | "prerelease";

/** Version comparison result for a current build and one release candidate. */
export type UpdateComparisonState = "update_available" | "current" | "candidate_older";

/** Local install path category used to keep future replacement logic bounded. */
export type InstallTargetKind = "release_archive" | "source_checkout" | "dev_shim" | "unknown";

/** Parsed combo-chen release identity with comparable semver pieces. */
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

/** Current CLI build facts exposed by release metadata. */
export interface CurrentBuildMetadata {
  version: string;
  commit: string;
  date: string;
}

/** GitHub release candidate facts consumed by read-only update planning. */
export interface ReleaseCandidate {
  tagName: string;
  prerelease: boolean;
  name?: string;
  publishedAt?: string;
}

/** Read-only comparison of the installed build and candidate release. */
export interface UpdateVersionComparison {
  state: UpdateComparisonState;
  current: NormalizedReleaseVersion;
  candidate: NormalizedReleaseVersion;
}

/** Platform and architecture pair used for release archive lookup. */
export interface UpdateAssetTarget {
  platform: string;
  arch: string;
}

/** Pure asset selection input; tests may inject supported target fixtures. */
export interface UpdateAssetSelectionInput extends UpdateAssetTarget {
  version: string;
  supportedTargets?: readonly UpdateAssetTarget[];
}

/** Result of choosing the expected archive for a platform and architecture. */
export interface UpdateAssetSelection extends UpdateAssetTarget {
  version: string;
  supported: boolean;
  fileName?: string;
  reason?: string;
}

/** One parsed sha256sum-compatible checksums.txt entry. */
export interface UpdateChecksumEntry {
  fileName: string;
  sha256: string;
  line: number;
}

/** Input for exact checksum lookup by release asset filename. */
export interface UpdateChecksumLookupInput {
  checksums: readonly UpdateChecksumEntry[];
  fileName: string;
}

/** Exact checksum lookup result without downloading or hashing any asset. */
export interface UpdateChecksumLookup {
  fileName: string;
  found: boolean;
  expectedSha256?: string;
  reason?: string;
}

/** Future checksum verification input after download/staging exists. */
export interface ChecksumVerificationInput {
  fileName: string;
  expectedSha256: string;
  actualSha256?: string;
}

/** Local executable path to classify before any installer mutation is allowed. */
export interface InstallTargetClassificationInput {
  path: string;
}

/** Read-only classification of whether a path can ever be auto-replaced. */
export interface InstallTargetClassification {
  path: string;
  kind: InstallTargetKind;
  autoReplaceable: boolean;
  reason: string;
}

/** Active combo capsule facts reserved for the future U4 guard. */
export interface ActiveComboState {
  active: boolean;
  comboIds: string[];
}

/** Aggregate read-only update plan shared by U2, U3, and future resolver/guard slices. */
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
const CHECKSUM_LINE_PATTERN = /^([0-9A-Fa-f]{64}) [ *](.+)$/;
const DEV_SHIM_PATTERN = /(?:^|\/)node_modules\/\.bin\/combo-chen(?:\.cmd)?$/;
const RELEASE_ARCHIVE_BIN_PATTERN = /(?:^|\/)(combo-chen-v[^/]+)\/bin\/combo-chen$/;
// -/ 1/3

// -- 2/3 CORE · normalizeReleaseVersion + asset/checksum/install selection + compareReleaseCandidate <- START HERE --
/** Normalize a combo-chen release tag or version into canonical comparable fields. */
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

/** Select the expected release archive name for a supported platform target without I/O. */
export function selectUpdateAsset(input: UpdateAssetSelectionInput): UpdateAssetSelection {
  const version = normalizeReleaseVersion(input.version);
  const supportedTargets = input.supportedTargets ?? RELEASE_TARGETS;
  const target = { platform: input.platform, arch: input.arch };
  const supported = supportedTargets.some(
    (supportedTarget) =>
      supportedTarget.platform === target.platform && supportedTarget.arch === target.arch,
  );

  if (!supported) {
    return {
      version: version.version,
      platform: target.platform,
      arch: target.arch,
      supported: false,
      reason: `unsupported update asset target: ${target.platform}-${target.arch}`,
    };
  }

  return {
    version: version.version,
    platform: target.platform,
    arch: target.arch,
    supported: true,
    fileName: releaseAssetFileName(version.version, target),
  };
}

/** Parse sha256sum-compatible checksums.txt content into deterministic entries. */
export function parseUpdateChecksums(text: string): UpdateChecksumEntry[] {
  const entries: UpdateChecksumEntry[] = [];
  const seenFileNames = new Set<string>();
  const lines = text.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index]!.replace(/\r$/, "");
    if (line.trim() === "") continue;

    const match = CHECKSUM_LINE_PATTERN.exec(line);
    if (match === null) {
      throw new Error(`invalid checksums.txt line ${lineNumber}`);
    }

    const fileName = match[2]!;
    if (seenFileNames.has(fileName)) {
      throw new Error(`duplicate checksum entry for ${fileName}`);
    }

    seenFileNames.add(fileName);
    entries.push({
      line: lineNumber,
      fileName,
      sha256: match[1]!.toLowerCase(),
    });
  }

  return entries;
}

/** Look up an expected sha256 by exact release asset filename. */
export function lookupUpdateChecksum(input: UpdateChecksumLookupInput): UpdateChecksumLookup {
  const match = input.checksums.find((checksum) => checksum.fileName === input.fileName);
  if (match === undefined) {
    return {
      fileName: input.fileName,
      found: false,
      reason: `checksum not found for ${input.fileName}`,
    };
  }

  return {
    fileName: input.fileName,
    found: true,
    expectedSha256: match.sha256,
  };
}

/** Classify a local combo-chen executable path without replacing or mutating it. */
export function classifyInstallTarget(
  input: InstallTargetClassificationInput,
): InstallTargetClassification {
  const path = normalizeInstallTargetPath(input.path.trim());
  const resolved = (() => {
    try {
      return normalizeInstallTargetPath(realpathSync(path));
    } catch {
      return path;
    }
  })();

  if (DEV_SHIM_PATTERN.test(resolved)) {
    return {
      path,
      kind: "dev_shim",
      autoReplaceable: false,
      reason: "package manager shim must not be auto-replaced",
    };
  }

  if (releaseArchiveVersionFromPath(resolved) !== undefined) {
    return {
      path,
      kind: "release_archive",
      autoReplaceable: true,
      reason: "release archive bin path is eligible for future archive replacement",
    };
  }

  if (isSourceCheckoutPath(resolved)) {
    return {
      path,
      kind: "source_checkout",
      autoReplaceable: false,
      reason: "source checkout path must not be auto-replaced",
    };
  }

  return {
    path,
    kind: "unknown",
    autoReplaceable: false,
    reason: "unknown install target must not be auto-replaced",
  };
}

/** Compare current build metadata with a candidate GitHub release. */
export function compareReleaseCandidate(input: {
  current: CurrentBuildMetadata;
  candidate: ReleaseCandidate;
}): UpdateVersionComparison {
  const current = normalizeReleaseVersion(input.current.version);
  const candidate = normalizeReleaseVersion(input.candidate.tagName);
  if (input.candidate.prerelease) {
    candidate.channel = "prerelease";
  }
  const order = compareNormalizedReleaseVersions(candidate, current);

  return {
    state: order > 0 ? "update_available" : order === 0 ? "current" : "candidate_older",
    current,
    candidate,
  };
}
// -/ 2/3

// -- 3/3 HELPER · install path and semver comparison helpers --
function normalizeInstallTargetPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function releaseArchiveVersionFromPath(path: string): NormalizedReleaseVersion | undefined {
  const match = RELEASE_ARCHIVE_BIN_PATTERN.exec(path);
  if (match === null) return undefined;

  try {
    return normalizeReleaseVersion(match[1]!.slice("combo-chen-".length));
  } catch {
    return undefined;
  }
}

function isSourceCheckoutPath(path: string): boolean {
  if (path.includes("/node_modules/")) return false;
  return /(?:^|\/)(?:src\/cli\/main\.ts|dist\/cli\.mjs)$/.test(path);
}

function parsePrerelease(value: string | undefined): string[] {
  if (value === undefined || value === "") return [];
  return value.split(".");
}

/** Compare two normalized release versions with semver ordering for deterministic candidate selection. */
export function compareNormalizedReleaseVersions(
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
// -/ 3/3
