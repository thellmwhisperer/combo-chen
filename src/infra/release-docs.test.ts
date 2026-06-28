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

  it("documents the active update command and active-runtime safety guard", () => {
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
      expect(doc).toContain("post-update refresh");
      expect(doc).toContain("no-mistakes daemon start");
      expect(doc).toContain("COMBO_CHEN_POST_UPDATE_DAEMON_REFRESH_TIMEOUT_MS");
      expect(doc).toContain("combo-chen park -n <combo-id>");
      expect(doc).toContain("combo-chen resume -n <combo-id>");
      expect(doc).toContain("installed target remains replaced");
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

  it("documents quiet passive update checks, cache, and disable knob", () => {
    const readme = normalizeDoc(readDoc("README.md"));
    const spec = normalizeDoc(readDoc("docs/spec.md"));

    for (const doc of [readme, spec]) {
      expect(doc).toContain("passive update checks");
      expect(doc).toContain("passive-update-cache.json");
      expect(doc).toContain("24 hours");
      expect(doc).toContain("COMBO_CHEN_DISABLE_PASSIVE_UPDATE_CHECKS");
      expect(doc).toContain("COMBO_CHEN_PASSIVE_UPDATE_LOOKUP_TIMEOUT_MS");
      expect(doc).toContain("default 60000");
      expect(doc).toContain("quiet");
      expect(doc).toContain("JSON/JSONL");
      expect(doc).toContain("never fail the command being run");
    }
  });

  it("documents forensics JSON output and outcome posting as separate command forms", () => {
    const readme = readDoc("README.md");

    expect(readme).toContain("combo-chen forensics --issues <numbers> [--format json]\n");
    expect(readme).toContain("combo-chen forensics --issues <numbers> [--record-outcome]\n");
    expect(readme).not.toContain("combo-chen forensics --issues <numbers> [--format json] [--record-outcome]");
  });

  it("documents PR label projection as single-writer and keeps deep status read-only", () => {
    const spec = normalizeDoc(readDoc("docs/spec.md"));

    expect(spec).toContain("`director-watch` or `director-tick`");
    expect(spec).toContain("status --deep");
    expect(spec).toContain("read-only");
    expect(spec).not.toContain("director-watch loop and `status --deep` keep GitHub PR labels in sync");
    expect(spec).not.toContain("`director-watch` or `status-deep`");
  });
});
// -/ 2/2
