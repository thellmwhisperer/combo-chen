/**
 * @overview Hermetic end-to-end coverage for the tarball install channel:
 *   install.sh installs a produced archive into a versions prefix + bin
 *   symlink, the layout classifies as an auto-replaceable release_archive,
 *   and combo-chen update performs a real local replacement on it.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at the describe block   <- install, verify, corrupt, update.
 *   2. Then produceArchive           <- release producer over a staged repo dir.
 *   3. Then runInstall               <- install.sh subprocess harness.
 *
 *   MAIN FLOW
 *   ---------
 *   produceReleaseAssets -> install.sh --archive -> symlink runs ->
 *   classifyInstallTarget -> runUpdateCommand with local artifacts
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   produceArchive, runInstall, runInstalledCli, tempDir.
 *
 * @exports none
 * @deps vitest, node:{child_process,fs,path,url}, ../src/update/index, ../src/infra/release-producer
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { produceReleaseAssets } from "../src/infra/release-producer.js";
import {
  classifyInstallTarget,
  defaultUpdateCommandDeps,
  releaseArchiveRoot,
  releaseAssetFileName,
  runUpdateCommand,
  type ReleaseTarget,
} from "../src/update/index.js";

// -- 1/3 HELPER · producer + install harness --
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const installScript = join(repoRoot, "install.sh");
const packageVersion = (
  JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string }
).version;
const TARGET = currentShellTarget();

const cleanupDirs: string[] = [];

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `combo-chen-install-e2e-${label}-`));
  cleanupDirs.push(dir);
  return dir;
}

function currentShellTarget(): ReleaseTarget {
  const platformName = shellOutput("uname", ["-s"]);
  const archName = shellOutput("uname", ["-m"]);
  const platforms: Record<string, ReleaseTarget["platform"]> = { Darwin: "darwin", Linux: "linux" };
  const arches: Record<string, ReleaseTarget["arch"]> = {
    arm64: "arm64",
    aarch64: "arm64",
    x86_64: "x64",
    amd64: "x64",
  };
  const platform = platforms[platformName];
  const arch = arches[archName];
  if (platform === undefined) throw new Error(`unsupported install test platform: ${platformName}`);
  if (arch === undefined) throw new Error(`unsupported install test architecture: ${archName}`);
  return { platform, arch };
}

function shellOutput(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** Produce a release archive; cliMarker appends bytes so replacement is provable. */
function produceArchive(version: string, cliMarker?: string): { assetPath: string; checksumsPath: string } {
  const stagedRepo = tempDir(`repo-${version}`);
  mkdirSync(join(stagedRepo, "dist"), { recursive: true });
  const cli = readFileSync(join(repoRoot, "dist", "cli.mjs"), "utf8");
  writeFileSync(
    join(stagedRepo, "dist", "cli.mjs"),
    cliMarker === undefined ? cli : `${cli}\n// ${cliMarker}\n`,
  );
  for (const file of ["package.json", "README.md", "LICENSE", "combo-chen.example.toml"]) {
    copyFileSync(join(repoRoot, file), join(stagedRepo, file));
  }
  const outDir = join(stagedRepo, "out");
  const produced = produceReleaseAssets({ repoDir: stagedRepo, outDir, version, targets: [TARGET] });
  const asset = produced.assets[0];
  if (asset === undefined) throw new Error("release producer returned no asset");
  return { assetPath: asset.filePath, checksumsPath: produced.checksumsPath };
}

function runInstall(args: string[]) {
  return spawnSync("sh", [installScript, ...args], { encoding: "utf8", timeout: 30_000 });
}

function runInstalledCli(binPath: string, args: string[]) {
  return spawnSync(process.execPath, [binPath, ...args], { encoding: "utf8", timeout: 30_000 });
}

afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});
// -/ 1/3

// -- 2/3 CORE · install.sh contract <- START HERE --
describe("install.sh tarball channel", () => {
  it("installs from a local archive and the symlinked CLI runs", () => {
    const { assetPath, checksumsPath } = produceArchive(packageVersion);
    const root = tempDir("happy");
    const prefix = join(root, "versions");
    const binDir = join(root, "bin");

    const result = runInstall([
      "--archive",
      assetPath,
      "--checksums",
      checksumsPath,
      "--prefix",
      prefix,
      "--bin-dir",
      binDir,
    ]);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const link = join(binDir, "combo-chen");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    const version = runInstalledCli(link, ["--version"]);
    expect(version.status).toBe(0);
    expect(version.stdout).toContain("combo-chen");
  });

  it("classifies the installed layout as an auto-replaceable release archive", () => {
    const { assetPath, checksumsPath } = produceArchive(packageVersion);
    const root = tempDir("classify");
    const binDir = join(root, "bin");
    runInstall([
      "--archive",
      assetPath,
      "--checksums",
      checksumsPath,
      "--prefix",
      join(root, "versions"),
      "--bin-dir",
      binDir,
    ]);

    const classification = classifyInstallTarget({ path: join(binDir, "combo-chen") });

    expect(classification.kind).toBe("release_archive");
    expect(classification.autoReplaceable).toBe(true);
  });

  it("aborts on checksum mismatch without installing anything", () => {
    const { assetPath, checksumsPath } = produceArchive(packageVersion);
    const corrupted = join(tempDir("corrupt"), "checksums.txt");
    writeFileSync(corrupted, readFileSync(checksumsPath, "utf8").replace(/^[0-9a-f]{8}/m, "deadbeef"));
    const root = tempDir("mismatch");
    const prefix = join(root, "versions");
    const binDir = join(root, "bin");

    const result = runInstall([
      "--archive",
      assetPath,
      "--checksums",
      corrupted,
      "--prefix",
      prefix,
      "--bin-dir",
      binDir,
    ]);

    expect(result.status).not.toBe(0);
    expect(existsSync(join(prefix, releaseArchiveRoot(packageVersion)))).toBe(false);
    expect(existsSync(join(binDir, "combo-chen"))).toBe(false);
  });

  it("is idempotent and keeps the previous version directory on upgrade", () => {
    const current = produceArchive(packageVersion);
    const next = produceArchive("9.9.9");
    const root = tempDir("upgrade");
    const prefix = join(root, "versions");
    const binDir = join(root, "bin");
    const currentArgs = [
      "--archive",
      current.assetPath,
      "--checksums",
      current.checksumsPath,
      "--prefix",
      prefix,
      "--bin-dir",
      binDir,
    ];

    expect(runInstall(currentArgs).status).toBe(0);
    expect(runInstall(currentArgs).status).toBe(0);
    const upgraded = runInstall([
      "--archive",
      next.assetPath,
      "--checksums",
      next.checksumsPath,
      "--prefix",
      prefix,
      "--bin-dir",
      binDir,
    ]);

    expect(upgraded.status).toBe(0);
    expect(existsSync(join(prefix, releaseArchiveRoot(packageVersion), "bin", "combo-chen"))).toBe(true);
    const version = runInstalledCli(join(binDir, "combo-chen"), ["--version"]);
    expect(version.status).toBe(0);
  });

  it("refuses to overwrite a non-symlink bin target", () => {
    const { assetPath, checksumsPath } = produceArchive(packageVersion);
    const root = tempDir("occupied");
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "combo-chen"), "#!/bin/sh\necho not ours\n");

    const result = runInstall([
      "--archive",
      assetPath,
      "--checksums",
      checksumsPath,
      "--prefix",
      join(root, "versions"),
      "--bin-dir",
      binDir,
    ]);

    expect(result.status).not.toBe(0);
    expect(readFileSync(join(binDir, "combo-chen"), "utf8")).toContain("not ours");
  });
});
// -/ 2/3

// -- 3/3 CORE · combo-chen update on the installed layout --
describe("combo-chen update over an install.sh layout", () => {
  it("replaces the installed executable from local release artifacts", async () => {
    const current = produceArchive(packageVersion);
    const marker = "combo-chen-update-e2e-marker-9.9.9";
    const next = produceArchive("9.9.9", marker);
    const root = tempDir("update");
    const binDir = join(root, "bin");
    runInstall([
      "--archive",
      current.assetPath,
      "--checksums",
      current.checksumsPath,
      "--prefix",
      join(root, "versions"),
      "--bin-dir",
      binDir,
    ]);
    const link = join(binDir, "combo-chen");
    const assetName = releaseAssetFileName("9.9.9", TARGET);
    const lines: string[] = [];
    const deps = {
      ...defaultUpdateCommandDeps({
        gh: () => ({
          status: 0,
          stdout: JSON.stringify([
            {
              tag_name: "combo-chen-v9.9.9",
              prerelease: false,
              draft: false,
              assets: [
                { name: assetName, browser_download_url: `file://${next.assetPath}` },
                { name: "checksums.txt", browser_download_url: `file://${next.checksumsPath}` },
              ],
            },
          ]),
          stderr: "",
        }),
        out: (line: string) => lines.push(line),
        argv1: link,
        env: { COMBO_CHEN_HOME: tempDir("home") },
      }),
      platform: TARGET.platform,
      arch: TARGET.arch,
      download: (request: { fileName: string }) =>
        readFileSync(request.fileName === "checksums.txt" ? next.checksumsPath : next.assetPath),
      postUpdateRefresh: () => ({ ok: true, attemptedDaemonRefresh: false, lines: [] }),
    };

    await runUpdateCommand({ beta: false, yes: true, deps });

    expect(readFileSync(link, "utf8")).toContain(marker);
    const version = runInstalledCli(link, ["--version"]);
    expect(version.status).toBe(0);
    expect(lines.join("\n")).toContain("9.9.9");
    // The bin symlink must survive replacement: the updater swaps the real
    // versioned executable, so the layout stays auto-replaceable next time.
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    const after = classifyInstallTarget({ path: link });
    expect(after.kind).toBe("release_archive");
    expect(after.autoReplaceable).toBe(true);
  });
});
// -/ 3/3
