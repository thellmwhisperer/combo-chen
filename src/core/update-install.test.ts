/**
 * @overview Unit tests for local update install replacement primitives.
 *   ~130 lines, no exports, pins staged fixture replacement and conservative failure behavior.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at replaceInstallTargetFromStagedArtifact tests <- local file replacement contract.
 *   2. Test helpers at the bottom build temporary release archive fixtures.
 *
 *   MAIN FLOW
 *   ---------
 *   release archive install target + staged artifact fixture -> guarded atomic executable replacement
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   tempDir, writeReleaseFixture, binPath
 *
 * @exports none
 * @deps node:{fs,os,path}, vitest, ./update-install
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync as fsRenameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { replaceInstallTargetFromStagedArtifact } from "./update-install.js";

// -- 1/2 CORE · replaceInstallTargetFromStagedArtifact <- START HERE --
describe("replaceInstallTargetFromStagedArtifact", () => {
  it("replaces supported release archive targets from staged fixtures and preserves executable mode", () => {
    const root = tempDir();
    const installRoot = writeReleaseFixture(join(root, "install"), "1.2.3", "old cli\n", 0o755);
    const stagedRoot = writeReleaseFixture(join(root, "stage"), "1.2.4", "new cli\n", 0o644);
    const targetPath = binPath(installRoot);

    const result = replaceInstallTargetFromStagedArtifact({
      targetPath,
      stagedArtifactRoot: stagedRoot,
    });

    expect(result).toMatchObject({
      targetPath,
      stagedExecutablePath: binPath(stagedRoot),
      replaced: true,
      executableMode: 0o755,
      installTarget: {
        kind: "release_archive",
        autoReplaceable: true,
      },
    });
    expect(readFileSync(targetPath, "utf8")).toBe("new cli\n");
    expect(statSync(targetPath).mode & 0o777).toBe(0o755);
    expect(readFileSync(binPath(stagedRoot), "utf8")).toBe("new cli\n");
  });

  it("refuses source checkouts, package-manager shims, and unknown layouts with classification errors", () => {
    const root = tempDir();
    const stagedRoot = writeReleaseFixture(join(root, "stage"), "1.2.4", "new cli\n", 0o755);
    const sourcePath = join(root, "repo", "src", "cli", "main.ts");
    const shimPath = join(root, "repo", "node_modules", ".bin", "combo-chen");
    const unknownPath = join(root, "bin", "combo-chen");
    mkdirSync(join(root, "repo", "src", "cli"), { recursive: true });
    mkdirSync(join(root, "repo", "node_modules", ".bin"), { recursive: true });
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(sourcePath, "source");
    writeFileSync(shimPath, "shim");
    writeFileSync(unknownPath, "unknown");

    expect(() =>
      replaceInstallTargetFromStagedArtifact({ targetPath: sourcePath, stagedArtifactRoot: stagedRoot }),
    ).toThrow(`source checkout path must not be auto-replaced: ${sourcePath}`);
    expect(() =>
      replaceInstallTargetFromStagedArtifact({ targetPath: shimPath, stagedArtifactRoot: stagedRoot }),
    ).toThrow(`package manager shim must not be auto-replaced: ${shimPath}`);
    expect(() =>
      replaceInstallTargetFromStagedArtifact({ targetPath: unknownPath, stagedArtifactRoot: stagedRoot }),
    ).toThrow(`unknown install target must not be auto-replaced: ${unknownPath}`);
  });

  it("reports unsupported staged artifact layouts before touching the installed target", () => {
    const root = tempDir();
    const installRoot = writeReleaseFixture(join(root, "install"), "1.2.3", "old cli\n", 0o755);
    const stagedRoot = join(root, "stage", "combo-chen-v1.2.4");
    mkdirSync(stagedRoot, { recursive: true });
    const targetPath = binPath(installRoot);

    expect(() =>
      replaceInstallTargetFromStagedArtifact({ targetPath, stagedArtifactRoot: stagedRoot }),
    ).toThrow(`staged artifact is missing bin/combo-chen: ${binPath(stagedRoot)}`);
    expect(readFileSync(targetPath, "utf8")).toBe("old cli\n");
  });

  it("leaves the previous installation intact when the final replacement fails", () => {
    const root = tempDir();
    const installRoot = writeReleaseFixture(join(root, "install"), "1.2.3", "old cli\n", 0o755);
    const stagedRoot = writeReleaseFixture(join(root, "stage"), "1.2.4", "new cli\n", 0o755);
    const targetPath = binPath(installRoot);
    const renameSync = vi.fn((from: Parameters<typeof fsRenameSync>[0], to: Parameters<typeof fsRenameSync>[1]) => {
      if (String(to) === targetPath) throw new Error("simulated replacement failure");
      fsRenameSync(from, to);
    });

    expect(() =>
      replaceInstallTargetFromStagedArtifact(
        { targetPath, stagedArtifactRoot: stagedRoot },
        { renameSync },
      ),
    ).toThrow("simulated replacement failure");

    expect(readFileSync(targetPath, "utf8")).toBe("old cli\n");
    expect(statSync(targetPath).mode & 0o777).toBe(0o755);
    expect(readdirSync(join(installRoot, "bin"))).toEqual(["combo-chen"]);
  });
});
// -/ 1/2

// -- 2/2 HELPER · temporary release fixture builders --
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "combo-chen-update-install-"));
}

function writeReleaseFixture(parent: string, version: string, executable: string, mode: number): string {
  const root = join(parent, `combo-chen-v${version}`);
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "combo-chen"), executable);
  chmodSync(join(bin, "combo-chen"), mode);
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ version })}\n`);
  return root;
}

function binPath(root: string): string {
  return join(root, "bin", "combo-chen");
}

// -/ 2/2
