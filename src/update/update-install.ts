/**
 * @overview Local installer replacement primitives for staged update artifacts.
 *   ~150 lines, 4 exports, guards release-archive install targets and swaps the CLI executable.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at replaceInstallTargetFromStagedArtifact <- guarded local replacement entry point.
 *   2. Then InstallReplacementInput/Result             <- the narrow U3 primitive contract.
 *   3. Everything else is validation and filesystem helpers.
 *
 *   MAIN FLOW
 *   ---------
 *   install target path + staged artifact root -> classify -> validate files -> temp copy -> atomic rename
 *
 *   PUBLIC API
 *   ----------
 *   InstallReplacementInput           Target path plus staged artifact root.
 *   InstallReplacementResult          Replacement facts returned after success.
 *   InstallReplacementDeps            Injectable filesystem operations for failure tests.
 *   replaceInstallTargetFromStagedArtifact Replace a supported release-archive CLI executable.
 *
 *   INTERNALS
 *   ---------
 *   defaultInstallReplacementDeps, nonEmptyPath, assertFile, temporarySiblingPath, cleanupTemporary.
 *
 * @exports InstallReplacementInput, InstallReplacementResult, InstallReplacementDeps,
 *   replaceInstallTargetFromStagedArtifact
 * @deps node:{crypto,fs,path}, ./update-contract
 */
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, renameSync, rmSync, statSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";

import { classifyInstallTarget, type InstallTargetClassification } from "./update-contract.js";

// -- 1/3 HELPER · update install replacement types --
const STAGED_INSTALL_EXECUTABLE = "bin/combo-chen";

export interface InstallReplacementInput {
  targetPath: string;
  stagedArtifactRoot: string;
}

export interface InstallReplacementResult {
  targetPath: string;
  stagedExecutablePath: string;
  installTarget: InstallTargetClassification;
  executableMode: number;
  replaced: true;
}

export interface InstallReplacementDeps {
  statSync: typeof statSync;
  copyFileSync: typeof copyFileSync;
  chmodSync: typeof chmodSync;
  renameSync: typeof renameSync;
  rmSync: typeof rmSync;
}

const defaultInstallReplacementDeps: InstallReplacementDeps = {
  statSync,
  copyFileSync,
  chmodSync,
  renameSync,
  rmSync,
};
// -/ 1/3

// -- 2/3 CORE · replaceInstallTargetFromStagedArtifact <- START HERE --
export function replaceInstallTargetFromStagedArtifact(
  input: InstallReplacementInput,
  deps: Partial<InstallReplacementDeps> = {},
): InstallReplacementResult {
  const fs = { ...defaultInstallReplacementDeps, ...deps };
  const targetPath = nonEmptyPath(input.targetPath, "install target path");
  const stagedArtifactRoot = nonEmptyPath(input.stagedArtifactRoot, "staged artifact root");
  const installTarget = classifyInstallTarget({ path: targetPath });

  if (!installTarget.autoReplaceable || installTarget.kind !== "release_archive") {
    throw new Error(`${installTarget.reason}: ${installTarget.path}`);
  }

  const targetStats = assertFile(fs, targetPath, "install target must be an existing file");
  const executableMode = targetStats.mode & 0o777;
  const stagedExecutablePath = join(stagedArtifactRoot, ...STAGED_INSTALL_EXECUTABLE.split("/"));
  assertFile(fs, stagedExecutablePath, "staged artifact is missing bin/combo-chen");

  const temporaryPath = temporarySiblingPath(targetPath);
  try {
    fs.copyFileSync(stagedExecutablePath, temporaryPath);
    fs.chmodSync(temporaryPath, executableMode);
    fs.renameSync(temporaryPath, targetPath);
  } catch (error) {
    cleanupTemporary(fs, temporaryPath);
    throw error;
  }

  return {
    targetPath,
    stagedExecutablePath,
    installTarget,
    executableMode,
    replaced: true,
  };
}
// -/ 2/3

// -- 3/3 HELPER · validation and atomic-swap helpers --
function nonEmptyPath(path: string, label: string): string {
  const trimmed = path.trim();
  if (trimmed.length === 0) throw new Error(`${label} is required`);
  return trimmed;
}

function assertFile(fs: InstallReplacementDeps, path: string, missingMessage: string): Stats {
  let stats: Stats;
  try {
    stats = fs.statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${missingMessage}: ${path}`, { cause: error });
    }
    throw error;
  }

  if (!stats.isFile()) {
    throw new Error(`${missingMessage}: ${path}`);
  }
  return stats;
}

function temporarySiblingPath(targetPath: string): string {
  return join(dirname(targetPath), `.combo-chen-update-${process.pid}-${randomUUID()}.tmp`);
}

function cleanupTemporary(fs: InstallReplacementDeps, path: string): void {
  fs.rmSync(path, { force: true });
}
// -/ 3/3
