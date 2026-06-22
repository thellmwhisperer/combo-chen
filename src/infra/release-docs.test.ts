/**
 * @overview Contract tests for the public release and update documentation.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at describe("release docs") <- updater-facing documentation contract.
 *   2. The helper only loads checked-in Markdown docs.
 *
 *   MAIN FLOW
 *   ---------
 *   README/spec markdown -> canonical release/update strings -> future updater guidance
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   readDoc, normalizeDoc.
 *
 * @exports none
 * @deps vitest, node:fs
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// -- 1/2 HELPER · markdown fixtures --
function readDoc(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

function normalizeDoc(body: string): string {
  return body.replace(/\s+/g, " ");
}
// -/ 1/2

// -- 2/2 CORE · release docs <- START HERE --
describe("release docs", () => {
  it("documents the release artifact contract for future update code", () => {
    const readme = readDoc("README.md");
    const spec = readDoc("docs/spec.md");

    for (const doc of [readme, spec].map(normalizeDoc)) {
      expect(doc).toContain("combo-chen-vX.Y.Z-<platform>-<arch>.tar.gz");
      expect(doc).toContain("checksums.txt");
      expect(doc).toContain("sha256sum-compatible");
      expect(doc).toContain("bin/combo-chen");
      expect(doc).toContain("combo-chen --version");
      expect(doc).toContain("pnpm release:assets");
      expect(doc).toContain("published and prereleased GitHub releases");
      expect(doc).toContain("No network update or executable replacement behavior");
    }
  });

  it("documents the U0 update bridge and follow-up updater slice boundaries", () => {
    const readme = normalizeDoc(readDoc("README.md"));
    const spec = normalizeDoc(readDoc("docs/spec.md"));

    for (const doc of [readme, spec]) {
      expect(doc).toContain("U0 update contract bridge");
      expect(doc).toContain("ReadOnlyUpdatePlan");
      expect(doc).toContain("source checkouts and package-manager dev shims are non-auto-replaceable");
      expect(doc).toContain("does not download, extract, replace, restart, or mutate active combo capsules");
      expect(doc).toContain("U1: release resolver and latest/beta check flow");
      expect(doc).toContain("U2: download, checksum verification, and staging");
      expect(doc).toContain("U3: install target and atomic replacement");
      expect(doc).toContain("U4: active capsule guard");
    }
  });
});
// -/ 2/2
