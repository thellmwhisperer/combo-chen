/**
 * @overview Self-update runtime and confirmation safety integration tests.
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
 * @deps ../testing/cli-harness
 */

import { createHash, describe, exec, expect, fakeDeps, it } from "../testing/cli-harness.js";

// -- 1/1 CORE · command contracts <- START HERE --
describe("self-update handler", () => {
  it("rejects update without --yes with a confirmation message", async () => {
    const assetName = "combo-chen-v1.2.1-linux-x64.tar.gz";
    const downloads: unknown[] = [];
    const dirs: string[] = [];
    const writes: unknown[] = [];
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
        makeStagingDir: () => {
          throw new Error("staging should not start without confirmation");
        },
        async download(request) {
          downloads.push(request);
          throw new Error("download should not run without confirmation");
        },
        async mkdir(path) {
          dirs.push(path);
          throw new Error("mkdir should not run without confirmation");
        },
        async writeFile(path, data) {
          writes.push({ path, data });
          throw new Error("writeFile should not run without confirmation");
        },
        async remove(path) {
          removals.push(path);
        },
        async extractArchive(input) {
          extracts.push(input);
          throw new Error("extractArchive should not run without confirmation");
        },
        replaceInstallTarget(input) {
          replacements.push(input);
          throw new Error("replacement should not run without confirmation");
        },
      },
    });

    await expect(exec(deps, ["update"])).rejects.toThrow(
      "confirmation required; rerun with -y/--yes to install 1.2.1",
    );

    expect(downloads).toEqual([]);
    expect(dirs).toEqual([]);
    expect(writes).toEqual([]);
    expect(extracts).toEqual([]);
    expect(removals).toEqual([]);
    expect(replacements).toEqual([]);
    expect(out).toEqual(["update available: combo-chen 1.2.0 -> 1.2.1 (stable)"]);
  });

  it("aborts update when active combo runtime exists and --yes is absent", async () => {
    const assetName = "combo-chen-v1.2.1-linux-x64.tar.gz";
    const unsafeComboId = "o-r-7\u061c\u200e\u200f\u2066\n$(touch .tmp/issue192-pwn)\u2069";
    const downloads: unknown[] = [];
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
        activeRuntime: () => ({
          status: "active",
          active: true,
          comboIds: [unsafeComboId],
          inspectedRunDirs: ["/home/combo/runs/o-r-7"],
          activeCombos: [
            {
              comboId: unsafeComboId,
              runDir: "/home/combo/runs/o-r-7",
              phase: "CODING",
              needsHuman: false,
              branch: "combo/issue-7",
              worktree: "/repo/.worktrees/issue-7",
              tmuxSession: "combo-chen-o-r-7",
              repoDir: "/repo",
              roleWindows: { coder: "coder" },
              createdAt: "2026-06-25T10:00:00.000Z",
              updatedAt: "2026-06-25T10:05:00.000Z",
              lastEvent: "coder_started",
            },
          ],
          staleCombos: [],
          errors: [],
        }),
        makeStagingDir: () => {
          throw new Error("staging should not start while active runtime is unconfirmed");
        },
        async download(request) {
          downloads.push(request);
          throw new Error("download should not run while active runtime is unconfirmed");
        },
        async mkdir() {},
        async writeFile() {},
        async remove() {},
        async extractArchive() {
          throw new Error("extractArchive should not run while active runtime is unconfirmed");
        },
        replaceInstallTarget(input) {
          replacements.push(input);
          throw new Error("replacement should not run while active runtime is unconfirmed");
        },
      },
    });

    await expect(exec(deps, ["update"])).rejects.toThrow(
      "active combo runtime detected; rerun with -y/--yes to update anyway",
    );

    expect(downloads).toEqual([]);
    expect(replacements).toEqual([]);
    expect(out).toEqual([
      "update available: combo-chen 1.2.0 -> 1.2.1 (stable)",
      "warning: active combo runtime detected: o-r-7 $(touch .tmp/issue192-pwn)(CODING)",
    ]);
    expect(out.every((line) => !line.includes("\n"))).toBe(true);
    expect(out[1]).not.toMatch(/[\u061c\u200e\u200f\u2066-\u2069]/u);
  });

  it("aborts update when active runtime detection throws before staging", async () => {
    const assetName = "combo-chen-v1.2.1-linux-x64.tar.gz";
    const downloads: unknown[] = [];
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
        activeRuntime: () => {
          throw new Error("permission denied while reading runtime state");
        },
        makeStagingDir: () => {
          throw new Error("staging should not start when runtime detection is uncertain");
        },
        async download(request) {
          downloads.push(request);
          throw new Error("download should not run when runtime detection is uncertain");
        },
        async mkdir() {},
        async writeFile() {},
        async remove() {},
        async extractArchive() {
          throw new Error("extractArchive should not run when runtime detection is uncertain");
        },
        replaceInstallTarget(input) {
          replacements.push(input);
          throw new Error("replacement should not run when runtime detection is uncertain");
        },
      },
    });

    await expect(exec(deps, ["update"])).rejects.toThrow(
      "active combo runtime state could not be verified; rerun with -y/--yes to update anyway",
    );

    expect(downloads).toEqual([]);
    expect(replacements).toEqual([]);
    expect(out).toEqual([
      "update available: combo-chen 1.2.0 -> 1.2.1 (stable)",
      "warning: active combo runtime state is uncertain: 0 stale runs, 1 detection error",
    ]);
  });

  it("warns and proceeds through active combo runtime when --yes is present", async () => {
    const archiveBytes = Buffer.from("active runtime release archive bytes");
    const archiveSha = createHash("sha256").update(archiveBytes).digest("hex");
    const assetName = "combo-chen-v1.2.1-linux-x64.tar.gz";
    const stagingDir = "/updates/combo-chen-update-active-runtime";
    const downloads: unknown[] = [];
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
        activeRuntime: () => ({
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
        }),
        makeStagingDir: () => stagingDir,
        async download(request) {
          downloads.push(request);
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
    expect(replacements).toEqual([
      {
        targetPath: "/opt/combo-chen-v1.2.0/bin/combo-chen",
        stagedArtifactRoot: `${stagingDir}/extracted/combo-chen-v1.2.1`,
      },
    ]);
    expect(out).toEqual([
      "update available: combo-chen 1.2.0 -> 1.2.1 (stable)",
      "warning: active combo runtime detected: o-r-7(REVIEWING)",
      `verified ${assetName} (${archiveSha})`,
      "installed combo-chen 1.2.1 to /opt/combo-chen-v1.2.0/bin/combo-chen",
      "post-update refresh: no-mistakes daemon refreshed with no-mistakes daemon start",
      "post-update refresh: live combo runners unchanged: o-r-7",
      "post-update refresh: manual runner refresh remains human-controlled; use combo-chen park -n <combo-id> then combo-chen resume -n <combo-id>",
    ]);
  });

  it("warns and proceeds through uncertain runtime detection when --yes is present", async () => {
    const archiveBytes = Buffer.from("uncertain runtime release archive bytes");
    const archiveSha = createHash("sha256").update(archiveBytes).digest("hex");
    const assetName = "combo-chen-v1.2.1-linux-x64.tar.gz";
    const stagingDir = "/updates/combo-chen-update-uncertain-runtime";
    const downloads: unknown[] = [];
    const replacements: unknown[] = [];
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
          return {
            status: "error",
            active: false,
            comboIds: [],
            inspectedRunDirs: ["/home/combo/runs/o-r-7"],
            activeCombos: [],
            staleCombos: [],
            errors: [
              {
                comboId: "o-r-7",
                runDir: "/home/combo/runs/o-r-7",
                reason: "runtime_state_unreadable",
                message: "permission denied while reading journal",
              },
            ],
          };
        },
        makeStagingDir: () => stagingDir,
        async download(request) {
          downloads.push(request);
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
    expect(replacements).toEqual([
      {
        targetPath: "/opt/combo-chen-v1.2.0/bin/combo-chen",
        stagedArtifactRoot: `${stagingDir}/extracted/combo-chen-v1.2.1`,
      },
    ]);
    expect(out).toEqual([
      "update available: combo-chen 1.2.0 -> 1.2.1 (stable)",
      "warning: active combo runtime state is uncertain: 0 stale runs, 1 detection error",
      `verified ${assetName} (${archiveSha})`,
      "installed combo-chen 1.2.1 to /opt/combo-chen-v1.2.0/bin/combo-chen",
      "post-update refresh: runtime state uncertain (0 stale runs, 1 detection error); no daemon or runner refresh attempted",
    ]);
  });
});
// -/ 1/1
