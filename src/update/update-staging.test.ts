/**
 * @overview Unit tests for the update-owned U2 download/checksum/staging primitives.
 *   ~520 lines, no exports, pins mocked download, checksum, extraction, and cleanup boundaries.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at describe("stageResolvedUpdate") <- U2 staging contract.
 *   2. Test helpers keep network/filesystem/extraction behind injectable deps.
 *
 *   MAIN FLOW
 *   ---------
 *   resolved update plan -> mocked downloads -> checksum verification -> isolated extraction -> staged descriptor
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   sha256Hex, plan, makeDeps, captureFailure.
 *
 * @exports none
 * @deps node:{crypto,path}, vitest, ./update-staging
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  UpdateStagingError,
  type UpdateDownloadRequest,
  type UpdateExtractionInput,
  type UpdateStagingDeps,
  stageResolvedUpdate,
} from "./update-staging.js";

interface MockCalls {
  downloads: UpdateDownloadRequest[];
  dirs: string[];
  writes: Map<string, Buffer>;
  removes: string[];
  extracts: UpdateExtractionInput[];
}

// -- 1/2 HELPER · mock staging dependencies --
function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function plan(checksums: { downloadUrl?: string; text?: string }) {
  return {
    asset: {
      fileName: "combo-chen-v1.2.3-linux-x64.tar.gz",
      downloadUrl: "https://example.test/releases/combo-chen-v1.2.3-linux-x64.tar.gz",
    },
    checksums,
  };
}

function makeDeps(options: {
  downloads?: ReadonlyMap<string, Uint8Array | string>;
  extractError?: Error;
  mkdirError?: Error;
  writeFileError?: Error;
}): { deps: UpdateStagingDeps; calls: MockCalls } {
  const calls: MockCalls = {
    downloads: [],
    dirs: [],
    writes: new Map(),
    removes: [],
    extracts: [],
  };

  return {
    calls,
    deps: {
      async download(request) {
        calls.downloads.push(request);
        const value = options.downloads?.get(request.url);
        if (value === undefined) {
          throw new Error(`unexpected download: ${request.url}`);
        }
        return value;
      },
      async mkdir(path) {
        calls.dirs.push(path);
        if (options.mkdirError !== undefined) throw options.mkdirError;
      },
      async writeFile(path, data) {
        calls.writes.set(path, Buffer.from(data));
        if (options.writeFileError !== undefined) throw options.writeFileError;
      },
      async remove(path) {
        calls.removes.push(path);
      },
      async extractArchive(input) {
        calls.extracts.push(input);
        if (options.extractError !== undefined) throw options.extractError;
        const rootDir = join(input.destinationDir, "combo-chen-v1.2.3");
        const executablePath = join(rootDir, "bin", "combo-chen");
        return {
          rootDir,
          executablePath,
          files: [executablePath],
        };
      },
    },
  };
}

async function captureFailure(run: () => Promise<unknown>): Promise<UpdateStagingError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(UpdateStagingError);
    return error as UpdateStagingError;
  }
  throw new Error("expected stageResolvedUpdate to fail");
}

function expectNoStagingIo(calls: MockCalls): void {
  expect(calls.downloads).toEqual([]);
  expect(calls.dirs).toEqual([]);
  expect(calls.writes.size).toBe(0);
  expect(calls.removes).toEqual([]);
  expect(calls.extracts).toEqual([]);
}
// -/ 1/2

// -- 2/2 CORE · resolved update staging contract <- START HERE --
describe("stageResolvedUpdate", () => {
  it("downloads the selected archive and checksums before returning a staged descriptor", async () => {
    const stagingDir = "/staging/combo-chen-update-1";
    const archiveBytes = Buffer.from("release archive bytes");
    const expectedSha256 = sha256Hex(archiveBytes);
    const checksumsText = `${expectedSha256}  combo-chen-v1.2.3-linux-x64.tar.gz\n`;
    const { deps, calls } = makeDeps({
      downloads: new Map<string, Uint8Array | string>([
        ["https://example.test/releases/combo-chen-v1.2.3-linux-x64.tar.gz", archiveBytes],
        ["https://example.test/releases/checksums.txt", checksumsText],
      ]),
    });

    const staged = await stageResolvedUpdate({
      plan: plan({ downloadUrl: "https://example.test/releases/checksums.txt" }),
      stagingDir,
      deps,
    });

    const archivePath = join(stagingDir, "downloads", "combo-chen-v1.2.3-linux-x64.tar.gz");
    const checksumsPath = join(stagingDir, "downloads", "checksums.txt");
    const extractedDir = join(stagingDir, "extracted");
    expect(calls.downloads).toEqual([
      {
        kind: "archive",
        url: "https://example.test/releases/combo-chen-v1.2.3-linux-x64.tar.gz",
        fileName: "combo-chen-v1.2.3-linux-x64.tar.gz",
      },
      {
        kind: "checksums",
        url: "https://example.test/releases/checksums.txt",
        fileName: "checksums.txt",
      },
    ]);
    expect(calls.dirs).toEqual([join(stagingDir, "downloads"), extractedDir]);
    expect(calls.writes.get(archivePath)?.equals(archiveBytes)).toBe(true);
    expect(calls.writes.get(checksumsPath)?.toString("utf8")).toBe(checksumsText);
    expect(calls.extracts).toEqual([
      {
        archivePath,
        destinationDir: extractedDir,
        assetFileName: "combo-chen-v1.2.3-linux-x64.tar.gz",
      },
    ]);
    expect(staged).toEqual({
      assetFileName: "combo-chen-v1.2.3-linux-x64.tar.gz",
      archivePath,
      checksumsPath,
      expectedSha256,
      actualSha256: expectedSha256,
      stagingDir,
      extractedDir,
      rootDir: join(extractedDir, "combo-chen-v1.2.3"),
      executablePath: join(extractedDir, "combo-chen-v1.2.3", "bin", "combo-chen"),
      files: [join(extractedDir, "combo-chen-v1.2.3", "bin", "combo-chen")],
    });
  });

  it("accepts received checksums.txt text without downloading it again", async () => {
    const archiveBytes = Buffer.from("release archive bytes");
    const checksumsText = `${sha256Hex(archiveBytes)}  combo-chen-v1.2.3-linux-x64.tar.gz\n`;
    const { deps, calls } = makeDeps({
      downloads: new Map([
        ["https://example.test/releases/combo-chen-v1.2.3-linux-x64.tar.gz", archiveBytes],
      ]),
    });

    await stageResolvedUpdate({
      plan: plan({ text: checksumsText }),
      stagingDir: "/staging/combo-chen-update-2",
      deps,
    });

    expect(calls.downloads).toEqual([
      {
        kind: "archive",
        url: "https://example.test/releases/combo-chen-v1.2.3-linux-x64.tar.gz",
        fileName: "combo-chen-v1.2.3-linux-x64.tar.gz",
      },
    ]);
  });

  it("fails checksum mismatches before extraction and cleans partial staging", async () => {
    const stagingDir = "/staging/combo-chen-update-mismatch";
    const { deps, calls } = makeDeps({
      downloads: new Map([
        ["https://example.test/releases/combo-chen-v1.2.3-linux-x64.tar.gz", Buffer.from("archive")],
      ]),
    });
    const failure = await captureFailure(() =>
      stageResolvedUpdate({
        plan: plan({ text: `${"0".repeat(64)}  combo-chen-v1.2.3-linux-x64.tar.gz\n` }),
        stagingDir,
        deps,
      }),
    );

    expect(failure).toMatchObject({
      code: "checksum_mismatch",
      cleanup: { attempted: true, path: stagingDir, removed: true },
    });
    expect(calls.extracts).toEqual([]);
    expect(calls.removes).toEqual([stagingDir]);
  });

  it("fails missing checksum entries before extraction and cleans partial staging", async () => {
    const stagingDir = "/staging/combo-chen-update-missing";
    const { deps, calls } = makeDeps({
      downloads: new Map([
        ["https://example.test/releases/combo-chen-v1.2.3-linux-x64.tar.gz", Buffer.from("archive")],
      ]),
    });
    const failure = await captureFailure(() =>
      stageResolvedUpdate({
        plan: plan({ text: `${"1".repeat(64)}  combo-chen-v1.2.3-darwin-arm64.tar.gz\n` }),
        stagingDir,
        deps,
      }),
    );

    expect(failure).toMatchObject({
      code: "checksum_not_found",
      cleanup: { attempted: true, path: stagingDir, removed: true },
    });
    expect(calls.extracts).toEqual([]);
    expect(calls.removes).toEqual([stagingDir]);
  });

  it("fails unavailable checksums before extraction and cleans partial staging", async () => {
    const stagingDir = "/staging/combo-chen-update-checksums-unavailable";
    const { deps, calls } = makeDeps({
      downloads: new Map([
        ["https://example.test/releases/combo-chen-v1.2.3-linux-x64.tar.gz", Buffer.from("archive")],
      ]),
    });
    const failure = await captureFailure(() =>
      stageResolvedUpdate({
        plan: plan({}),
        stagingDir,
        deps,
      }),
    );

    expect(failure).toMatchObject({
      code: "checksums_unavailable",
      cleanup: { attempted: true, path: stagingDir, removed: true },
    });
    expect(calls.extracts).toEqual([]);
    expect(calls.removes).toEqual([stagingDir]);
  });

  it("fails malformed checksums before extraction and cleans partial staging", async () => {
    const stagingDir = "/staging/combo-chen-update-checksums-invalid";
    const { deps, calls } = makeDeps({
      downloads: new Map([
        ["https://example.test/releases/combo-chen-v1.2.3-linux-x64.tar.gz", Buffer.from("archive")],
      ]),
    });
    const failure = await captureFailure(() =>
      stageResolvedUpdate({
        plan: plan({ text: "not a checksum\n" }),
        stagingDir,
        deps,
      }),
    );

    expect(failure).toMatchObject({
      code: "checksums_invalid",
      cleanup: { attempted: true, path: stagingDir, removed: true },
    });
    expect(calls.extracts).toEqual([]);
    expect(calls.removes).toEqual([stagingDir]);
  });

  it("reports mkdir failures with staging_failed code and cleans partial staging", async () => {
    const stagingDir = "/staging/combo-chen-update-mkdir-failed";
    const { deps, calls } = makeDeps({
      downloads: new Map([
        ["https://example.test/releases/combo-chen-v1.2.3-linux-x64.tar.gz", Buffer.from("archive")],
      ]),
      mkdirError: new Error("EACCES: permission denied"),
    });
    const failure = await captureFailure(() =>
      stageResolvedUpdate({
        plan: plan({ text: `${"1".repeat(64)}  combo-chen-v1.2.3-linux-x64.tar.gz\n` }),
        stagingDir,
        deps,
      }),
    );

    expect(failure).toMatchObject({
      code: "staging_failed",
      cleanup: { attempted: true, path: stagingDir, removed: true },
    });
    expect(calls.extracts).toEqual([]);
    expect(calls.removes).toEqual([stagingDir]);
  });

  it("reports archive write failures with staging_failed code and cleans partial staging", async () => {
    const stagingDir = "/staging/combo-chen-update-write-failed";
    const archiveBytes = Buffer.from("archive");
    const { deps, calls } = makeDeps({
      downloads: new Map([
        ["https://example.test/releases/combo-chen-v1.2.3-linux-x64.tar.gz", archiveBytes],
      ]),
      writeFileError: new Error("ENOSPC: no space left on device"),
    });
    const failure = await captureFailure(() =>
      stageResolvedUpdate({
        plan: plan({ text: `${sha256Hex(archiveBytes)}  combo-chen-v1.2.3-linux-x64.tar.gz\n` }),
        stagingDir,
        deps,
      }),
    );

    expect(failure).toMatchObject({
      code: "staging_failed",
      cleanup: { attempted: true, path: stagingDir, removed: true },
    });
    expect(failure.message).toContain("failed to write");
    expect(calls.extracts).toEqual([]);
    expect(calls.removes).toEqual([stagingDir]);
  });

  it("reports archive download failures and cleans partial staging", async () => {
    const stagingDir = "/staging/combo-chen-update-download-failed";
    const { deps, calls } = makeDeps({
      downloads: new Map(),
    });
    const failure = await captureFailure(() =>
      stageResolvedUpdate({
        plan: plan({ text: `${"1".repeat(64)}  combo-chen-v1.2.3-linux-x64.tar.gz\n` }),
        stagingDir,
        deps,
      }),
    );

    expect(failure).toMatchObject({
      code: "download_failed",
      cleanup: { attempted: true, path: stagingDir, removed: true },
    });
    expect(calls.extracts).toEqual([]);
    expect(calls.removes).toEqual([stagingDir]);
  });

  it("rejects asset file names with path traversal before any I/O", async () => {
    const stagingDir = "/staging/combo-chen-update-traversal";
    const { deps, calls } = makeDeps({
      downloads: new Map(),
    });
    const failure = await captureFailure(() =>
      stageResolvedUpdate({
        plan: {
          asset: {
            fileName: "../etc/passwd",
            downloadUrl: "https://example.test/releases/combo-chen.tar.gz",
          },
          checksums: { text: `${"1".repeat(64)}  ../etc/passwd\n` },
        },
        stagingDir,
        deps,
      }),
    );

    expect(failure.code).toBe("unsafe_file_name");
    expect(failure.message).toContain("unsafe fileName");
    expectNoStagingIo(calls);
  });

  it("rejects checksums file names with path traversal before any I/O", async () => {
    const stagingDir = "/staging/combo-chen-update-checksums-traversal";
    const { deps, calls } = makeDeps({
      downloads: new Map(),
    });
    const failure = await captureFailure(() =>
      stageResolvedUpdate({
        plan: {
          asset: {
            fileName: "combo-chen-v1.2.3-linux-x64.tar.gz",
            downloadUrl: "https://example.test/releases/combo-chen-v1.2.3-linux-x64.tar.gz",
          },
          checksums: {
            text: `${"1".repeat(64)}  combo-chen-v1.2.3-linux-x64.tar.gz\n`,
            fileName: "../../etc/passwd",
          },
        },
        stagingDir,
        deps,
      }),
    );

    expect(failure.code).toBe("unsafe_file_name");
    expect(failure.message).toContain("unsafe fileName");
    expectNoStagingIo(calls);
  });

  it("rejects empty asset file names before any I/O", async () => {
    const stagingDir = "/staging/combo-chen-update-empty-asset";
    const { deps, calls } = makeDeps({
      downloads: new Map(),
    });
    const failure = await captureFailure(() =>
      stageResolvedUpdate({
        plan: {
          asset: {
            fileName: "",
            downloadUrl: "https://example.test/releases/combo-chen.tar.gz",
          },
          checksums: { text: `${"1".repeat(64)}  combo-chen.tar.gz\n` },
        },
        stagingDir,
        deps,
      }),
    );

    expect(failure.code).toBe("unsafe_file_name");
    expect(failure.message).toContain("unsafe fileName");
    expectNoStagingIo(calls);
  });

  it("rejects empty checksums file names before any I/O", async () => {
    const stagingDir = "/staging/combo-chen-update-empty-checksums";
    const { deps, calls } = makeDeps({
      downloads: new Map(),
    });
    const failure = await captureFailure(() =>
      stageResolvedUpdate({
        plan: {
          asset: {
            fileName: "combo-chen-v1.2.3-linux-x64.tar.gz",
            downloadUrl: "https://example.test/releases/combo-chen-v1.2.3-linux-x64.tar.gz",
          },
          checksums: { text: `${"1".repeat(64)}  combo-chen-v1.2.3-linux-x64.tar.gz\n`, fileName: "" },
        },
        stagingDir,
        deps,
      }),
    );

    expect(failure.code).toBe("unsafe_file_name");
    expect(failure.message).toContain("unsafe fileName");
    expectNoStagingIo(calls);
  });

  it("rejects single-dot asset file names before any I/O", async () => {
    const stagingDir = "/staging/combo-chen-update-dot-asset";
    const { deps, calls } = makeDeps({
      downloads: new Map(),
    });
    const failure = await captureFailure(() =>
      stageResolvedUpdate({
        plan: {
          asset: {
            fileName: ".",
            downloadUrl: "https://example.test/releases/combo-chen.tar.gz",
          },
          checksums: { text: `${"1".repeat(64)}  combo-chen.tar.gz\n` },
        },
        stagingDir,
        deps,
      }),
    );

    expect(failure.code).toBe("unsafe_file_name");
    expect(failure.message).toContain("unsafe fileName");
    expectNoStagingIo(calls);
  });

  it("cleans partial staging when extraction fails", async () => {
    const stagingDir = "/staging/combo-chen-update-extract-failed";
    const archiveBytes = Buffer.from("release archive bytes");
    const { deps, calls } = makeDeps({
      downloads: new Map([
        ["https://example.test/releases/combo-chen-v1.2.3-linux-x64.tar.gz", archiveBytes],
      ]),
      extractError: new Error("tar failed"),
    });
    const failure = await captureFailure(() =>
      stageResolvedUpdate({
        plan: plan({
          text: `${sha256Hex(archiveBytes)}  combo-chen-v1.2.3-linux-x64.tar.gz\n`,
        }),
        stagingDir,
        deps,
      }),
    );

    expect(failure).toMatchObject({
      code: "extraction_failed",
      cleanup: { attempted: true, path: stagingDir, removed: true },
    });
    expect(calls.extracts).toHaveLength(1);
    expect(calls.removes).toEqual([stagingDir]);
  });
});
// -/ 2/2
