/**
 * @overview Unit tests for the read-only updater contract foundation.
 *   ~360 lines, no exports, pins release identity, asset selection, checksums, install targets, and candidate comparison.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at normalizeReleaseVersion tests <- release tag/version contract.
 *   2. Then selectUpdateAsset tests            <- supported platform asset contract.
 *   3. Then parseUpdateChecksums tests         <- checksums.txt parsing and lookup.
 *   4. Then classifyInstallTarget tests        <- read-only local install classification.
 *   5. Then compareReleaseCandidate tests      <- current versus candidate state.
 *
 *   MAIN FLOW
 *   ---------
 *   release tag or version -> normalized release version -> asset/checksum/comparison result
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   none
 *
 * @exports none
 * @deps node:{fs,os,path}, vitest, ./update-contract
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  classifyInstallTarget,
  compareReleaseCandidate,
  lookupUpdateChecksum,
  normalizeReleaseVersion,
  parseUpdateChecksums,
  selectUpdateAsset,
} from "./update-contract.js";

// -- 1/1 CORE · updater release identity contract <- START HERE --
describe("update contract release identity", () => {
  it("normalizes stable combo-chen release tags and versions", () => {
    expect(normalizeReleaseVersion("v1.2.3")).toEqual({
      input: "v1.2.3",
      tagName: "v1.2.3",
      version: "1.2.3",
      channel: "stable",
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    });

    expect(normalizeReleaseVersion("  1.2.3  ")).toMatchObject({
      tagName: "v1.2.3",
      version: "1.2.3",
      channel: "stable",
    });
  });

  it("normalizes prerelease combo-chen release tags and versions", () => {
    expect(normalizeReleaseVersion("v2.0.0-beta.3")).toEqual({
      input: "v2.0.0-beta.3",
      tagName: "v2.0.0-beta.3",
      version: "2.0.0-beta.3",
      channel: "prerelease",
      major: 2,
      minor: 0,
      patch: 0,
      prerelease: ["beta", "3"],
    });
  });

  it("selects the expected platform asset for supported targets", () => {
    expect(
      selectUpdateAsset({ version: "v1.2.3", platform: "darwin", arch: "arm64" }),
    ).toEqual({
      version: "1.2.3",
      platform: "darwin",
      arch: "arm64",
      supported: true,
      fileName: "combo-chen-v1.2.3-darwin-arm64.tar.gz",
    });

    expect(
      selectUpdateAsset({ version: "1.2.3-beta.4", platform: "linux", arch: "x64" }),
    ).toEqual({
      version: "1.2.3-beta.4",
      platform: "linux",
      arch: "x64",
      supported: true,
      fileName: "combo-chen-v1.2.3-beta.4-linux-x64.tar.gz",
    });
  });

  it("reports unsupported platform assets without inventing a filename", () => {
    expect(
      selectUpdateAsset({ version: "v1.2.3", platform: "win32", arch: "x64" }),
    ).toEqual({
      version: "1.2.3",
      platform: "win32",
      arch: "x64",
      supported: false,
      reason: "unsupported update asset target: win32-x64",
    });

    const unsupportedArch = selectUpdateAsset({
      version: "v1.2.3",
      platform: "linux",
      arch: "ia32",
    });
    expect(unsupportedArch).toMatchObject({
      supported: false,
      reason: "unsupported update asset target: linux-ia32",
    });
    expect(unsupportedArch).not.toHaveProperty("fileName");
  });

  it("parses sha256sum-compatible checksums.txt entries", () => {
    const linuxDigest = "B".repeat(64);
    const darwinDigest = "a".repeat(64);
    const checksumsText = [
      `${linuxDigest}  combo-chen-v1.2.3-linux-x64.tar.gz`,
      `${darwinDigest} *combo-chen-v1.2.3-darwin-arm64.tar.gz`,
      "",
    ].join("\n");

    expect(parseUpdateChecksums(checksumsText)).toEqual([
      {
        line: 1,
        fileName: "combo-chen-v1.2.3-linux-x64.tar.gz",
        sha256: linuxDigest.toLowerCase(),
      },
      {
        line: 2,
        fileName: "combo-chen-v1.2.3-darwin-arm64.tar.gz",
        sha256: darwinDigest,
      },
    ]);
  });

  it("looks up expected checksums by exact asset filename", () => {
    const entries = parseUpdateChecksums(
      [
        `${"1".repeat(64)}  combo-chen-v1.2.3-darwin-arm64.tar.gz`,
        `${"2".repeat(64)}  combo-chen-v1.2.3-linux-x64.tar.gz`,
      ].join("\n"),
    );

    expect(
      lookupUpdateChecksum({
        checksums: entries,
        fileName: "combo-chen-v1.2.3-linux-x64.tar.gz",
      }),
    ).toEqual({
      fileName: "combo-chen-v1.2.3-linux-x64.tar.gz",
      found: true,
      expectedSha256: "2".repeat(64),
    });

    expect(
      lookupUpdateChecksum({
        checksums: entries,
        fileName: "combo-chen-v1.2.3-linux-arm64.tar.gz",
      }),
    ).toEqual({
      fileName: "combo-chen-v1.2.3-linux-arm64.tar.gz",
      found: false,
      reason: "checksum not found for combo-chen-v1.2.3-linux-arm64.tar.gz",
    });
  });

  it("rejects malformed or duplicate checksum entries", () => {
    expect(() => parseUpdateChecksums("not-a-checksum  asset.tar.gz\n")).toThrow(
      "invalid checksums.txt line 1",
    );

    expect(() =>
      parseUpdateChecksums(
        [
          `${"a".repeat(64)}  combo-chen-v1.2.3-linux-x64.tar.gz`,
          `${"b".repeat(64)}  combo-chen-v1.2.3-linux-x64.tar.gz`,
        ].join("\n"),
      ),
    ).toThrow("duplicate checksum entry for combo-chen-v1.2.3-linux-x64.tar.gz");
  });

  it("classifies release archive install targets as auto-replaceable", () => {
    expect(classifyInstallTarget({ path: "/opt/combo-chen-v1.2.3/bin/combo-chen" })).toEqual({
      path: "/opt/combo-chen-v1.2.3/bin/combo-chen",
      kind: "release_archive",
      autoReplaceable: true,
      reason: "release archive bin path is eligible for future archive replacement",
    });

    expect(
      classifyInstallTarget({ path: "/opt/combo-chen-v1.2.3-beta.4/bin/combo-chen" }),
    ).toMatchObject({
      kind: "release_archive",
      autoReplaceable: true,
    });
  });

  it("classifies source checkout and dev shim install targets as non-auto-replaceable", () => {
    expect(classifyInstallTarget({ path: "/work/combo-chen/src/cli/main.ts" })).toEqual({
      path: "/work/combo-chen/src/cli/main.ts",
      kind: "source_checkout",
      autoReplaceable: false,
      reason: "source checkout path must not be auto-replaced",
    });

    expect(classifyInstallTarget({ path: "/work/combo-chen/dist/cli.mjs" })).toMatchObject({
      kind: "source_checkout",
      autoReplaceable: false,
    });

    expect(classifyInstallTarget({ path: "/work/combo-chen/node_modules/.bin/combo-chen" })).toEqual({
      path: "/work/combo-chen/node_modules/.bin/combo-chen",
      kind: "dev_shim",
      autoReplaceable: false,
      reason: "package manager shim must not be auto-replaced",
    });
  });

  it("classifies real node_modules .bin symlinks by the original shim path", () => {
    const root = mkdtempSync(join(tmpdir(), "combo-chen-update-contract-"));
    const releaseBin = join(root, "combo-chen-v1.2.3", "bin");
    const shimBin = join(root, "node_modules", ".bin");
    mkdirSync(releaseBin, { recursive: true });
    mkdirSync(shimBin, { recursive: true });
    const releaseTarget = join(releaseBin, "combo-chen");
    const shimPath = join(shimBin, "combo-chen");
    writeFileSync(releaseTarget, "cli\n");
    symlinkSync(releaseTarget, shimPath);

    expect(classifyInstallTarget({ path: shimPath })).toEqual({
      path: shimPath,
      kind: "dev_shim",
      autoReplaceable: false,
      reason: "package manager shim must not be auto-replaced",
    });
  });

  it("keeps unknown install targets read-only and non-auto-replaceable", () => {
    expect(classifyInstallTarget({ path: "/usr/local/bin/combo-chen" })).toEqual({
      path: "/usr/local/bin/combo-chen",
      kind: "unknown",
      autoReplaceable: false,
      reason: "unknown install target must not be auto-replaced",
    });
  });

  it("compares current build metadata with a newer release candidate", () => {
    expect(
      compareReleaseCandidate({
        current: { version: "0.0.51", commit: "abc1234", date: "2026-06-21T12:00:00.000Z" },
        candidate: { tagName: "v0.0.52", prerelease: false },
      }),
    ).toMatchObject({
      state: "update_available",
      current: { version: "0.0.51", channel: "stable" },
      candidate: { version: "0.0.52", channel: "stable" },
    });
  });

  it("treats a stable release as newer than the same-core prerelease", () => {
    expect(
      compareReleaseCandidate({
        current: { version: "1.2.3-beta.2", commit: "abc1234", date: "2026-06-21T12:00:00.000Z" },
        candidate: { tagName: "v1.2.3", prerelease: false },
      }),
    ).toMatchObject({
      state: "update_available",
      current: { version: "1.2.3-beta.2", channel: "prerelease" },
      candidate: { version: "1.2.3", channel: "stable" },
    });
  });

  it("compares prerelease candidates using numeric and string identifier rules", () => {
    expect(
      compareReleaseCandidate({
        current: { version: "1.2.3-beta.2", commit: "abc1234", date: "2026-06-21T12:00:00.000Z" },
        candidate: { tagName: "v1.2.3-beta.10", prerelease: true },
      }),
    ).toMatchObject({
      state: "update_available",
      current: { version: "1.2.3-beta.2" },
      candidate: { version: "1.2.3-beta.10" },
    });

    expect(
      compareReleaseCandidate({
        current: { version: "1.2.3-beta.10", commit: "abc1234", date: "2026-06-21T12:00:00.000Z" },
        candidate: { tagName: "v1.2.3-beta.2", prerelease: true },
      }).state,
    ).toBe("candidate_older");

    expect(
      compareReleaseCandidate({
        current: { version: "1.2.3-alpha", commit: "abc1234", date: "2026-06-21T12:00:00.000Z" },
        candidate: { tagName: "v1.2.3-beta", prerelease: true },
      }),
    ).toMatchObject({
      state: "update_available",
      candidate: { version: "1.2.3-beta" },
    });
  });

  it("reports channel as prerelease when GitHub prerelease flag is set on a stable-looking tag", () => {
    const result = compareReleaseCandidate({
      current: { version: "1.2.3", commit: "abc1234", date: "2026-06-21T12:00:00.000Z" },
      candidate: { tagName: "v1.2.4", prerelease: true },
    });
    expect(result.candidate.channel).toBe("prerelease");
    expect(result.state).toBe("update_available");
  });

  it("treats same-core prerelease-flag candidates as older than stable current", () => {
    expect(
      compareReleaseCandidate({
        current: { version: "1.2.3", commit: "abc1234", date: "2026-06-21T12:00:00.000Z" },
        candidate: { tagName: "v1.2.3", prerelease: true },
      }).state,
    ).toBe("candidate_older");
  });

  it("reports equal or older candidates without claiming an update", () => {
    expect(
      compareReleaseCandidate({
        current: { version: "1.2.3", commit: "abc1234", date: "2026-06-21T12:00:00.000Z" },
        candidate: { tagName: "v1.2.3", prerelease: false },
      }).state,
    ).toBe("current");

    expect(
      compareReleaseCandidate({
        current: { version: "1.2.3", commit: "abc1234", date: "2026-06-21T12:00:00.000Z" },
        candidate: { tagName: "v1.2.2", prerelease: false },
      }).state,
    ).toBe("candidate_older");
  });

  it("throws on invalid release version input", () => {
    expect(() => normalizeReleaseVersion("not-a-version")).toThrow("invalid combo-chen release version");
    expect(() => normalizeReleaseVersion("")).toThrow("invalid combo-chen release version");
    expect(() => normalizeReleaseVersion("v1.2")).toThrow("invalid combo-chen release version");
  });

  it("parses empty checksums text without errors", () => {
    expect(parseUpdateChecksums("")).toEqual([]);
  });

  it("parses checksums with CRLF line endings", () => {
    const digest = "a".repeat(64);
    const checksumsText = `${digest}  combo-chen-v1.2.3-darwin-arm64.tar.gz\r\n${digest} *combo-chen-v1.2.3-linux-x64.tar.gz\r\n`;
    expect(parseUpdateChecksums(checksumsText)).toEqual([
      { line: 1, fileName: "combo-chen-v1.2.3-darwin-arm64.tar.gz", sha256: digest },
      { line: 2, fileName: "combo-chen-v1.2.3-linux-x64.tar.gz", sha256: digest },
    ]);
  });
});
// -/ 1/1
