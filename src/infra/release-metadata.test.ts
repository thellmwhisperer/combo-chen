/**
 * @overview Unit tests for release metadata formatting and build-time defaults.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at describe("release metadata") <- pins the inspectable version contract.
 *   2. Keep values literal                  <- release automation consumes this text.
 *
 *   MAIN FLOW
 *   ---------
 *   ReleaseMetadata -> formatReleaseMetadata -> CLI --version text
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   release metadata format fixtures.
 *
 * @exports none
 * @deps vitest, ./release-metadata
 */
import { describe, expect, it } from "vitest";

import { formatReleaseMetadata, releaseMetadata } from "./release-metadata.js";

// -- 1/1 CORE · release metadata contract <- START HERE --
describe("release metadata", () => {
  it("renders the inspectable CLI version string", () => {
    expect(
      formatReleaseMetadata({
        version: "1.2.3",
        commit: "abc1234",
        date: "2026-06-18T10:11:12.000Z",
      }),
    ).toBe("combo-chen 1.2.3 (commit abc1234, built 2026-06-18T10:11:12.000Z)");
  });

  it("has fallback source-run metadata when build defines are absent", () => {
    expect(releaseMetadata).toEqual({
      version: "0.0.0-dev",
      commit: "unknown",
      date: "unknown",
    });
  });
});
// -/ 1/1
