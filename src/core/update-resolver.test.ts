/**
 * @overview Unit tests for the read-only GitHub Releases update resolver.
 *   ~100 lines, no exports, pins latest stable/prerelease candidate selection.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at resolveLatestReleaseCandidate tests <- resolver mode contract.
 *
 *   MAIN FLOW
 *   ---------
 *   mocked GitHub Releases metadata -> resolver mode filter -> normalized latest candidate
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   release
 *
 * @exports none
 * @deps vitest, ./update-resolver
 */
import { describe, expect, it } from "vitest";

import { resolveLatestReleaseCandidate, type GitHubReleaseMetadata } from "./update-resolver.js";

// -- 1/1 CORE · GitHub Releases resolver contract <- START HERE --
function release(tagName: string, prerelease = false): GitHubReleaseMetadata {
  return {
    tagName,
    prerelease,
    name: tagName,
    publishedAt: `2026-06-2${tagName.length % 10}T12:00:00.000Z`,
  };
}

describe("update release resolver", () => {
  it("selects the latest stable release by default", () => {
    expect(
      resolveLatestReleaseCandidate({
        releases: [release("v1.2.0"), release("v1.3.0"), release("v1.1.9")],
      }),
    ).toMatchObject({
      status: "found",
      mode: "stable",
      candidate: {
        tagName: "v1.3.0",
        prerelease: false,
        normalized: { version: "1.3.0", channel: "stable" },
      },
    });
  });

  it("ignores prereleases in stable mode even when the prerelease version is newer", () => {
    expect(
      resolveLatestReleaseCandidate({
        releases: [release("v2.0.0-beta.1", true), release("v1.5.0"), release("v1.4.0")],
      }),
    ).toMatchObject({
      status: "found",
      mode: "stable",
      candidate: {
        tagName: "v1.5.0",
        prerelease: false,
        normalized: { version: "1.5.0", channel: "stable" },
      },
    });
  });

  it("includes prereleases in beta mode and selects the latest normalized candidate", () => {
    expect(
      resolveLatestReleaseCandidate({
        mode: "beta",
        releases: [
          release("v1.5.0"),
          release("v2.0.0-beta.1", true),
          release("v2.0.0-beta.3", true),
        ],
      }),
    ).toMatchObject({
      status: "found",
      mode: "beta",
      candidate: {
        tagName: "v2.0.0-beta.3",
        prerelease: true,
        normalized: { version: "2.0.0-beta.3", channel: "prerelease" },
      },
    });
  });

  it("reports missing_release when no release is eligible for the selected mode", () => {
    expect(
      resolveLatestReleaseCandidate({
        releases: [release("v2.0.0-beta.1", true)],
      }),
    ).toEqual({
      status: "missing_release",
      mode: "stable",
      reason: "no stable GitHub release found",
    });
  });
});
// -/ 1/1
