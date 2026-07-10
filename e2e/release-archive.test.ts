/**
 * @overview Hermetic end-to-end proof that a produced release archive is
 *   runnable: extract the real tarball into a clean directory and execute the
 *   installed CLI with no sibling dist files available.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at the describe block   <- produce, extract, execute.
 *   2. Then produceAndExtract        <- release producer + tar extraction.
 *
 *   MAIN FLOW
 *   ---------
 *   dist build -> produceReleaseAssets -> tar -xzf -> bin/combo-chen --version/status
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   produceAndExtract, runExtractedCli.
 *
 * @exports none
 * @deps vitest, node:{child_process,fs,path,url}, ../src/update/index
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { PASSIVE_UPDATE_DISABLE_ENV, produceReleaseAssets, releaseArchiveRoot } from "../src/update/index.js";

// -- 1/2 HELPER · produce + extract + run --
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const packageVersion = (
  JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string }
).version;

const cleanupDirs: string[] = [];

function produceAndExtract(): string {
  const root = mkdtempSync(join(tmpdir(), "combo-chen-release-e2e-"));
  cleanupDirs.push(root);
  const outDir = join(root, "assets");
  const target = { platform: "darwin", arch: "arm64" };
  const produced = produceReleaseAssets({
    repoDir: repoRoot,
    outDir,
    version: packageVersion,
    targets: [target],
  });
  const asset = produced.assets[0];
  if (asset === undefined) throw new Error("release producer returned no asset");
  const extract = spawnSync("tar", ["-xzf", asset.filePath, "-C", root], { encoding: "utf8" });
  if (extract.status !== 0) throw new Error(`tar extraction failed: ${extract.stderr}`);
  return join(root, releaseArchiveRoot(packageVersion));
}

function runExtractedCli(archiveDir: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [join(archiveDir, "bin", "combo-chen"), ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, [PASSIVE_UPDATE_DISABLE_ENV]: "1", ...env },
  });
}

afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});
// -/ 1/2

// -- 2/2 CORE · extracted archive executes <- START HERE --
describe("release archive is self-contained and runnable", () => {
  it("runs bin/combo-chen --version from a clean extraction", () => {
    const archiveDir = produceAndExtract();
    const result = runExtractedCli(archiveDir, ["--version"]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`combo-chen ${packageVersion}`);
  });

  it("smoke-runs a read-only subcommand from the extraction", () => {
    const archiveDir = produceAndExtract();
    const home = mkdtempSync(join(tmpdir(), "combo-chen-release-e2e-home-"));
    cleanupDirs.push(home);
    const result = runExtractedCli(archiveDir, ["status"], { COMBO_CHEN_HOME: home });
    expect(result.status).toBe(0);
  });
});
// -/ 2/2
