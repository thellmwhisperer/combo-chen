/**
 * @overview Unit tests for active update command production adapters.
 *   ~175 lines, no exports, pins download timeout, daemon refresh timeout, and archive extraction validation.
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
 * @deps node:{child_process,fs,os,path}, vitest, ../core/active-runtime, ./update
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { ActiveComboRuntimeDetection } from "../core/active-runtime.js";
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

  it("bounds post-update no-mistakes daemon refresh with a timeout", async () => {
    vi.resetModules();
    const spawnSyncMock = vi.fn(() => ({
      status: null,
      stdout: "",
      stderr: "",
      error: new Error("spawnSync ETIMEDOUT"),
    }));
    vi.doMock("node:child_process", () => ({ spawnSync: spawnSyncMock }));
    try {
      const { defaultUpdateCommandDeps: mockedDefaultUpdateCommandDeps } = await import("./update.js");
      const deps = mockedDefaultUpdateCommandDeps({
        gh: () => ({ status: 0, stdout: "[]", stderr: "" }),
        out: () => {},
      });

      const result = deps.postUpdateRefresh(activeDetection());

      expect(spawnSyncMock).toHaveBeenCalledWith("no-mistakes", ["daemon", "start"], {
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result).toMatchObject({
        ok: false,
        attemptedDaemonRefresh: true,
      });
      expect(result.lines[0]).toBe(
        "post-update refresh failed: no-mistakes daemon start failed: spawnSync ETIMEDOUT",
      );
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });
});
// -/ 1/2

// -- 2/2 HELPER · tar fixture builder --
function activeDetection(): ActiveComboRuntimeDetection {
  return {
    status: "active",
    active: true,
    comboIds: ["o-r-7"],
    inspectedRunDirs: ["/combo/runs/o-r-7"],
    activeCombos: [
      {
        comboId: "o-r-7",
        runDir: "/combo/runs/o-r-7",
        phase: "REVIEWING",
        needsHuman: false,
        branch: "combo/issue-7",
        worktree: "/repo/.worktrees/issue-7",
        tmuxSession: "combo-chen-o-r-7",
        repoDir: "/repo",
        roleWindows: { coder: "coder", gatekeeper: "gatekeeper", directorWatch: "director-watch" },
        createdAt: "2026-06-25T10:00:00.000Z",
        updatedAt: "2026-06-25T10:05:00.000Z",
        lastEvent: "pr_opened",
      },
    ],
    staleCombos: [],
    errors: [],
  };
}

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
