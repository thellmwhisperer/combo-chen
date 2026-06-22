/**
 * @overview U2 update download, checksum verification, and staging primitives.
 *   ~356 lines, 13 exports, orchestrates only injectable network/filesystem/extraction boundaries.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at stageResolvedUpdate      <- main U2 staging primitive.
 *   2. Then UpdateStagingDeps            <- injected I/O contract for tests and CLI wiring.
 *   3. Skim UpdateStagingError           <- deterministic cleanup reporting.
 *
 *   MAIN FLOW
 *   ---------
 *   resolved asset/checksums plan -> downloads dir -> sha256 verification -> extracted staging dir -> descriptor
 *
 *   PUBLIC API
 *   ----------
 *   stageResolvedUpdate        Download, verify, extract, and describe a resolved update asset.
 *   UpdateStagingError         Failure with cleanup status for partial staging.
 *   ResolvedUpdateStagingPlan  Already-resolved U2 input; no release lookup.
 *   UpdateStagingDeps          Injected download/filesystem/extraction boundary.
 *   StagedUpdateArtifact       Descriptor for the future replacement slice.
 *
 *   INTERNALS
 *   ---------
 *   resolveChecksumsText, expectedChecksumForAsset, failWithCleanup, cleanupPartial, sha256Hex, toBuffer,
 *   errorMessage, validateSafePathComponent.
 *
 * @exports UpdateDownloadKind, UpdateDownloadRequest, UpdateExtractionInput, UpdateExtractionResult,
 *   UpdateStagingDeps, ResolvedUpdateAsset, ResolvedUpdateChecksums, ResolvedUpdateStagingPlan,
 *   StagedUpdateArtifact, UpdateStagingErrorCode, UpdateStagingCleanup, UpdateStagingError,
 *   stageResolvedUpdate
 * @deps node:{crypto,path}, ../infra/release-artifacts, ./update-contract
 */
import { createHash } from "node:crypto";
import { join } from "node:path";

import { RELEASE_CHECKSUMS_FILE } from "../infra/release-artifacts.js";
import { lookupUpdateChecksum, parseUpdateChecksums } from "./update-contract.js";

// -- 1/3 HELPER · staging contracts --
export type UpdateDownloadKind = "archive" | "checksums";

export interface UpdateDownloadRequest {
  kind: UpdateDownloadKind;
  url: string;
  fileName: string;
}

export interface UpdateExtractionInput {
  archivePath: string;
  destinationDir: string;
  assetFileName: string;
}

export interface UpdateExtractionResult {
  rootDir: string;
  executablePath: string;
  files: readonly string[];
}

export interface UpdateStagingDeps {
  download(request: UpdateDownloadRequest): Promise<Uint8Array | string> | Uint8Array | string;
  mkdir(path: string): Promise<void> | void;
  writeFile(path: string, data: Uint8Array | string): Promise<void> | void;
  remove(path: string): Promise<void> | void;
  extractArchive(input: UpdateExtractionInput): Promise<UpdateExtractionResult> | UpdateExtractionResult;
}

export interface ResolvedUpdateAsset {
  fileName: string;
  downloadUrl: string;
}

export interface ResolvedUpdateChecksums {
  downloadUrl?: string;
  text?: string;
  fileName?: string;
}

export interface ResolvedUpdateStagingPlan {
  asset: ResolvedUpdateAsset;
  checksums: ResolvedUpdateChecksums;
}

export interface StagedUpdateArtifact {
  assetFileName: string;
  archivePath: string;
  checksumsPath: string;
  expectedSha256: string;
  actualSha256: string;
  stagingDir: string;
  extractedDir: string;
  rootDir: string;
  executablePath: string;
  files: readonly string[];
}

export type UpdateStagingErrorCode =
  | "download_failed"
  | "checksums_unavailable"
  | "checksums_invalid"
  | "checksum_not_found"
  | "checksum_mismatch"
  | "extraction_failed"
  | "unsafe_file_name";

export interface UpdateStagingCleanup {
  attempted: boolean;
  path: string;
  removed: boolean;
  error?: string;
}

interface UpdateStagingErrorDetails {
  code: UpdateStagingErrorCode;
  cleanup: UpdateStagingCleanup;
  cause?: unknown;
}

export class UpdateStagingError extends Error {
  readonly code: UpdateStagingErrorCode;
  readonly cleanup: UpdateStagingCleanup;
  readonly sourceError?: string;

  constructor(message: string, details: UpdateStagingErrorDetails) {
    super(message);
    this.name = "UpdateStagingError";
    this.code = details.code;
    this.cleanup = details.cleanup;
    if (details.cause !== undefined) this.sourceError = errorMessage(details.cause);
  }
}
// -/ 1/3

// -- 2/3 CORE · stageResolvedUpdate <- START HERE --
export async function stageResolvedUpdate(input: {
  plan: ResolvedUpdateStagingPlan;
  stagingDir: string;
  deps: UpdateStagingDeps;
}): Promise<StagedUpdateArtifact> {
  const assetFileName = validateSafePathComponent(input.plan.asset.fileName);
  const checksumsFileName = validateSafePathComponent(
    input.plan.checksums.fileName ?? RELEASE_CHECKSUMS_FILE,
  );
  const downloadsDir = join(input.stagingDir, "downloads");
  const extractedDir = join(input.stagingDir, "extracted");
  const archivePath = join(downloadsDir, assetFileName);
  const checksumsPath = join(downloadsDir, checksumsFileName);

  try {
    await input.deps.mkdir(downloadsDir);

    const archiveBytes = toBuffer(
      await input.deps.download({
        kind: "archive",
        url: input.plan.asset.downloadUrl,
        fileName: assetFileName,
      }),
    );
    await input.deps.writeFile(archivePath, archiveBytes);

    if (input.plan.checksums.text === undefined && input.plan.checksums.downloadUrl === undefined) {
      await failWithCleanup({
        code: "checksums_unavailable",
        message: "checksums.txt text or downloadUrl is required",
        stagingDir: input.stagingDir,
        deps: input.deps,
      });
    }

    const checksumsText = await resolveChecksumsText({
      checksums: input.plan.checksums,
      fileName: checksumsFileName,
      deps: input.deps,
    });
    await input.deps.writeFile(checksumsPath, checksumsText);

    let expectedSha256: string;
    try {
      expectedSha256 = expectedChecksumForAsset({
        checksumsText,
        fileName: assetFileName,
        stagingDir: input.stagingDir,
      });
    } catch (error) {
      return await failWithCleanup({
        code: error instanceof UpdateStagingError ? error.code : "checksums_invalid",
        message: error instanceof Error ? error.message : String(error),
        stagingDir: input.stagingDir,
        deps: input.deps,
        cause: error,
      });
    }
    const actualSha256 = sha256Hex(archiveBytes);
    if (actualSha256 !== expectedSha256) {
      await failWithCleanup({
        code: "checksum_mismatch",
        message:
          `checksum mismatch for ${assetFileName}: ` +
          `expected ${expectedSha256} but downloaded ${actualSha256}`,
        stagingDir: input.stagingDir,
        deps: input.deps,
      });
    }

    await input.deps.mkdir(extractedDir);
    let extracted: UpdateExtractionResult;
    try {
      extracted = await input.deps.extractArchive({
        archivePath,
        destinationDir: extractedDir,
        assetFileName,
      });
    } catch (error) {
      return await failWithCleanup({
        code: "extraction_failed",
        message: `failed to extract ${assetFileName}: ${errorMessage(error)}`,
        stagingDir: input.stagingDir,
        deps: input.deps,
        cause: error,
      });
    }

    return {
      assetFileName,
      archivePath,
      checksumsPath,
      expectedSha256,
      actualSha256,
      stagingDir: input.stagingDir,
      extractedDir,
      rootDir: extracted.rootDir,
      executablePath: extracted.executablePath,
      files: Array.from(extracted.files),
    };
  } catch (error) {
    if (error instanceof UpdateStagingError) throw error;
    return await failWithCleanup({
      code: "download_failed",
      message: `failed to stage ${assetFileName}: ${errorMessage(error)}`,
      stagingDir: input.stagingDir,
      deps: input.deps,
      cause: error,
    });
  }
}
// -/ 2/3

// -- 3/3 HELPER · checksum and cleanup helpers --
async function resolveChecksumsText(input: {
  checksums: ResolvedUpdateChecksums;
  fileName: string;
  deps: UpdateStagingDeps;
}): Promise<string> {
  if (input.checksums.text !== undefined) return input.checksums.text;
  if (input.checksums.downloadUrl === undefined) {
    throw new Error("checksums.txt text or downloadUrl is required");
  }

  return toBuffer(
    await input.deps.download({
      kind: "checksums",
      url: input.checksums.downloadUrl,
      fileName: input.fileName,
    }),
  ).toString("utf8");
}

function expectedChecksumForAsset(input: {
  checksumsText: string;
  fileName: string;
  stagingDir: string;
}): string {
  let entries: ReturnType<typeof parseUpdateChecksums>;
  try {
    entries = parseUpdateChecksums(input.checksumsText);
  } catch (error) {
    throw new UpdateStagingError(`invalid checksums.txt: ${errorMessage(error)}`, {
      code: "checksums_invalid",
      cleanup: {
        attempted: false,
        path: input.stagingDir,
        removed: false,
      },
      cause: error,
    });
  }

  const lookup = lookupUpdateChecksum({ checksums: entries, fileName: input.fileName });
  if (!lookup.found || lookup.expectedSha256 === undefined) {
    throw new UpdateStagingError(lookup.reason ?? `checksum not found for ${input.fileName}`, {
      code: "checksum_not_found",
      cleanup: {
        attempted: false,
        path: input.stagingDir,
        removed: false,
      },
    });
  }

  return lookup.expectedSha256.toLowerCase();
}

async function failWithCleanup(input: {
  code: UpdateStagingErrorCode;
  message: string;
  stagingDir: string;
  deps: UpdateStagingDeps;
  cause?: unknown;
}): Promise<never> {
  throw new UpdateStagingError(input.message, {
    code: input.code,
    cleanup: await cleanupPartial(input.stagingDir, input.deps),
    cause: input.cause,
  });
}

async function cleanupPartial(path: string, deps: UpdateStagingDeps): Promise<UpdateStagingCleanup> {
  try {
    await deps.remove(path);
    return {
      attempted: true,
      path,
      removed: true,
    };
  } catch (error) {
    return {
      attempted: true,
      path,
      removed: false,
      error: errorMessage(error),
    };
  }
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function toBuffer(data: Uint8Array | string): Buffer {
  return typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateSafePathComponent(name: string): string {
  if (name === "" || name === ".") {
    throw new UpdateStagingError(`unsafe fileName: ${name}`, {
      code: "unsafe_file_name",
      cleanup: { attempted: false, path: "", removed: false },
    });
  }

  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    throw new UpdateStagingError(`unsafe fileName: ${name}`, {
      code: "unsafe_file_name",
      cleanup: { attempted: false, path: "", removed: false },
    });
  }
  return name;
}
// -/ 3/3
