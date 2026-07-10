/**
 * @overview Unit tests for release artifact names, archive layout, and checksums.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at describe("release artifacts") <- pins the update-facing artifact contract.
 *   2. Keep fixture strings literal            <- release automation should consume this shape.
 *
 *   MAIN FLOW
 *   ---------
 *   version/target -> asset name + archive layout -> checksums.txt
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   release artifact fixtures.
 *
 * @exports none
 * @deps vitest, ./release-artifacts
 */
import { describe, expect, it } from "vitest";

import {
  RELEASE_CHECKSUMS_FILE,
  formatChecksums,
  releaseArchiveEntries,
  releaseArchiveRoot,
  releaseAssetFileNames,
} from "./release-artifacts.js";

// -- 1/1 CORE · release artifact contract <- START HERE --
describe("release artifacts", () => {
  it("names platform assets with the stable version-target contract", () => {
    expect(releaseAssetFileNames("v1.2.3")).toEqual([
      "combo-chen-v1.2.3-darwin-arm64.tar.gz",
      "combo-chen-v1.2.3-darwin-x64.tar.gz",
      "combo-chen-v1.2.3-linux-arm64.tar.gz",
      "combo-chen-v1.2.3-linux-x64.tar.gz",
    ]);
  });

  it("defines the archive root and installed CLI layout", () => {
    expect(releaseArchiveRoot("1.2.3")).toBe("combo-chen-v1.2.3");
    expect(releaseArchiveEntries("1.2.3")).toEqual([
      {
        sourcePath: "dist/cli.mjs",
        archivePath: "combo-chen-v1.2.3/bin/combo-chen",
        mode: 0o755,
      },
      {
        sourcePath: "package.json",
        archivePath: "combo-chen-v1.2.3/package.json",
        mode: 0o644,
      },
      {
        sourcePath: "README.md",
        archivePath: "combo-chen-v1.2.3/README.md",
        mode: 0o644,
      },
      {
        sourcePath: "LICENSE",
        archivePath: "combo-chen-v1.2.3/LICENSE",
        mode: 0o644,
      },
      {
        sourcePath: "combo-chen.example.toml",
        archivePath: "combo-chen-v1.2.3/combo-chen.example.toml",
        mode: 0o644,
      },
    ]);
  });

  it("formats checksums.txt in deterministic sha256sum-compatible order", () => {
    expect(RELEASE_CHECKSUMS_FILE).toBe("checksums.txt");
    expect(
      formatChecksums([
        {
          fileName: "combo-chen-v1.2.3-linux-x64.tar.gz",
          sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
        {
          fileName: "combo-chen-v1.2.3-darwin-arm64.tar.gz",
          sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      ]),
    ).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  combo-chen-v1.2.3-darwin-arm64.tar.gz\n" +
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  combo-chen-v1.2.3-linux-x64.tar.gz\n",
    );
  });

  it("rejects malformed release versions before deriving archive paths", () => {
    expect(() => releaseArchiveEntries("1.2.3/../x")).toThrow(
      "invalid combo-chen release version: 1.2.3/../x",
    );
    expect(() => releaseAssetFileNames("1.2.3/../x")).toThrow(
      "invalid combo-chen release version: 1.2.3/../x",
    );
  });
});
// -/ 1/1
