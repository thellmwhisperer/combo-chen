/**
 * @overview Self-update artifact integrity integration tests.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at the describe block  <- command contracts and their effects.
 *
 *   MAIN FLOW
 *   ---------
 *   shared fakeDeps -> createProgram -> extracted handler -> recorded effects
 *
 *   PUBLIC API
 *   ----------
 *   None (test file).
 *
 *   INTERNALS
 *   ---------
 *   Command-specific fixtures live inside the describe block.
 *
 * @exports none
 * @deps ../cli/main.test-harness
 */

import { createHash, describe, exec, expect, fakeDeps, it } from "../cli/main.test-harness.js";

// -- 1/1 CORE · command contracts <- START HERE --
describe("self-update handler", () => {
  it("reports checksum mismatch failures before replacement", async () => {
    const archiveBytes = Buffer.from("corrupted release archive bytes");
    const archiveSha = createHash("sha256").update(archiveBytes).digest("hex");
    const expectedSha = "0".repeat(64);
    const assetName = "combo-chen-v1.2.1-linux-x64.tar.gz";
    const stagingDir = "/updates/combo-chen-update-checksum-mismatch";
    const downloads: unknown[] = [];
    const extracts: unknown[] = [];
    const removals: string[] = [];
    const replacements: unknown[] = [];
    const { deps, out } = fakeDeps({
      gh: (args) => {
        if (args[0] === "api" && args[1] === "repos/thellmwhisperer/combo-chen/releases?per_page=100") {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                tag_name: "v1.2.1",
                prerelease: false,
                draft: false,
                assets: [
                  {
                    name: assetName,
                    browser_download_url: `https://downloads.example/${assetName}`,
                  },
                  {
                    name: "checksums.txt",
                    browser_download_url: "https://downloads.example/checksums.txt",
                  },
                ],
              },
            ]),
            stderr: "",
          };
        }
        return { status: 1, stdout: "", stderr: `unexpected gh call: ${args.join(" ")}` };
      },
      update: {
        current: { version: "1.2.0", commit: "abc1234", date: "2026-06-23T09:00:00.000Z" },
        installTargetPath: "/opt/combo-chen-v1.2.0/bin/combo-chen",
        platform: "linux",
        arch: "x64",
        makeStagingDir: () => stagingDir,
        async download(request) {
          downloads.push(request);
          if (request.fileName === assetName) return archiveBytes;
          if (request.fileName === "checksums.txt") return `${expectedSha}  ${assetName}\n`;
          throw new Error(`unexpected download ${request.fileName}`);
        },
        async mkdir() {},
        async writeFile() {},
        async remove(path) {
          removals.push(path);
        },
        async extractArchive(input) {
          extracts.push(input);
          throw new Error("extractArchive should not run after checksum mismatch");
        },
        replaceInstallTarget(input) {
          replacements.push(input);
          throw new Error("replacement should not run after checksum mismatch");
        },
      },
    });

    await expect(exec(deps, ["update", "--yes"])).rejects.toThrow(
      `checksum mismatch for ${assetName}: expected ${expectedSha} but downloaded ${archiveSha}`,
    );

    expect(downloads).toEqual([
      {
        kind: "archive",
        url: `https://downloads.example/${assetName}`,
        fileName: assetName,
      },
      {
        kind: "checksums",
        url: "https://downloads.example/checksums.txt",
        fileName: "checksums.txt",
      },
    ]);
    expect(extracts).toEqual([]);
    expect(replacements).toEqual([]);
    expect(removals).toEqual([stagingDir]);
    expect(out).toEqual([
      "update available: combo-chen 1.2.0 -> 1.2.1 (stable)",
      `update failed before replacement: checksum mismatch for ${assetName}: expected ${expectedSha} but downloaded ${archiveSha}`,
    ]);
  });

  it("reports missing checksums assets before replacement with staging cleanup", async () => {
    const assetName = "combo-chen-v1.2.1-linux-x64.tar.gz";
    const stagingDir = "/updates/combo-chen-update-missing-checksums";
    const downloads: unknown[] = [];
    const extracts: unknown[] = [];
    const removals: string[] = [];
    const replacements: unknown[] = [];
    const { deps, out } = fakeDeps({
      gh: (args) => {
        if (args[0] === "api" && args[1] === "repos/thellmwhisperer/combo-chen/releases?per_page=100") {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                tag_name: "v1.2.1",
                prerelease: false,
                draft: false,
                assets: [
                  {
                    name: assetName,
                    browser_download_url: `https://downloads.example/${assetName}`,
                  },
                ],
              },
            ]),
            stderr: "",
          };
        }
        return { status: 1, stdout: "", stderr: `unexpected gh call: ${args.join(" ")}` };
      },
      update: {
        current: { version: "1.2.0", commit: "abc1234", date: "2026-06-23T09:00:00.000Z" },
        installTargetPath: "/opt/combo-chen-v1.2.0/bin/combo-chen",
        platform: "linux",
        arch: "x64",
        makeStagingDir: () => stagingDir,
        async download(request) {
          downloads.push(request);
          throw new Error(`download should not run without checksums metadata: ${request.fileName}`);
        },
        async mkdir() {
          throw new Error("mkdir should not run without checksums metadata");
        },
        async writeFile() {
          throw new Error("writeFile should not run without checksums metadata");
        },
        async remove(path) {
          removals.push(path);
        },
        async extractArchive(input) {
          extracts.push(input);
          throw new Error("extractArchive should not run without checksums metadata");
        },
        replaceInstallTarget(input) {
          replacements.push(input);
          throw new Error("replacement should not run without checksums metadata");
        },
      },
    });

    await expect(exec(deps, ["update", "--yes"])).rejects.toThrow(
      "checksums.txt text or downloadUrl is required",
    );

    expect(downloads).toEqual([]);
    expect(extracts).toEqual([]);
    expect(replacements).toEqual([]);
    expect(removals).toEqual([stagingDir]);
    expect(out).toEqual([
      "update available: combo-chen 1.2.0 -> 1.2.1 (stable)",
      "update failed before replacement: checksums.txt text or downloadUrl is required",
    ]);
  });

  it("reports checksums download failures before replacement", async () => {
    const archiveBytes = Buffer.from("release archive bytes");
    const assetName = "combo-chen-v1.2.1-linux-x64.tar.gz";
    const stagingDir = "/updates/combo-chen-update-checksums-download";
    const downloads: unknown[] = [];
    const extracts: unknown[] = [];
    const removals: string[] = [];
    const replacements: unknown[] = [];
    const { deps, out } = fakeDeps({
      gh: (args) => {
        if (args[0] === "api" && args[1] === "repos/thellmwhisperer/combo-chen/releases?per_page=100") {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                tag_name: "v1.2.1",
                prerelease: false,
                draft: false,
                assets: [
                  {
                    name: assetName,
                    browser_download_url: `https://downloads.example/${assetName}`,
                  },
                  {
                    name: "checksums.txt",
                    browser_download_url: "https://downloads.example/checksums.txt",
                  },
                ],
              },
            ]),
            stderr: "",
          };
        }
        return { status: 1, stdout: "", stderr: `unexpected gh call: ${args.join(" ")}` };
      },
      update: {
        current: { version: "1.2.0", commit: "abc1234", date: "2026-06-23T09:00:00.000Z" },
        installTargetPath: "/opt/combo-chen-v1.2.0/bin/combo-chen",
        platform: "linux",
        arch: "x64",
        makeStagingDir: () => stagingDir,
        async download(request) {
          downloads.push(request);
          if (request.fileName === assetName) return archiveBytes;
          if (request.fileName === "checksums.txt") throw new Error("network timeout");
          throw new Error(`unexpected download ${request.fileName}`);
        },
        async mkdir() {},
        async writeFile() {
          throw new Error("writeFile should not run before checksums download succeeds");
        },
        async remove(path) {
          removals.push(path);
        },
        async extractArchive(input) {
          extracts.push(input);
          throw new Error("extractArchive should not run after checksums download failure");
        },
        replaceInstallTarget(input) {
          replacements.push(input);
          throw new Error("replacement should not run after checksums download failure");
        },
      },
    });

    await expect(exec(deps, ["update", "--yes"])).rejects.toThrow(
      "failed to download checksums.txt: network timeout",
    );

    expect(downloads).toEqual([
      {
        kind: "archive",
        url: `https://downloads.example/${assetName}`,
        fileName: assetName,
      },
      {
        kind: "checksums",
        url: "https://downloads.example/checksums.txt",
        fileName: "checksums.txt",
      },
    ]);
    expect(extracts).toEqual([]);
    expect(replacements).toEqual([]);
    expect(removals).toEqual([stagingDir]);
    expect(out).toEqual([
      "update available: combo-chen 1.2.0 -> 1.2.1 (stable)",
      "update failed before replacement: failed to download checksums.txt: network timeout",
    ]);
  });

  it("rejects source checkout update targets before staging begins", async () => {
    const assetName = "combo-chen-v1.2.1-linux-x64.tar.gz";
    const downloads: unknown[] = [];
    const replacements: unknown[] = [];
    const { deps, calls, out } = fakeDeps({
      gh: (args) => {
        calls.push(["gh", ...args]);
        if (args[0] === "api" && args[1] === "repos/thellmwhisperer/combo-chen/releases?per_page=100") {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                tag_name: "v1.2.1",
                prerelease: false,
                draft: false,
                assets: [
                  {
                    name: assetName,
                    browser_download_url: `https://downloads.example/${assetName}`,
                  },
                  {
                    name: "checksums.txt",
                    browser_download_url: "https://downloads.example/checksums.txt",
                  },
                ],
              },
            ]),
            stderr: "",
          };
        }
        return { status: 1, stdout: "", stderr: `unexpected gh call: ${args.join(" ")}` };
      },
      update: {
        current: { version: "1.2.0", commit: "abc1234", date: "2026-06-23T09:00:00.000Z" },
        installTargetPath: "/repos/combo-chen/src/cli/main.ts",
        platform: "linux",
        arch: "x64",
        makeStagingDir: () => "/updates/should-not-stage",
        async download(request) {
          downloads.push(request);
          throw new Error("download should not run for unsupported install targets");
        },
        async mkdir() {
          throw new Error("mkdir should not run for unsupported install targets");
        },
        async writeFile() {
          throw new Error("writeFile should not run for unsupported install targets");
        },
        async remove() {},
        async extractArchive() {
          throw new Error("extractArchive should not run for unsupported install targets");
        },
        replaceInstallTarget(input) {
          replacements.push(input);
          throw new Error("replacement should not run for unsupported install targets");
        },
      },
    });

    await expect(exec(deps, ["update", "--yes"])).rejects.toThrow(
      "source checkout path must not be auto-replaced: /repos/combo-chen/src/cli/main.ts",
    );

    expect(calls).toEqual([]);
    expect(downloads).toEqual([]);
    expect(replacements).toEqual([]);
    expect(out).toEqual([]);
  });
});
// -/ 1/1
