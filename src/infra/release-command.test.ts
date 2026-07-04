/**
 * @overview Unit tests for the runnable release-assets packaging command.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at describe("release assets command") <- package-script and command contract.
 *   2. Fixture helpers only create the minimal repo files the producer archives.
 *
 *   MAIN FLOW
 *   ---------
 *   fixture repo + package version -> runReleaseAssetsCommand -> dist/release assets
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   writeFixtureRepo, readRootPackageJson.
 *
 * @exports none
 * @deps vitest, node:{fs,os,path}, ../core/release-artifacts, ./release-command
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { RELEASE_CHECKSUMS_FILE, releaseAssetFileNames } from "../core/release-artifacts.js";
import { runReleaseAssetsCommand } from "./release-command.js";

interface PackageJson {
  scripts?: Record<string, string>;
}

// -- 1/2 HELPER · command fixtures --
function writeFixtureRepo(version: string): string {
  const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-release-command-"));
  mkdirSync(join(repoDir, "dist"));
  writeFileSync(join(repoDir, "dist", "cli.mjs"), "#!/usr/bin/env node\nconsole.log('combo-chen');\n");
  writeFileSync(join(repoDir, "package.json"), `${JSON.stringify({ name: "combo-chen", version })}\n`);
  writeFileSync(join(repoDir, "README.md"), "# combo-chen\n");
  writeFileSync(join(repoDir, "LICENSE"), "MIT\n");
  writeFileSync(join(repoDir, "combo-chen.example.toml"), "[limits]\nbabysit_poll_seconds = 5\n");
  return repoDir;
}

function readRootPackageJson(): PackageJson {
  return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as PackageJson;
}
// -/ 1/2

// -- 2/2 CORE · release assets command <- START HERE --
describe("release assets command", () => {
  it("materializes default release assets into dist/release using package version", () => {
    const repoDir = writeFixtureRepo("9.8.7");
    const out: string[] = [];

    const result = runReleaseAssetsCommand({ cwd: repoDir, argv: [], out: (line) => out.push(line) });

    expect(result.assets.map((asset) => asset.fileName)).toEqual(releaseAssetFileNames("9.8.7"));
    expect(result.checksumsPath).toBe(join(repoDir, "dist", "release", RELEASE_CHECKSUMS_FILE));
    expect(readFileSync(result.checksumsPath, "utf8")).toContain("combo-chen-v9.8.7-darwin-arm64.tar.gz");
    expect(out).toEqual([`wrote 4 release assets to ${join(repoDir, "dist", "release")}`]);
  });

  it("wires a package script that builds before invoking the bundled entrypoint", () => {
    expect(readRootPackageJson().scripts?.["release:assets"]).toBe("pnpm build && node dist/release-assets.mjs");
  });
});
// -/ 2/2
