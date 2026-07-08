/**
 * @overview Unit tests for reproducible release asset production.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at describe("release producer") <- real artifact materialization.
 *   2. Test helpers parse the tiny tar surface needed for contract checks.
 *
 *   MAIN FLOW
 *   ---------
 *   fixture repo -> produceReleaseAssets -> tar.gz assets + checksums.txt
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   writeFixtureRepo, readTarGzipMembers, readOctal, nullTerminatedAscii.
 *
 * @exports none
 * @deps vitest, node:{crypto,fs,os,path,zlib}, ../core/release-artifacts, ./release-producer
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { RELEASE_CHECKSUMS_FILE, formatChecksums } from "../core/release-artifacts.js";
import { produceReleaseAssets } from "./release-producer.js";

interface TarMember {
  name: string;
  mode: number;
  content: string;
}

// -- 1/2 HELPER · tar fixture parsing --
function writeFixtureRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-release-repo-"));
  mkdirSync(join(repoDir, "dist"));
  writeFileSync(join(repoDir, "dist", "cli.mjs"), "#!/usr/bin/env node\nconsole.log('combo-chen');\n");
  writeFileSync(join(repoDir, "package.json"), '{"name":"combo-chen"}\n');
  writeFileSync(join(repoDir, "README.md"), "# combo-chen\n");
  writeFileSync(join(repoDir, "LICENSE"), "MIT\n");
  writeFileSync(join(repoDir, "combo-chen.example.toml"), "[limits]\nbabysit_poll_seconds = 5\n");
  return repoDir;
}

function readTarGzipMembers(path: string): TarMember[] {
  const tar = gunzipSync(readFileSync(path));
  const members: TarMember[] = [];
  for (let offset = 0; offset < tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = nullTerminatedAscii(header, 0, 100);
    const mode = readOctal(header, 100, 8);
    const size = readOctal(header, 124, 12);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    members.push({
      name,
      mode,
      content: tar.subarray(contentStart, contentEnd).toString("utf8"),
    });
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return members;
}

function readOctal(buffer: Buffer, offset: number, length: number): number {
  const raw = nullTerminatedAscii(buffer, offset, length).trim();
  return raw.length === 0 ? 0 : Number.parseInt(raw, 8);
}

function nullTerminatedAscii(buffer: Buffer, offset: number, length: number): string {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? undefined : end).toString("ascii");
}
// -/ 1/2

// -- 2/2 CORE · release producer contract <- START HERE --
describe("release producer", () => {
  it("materializes target tarballs and checksums.txt reproducibly", () => {
    const repoDir = writeFixtureRepo();
    const firstOutDir = mkdtempSync(join(tmpdir(), "combo-chen-release-out-"));
    const secondOutDir = mkdtempSync(join(tmpdir(), "combo-chen-release-out-"));
    const targets = [
      { platform: "darwin", arch: "arm64" },
      { platform: "linux", arch: "x64" },
    ];

    const first = produceReleaseAssets({ repoDir, outDir: firstOutDir, version: "1.2.3", targets });
    const second = produceReleaseAssets({ repoDir, outDir: secondOutDir, version: "1.2.3", targets });

    expect(first.assets.map((asset) => asset.fileName)).toEqual([
      "combo-chen-v1.2.3-darwin-arm64.tar.gz",
      "combo-chen-v1.2.3-linux-x64.tar.gz",
    ]);
    expect(first.checksumsPath).toBe(join(firstOutDir, RELEASE_CHECKSUMS_FILE));
    expect(readFileSync(first.checksumsPath, "utf8")).toBe(
      formatChecksums(first.assets.map(({ fileName, sha256 }) => ({ fileName, sha256 }))),
    );
    for (const asset of first.assets) {
      expect(asset.sha256).toBe(createHash("sha256").update(readFileSync(asset.filePath)).digest("hex"));
      const secondAsset = second.assets.find((candidate) => candidate.fileName === asset.fileName);
      expect(secondAsset).toBeDefined();
      expect(readFileSync(asset.filePath).equals(readFileSync(secondAsset!.filePath))).toBe(true);
    }
    expect(readFileSync(first.checksumsPath, "utf8")).toBe(readFileSync(second.checksumsPath, "utf8"));

    expect(readTarGzipMembers(first.assets[0]!.filePath)).toEqual([
      {
        name: "combo-chen-v1.2.3/bin/combo-chen",
        mode: 0o755,
        content: "#!/usr/bin/env node\nconsole.log('combo-chen');\n",
      },
      {
        name: "combo-chen-v1.2.3/package.json",
        mode: 0o644,
        content: '{"name":"combo-chen"}\n',
      },
      {
        name: "combo-chen-v1.2.3/README.md",
        mode: 0o644,
        content: "# combo-chen\n",
      },
      {
        name: "combo-chen-v1.2.3/LICENSE",
        mode: 0o644,
        content: "MIT\n",
      },
      {
        name: "combo-chen-v1.2.3/combo-chen.example.toml",
        mode: 0o644,
        content: "[limits]\nbabysit_poll_seconds = 5\n",
      },
    ]);
  });
});
// -/ 2/2
