/**
 * @overview Unit tests for the read-only updater contract foundation.
 *   ~130 lines, no exports, pins release identity, asset selection, and candidate comparison.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at normalizeReleaseVersion tests <- release tag/version contract.
 *   2. Then selectUpdateAsset tests            <- supported platform asset contract.
 *   3. Then compareReleaseCandidate tests      <- current versus candidate state.
 *
 *   MAIN FLOW
 *   ---------
 *   release tag or version -> normalized release version -> asset/comparison result
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
 * @deps vitest, ./update-contract
 */
import { describe, expect, it } from "vitest";

import {
  compareReleaseCandidate,
  normalizeReleaseVersion,
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
});
// -/ 1/1
