/**
 * @overview Reproducible release asset producer for combo-chen archives.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at produceReleaseAssets <- materializes tarballs and checksums.
 *   2. Then tarGzipArchive          <- deterministic tar.gz construction.
 *   3. Helper sections are a tiny ustar writer for release files only.
 *
 *   MAIN FLOW
 *   ---------
 *   release contract -> deterministic tar.gz buffers -> checksums.txt
 *
 *   PUBLIC API
 *   ----------
 *   produceReleaseAssets  Write target release tarballs and checksums.txt.
 *
 *   INTERNALS
 *   ---------
 *   tarGzipArchive, tarFileMember, tarFileHeader, writeHeaderString,
 *   writeTarOctal, writeTarChecksum, sha256Hex, tarMtimeSeconds.
 *
 * @exports ProduceReleaseAssetsOptions, ProducedReleaseAsset, ProduceReleaseAssetsResult, produceReleaseAssets
 * @deps node:{crypto,fs,path,zlib}, ./release-artifacts
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import {
  RELEASE_CHECKSUMS_FILE,
  RELEASE_TARGETS,
  formatChecksums,
  releaseArchiveEntries,
  releaseAssetFileName,
  type ReleaseArchiveEntry,
  type ReleaseTarget,
} from "./release-artifacts.js";

// -- 1/3 HELPER · producer data contracts --
const TAR_BLOCK_SIZE = 512;
const TAR_TRAILER = Buffer.alloc(TAR_BLOCK_SIZE * 2);
const DEFAULT_TAR_MTIME_SECONDS = 0;

export interface ProduceReleaseAssetsOptions {
  repoDir: string;
  outDir: string;
  version: string;
  targets?: readonly ReleaseTarget[];
  mtimeSeconds?: number;
}

export interface ProducedReleaseAsset {
  target: ReleaseTarget;
  fileName: string;
  filePath: string;
  sha256: string;
}

export interface ProduceReleaseAssetsResult {
  assets: ProducedReleaseAsset[];
  checksumsPath: string;
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function tarMtimeSeconds(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TAR_MTIME_SECONDS;
  if (!Number.isFinite(value) || value < 0)
    throw new Error("release archive mtimeSeconds must be a non-negative number");
  return Math.trunc(value);
}
// -/ 1/3

// -- 2/3 CORE · produceReleaseAssets <- START HERE --
export function produceReleaseAssets(options: ProduceReleaseAssetsOptions): ProduceReleaseAssetsResult {
  mkdirSync(options.outDir, { recursive: true });
  const archive = tarGzipArchive({
    repoDir: options.repoDir,
    version: options.version,
    mtimeSeconds: tarMtimeSeconds(options.mtimeSeconds),
  });
  const targets = options.targets ?? RELEASE_TARGETS;
  const assets = targets.map((target) => {
    const fileName = releaseAssetFileName(options.version, target);
    const filePath = join(options.outDir, fileName);
    writeFileSync(filePath, archive);
    return {
      target: { platform: target.platform, arch: target.arch },
      fileName,
      filePath,
      sha256: sha256Hex(archive),
    };
  });
  const checksumsPath = join(options.outDir, RELEASE_CHECKSUMS_FILE);
  writeFileSync(checksumsPath, formatChecksums(assets.map(({ fileName, sha256 }) => ({ fileName, sha256 }))));
  return { assets, checksumsPath };
}
// -/ 2/3

// -- 3/3 HELPER · deterministic tar.gz writer --
function tarGzipArchive(input: { repoDir: string; version: string; mtimeSeconds: number }): Buffer {
  const members = releaseArchiveEntries(input.version).map((entry) => {
    const content = readFileSync(join(input.repoDir, entry.sourcePath));
    return tarFileMember(entry, content, input.mtimeSeconds);
  });
  return gzipSync(Buffer.concat([...members, TAR_TRAILER]), { level: 9 });
}

function tarFileMember(entry: ReleaseArchiveEntry, content: Buffer, mtimeSeconds: number): Buffer {
  const header = tarFileHeader(entry, content.length, mtimeSeconds);
  const paddingLength = (TAR_BLOCK_SIZE - (content.length % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
  return Buffer.concat([header, content, Buffer.alloc(paddingLength)]);
}

function tarFileHeader(entry: ReleaseArchiveEntry, size: number, mtimeSeconds: number): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  writeHeaderString(header, 0, 100, entry.archivePath);
  writeTarOctal(header, 100, 8, entry.mode);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, mtimeSeconds);
  header.fill(0x20, 148, 156);
  writeHeaderString(header, 156, 1, "0");
  writeHeaderString(header, 257, 6, "ustar");
  writeHeaderString(header, 263, 2, "00");
  writeTarChecksum(header);
  return header;
}

function writeHeaderString(header: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error(`release archive path is too long for ustar: ${value}`);
  bytes.copy(header, offset);
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  const text = Math.trunc(value).toString(8);
  if (text.length > length - 1) throw new Error(`release archive tar field overflow: ${value}`);
  header.write(text.padStart(length - 1, "0"), offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function writeTarChecksum(header: Buffer): void {
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const text = checksum.toString(8);
  if (text.length > 6) throw new Error(`release archive checksum overflow: ${checksum}`);
  header.write(text.padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
}
// -/ 3/3
