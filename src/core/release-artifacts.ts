/**
 * @overview Release artifact contract helpers for tagged combo-chen builds.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at releaseAssetFileNames <- platform asset naming contract.
 *   2. Then releaseArchiveEntries     <- installed CLI archive layout.
 *   3. Then formatChecksums           <- checksums.txt rendering contract.
 *
 *   MAIN FLOW
 *   ---------
 *   release version + target -> tarball name + archive entries -> checksums.txt
 *
 *   PUBLIC API
 *   ----------
 *   RELEASE_CHECKSUMS_FILE   Stable checksum artifact filename.
 *   RELEASE_TARGETS          Default platform/architecture release targets.
 *   releaseAssetFileNames    Render platform tarball filenames.
 *   releaseArchiveRoot       Render the top-level archive directory.
 *   releaseArchiveEntries    Render archive member source/path/mode entries.
 *   formatChecksums          Render sha256sum-compatible checksum text.
 *
 *   INTERNALS
 *   ---------
 *   PACKAGE_NAME, releaseVersionTag, archivePath.
 *
 * @exports RELEASE_CHECKSUMS_FILE, RELEASE_TARGETS, ReleaseTarget, ReleaseArchiveEntry, ReleaseChecksum,
 *   releaseAssetFileName, releaseAssetFileNames, releaseArchiveRoot, releaseArchiveEntries, formatChecksums
 * @deps none
 */

// -- 1/3 HELPER · release naming primitives --
const PACKAGE_NAME = "combo-chen";

export const RELEASE_CHECKSUMS_FILE = "checksums.txt";

export interface ReleaseTarget {
  platform: string;
  arch: string;
}

export interface ReleaseArchiveEntry {
  sourcePath: string;
  archivePath: string;
  mode: number;
}

export interface ReleaseChecksum {
  fileName: string;
  sha256: string;
}

export const RELEASE_TARGETS = [
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "linux", arch: "arm64" },
  { platform: "linux", arch: "x64" },
] as const satisfies readonly ReleaseTarget[];

function releaseVersionTag(version: string): string {
  const trimmed = version.trim();
  const normalized = trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
  if (normalized.length === 0) throw new Error("release version is required");
  return `v${normalized}`;
}

function archivePath(version: string, path: string): string {
  return `${releaseArchiveRoot(version)}/${path}`;
}
// -/ 1/3

// -- 2/3 CORE · asset names + archive layout <- START HERE --
export function releaseArchiveRoot(version: string): string {
  return `${PACKAGE_NAME}-${releaseVersionTag(version)}`;
}

export function releaseAssetFileName(version: string, target: ReleaseTarget): string {
  return `${releaseArchiveRoot(version)}-${target.platform}-${target.arch}.tar.gz`;
}

export function releaseAssetFileNames(
  version: string,
  targets: readonly ReleaseTarget[] = RELEASE_TARGETS,
): string[] {
  return targets.map((target) => releaseAssetFileName(version, target));
}

export function releaseArchiveEntries(version: string): ReleaseArchiveEntry[] {
  return [
    { sourcePath: "dist/cli.mjs", archivePath: archivePath(version, "bin/combo-chen"), mode: 0o755 },
    { sourcePath: "package.json", archivePath: archivePath(version, "package.json"), mode: 0o644 },
    { sourcePath: "README.md", archivePath: archivePath(version, "README.md"), mode: 0o644 },
    { sourcePath: "LICENSE", archivePath: archivePath(version, "LICENSE"), mode: 0o644 },
    {
      sourcePath: "combo-chen.example.toml",
      archivePath: archivePath(version, "combo-chen.example.toml"),
      mode: 0o644,
    },
  ];
}
// -/ 2/3

// -- 3/3 CORE · checksums.txt contract --
export function formatChecksums(checksums: readonly ReleaseChecksum[]): string {
  const lines = Array.from(checksums)
    .sort((left, right) => left.fileName.localeCompare(right.fileName))
    .map((checksum) => `${checksum.sha256.toLowerCase()}  ${checksum.fileName}`);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
// -/ 3/3
