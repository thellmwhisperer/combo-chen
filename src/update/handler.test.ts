/**
 * @overview Self-update happy-path application handler integration tests.
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

import {
  createHash,
  describe,
  exec,
  expect,
  fakeDeps,
  idleActiveRuntime,
  it,
  refreshPostUpdateLocalState,
} from "../cli/main.test-harness.js";

// -- 1/1 CORE · command contracts <- START HERE --
describe("self-update handler", () => {
  it("wires update --yes through idle runtime detection, release resolution, staging, and replacement", async () => {
    const archiveBytes = Buffer.from("release archive bytes");
    const archiveSha = createHash("sha256").update(archiveBytes).digest("hex");
    const assetName = "combo-chen-v1.2.1-linux-x64.tar.gz";
    const stagingDir = "/updates/combo-chen-update-1";
    const downloads: unknown[] = [];
    const extracts: unknown[] = [];
    const writes = new Map<string, string>();
    const replacements: unknown[] = [];
    let detectionCalls = 0;
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
        installTargetPath: "/opt/combo-chen-v1.2.0/bin/combo-chen",
        platform: "linux",
        arch: "x64",
        activeRuntime: () => {
          detectionCalls += 1;
          return idleActiveRuntime();
        },
        makeStagingDir: () => stagingDir,
        async download(request) {
          downloads.push(request);
          if (request.fileName === assetName) return archiveBytes;
          if (request.fileName === "checksums.txt") return `${archiveSha}  ${assetName}\n`;
          throw new Error(`unexpected download ${request.fileName}`);
        },
        async mkdir() {},
        async writeFile(path, data) {
          writes.set(path, Buffer.from(data).toString("utf8"));
        },
        async remove() {},
        async extractArchive(input) {
          extracts.push(input);
          return {
            rootDir: `${input.destinationDir}/combo-chen-v1.2.1`,
            executablePath: `${input.destinationDir}/combo-chen-v1.2.1/bin/combo-chen`,
            files: [`${input.destinationDir}/combo-chen-v1.2.1/bin/combo-chen`],
          };
        },
        replaceInstallTarget(input) {
          replacements.push(input);
          return {
            targetPath: input.targetPath,
            stagedExecutablePath: `${input.stagedArtifactRoot}/bin/combo-chen`,
            installTarget: {
              path: input.targetPath,
              kind: "release_archive",
              autoReplaceable: true,
              reason: "release archive executable",
            },
            executableMode: 0o755,
            replaced: true,
          };
        },
      },
    });

    await exec(deps, ["update", "--yes"]);

    expect(detectionCalls).toBe(2);
    expect(calls).toContainEqual(["gh", "api", "repos/thellmwhisperer/combo-chen/releases?per_page=100"]);
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
    expect(writes.get(`${stagingDir}/downloads/${assetName}`)).toBe("release archive bytes");
    expect(extracts).toEqual([
      {
        archivePath: `${stagingDir}/downloads/${assetName}`,
        destinationDir: `${stagingDir}/extracted`,
        assetFileName: assetName,
      },
    ]);
    expect(replacements).toEqual([
      {
        targetPath: "/opt/combo-chen-v1.2.0/bin/combo-chen",
        stagedArtifactRoot: `${stagingDir}/extracted/combo-chen-v1.2.1`,
      },
    ]);
    expect(out).toEqual([
      "update available: combo-chen 1.2.0 -> 1.2.1 (stable)",
      `verified ${assetName} (${archiveSha})`,
      "installed combo-chen 1.2.1 to /opt/combo-chen-v1.2.0/bin/combo-chen",
      "post-update refresh: no active combo runtime detected; no daemon or runner refresh needed",
    ]);
  });

  it("re-detects active runtime after replacement before post-update refresh", async () => {
    const archiveBytes = Buffer.from("release archive bytes");
    const archiveSha = createHash("sha256").update(archiveBytes).digest("hex");
    const assetName = "combo-chen-v1.2.1-linux-x64.tar.gz";
    const stagingDir = "/updates/combo-chen-update-redetect-runtime";
    const refreshDetections: unknown[] = [];
    let detectionCalls = 0;
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
        activeRuntime: () => {
          detectionCalls += 1;
          if (detectionCalls === 1) return idleActiveRuntime();
          return {
            status: "active",
            active: true,
            comboIds: ["o-r-7"],
            inspectedRunDirs: ["/home/combo/runs/o-r-7"],
            activeCombos: [
              {
                comboId: "o-r-7",
                runDir: "/home/combo/runs/o-r-7",
                phase: "REVIEWING",
                needsHuman: false,
                branch: "combo/issue-7",
                worktree: "/repo/.worktrees/issue-7",
                tmuxSession: "combo-chen-o-r-7",
                repoDir: "/repo",
                roleWindows: { coder: "coder", reviewer: "reviewer" },
                createdAt: "2026-06-25T10:00:00.000Z",
                updatedAt: "2026-06-25T10:05:00.000Z",
                lastEvent: "pr_opened",
              },
            ],
            staleCombos: [],
            errors: [],
          };
        },
        makeStagingDir: () => stagingDir,
        async download(request) {
          if (request.fileName === assetName) return archiveBytes;
          if (request.fileName === "checksums.txt") return `${archiveSha}  ${assetName}\n`;
          throw new Error(`unexpected download ${request.fileName}`);
        },
        async mkdir() {},
        async writeFile() {},
        async remove() {},
        async extractArchive(input) {
          return {
            rootDir: `${input.destinationDir}/combo-chen-v1.2.1`,
            executablePath: `${input.destinationDir}/combo-chen-v1.2.1/bin/combo-chen`,
            files: [`${input.destinationDir}/combo-chen-v1.2.1/bin/combo-chen`],
          };
        },
        replaceInstallTarget(input) {
          return {
            targetPath: input.targetPath,
            stagedExecutablePath: `${input.stagedArtifactRoot}/bin/combo-chen`,
            installTarget: {
              path: input.targetPath,
              kind: "release_archive",
              autoReplaceable: true,
              reason: "release archive executable",
            },
            executableMode: 0o755,
            replaced: true,
          };
        },
        postUpdateRefresh(detection) {
          refreshDetections.push(detection);
          return refreshPostUpdateLocalState({
            detection,
            noMistakes: () => ({ status: 0, stdout: "daemon: running\n", stderr: "" }),
          });
        },
      },
    });

    await exec(deps, ["update", "--yes"]);

    expect(detectionCalls).toBe(2);
    expect(refreshDetections).toMatchObject([{ status: "active", comboIds: ["o-r-7"] }]);
    expect(out).toEqual([
      "update available: combo-chen 1.2.0 -> 1.2.1 (stable)",
      `verified ${assetName} (${archiveSha})`,
      "installed combo-chen 1.2.1 to /opt/combo-chen-v1.2.0/bin/combo-chen",
      "post-update refresh: no-mistakes daemon refreshed with no-mistakes daemon start",
      "post-update refresh: live combo runners unchanged: o-r-7",
      "post-update refresh: manual runner refresh remains human-controlled; use combo-chen park -n <combo-id> then combo-chen resume -n <combo-id>",
    ]);
  });

  it("wires update --beta through prerelease resolution, staging, and replacement", async () => {
    const archiveBytes = Buffer.from("beta release archive bytes");
    const archiveSha = createHash("sha256").update(archiveBytes).digest("hex");
    const stableAssetName = "combo-chen-v1.2.1-linux-x64.tar.gz";
    const betaAssetName = "combo-chen-v1.3.0-beta.2-linux-x64.tar.gz";
    const stagingDir = "/updates/combo-chen-update-beta";
    const downloads: unknown[] = [];
    const extracts: unknown[] = [];
    const writes = new Map<string, string>();
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
                    name: stableAssetName,
                    browser_download_url: `https://downloads.example/${stableAssetName}`,
                  },
                  {
                    name: "checksums.txt",
                    browser_download_url: "https://downloads.example/stable-checksums.txt",
                  },
                ],
              },
              {
                tag_name: "v1.3.0-beta.2",
                prerelease: true,
                draft: false,
                assets: [
                  {
                    name: betaAssetName,
                    browser_download_url: `https://downloads.example/${betaAssetName}`,
                  },
                  {
                    name: "checksums.txt",
                    browser_download_url: "https://downloads.example/beta-checksums.txt",
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
          if (request.fileName === betaAssetName) return archiveBytes;
          if (request.fileName === "checksums.txt") return `${archiveSha}  ${betaAssetName}\n`;
          throw new Error(`unexpected download ${request.fileName}`);
        },
        async mkdir() {},
        async writeFile(path, data) {
          writes.set(path, Buffer.from(data).toString("utf8"));
        },
        async remove() {},
        async extractArchive(input) {
          extracts.push(input);
          return {
            rootDir: `${input.destinationDir}/combo-chen-v1.3.0-beta.2`,
            executablePath: `${input.destinationDir}/combo-chen-v1.3.0-beta.2/bin/combo-chen`,
            files: [`${input.destinationDir}/combo-chen-v1.3.0-beta.2/bin/combo-chen`],
          };
        },
        replaceInstallTarget(input) {
          replacements.push(input);
          return {
            targetPath: input.targetPath,
            stagedExecutablePath: `${input.stagedArtifactRoot}/bin/combo-chen`,
            installTarget: {
              path: input.targetPath,
              kind: "release_archive",
              autoReplaceable: true,
              reason: "release archive executable",
            },
            executableMode: 0o755,
            replaced: true,
          };
        },
      },
    });

    await exec(deps, ["update", "--beta", "--yes"]);

    expect(downloads).toEqual([
      {
        kind: "archive",
        url: `https://downloads.example/${betaAssetName}`,
        fileName: betaAssetName,
      },
      {
        kind: "checksums",
        url: "https://downloads.example/beta-checksums.txt",
        fileName: "checksums.txt",
      },
    ]);
    expect(writes.get(`${stagingDir}/downloads/${betaAssetName}`)).toBe("beta release archive bytes");
    expect(extracts).toEqual([
      {
        archivePath: `${stagingDir}/downloads/${betaAssetName}`,
        destinationDir: `${stagingDir}/extracted`,
        assetFileName: betaAssetName,
      },
    ]);
    expect(replacements).toEqual([
      {
        targetPath: "/opt/combo-chen-v1.2.0/bin/combo-chen",
        stagedArtifactRoot: `${stagingDir}/extracted/combo-chen-v1.3.0-beta.2`,
      },
    ]);
    expect(out).toEqual([
      "update available: combo-chen 1.2.0 -> 1.3.0-beta.2 (beta)",
      `verified ${betaAssetName} (${archiveSha})`,
      "installed combo-chen 1.3.0-beta.2 to /opt/combo-chen-v1.2.0/bin/combo-chen",
      "post-update refresh: no active combo runtime detected; no daemon or runner refresh needed",
    ]);
  });
});
// -/ 1/1
