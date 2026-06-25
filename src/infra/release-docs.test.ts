/**
 * @overview Contract tests for public release, update, and command documentation.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at describe("release docs") <- public documentation contracts.
 *   2. The helper only loads checked-in Markdown docs.
 *
 *   MAIN FLOW
 *   ---------
 *   README/spec markdown -> canonical release/update and command strings
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
  it("documents the release artifact contract consumed by the updater", () => {
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
      expect(doc).toContain("release asset contract feeds the active `combo-chen update` command");
    }
  });

  it("documents the active update command and live-session handoff", () => {
    const readme = normalizeDoc(readDoc("README.md"));
    const spec = normalizeDoc(readDoc("docs/spec.md"));

    for (const doc of [readme, spec]) {
      expect(doc).toContain("combo-chen update --yes");
      expect(doc).toContain("combo-chen update --beta --yes");
      expect(doc).toContain("downloads the selected archive and checksums.txt");
      expect(doc).toContain("verifies the checksum before extraction");
      expect(doc).toContain("reports failures before replacement");
      expect(doc).toContain("checks persisted active combo runtime state");
      expect(doc).toContain("requires `-y/--yes`");
      expect(doc).toContain("aborts before staging");
      expect(doc).toContain("U0 update contract bridge");
      expect(doc).toContain("ReadOnlyUpdatePlan");
      expect(doc).toContain("detectActiveComboRuntime({ home, cli })");
      expect(doc).toContain("`idle`, `active`, `stale`, or `error`");
      expect(doc).toContain("source checkouts and package-manager dev shims are non-auto-replaceable");
      expect(doc).toContain("U1: release resolver and latest/beta check flow");
      expect(doc).toContain("U2: download, checksum verification, and staging");
      expect(doc).toContain("U3: install target and atomic replacement");
      expect(doc).toContain("U72-B: active-runtime safety prompts and yes flag policy");
      expect(doc).toContain("U72-C: post-update daemon and runner refresh");
    }
  });

  it("documents forensics JSON output and outcome posting as separate command forms", () => {
    const readme = readDoc("README.md");

    expect(readme).toContain("combo-chen forensics --issues <numbers> [--format json]\n");
    expect(readme).toContain("combo-chen forensics --issues <numbers> [--record-outcome]\n");
    expect(readme).not.toContain("combo-chen forensics --issues <numbers> [--format json] [--record-outcome]");
  });
});
// -/ 2/2
