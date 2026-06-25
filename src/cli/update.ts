/**
 * @overview Active update command assembly for combo-chen release archives.
 *   ~430 lines, 4 exports, wires release resolution, active-runtime safety, verified staging, and installer replacement.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at runUpdateCommand         <- command-level updater orchestration.
 *   2. Then defaultUpdateCommandDeps     <- production network/filesystem adapters.
 *   3. Skim fetchGitHubReleases          <- GitHub Releases metadata boundary.
 *
 *   MAIN FLOW
 *   ---------
 *   gh releases -> read-only plan -> active-runtime guard -> download/checksum/stage -> guarded replacement -> user output
 *
 *   PUBLIC API
 *   ----------
 *   UpdateCommandDeps          Injectable command boundary for tests and real CLI wiring.
 *   UpdateCommandOptions       Parsed command flags.
 *   defaultUpdateCommandDeps   Production adapters for the update command.
 *   runUpdateCommand           Active self-update command implementation.
 *
 *   INTERNALS
 *   ---------
 *   fetchGitHubReleases, detectActiveRuntimeForUpdate, activeRuntimeWarning, parseRelease, parseAsset, defaultExtractArchive, commandError.
 *
 * @exports UpdateCommandDeps, UpdateCommandOptions, defaultUpdateCommandDeps, runUpdateCommand
 * @deps node:{child_process,fs,os,path}, ../core/{active-runtime,state,update-contract,update-install,update-resolver,update-staging}, ../infra/{release-artifacts,release-metadata}
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectActiveComboRuntime,
  type ActiveComboRuntimeDetection,
} from "../core/active-runtime.js";
import { comboHome } from "../core/state.js";
import {
  classifyInstallTarget,
  type CurrentBuildMetadata,
} from "../core/update-contract.js";
import {
  replaceInstallTargetFromStagedArtifact,
  type InstallReplacementInput,
  type InstallReplacementResult,
} from "../core/update-install.js";
import {
  resolveReadOnlyUpdatePlan,
  type GitHubReleaseAssetMetadata,
  type GitHubReleaseMetadata,
} from "../core/update-resolver.js";
import {
  stageResolvedUpdate,
  type StagedUpdateArtifact,
  type UpdateDownloadRequest,
  type UpdateExtractionInput,
  type UpdateExtractionResult,
} from "../core/update-staging.js";
import { RELEASE_CHECKSUMS_FILE } from "../infra/release-artifacts.js";
import { releaseMetadata } from "../infra/release-metadata.js";

// -- 1/3 HELPER · command dependency contract --
const UPDATE_REPOSITORY_API_PATH = "repos/thellmwhisperer/combo-chen/releases?per_page=100";
const UPDATE_DOWNLOAD_TIMEOUT_MS = (() => {
  const env = process.env.COMBO_CHEN_UPDATE_DOWNLOAD_TIMEOUT_MS;
  if (env !== undefined) {
    const parsed = Number.parseInt(env, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return 60_000;
})();

export interface UpdateCommandDeps {
  gh: (args: string[]) => { status: number; stdout: string; stderr: string };
  out: (line: string) => void;
  current: CurrentBuildMetadata;
  platform: string;
  arch: string;
  installTargetPath: string;
  makeStagingDir: () => string;
  download: (request: UpdateDownloadRequest) => Promise<Uint8Array | string> | Uint8Array | string;
  mkdir: (path: string) => Promise<void> | void;
  writeFile: (path: string, data: Uint8Array | string) => Promise<void> | void;
  remove: (path: string) => Promise<void> | void;
  extractArchive: (input: UpdateExtractionInput) => Promise<UpdateExtractionResult> | UpdateExtractionResult;
  replaceInstallTarget: (input: InstallReplacementInput) => InstallReplacementResult;
  activeRuntime: () => ActiveComboRuntimeDetection;
}

export interface UpdateCommandOptions {
  beta: boolean;
  yes: boolean;
  deps: UpdateCommandDeps;
}

export function defaultUpdateCommandDeps(input: {
  gh: UpdateCommandDeps["gh"];
  out: UpdateCommandDeps["out"];
  argv1?: string;
  env?: Record<string, string | undefined>;
}): UpdateCommandDeps {
  return {
    gh: input.gh,
    out: input.out,
    current: releaseMetadata,
    platform: process.platform,
    arch: process.arch,
    installTargetPath: input.argv1 ?? process.argv[1] ?? "",
    makeStagingDir: () => mkdtempSync(join(tmpdir(), "combo-chen-update-")),
    async download(request) {
      const response = await fetch(request.url, { signal: AbortSignal.timeout(UPDATE_DOWNLOAD_TIMEOUT_MS) });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    mkdir(path) {
      mkdirSync(path, { recursive: true });
    },
    writeFile(path, data) {
      writeFileSync(path, data);
    },
    remove(path) {
      rmSync(path, { recursive: true, force: true });
    },
    extractArchive: defaultExtractArchive,
    replaceInstallTarget: (replacement) => replaceInstallTargetFromStagedArtifact(replacement),
    activeRuntime: () =>
      detectActiveComboRuntime({
        home: comboHome(input.env ?? process.env),
        cli: input.argv1 ?? process.argv[1],
      }),
  };
}
// -/ 1/3

// -- 2/3 CORE · runUpdateCommand <- START HERE --
export async function runUpdateCommand(options: UpdateCommandOptions): Promise<void> {
  const mode = options.beta ? "beta" : "stable";
  assertAutoReplaceableInstallTarget(options.deps.installTargetPath);
  const releases = fetchGitHubReleases(options.deps.gh);
  const plan = resolveReadOnlyUpdatePlan({
    current: options.deps.current,
    releases,
    mode,
    assetTarget: {
      platform: options.deps.platform,
      arch: options.deps.arch,
    },
  });

  if (plan.status === "current") {
    options.deps.out(`combo-chen is current: ${plan.current.version}`);
    return;
  }

  if (plan.status === "candidate_older") {
    options.deps.out(
      `combo-chen ${plan.current.version} is newer than latest ${plan.candidate.normalized.version}`,
    );
    return;
  }

  if (plan.status === "missing_release" || plan.status === "unversioned_current_build") {
    throw new Error(plan.reason);
  }

  if (plan.status === "missing_asset" || plan.status === "unsupported_platform") {
    throw new Error(plan.reason);
  }

  const asset = plan.asset;
  const releaseAsset = plan.releaseAsset;
  if (asset?.fileName === undefined || releaseAsset?.browserDownloadUrl === undefined) {
    throw new Error(`release ${plan.candidate.tagName} is missing the selected update archive`);
  }

  const checksumsAsset = plan.candidate.assets.find((candidateAsset) => candidateAsset.name === RELEASE_CHECKSUMS_FILE);

  const candidateVersion = plan.candidate.normalized.version;
  options.deps.out(`update available: combo-chen ${plan.current.version} -> ${candidateVersion} (${mode})`);
  enforceActiveRuntimeSafety({
    detection: detectActiveRuntimeForUpdate(options.deps.activeRuntime),
    yes: options.yes,
    out: options.deps.out,
  });
  if (!options.yes) {
    throw new Error(`confirmation required; rerun with -y/--yes to install ${candidateVersion}`);
  }

  const stagingDir = options.deps.makeStagingDir();
  let staged: StagedUpdateArtifact;
  try {
    staged = await stageResolvedUpdate({
      plan: {
        asset: {
          fileName: asset.fileName,
          downloadUrl: releaseAsset.browserDownloadUrl,
        },
        checksums: {
          fileName: RELEASE_CHECKSUMS_FILE,
          downloadUrl: checksumsAsset?.browserDownloadUrl,
        },
      },
      stagingDir,
      deps: {
        download: options.deps.download,
        mkdir: options.deps.mkdir,
        writeFile: options.deps.writeFile,
        remove: options.deps.remove,
        extractArchive: options.deps.extractArchive,
      },
    });
  } catch (error) {
    options.deps.out(`update failed before replacement: ${errorMessage(error)}`);
    throw error;
  }

  options.deps.out(`verified ${staged.assetFileName} (${staged.actualSha256})`);
  let replacement: InstallReplacementResult;
  try {
    replacement = options.deps.replaceInstallTarget({
      targetPath: options.deps.installTargetPath,
      stagedArtifactRoot: staged.rootDir,
    });
  } finally {
    try {
      await options.deps.remove(stagingDir);
    } catch {
      // A replacement result should not be hidden by a best-effort temp cleanup race.
    }
  }
  options.deps.out(`installed combo-chen ${candidateVersion} to ${replacement.targetPath}`);
}
// -/ 2/3

// -- 3/3 HELPER · GitHub release metadata + extraction adapters --
function fetchGitHubReleases(gh: UpdateCommandDeps["gh"]): GitHubReleaseMetadata[] {
  const result = gh(["api", UPDATE_REPOSITORY_API_PATH]);
  if (result.status !== 0) {
    throw new Error(`gh release query failed: ${commandError(result)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`gh release query returned invalid JSON: ${errorMessage(error)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("gh release query returned invalid JSON: expected an array");
  }
  return parsed.map(parseRelease);
}

function enforceActiveRuntimeSafety(input: {
  detection: ActiveComboRuntimeDetection;
  yes: boolean;
  out: UpdateCommandDeps["out"];
}): void {
  const warning = activeRuntimeWarning(input.detection);
  if (warning === undefined) return;

  input.out(warning);
  if (!input.yes) {
    throw new Error(activeRuntimeConfirmationError(input.detection));
  }
}

function detectActiveRuntimeForUpdate(activeRuntime: UpdateCommandDeps["activeRuntime"]): ActiveComboRuntimeDetection {
  try {
    return activeRuntime();
  } catch (error) {
    return {
      status: "error",
      active: false,
      comboIds: [],
      inspectedRunDirs: [],
      activeCombos: [],
      staleCombos: [],
      errors: [
        {
          reason: "runtime_state_unreadable",
          message: errorMessage(error),
        },
      ],
    };
  }
}

function activeRuntimeWarning(detection: ActiveComboRuntimeDetection): string | undefined {
  if (detection.status === "active") {
    return `warning: active combo runtime detected: ${activeRuntimeSummary(detection)}`;
  }
  if (detection.status === "error" || detection.status === "stale") {
    const staleCount = detection.staleCombos.length;
    const errorCount = detection.errors.length;
    const staleText = `${staleCount} stale run${staleCount === 1 ? "" : "s"}`;
    const errorText = `${errorCount} detection error${errorCount === 1 ? "" : "s"}`;
    return `warning: active combo runtime state is uncertain: ${staleText}, ${errorText}`;
  }
  return undefined;
}

function activeRuntimeSummary(detection: ActiveComboRuntimeDetection): string {
  const activeCombos = detection.activeCombos.map((combo) => `${combo.comboId}(${combo.phase})`);
  if (activeCombos.length > 0) return activeCombos.join(", ");
  if (detection.comboIds.length > 0) return detection.comboIds.join(", ");
  return "unknown";
}

function activeRuntimeConfirmationError(detection: ActiveComboRuntimeDetection): string {
  if (detection.status === "active") {
    return "active combo runtime detected; rerun with -y/--yes to update anyway";
  }
  return "active combo runtime state could not be verified; rerun with -y/--yes to update anyway";
}

function parseRelease(value: unknown): GitHubReleaseMetadata {
  if (!isRecord(value)) throw new Error("GitHub release entry must be an object");
  return {
    tagName: requiredString(value, ["tag_name", "tagName"], "release tag"),
    prerelease: Boolean(value["prerelease"]),
    draft: Boolean(value["draft"]),
    name: optionalString(value, ["name"]),
    publishedAt: optionalString(value, ["published_at", "publishedAt"]),
    assets: Array.isArray(value["assets"]) ? value["assets"].map(parseAsset) : [],
  };
}

function parseAsset(value: unknown): GitHubReleaseAssetMetadata {
  if (!isRecord(value)) throw new Error("GitHub release asset entry must be an object");
  return {
    name: requiredString(value, ["name"], "release asset name"),
    browserDownloadUrl: optionalString(value, ["browser_download_url", "browserDownloadUrl", "downloadUrl"]),
  };
}

function defaultExtractArchive(input: UpdateExtractionInput): UpdateExtractionResult {
  const listed = spawnSync("tar", ["-tzf", input.archivePath], { encoding: "utf8" });
  if ((listed.status ?? 1) !== 0) {
    throw new Error(`tar list failed: ${listed.stderr.trim() || "unknown error"}`);
  }
  const archiveFiles = listed.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const rootName = archiveRootName(input.assetFileName, archiveFiles);

  const extracted = spawnSync("tar", ["-xzf", input.archivePath, "-C", input.destinationDir], {
    encoding: "utf8",
  });
  if ((extracted.status ?? 1) !== 0) {
    throw new Error(`tar extract failed: ${extracted.stderr.trim() || "unknown error"}`);
  }

  const rootDir = join(input.destinationDir, rootName);
  return {
    rootDir,
    executablePath: join(rootDir, "bin", "combo-chen"),
    files: archiveFiles.map((archivePath) => join(input.destinationDir, ...archivePath.split("/"))),
  };
}

function archiveRootName(assetFileName: string, archiveFiles: readonly string[]): string {
  if (archiveFiles.length === 0) throw new Error(`release archive is empty: ${assetFileName}`);

  const roots = new Set<string>();
  for (const archiveFile of archiveFiles) {
    const normalized = archiveFile.replace(/^\.\//, "");
    if (normalized.length === 0 || normalized === ".") continue;

    const parts = normalized.split("/");
    const root = parts[0];
    if (
      root === undefined ||
      root.length === 0 ||
      root === "." ||
      root === ".." ||
      (parts.length === 1 && !normalized.endsWith("/"))
    ) {
      throw new Error(`release archive must contain a single top-level directory: ${assetFileName}`);
    }

    roots.add(root);
    if (roots.size > 1) {
      throw new Error(`release archive must contain a single top-level directory: ${assetFileName}`);
    }
  }

  const rootName = Array.from(roots)[0];
  if (rootName === undefined) {
    throw new Error(`release archive must contain a single top-level directory: ${assetFileName}`);
  }
  return rootName;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requiredString(value: Record<string, unknown>, names: string[], label: string): string {
  const found = optionalString(value, names);
  if (found === undefined || found.length === 0) throw new Error(`GitHub ${label} is required`);
  return found;
}

function optionalString(value: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

function commandError(result: { stdout: string; stderr: string }): string {
  return result.stderr.trim() || result.stdout.trim() || "unknown error";
}

function assertAutoReplaceableInstallTarget(path: string): void {
  const installTarget = classifyInstallTarget({ path });
  if (!installTarget.autoReplaceable || installTarget.kind !== "release_archive") {
    throw new Error(`${installTarget.reason}: ${installTarget.path}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
// -/ 3/3
