/**
 * @overview Unit tests for active update command production adapters.
 *   ~130 lines, no exports, pins download timeout and archive extraction validation.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at defaultUpdateCommandDeps tests <- real adapter contract.
 *   2. Helpers build tiny tar.gz fixtures for extractor validation.
 *
 *   MAIN FLOW
 *   ---------
 *   production update deps -> fetch/tar boundaries -> bounded download + validated archive root
 *
 * @exports none
 * @deps node:{child_process,fs,os,path}, vitest, ./update
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { defaultUpdateCommandDeps } from "./update.js";

// -- 1/2 CORE · default update command adapters <- START HERE --
describe("defaultUpdateCommandDeps", () => {
  it("bounds archive and checksum downloads with an abort timeout", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const deps = defaultUpdateCommandDeps({
      gh: () => ({ status: 0, stdout: "[]", stderr: "" }),
      out: () => {},
    });

    try {
      await expect(
        deps.download({
          kind: "archive",
          url: "https://downloads.example/archive.tar.gz",
          fileName: "archive.tar.gz",
        }),
      ).resolves.toEqual(new Uint8Array([1, 2, 3]));
      expect(timeout).toHaveBeenCalledWith(60_000);
      expect(fetchMock).toHaveBeenCalledWith("https://downloads.example/archive.tar.gz", {
        signal: controller.signal,
      });
    } finally {
      vi.unstubAllGlobals();
      timeout.mockRestore();
    }
  });

  it("rejects archives that do not contain one top-level release directory", () => {
    const deps = defaultUpdateCommandDeps({
      gh: () => ({ status: 0, stdout: "[]", stderr: "" }),
      out: () => {},
    });
    const cases = [
      tarFixture({
        name: "multiple-roots",
        entries: {
          "combo-chen-v1.2.3/bin/combo-chen": "cli",
          "other-root/bin/combo-chen": "other",
        },
      }),
      tarFixture({
        name: "top-level-file",
        entries: {
          "combo-chen-v1.2.3/bin/combo-chen": "cli",
          "README.md": "top-level file",
        },
      }),
    ];

    for (const archivePath of cases) {
      const destinationDir = mkdtempSync(join(tmpdir(), "combo-chen-update-extract-out-"));

      expect(() =>
        deps.extractArchive({
          archivePath,
          destinationDir,
          assetFileName: "bad-release.tar.gz",
        }),
      ).toThrow("release archive must contain a single top-level directory: bad-release.tar.gz");
    }
  });
});
// -/ 1/2

// -- 2/2 HELPER · tar fixture builder --
function tarFixture(input: { name: string; entries: Record<string, string> }): string {
  const root = mkdtempSync(join(tmpdir(), `combo-chen-update-${input.name}-`));
  const sourceDir = join(root, "source");
  mkdirSync(sourceDir, { recursive: true });
  for (const [relativePath, body] of Object.entries(input.entries)) {
    const filePath = join(sourceDir, ...relativePath.split("/"));
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, body);
  }

  const archivePath = join(root, "fixture.tar.gz");
  const tar = spawnSync("tar", ["-czf", archivePath, "-C", sourceDir, "."], { encoding: "utf8" });
  if ((tar.status ?? 1) !== 0) {
    throw new Error(`tar fixture failed: ${tar.stderr.trim() || "unknown error"}`);
  }
  return archivePath;
}
// -/ 2/2
