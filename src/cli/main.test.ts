/**
 * @overview Integration tests for the combo-chen CLI. Uses fake tmux/git/gh
 *   deps so tests run without a real terminal or network. ~8000 lines.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at fakeDeps            ← builds the fake universe (tmux, git, gh)
 *   2. "run" describe block         ← the main combo launch flow
 *   3. "nudge-review-comments"      ← most complex integration: mirror sync + routing
 *   4. Pick any describe() block    ← each tests one CLI command in isolation
 *
 *   Each describe() block = one CLI command. Use the markers // -- N/M below
 *   to jump between commands.
 *
 *   ┌─ TEST SECTIONS (by CLI command) ───────────────────────────────┐
 *   │ command surface       Verifies all commands are registered     │
 *   │ overture              Launch runway checklist + artifact       │
 *   │ run                   Treehouse lease + runner.sh + tmux       │
 *   │ attach                Session resolution and journal window    │
 *   │ activate-coder        Coder resume worker                      │
 *   │ nudge-review-comments Mirror sync + PR comment routing         │
 *   │ director-prompt       Manual director prompt endpoint           │
 *   │ emit                  Event append to journal                  │
 *   │ gate-lease            Hidden branch-scoped no-mistakes lease   │
 *   │ reconcile             Frozen journal repair command            │
 *   │ resume                Recovery routing without fresh run setup  │
 *   │ status                Table format + liveness/deep output      │
 *   │ forensics             Markdown/JSON reports + outcome comments │
 *   │ activate-reviewer     Reviewer + director-watch windows        │
 *   │ reviewer-tick         Poll loop: merge, close, LGTM, re-review │
 *   │ events                Journal JSONL read (no follow in tests)  │
 *   │ update                Active self-update command wiring         │
 *   │ park                  reboot handoff + non-terminal tmux stop  │
 *   │ stop                  kill-session + journal stopped event     │
 *   │ resolvePollMs         Env variable resolution                  │
 *   │ run ordering          Treehouse lease + branch safety          │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * @exports none (test file)
 * @deps vitest, node:{child_process,crypto,fs,os,path}, ../core/{combo,events,gate-lease,runtime-ledger,state,work-plan},
 *   ../infra/{config,config-snapshot,release-metadata}, ../roles/{coder,gatekeeper}, ./gate, ./main
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { shellQuote } from "../core/combo.js";
import { appendEvent, readEvents } from "../core/events.js";
import { acquireGateLease } from "../core/gate-lease.js";
import { buildRuntimeLedger, writeRuntimeLedger } from "../core/runtime-ledger.js";
import { listCombos, runDirFor, writeCombo } from "../core/state.js";
import { normalizeMarkdownWorkPlan, renderWorkPlanMarkdown } from "../core/work-plan.js";
import { loadConfig } from "../infra/config.js";
import { CONFIG_SNAPSHOT_FILE, readConfigSnapshot, writeConfigSnapshot } from "../infra/config-snapshot.js";
import { formatReleaseMetadata, releaseMetadata } from "../infra/release-metadata.js";
import { CODER_THREAD_ARTIFACT } from "../roles/coder.js";
import { buildIssuePrIntent, buildWorkPlanPrIntent } from "../roles/gatekeeper.js";
import { GATEKEEPER_WINDOW, GATE_RUNNER_WINDOW } from "./gate.js";
import { buildDirectorWatchCommand, createProgram, isDirectRun, type Deps } from "./main.js";

// -- 1/4 HELPER · Test harness: home, fakeDeps, seedCodexGnhfRun --
function home(): string {
  return mkdtempSync(join(tmpdir(), "combo-chen-cli-"));
}

function idleActiveRuntime() {
  return {
    status: "idle" as const,
    active: false,
    comboIds: [],
    inspectedRunDirs: [],
    activeCombos: [],
    staleCombos: [],
    errors: [],
  };
}

function fakeDeps(overrides: Partial<Deps> = {}): { deps: Deps; calls: string[][]; out: string[] } {
  const calls: string[][] = [];
  const out: string[] = [];
  const sessions = new Set<string>();
  const deps: Deps = {
    env: {},
    out: (line) => out.push(line),
    tmux: (args) => {
      calls.push(["tmux", ...args]);
      const flagIndex = args.indexOf("-t") !== -1 ? args.indexOf("-t") : args.indexOf("-s");
      const target = flagIndex === -1 ? "" : (args[flagIndex + 1] ?? "");
      if (args[0] === "has-session") {
        return { status: sessions.has(target) ? 0 : 1, stdout: "", stderr: "" };
      }
      if (args[0] === "new-session") sessions.add(target);
      if (args[0] === "kill-session") sessions.delete(target);
      return { status: 0, stdout: "", stderr: "" };
    },
    git: (args, cwd) => {
      calls.push(["git", `cwd=${cwd}`, ...args]);
      if (args[0] === "branch" && args[1] === "--show-current") {
        return { status: 0, stdout: "main\n", stderr: "" };
      }
      if (args[0] === "status" && args[1] === "--porcelain") {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    treehouse: (args, cwd) => {
      calls.push(["treehouse", `cwd=${cwd}`, ...args]);
      if (args[0] === "get" && args.includes("--lease")) {
        const holderIndex = args.indexOf("--lease-holder");
        const holder = holderIndex === -1 ? "treehouse-worktree" : (args[holderIndex + 1] ?? "treehouse-worktree");
        const suffix = holder === "o-r-7" ? "issue-7" : holder;
        const worktree = join(cwd, ".worktrees", suffix);
        mkdirSync(worktree, { recursive: true });
        return { status: 0, stdout: `${worktree}\n`, stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    gh: (args) => {
      calls.push(["gh", ...args]);
      if (args[0] === "issue" && args[1] === "view") {
        return {
          status: 0,
          stdout: JSON.stringify({ title: "Issue title", body: "Issue body" }),
          stderr: "",
        };
      }
      return { status: 0, stdout: "[]", stderr: "" };
    },
    noMistakes: (args, cwd) => {
      calls.push(["no-mistakes", `cwd=${cwd}`, ...args]);
      if (args[0] === "status") return { status: 0, stdout: "daemon: running\n", stderr: "" };
      if (args[0] === "axi" && args[1] === "status") {
        return { status: 1, stdout: "No active run.\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "no no-mistakes status" };
    },
    sleep: (ms) => {
      calls.push(["sleep", String(ms)]);
      return Promise.resolve();
    },
    issueExists: () => true,
    ...overrides,
    update: {
      activeRuntime: idleActiveRuntime,
      ...overrides.update,
    },
  };
  return { deps, calls, out };
}

const ISSUE = "https://github.com/o/r/issues/7";
const CODEX_THREAD_ID = "019eb3f5-c135-76d2-88c5-0aa8edfe4c84";

async function exec(deps: Deps, argv: string[]): Promise<void> {
  const program = createProgram(deps);
  await program.parseAsync(["node", "combo-chen", ...argv]);
}

function seedCodexGnhfRun(worktree: string): void {
  const gnhfRun = join(worktree, ".gnhf", "runs", "implement-github-iss-e6510c");
  mkdirSync(gnhfRun, { recursive: true });
  writeFileSync(
    join(gnhfRun, "iteration-1.jsonl"),
    `${JSON.stringify({ type: "thread.started", thread_id: CODEX_THREAD_ID })}\n`,
  );
}

function writeCoderThreadArtifact(runDir: string): void {
  writeFileSync(
    join(runDir, CODER_THREAD_ARTIFACT),
    `${JSON.stringify({
      agent: "codex",
      thread_id: CODEX_THREAD_ID,
      source: ".gnhf/runs/implement-github-iss-e6510c/iteration-1.jsonl",
    })}\n`,
  );
}

// -/ 1/4

// -- 2/4 CORE · Command surface + run (+ attach, activate-coder, nudge-comments, emit) --
function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}
describe("command surface", () => {
  it("detects direct source execution when argv[1] needs file URL escaping", () => {
    const script = "/repo/combo#chen/src/cli/main.ts";

    expect(isDirectRun(pathToFileURL(script).href, script)).toBe(true);
  });

  it("exposes release build metadata through the version flag", () => {
    const { deps } = fakeDeps();

    expect(createProgram(deps).version()).toBe(formatReleaseMetadata(releaseMetadata));
  });

  it("exposes the configured command surface", () => {
    const { deps } = fakeDeps();
    const names = createProgram(deps)
      .commands.map((c) => c.name())
      .sort();
    expect(names).toEqual(
      [
        "activate-coder",
        "activate-reviewer",
        "attach",
        "closure",
        "director-prompt",
        "director-tick",
        "director-watch",
        "emit",
        "ensure-pr-autoclose",
        "events",
        "forensics",
        "gate-lease",
        "gate-restart",
        "intent",
        "reviewer-tick",
        "nudge-review-comments",
        "overture",
        "park",
        "reconcile",
        "resume",
        "run",
        "status",
        "stop",
        "update",
      ].sort(),
    );
  });

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

    expect(detectionCalls).toBe(1);
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
    ]);
  });

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
    const unsafeComboId = "o-r-7\n$(touch .tmp/issue192-pwn)";
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

    expect(detectionCalls).toBe(1);
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
    ]);
  });

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

  it("describes status as the parallel capsule dashboard", () => {
    const { deps } = fakeDeps();
    const program = createProgram(deps);
    const status = program.commands.find((command) => command.name() === "status");

    expect(program.description()).toContain("parallel capsule");
    expect(status?.description()).toContain("parallel capsule dashboard");
    expect(status?.helpInformation()).toContain("Probe downstream no-mistakes/GitHub recovery state");
  });

  it("sends a director prompt command through tmux and journals it", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    const record = {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    };
    writeCombo(dir, record);
    writeRuntimeLedger(
      dir,
      buildRuntimeLedger({
        combo: record,
        runDir: dir,
        cli: "combo-chen",
        roleWindows: { director: "director" },
      }),
    );
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "list-windows") {
          return { status: 0, stdout: "coder\ndirector\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, [
      "director-prompt",
      "-n",
      "o-r-7",
      "--reason",
      "ambiguous_signal",
      "Inspect",
      "the",
      "gate",
      "signal",
    ]);

    expect(calls).toContainEqual([
      "tmux",
      "paste-buffer",
      "-d",
      "-b",
      "combo-chen-nudge-combo-chen-o-r-7-director",
      "-t",
      "combo-chen-o-r-7:director",
    ]);
    expect(readEvents(dir).at(-1)).toMatchObject({
      event: "director_prompted",
      reason: "ambiguous_signal",
      target: "combo-chen-o-r-7:director",
      prompt_preview: expect.stringContaining("Inspect the gate signal"),
    });
    expect(out).toEqual([
      "director-prompt: prompted combo-chen-o-r-7:director for o-r-7 (ambiguous_signal)",
    ]);
  });

  it("prints the canonical issue PR intent with the verbatim autoclose requirement", async () => {
    const h = home();
    writeCombo(runDirFor(h, "o-r-7"), {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    const ghCalls: string[][] = [];
    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        ghCalls.push(["gh", ...args]);
        if (args[0] === "issue" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({ title: "My title", body: "My body" }),
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["intent", "-n", "o-r-7"]);

    expect(ghCalls[0]).toEqual(["gh", "issue", "view", ISSUE, "--json", "title,body"]);
    expect(out).toEqual([
      [
        "Implement GitHub issue https://github.com/o/r/issues/7.",
        "",
        "Title: My title",
        "",
        "Pull request body requirement:",
        "Include this exact visible line verbatim in the PR body, outside comments, code blocks, or collapsed details:",
        "Fixes #7",
        "",
        "Issue body:",
        "My body",
      ].join("\n"),
    ]);
  });

  it("prints exactly the canonical buildIssuePrIntent, preserving shell-special content byte-for-byte", async () => {
    const h = home();
    writeCombo(runDirFor(h, "o-r-7"), {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    // Same intent the runner pushes (run command, main.ts:256) flows through the
    // same buildIssuePrIntent. Pin that the intent command introduces no
    // transformation, even for content with shell-special characters.
    const title = 'Fix `$(rm -rf)` in "quoted" ${VAR} path';
    const body = 'Line 1 with `backticks`\nLine 2 with $(cmd) and "quotes"\n\\backslash tail';
    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        if (args[0] === "issue" && args[1] === "view") {
          return { status: 0, stdout: JSON.stringify({ title, body }), stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["intent", "-n", "o-r-7"]);

    expect(out).toEqual([
      buildIssuePrIntent({ combo: { issueUrl: ISSUE }, issueTitle: title, issueBody: body }),
    ]);
  });

  it("omits the issue body section but keeps the autoclose line when the issue has no body", async () => {
    const h = home();
    writeCombo(runDirFor(h, "o-r-7"), {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        if (args[0] === "issue" && args[1] === "view") {
          // GitHub returns body: null (not "") for an issue with no body.
          return { status: 0, stdout: JSON.stringify({ title: "My title", body: null }), stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["intent", "-n", "o-r-7"]);

    expect(out).toHaveLength(1);
    expect(out[0]).toContain("Fixes #7");
    expect(out[0]).not.toContain("Issue body:");
  });

  it("throws and writes nothing to stdout when the issue fetch fails", async () => {
    const h = home();
    writeCombo(runDirFor(h, "o-r-7"), {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        if (args[0] === "issue" && args[1] === "view") {
          return { status: 1, stdout: "", stderr: "gh: not found" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    // On failure the command must throw and leave stdout empty: nothing partial
    // is ever emitted as if it were a canonical intent.
    await expect(exec(deps, ["intent", "-n", "o-r-7"])).rejects.toThrow(/Issue details not reachable/);
    expect(out).toEqual([]);
  });

  it("throws and writes nothing to stdout for an unknown combo id", async () => {
    const h = home();
    const { deps, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await expect(exec(deps, ["intent", "-n", "missing"])).rejects.toThrow();
    expect(out).toEqual([]);
  });

  it("prints the persisted work-plan intent without fetching a GitHub issue", async () => {
    const h = home();
    const dir = runDirFor(h, "plan-generic-work-1234abcd");
    const plan = normalizeMarkdownWorkPlan({
      markdown: [
        "# Generic work",
        "",
        "## Problem",
        "GitHub issues are only one carrier.",
        "",
        "## Acceptance Criteria",
        "- Plan-backed intent is inspectable without an issue URL.",
        "",
        "## Validation",
        "- pnpm test",
      ].join("\n"),
      source: { type: "local_file", reference: "/plans/generic-work.md" },
    });
    writeCombo(dir, {
      id: "plan-generic-work-1234abcd",
      issueUrl: "",
      workItemSourceType: "local_file",
      workItemSourceReference: "/plans/generic-work.md",
      workItemTitle: "Generic work",
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/plan-generic-work-1234abcd",
      branch: "combo/plan-generic-work-1234abcd",
      tmuxSession: "combo-chen-plan-generic-work-1234abcd",
      createdAt: new Date().toISOString(),
    });
    writeFileSync(join(dir, "work-plan.md"), renderWorkPlanMarkdown(plan));
    const ghCalls: string[][] = [];
    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        ghCalls.push(["gh", ...args]);
        return { status: 1, stdout: "", stderr: "GitHub should not be consulted" };
      },
    });

    await exec(deps, ["intent", "-n", "plan-generic-work-1234abcd"]);

    expect(ghCalls).toEqual([]);
    expect(out).toEqual([buildWorkPlanPrIntent(plan)]);
  });

  it("ensures a generated PR body has a visible source issue autoclose line", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    const ghCalls: string[][] = [];
    let viewed = 0;
    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        ghCalls.push(["gh", ...args]);
        if (args[0] === "pr" && args[1] === "view") {
          viewed += 1;
          if (viewed === 2) {
            return {
              status: 0,
              stdout: "Fixes #7\n\n## Intent\n\nThis mentions issue #7.\n",
              stderr: "",
            };
          }
          return {
            status: 0,
            stdout: "## Intent\n\nThis mentions issue #7.\n\n```text\nFixes #7\n```\n",
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["ensure-pr-autoclose", "-n", "o-r-7", "--pr-url", "https://github.com/o/r/pull/9"]);

    expect(ghCalls[0]).toEqual([
      "gh",
      "pr",
      "view",
      "https://github.com/o/r/pull/9",
      "--json",
      "body",
      "--jq",
      ".body",
    ]);
    expect(ghCalls[1]?.slice(0, 5)).toEqual([
      "gh",
      "pr",
      "edit",
      "https://github.com/o/r/pull/9",
      "--body-file",
    ]);
    const bodyPath = ghCalls[1]?.[5];
    expect(bodyPath).toBe(join(dir, "pr-body.autoclose.md"));
    expect(readFileSync(bodyPath!, "utf8")).toBe(
      "Fixes #7\n\n## Intent\n\nThis mentions issue #7.\n\n```text\nFixes #7\n```\n",
    );
    expect(ghCalls[2]).toEqual([
      "gh",
      "pr",
      "view",
      "https://github.com/o/r/pull/9",
      "--json",
      "body",
      "--jq",
      ".body",
    ]);
    expect(out).toEqual(["pr autoclose ensured for o-r-7"]);
  });

  it("leaves a PR body unchanged when a visible autoclose line already exists", async () => {
    const h = home();
    writeCombo(runDirFor(h, "o-r-7"), {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    const ghCalls: string[][] = [];
    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        ghCalls.push(["gh", ...args]);
        return { status: 0, stdout: "## Intent\n\nFixes #7\n", stderr: "" };
      },
    });

    await exec(deps, ["ensure-pr-autoclose", "-n", "o-r-7", "--pr-url", "https://github.com/o/r/pull/9"]);

    expect(ghCalls).toHaveLength(1);
    expect(out).toEqual(["pr autoclose already present for o-r-7"]);
  });

  it("reports a gh pr view failure while ensuring PR autoclose", async () => {
    const h = home();
    writeCombo(runDirFor(h, "o-r-7"), {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: () => ({ status: 1, stdout: "", stderr: "no pr" }),
    });

    await expect(
      exec(deps, ["ensure-pr-autoclose", "-n", "o-r-7", "--pr-url", "https://github.com/o/r/pull/9"]),
    ).rejects.toThrow("gh pr view failed for https://github.com/o/r/pull/9: no pr");
  });

  it("reports a gh pr edit failure while ensuring PR autoclose", async () => {
    const h = home();
    writeCombo(runDirFor(h, "o-r-7"), {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return { status: 0, stdout: "## Intent\n\nmentions issue #7\n", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "edit rejected" };
      },
    });

    await expect(
      exec(deps, ["ensure-pr-autoclose", "-n", "o-r-7", "--pr-url", "https://github.com/o/r/pull/9"]),
    ).rejects.toThrow("gh pr edit failed for https://github.com/o/r/pull/9: edit rejected");
  });

  it("reports a verification failure when the edited PR body still lacks autoclose", async () => {
    const h = home();
    writeCombo(runDirFor(h, "o-r-7"), {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return { status: 0, stdout: "## Intent\n\nmentions issue #7\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(
      exec(deps, ["ensure-pr-autoclose", "-n", "o-r-7", "--pr-url", "https://github.com/o/r/pull/9"]),
    ).rejects.toThrow(
      "pr autoclose verification failed for https://github.com/o/r/pull/9: body still lacks a visible GitHub autoclose keyword for o-r-7",
    );
  });
});

describe("gate-restart", () => {
  const HEAD = "abcdef012345abcdef012345abcdef0123456789";

  function gateDeps(h: string, overrides: Partial<Deps> = {}): ReturnType<typeof fakeDeps> {
    return fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return { status: 0, stdout: `${HEAD}\n`, stderr: "" };
        }
        if (args[0] === "status" && args[1] === "--porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      ...overrides,
    });
  }

  it("with no PR, restarts the initial gate with the canonical intent and autoclose guard", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    const { deps, calls, out } = gateDeps(h);

    await exec(deps, ["gate-restart", "-n", "o-r-7"]);

    // The restart goes through the real gate script, which bakes in the
    // canonical intent and the autoclose guard. No improvised axi run.
    const script = readFileSync(join(dir, `gatekeeper-initial-${HEAD.slice(0, 12)}.sh`), "utf8");
    expect(script).toContain("ensure-pr-autoclose");
    expect(calls.some((c) => c[0] === "tmux" && c.includes("new-window"))).toBe(true);
    expect(out.join("\n")).toContain("initial gate restarted");
  });

  it("with a PR open and a failed gate at HEAD, force-restarts the post-address gate", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/9" });
    // The exact recovery case: a gate already FAILED at this same head. The
    // idempotent director path would no-op here; gate-restart must force it.
    appendEvent(dir, "gate_status", { state: "failed", head_sha: HEAD });
    const { deps, calls, out } = gateDeps(h);

    await exec(deps, ["gate-restart", "-n", "o-r-7"]);

    const script = readFileSync(join(dir, `gatekeeper-post-${HEAD.slice(0, 12)}.sh`), "utf8");
    expect(script).toContain("ensure-pr-autoclose");
    expect(calls.some((c) => c[0] === "tmux" && c.includes("new-window"))).toBe(true);
    expect(existsSync(join(dir, `gatekeeper-initial-${HEAD.slice(0, 12)}.sh`))).toBe(false);
    expect(out.join("\n")).toContain("post-address gate restarted");
    // Parity with the idempotent path: leave an address_done breadcrumb so the
    // phase moves and there is a journal trace even before the gate emits.
    expect(readEvents(dir).some((e) => e.event === "address_done" && e["head_sha"] === HEAD)).toBe(true);
  });

  it("refuses a post-address gate restart when local HEAD omits the published PR head", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    const publishedSha = "1234567890abcdef1234567890abcdef12345678";
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/9" });
    appendEvent(dir, "gate_status", { state: "idle", head_sha: publishedSha });
    appendEvent(dir, "gate_validated", { sha: publishedSha });
    appendEvent(dir, "review_comment", {
      author: "coderabbitai[bot]",
      kind: "review_comment",
      url: "https://github.com/o/r/pull/9#discussion_r1",
      head_sha: publishedSha,
    });
    const { deps, calls, out } = gateDeps(h, {
      git: (args) => {
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return { status: 0, stdout: `${HEAD}\n`, stderr: "" };
        }
        if (args[0] === "status" && args[1] === "--porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "merge-base" && args[1] === "--is-ancestor" && args[2] === publishedSha && args[3] === HEAD) {
          return { status: 1, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["gate-restart", "-n", "o-r-7"]);

    expect(out.join("\n")).toContain("coder_worktree_out_of_sync");
    expect(out.join("\n")).toContain(`does not include published gate ${publishedSha}`);
    expect(calls.some((c) => c[0] === "tmux" && c.includes("new-window"))).toBe(false);
    expect(existsSync(join(dir, `gatekeeper-post-${HEAD.slice(0, 12)}.sh`))).toBe(false);
    expect(readEvents(dir).some((e) => e.event === "address_done" && e["head_sha"] === HEAD)).toBe(false);
    expect(readEvents(dir).some((e) => e.event === "gate_stale" && e["new_sha"] === HEAD)).toBe(false);
  });

  it("with a plan-backed PR open, restarts the post-address gate without issue fetch or autoclose guard", async () => {
    const h = home();
    const dir = runDirFor(h, "plan-generic-work-1234abcd");
    const plan = normalizeMarkdownWorkPlan({
      markdown: [
        "# Generic work",
        "",
        "## Problem",
        "GitHub issues are only one carrier.",
        "",
        "## Acceptance Criteria",
        "- Plan-backed gates reuse the persisted plan artifact.",
        "",
        "## Validation",
        "- pnpm test",
      ].join("\n"),
      source: { type: "local_file", reference: "/plans/generic-work.md" },
    });
    writeCombo(dir, {
      id: "plan-generic-work-1234abcd",
      issueUrl: "",
      workItemSourceType: "local_file",
      workItemSourceReference: "/plans/generic-work.md",
      workItemTitle: "Generic work",
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/plan-generic-work-1234abcd",
      branch: "combo/plan-generic-work-1234abcd",
      tmuxSession: "combo-chen-plan-generic-work-1234abcd",
      createdAt: new Date().toISOString(),
    });
    writeFileSync(join(dir, "work-plan.md"), renderWorkPlanMarkdown(plan));
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/9" });
    appendEvent(dir, "gate_status", { state: "failed", head_sha: HEAD });
    const ghCalls: string[][] = [];
    const { deps, calls, out } = gateDeps(h, {
      gh: (args) => {
        ghCalls.push(["gh", ...args]);
        return { status: 1, stdout: "", stderr: "GitHub should not be consulted" };
      },
    });

    await exec(deps, ["gate-restart", "-n", "plan-generic-work-1234abcd"]);

    const script = readFileSync(join(dir, `gatekeeper-post-${HEAD.slice(0, 12)}.sh`), "utf8");
    expect(ghCalls).toEqual([]);
    expect(script).toContain("Implement work plan Generic work.");
    expect(script).not.toContain("ensure-pr-autoclose");
    expect(script).not.toContain("pr_autoclose_failed");
    expect(calls.some((c) => c[0] === "tmux" && c.includes("new-window"))).toBe(true);
    expect(out.join("\n")).toContain("post-address gate restarted");
  });

  it("warns but still restarts when a gate is in flight (fix_inflight) at HEAD", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/9" });
    appendEvent(dir, "gate_status", { state: "fix_inflight", head_sha: HEAD });
    const { deps, out } = gateDeps(h);

    await exec(deps, ["gate-restart", "-n", "o-r-7"]);

    // It is a force lever: it still restarts, but it must surface that a gate
    // was running so the director confirms a stall before clobbering it.
    expect(out.join("\n")).toContain("in flight");
    expect(out.join("\n")).toContain("post-address gate restarted");
    expect(existsSync(join(dir, `gatekeeper-post-${HEAD.slice(0, 12)}.sh`))).toBe(true);
  });
});

describe("attach", () => {
  function seedCombo(homeDir: string, id: string, createdAt: string): void {
    const issueNumber = id.split("-").at(-1) ?? "7";
    writeCombo(runDirFor(homeDir, id), {
      id,
      issueUrl: `https://github.com/o/r/issues/${issueNumber}`,
      repoDir: "/repos/r",
      worktree: `/repos/r/.worktrees/issue-${issueNumber}`,
      branch: `combo/issue-${issueNumber}`,
      tmuxSession: `combo-chen-${id}`,
      createdAt,
    });
  }

  it("resolves the only running combo without --name and attaches to its session", async () => {
    const h = home();
    seedCombo(h, "stale-o-r-6", "2026-06-10T10:00:00.000Z");
    seedCombo(h, "o-r-7", "2026-06-10T11:00:00.000Z");
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "has-session") {
          return {
            status: args.at(-1) === "combo-chen-o-r-7" ? 0 : 1,
            stdout: "",
            stderr: "no such session",
          };
        }
        if (args[0] === "list-panes") return { status: 0, stdout: "0\n1\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["attach"]);

    expect(calls).toContainEqual(["tmux", "attach", "-t", "combo-chen-o-r-7"]);
    expect(calls.some((call) => call[1] === "split-window")).toBe(false);
  });

  it("requires --name when several combos are running", async () => {
    const h = home();
    seedCombo(h, "o-r-7", "2026-06-10T10:00:00.000Z");
    seedCombo(h, "o-r-8", "2026-06-10T11:00:00.000Z");
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "has-session") return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(exec(deps, ["attach"])).rejects.toThrow(/--name/);

    expect(calls.some((call) => call[1] === "attach")).toBe(false);
  });

  it("uses a friendly error when the named combo's tmux session is gone", async () => {
    const h = home();
    seedCombo(h, "o-r-7", "2026-06-10T10:00:00.000Z");
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "has-session") {
          return { status: 1, stdout: "", stderr: "can't find session: combo-chen-o-r-7" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    let message = "";
    try {
      await exec(deps, ["attach", "--name", "o-r-7"]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/Combo "o-r-7" is not running/);
    expect(message).toContain('tmux session "combo-chen-o-r-7" does not exist');
    expect(message).not.toContain("can't find session");
    expect(calls.some((call) => call[1] === "attach")).toBe(false);
  });

  it("recreates a missing journal window before attaching", async () => {
    const h = home();
    seedCombo(h, "o-r-7", "2026-06-10T10:00:00.000Z");
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "has-session") return { status: 0, stdout: "", stderr: "" };
        if (args[0] === "list-windows") return { status: 0, stdout: "coder\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["attach", "--name", "o-r-7"]);

    const journalIndex = calls.findIndex(
      (call) => call[1] === "new-window" && call[call.indexOf("-n") + 1] === "journal",
    );
    const attachIndex = calls.findIndex((call) => call[1] === "attach");
    expect(calls[journalIndex]).toEqual([
      "tmux",
      "new-window",
      "-t",
      "combo-chen-o-r-7",
      "-n",
      "journal",
      expect.stringContaining("events --follow -n 'o-r-7'"),
    ]);
    expect(calls[attachIndex]).toEqual(["tmux", "attach", "-t", "combo-chen-o-r-7"]);
    expect(journalIndex).toBeLessThan(attachIndex);
    expect(calls.some((call) => call[1] === "select-pane")).toBe(false);
  });
});

describe("activate-coder", () => {
  it("uses OSS-friendly default coder responding worker", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    writeFileSync(
      join(dir, CODER_THREAD_ARTIFACT),
      `${JSON.stringify({
        agent: "codex",
        thread_id: CODEX_THREAD_ID,
        source: ".gnhf/runs/implement-github-iss-e6510c/iteration-1.jsonl",
      })}\n`,
    );
    const { deps, calls, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["activate-coder", "-n", "o-r-7"]);

    const newWindows = calls.filter((call) => call[0] === "tmux" && call[1] === "new-window");
    expect(newWindows).toHaveLength(1);
    expect(newWindows[0]).toContain("coder-responding");
    expect(out.join("\n")).toContain("coder responding active for o-r-7");
  });

  it("starts the resumed sitter window from the coder thread artifact", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      "[limits]\nbabysit_poll_seconds = 7\n\n[rower.codex]\nresume_command = \"codex --profile sitter --no-alt-screen resume {thread_id}\"\n\n[thread_sitter]\nwindow_name = \"sitter\"\nwatch_window_name = \"sitter-watch\"\n",
    );
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    writeFileSync(
      join(dir, CODER_THREAD_ARTIFACT),
      `${JSON.stringify({
        agent: "codex",
        thread_id: CODEX_THREAD_ID,
        source: ".gnhf/runs/implement-github-iss-e6510c/iteration-1.jsonl",
      })}\n`,
    );
    const { deps, calls } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["activate-coder", "-n", "o-r-7"]);

    const newWindows = calls.filter((call) => call[0] === "tmux" && call[1] === "new-window");
    expect(newWindows).toHaveLength(1);
    expect(newWindows[0]).toContain("sitter");
    expect(newWindows[0]?.at(-1)).toBe(`codex --profile sitter --no-alt-screen resume '${CODEX_THREAD_ID}'`);
    expect(calls.some((call) => call[0] === "git")).toBe(false);
    expect(calls.some((call) => call[0] === "gh")).toBe(false);
  });

  it("reports resumed coder startup failures", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      '[thread_sitter]\nwindow_name = "sitter"\nwatch_window_name = "sitter-watch"\n',
    );
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    writeFileSync(
      join(dir, CODER_THREAD_ARTIFACT),
      `${JSON.stringify({
        agent: "codex",
        thread_id: CODEX_THREAD_ID,
        source: ".gnhf/runs/implement-github-iss-e6510c/iteration-1.jsonl",
      })}\n`,
    );
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "new-window" && args.includes("sitter")) {
          return { status: 1, stdout: "", stderr: "duplicate window" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(exec(deps, ["activate-coder", "-n", "o-r-7"])).rejects.toThrow(
      /tmux failed to start sitter: duplicate window/,
    );

    expect(calls).not.toContainEqual(["tmux", "kill-window", "-t", "combo-chen-o-r-7:sitter"]);
  });
});

describe("nudge-review-comments", () => {
  it("syncs a stale no-mistakes mirror from origin before routing comments", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const originSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const mirrorSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "remote") {
          return { status: 0, stdout: "/home/user/.no-mistakes/repos/o-r.git\n", stderr: "" };
        }
        if (args[0] === "fetch") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "rev-parse") {
          return { status: 0, stdout: `${originSha}\n`, stderr: "" };
        }
        if (args[0] === "ls-remote") {
          return {
            status: 0,
            stdout: `${mirrorSha}\trefs/heads/combo/issue-7\n`,
            stderr: "",
          };
        }
        if (args[0] === "push") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
      },
    });

    await exec(deps, ["nudge-review-comments", "-n", "o-r-7"]);

    expect(calls).toContainEqual([
      "git",
      `cwd=${worktree}`,
      "push",
      "no-mistakes",
      `--force-with-lease=refs/heads/combo/issue-7:${mirrorSha}`,
      "refs/remotes/origin/combo/issue-7:refs/heads/combo/issue-7",
    ]);
    const pushIndex = calls.findIndex((call) => call[0] === "git" && call[2] === "push");
    const firstGhIndex = calls.findIndex((call) => call[0] === "gh");
    expect(pushIndex).toBeGreaterThan(-1);
    expect(firstGhIndex).toBeGreaterThan(pushIndex);
  });

  it("reconciles a divergent mirror with a lease against the observed mirror SHA", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const originSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const mirrorSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const expectedLease = `--force-with-lease=refs/heads/combo/issue-7:${mirrorSha}`;
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "remote") {
          return { status: 0, stdout: "/home/user/.no-mistakes/repos/o-r.git\n", stderr: "" };
        }
        if (args[0] === "fetch") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "rev-parse") {
          return { status: 0, stdout: `${originSha}\n`, stderr: "" };
        }
        if (args[0] === "ls-remote") {
          return {
            status: 0,
            stdout: `${mirrorSha}\trefs/heads/combo/issue-7\n`,
            stderr: "",
          };
        }
        if (args[0] === "push" && args.includes(expectedLease)) {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "push") {
          return { status: 1, stdout: "", stderr: "! [rejected] non-fast-forward" };
        }
        return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
      },
    });

    await exec(deps, ["nudge-review-comments", "-n", "o-r-7"]);

    expect(calls).toContainEqual([
      "git",
      `cwd=${worktree}`,
      "push",
      "no-mistakes",
      expectedLease,
      "refs/remotes/origin/combo/issue-7:refs/heads/combo/issue-7",
    ]);
  });

  it("recovers from a force-pushed origin branch before syncing the mirror", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const originSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const mirrorSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const otherMirrorSha = "cccccccccccccccccccccccccccccccccccccccc";
    const expectedLease = `--force-with-lease=refs/heads/combo/issue-7:${mirrorSha}`;
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "remote") {
          return { status: 0, stdout: "/home/user/.no-mistakes/repos/o-r.git\n", stderr: "" };
        }
        if (args[0] === "fetch") {
          return args[2] === "+combo/issue-7:refs/remotes/origin/combo/issue-7"
            ? { status: 0, stdout: "", stderr: "" }
            : { status: 1, stdout: "", stderr: "non-fast-forward" };
        }
        if (args[0] === "rev-parse") {
          return { status: 0, stdout: `${originSha}\n`, stderr: "" };
        }
        if (args[0] === "ls-remote") {
          return {
            status: 0,
            stdout:
              `${otherMirrorSha}\trefs/heads/aaa/combo/issue-7\n` +
              `${mirrorSha}\trefs/heads/combo/issue-7\n`,
            stderr: "",
          };
        }
        if (args[0] === "push" && args.includes(expectedLease)) {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "push") {
          return { status: 1, stdout: "", stderr: "wrong lease" };
        }
        return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
      },
    });

    await exec(deps, ["nudge-review-comments", "-n", "o-r-7"]);

    expect(calls).toContainEqual([
      "git",
      `cwd=${worktree}`,
      "fetch",
      "origin",
      "+combo/issue-7:refs/remotes/origin/combo/issue-7",
    ]);
    expect(calls).toContainEqual([
      "git",
      `cwd=${worktree}`,
      "push",
      "no-mistakes",
      expectedLease,
      "refs/remotes/origin/combo/issue-7:refs/heads/combo/issue-7",
    ]);
  });

  it("routes a fetched PR comment once and skips repo writes when no mirror remote exists", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      '[thread_sitter]\nreview_nudge_prompt = "Please address {url}"\nwindow_name = "sitter"\n',
    );
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-owned-session",
      createdAt: new Date().toISOString(),
    });
    writeCoderThreadArtifact(dir);
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        calls.push(["gh", ...args]);
        const endpoint = args.at(-1);
        if (endpoint === "repos/o/r/issues/7/comments") {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                html_url: "https://github.com/o/r/pull/7#issuecomment-1",
                user: { login: "external-reviewer" },
                body: "Please handle this.",
              },
            ]),
            stderr: "",
          };
        }
        return { status: 0, stdout: "[]", stderr: "" };
      },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "remote" && args[1] === "get-url" && args[2] === "no-mistakes") {
          return { status: 2, stdout: "", stderr: "No such remote 'no-mistakes'" };
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return { status: 0, stdout: "abc123\n", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
      },
    });

    await exec(deps, ["nudge-review-comments", "-n", "o-r-7"]);
    await exec(deps, ["nudge-review-comments", "-n", "o-r-7"]);

    const events = readEvents(dir).filter((event) => event.event === "review_comment");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      author: "external-reviewer",
      kind: "pr_comment",
      url: "https://github.com/o/r/pull/7#issuecomment-1",
      head_sha: "abc123",
    });

    const tmuxCalls = calls.filter((call) => call[0] === "tmux");
    expect(tmuxCalls).toEqual([
      [
        "tmux",
        "list-windows",
        "-t",
        "combo-chen-owned-session",
        "-F",
        "#{window_name}",
      ],
      [
        "tmux",
        "new-window",
        "-t",
        "combo-chen-owned-session",
        "-n",
        "sitter",
        `codex resume '${CODEX_THREAD_ID}'`,
      ],
      [
        "tmux",
        "set-buffer",
        "-b",
        "combo-chen-nudge-combo-chen-owned-session-sitter",
        "Please address 'https://github.com/o/r/pull/7#issuecomment-1'",
      ],
      [
        "tmux",
        "paste-buffer",
        "-d",
        "-b",
        "combo-chen-nudge-combo-chen-owned-session-sitter",
        "-t",
        "combo-chen-owned-session:sitter",
      ],
      ["tmux", "send-keys", "-t", "combo-chen-owned-session:sitter", "C-m"],
    ]);
    expect(calls.filter((call) => call[0] === "git")).toEqual([
      ["git", `cwd=${worktree}`, "remote", "get-url", "no-mistakes"],
      ["git", `cwd=${worktree}`, "rev-parse", "HEAD"],
      ["git", `cwd=${worktree}`, "remote", "get-url", "no-mistakes"],
    ]);
    const ghCalls = calls.filter((call) => call[0] === "gh");
    expect(ghCalls).not.toHaveLength(0);
    expect(ghCalls.every((call) => call[1] === "api" && !call.includes("--method"))).toBe(true);
  });

  it("routes a fetched PR comment even when mirror git commands fail", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      '[thread_sitter]\nreview_nudge_prompt = "Please address {url}"\nwindow_name = "sitter"\n',
    );
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-owned-session",
      createdAt: new Date().toISOString(),
    });
    writeCoderThreadArtifact(dir);
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        calls.push(["gh", ...args]);
        const endpoint = args.at(-1);
        if (endpoint === "repos/o/r/issues/7/comments") {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                html_url: "https://github.com/o/r/pull/7#issuecomment-1",
                user: { login: "external-reviewer" },
                body: "Please handle this.",
              },
            ]),
            stderr: "",
          };
        }
        return { status: 0, stdout: "[]", stderr: "" };
      },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "remote") {
          return { status: 0, stdout: "/home/user/.no-mistakes/repos/o-r.git\n", stderr: "" };
        }
        if (args[0] === "fetch") {
          return { status: 128, stdout: "", stderr: "network down" };
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return { status: 0, stdout: "abc123\n", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
      },
    });

    await exec(deps, ["nudge-review-comments", "-n", "o-r-7"]);

    const events = readEvents(dir).filter((event) => event.event === "review_comment");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      author: "external-reviewer",
      kind: "pr_comment",
      url: "https://github.com/o/r/pull/7#issuecomment-1",
      head_sha: "abc123",
    });
    expect(out.some((line) => line.includes("mirror sync failed"))).toBe(true);
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "paste-buffer")).toBe(true);
    expect(calls.some((call) => call[0] === "gh")).toBe(true);
  });

  it("skips the mirror push when origin and mirror SHAs match (no-op)", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const sameSha = "cccccccccccccccccccccccccccccccccccccccc";
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "remote") {
          return { status: 0, stdout: "/home/user/.no-mistakes/repos/o-r.git\n", stderr: "" };
        }
        if (args[0] === "fetch") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "rev-parse") {
          return { status: 0, stdout: `${sameSha}\n`, stderr: "" };
        }
        if (args[0] === "ls-remote") {
          return { status: 0, stdout: `${sameSha}\trefs/heads/combo/issue-7\n`, stderr: "" };
        }
        if (args[0] === "push") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
      },
    });

    await exec(deps, ["nudge-review-comments", "-n", "o-r-7"]);

    const gitCalls = calls.filter((call) => call[0] === "git");
    expect(gitCalls.some((call) => call[2] === "push")).toBe(false);
    const ghCalls = calls.filter((call) => call[0] === "gh");
    expect(ghCalls).not.toHaveLength(0);
  });

  it("pushes to create the mirror branch when it does not exist yet", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const originSha = "dddddddddddddddddddddddddddddddddddddddd";
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "remote") {
          return { status: 0, stdout: "/home/user/.no-mistakes/repos/o-r.git\n", stderr: "" };
        }
        if (args[0] === "fetch") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "rev-parse") {
          return { status: 0, stdout: `${originSha}\n`, stderr: "" };
        }
        if (args[0] === "ls-remote") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "push") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
      },
    });

    await exec(deps, ["nudge-review-comments", "-n", "o-r-7"]);

    expect(calls).toContainEqual([
      "git",
      `cwd=${worktree}`,
      "push",
      "no-mistakes",
      "refs/remotes/origin/combo/issue-7:refs/heads/combo/issue-7",
    ]);
  });

  it("skips the mirror push when the gate has a CI fix in flight", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(dir, "gate_status", { state: "fix_inflight", head_sha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" });

    const originSha = "ffffffffffffffffffffffffffffffffffffffff";
    const mirrorSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "remote") {
          return { status: 0, stdout: "/home/user/.no-mistakes/repos/o-r.git\n", stderr: "" };
        }
        if (args[0] === "fetch") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "rev-parse") {
          return { status: 0, stdout: `${originSha}\n`, stderr: "" };
        }
        if (args[0] === "ls-remote") {
          return { status: 0, stdout: `${mirrorSha}\trefs/heads/combo/issue-7\n`, stderr: "" };
        }
        if (args[0] === "push") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
      },
    });

    await exec(deps, ["nudge-review-comments", "-n", "o-r-7"]);

    const gitCalls = calls.filter((call) => call[0] === "git");
    expect(gitCalls.some((call) => call[2] === "push")).toBe(false);
    expect(out.some((line) => line.includes("gatekeeper fix in flight"))).toBe(true);
    const ghCalls = calls.filter((call) => call[0] === "gh");
    expect(ghCalls).not.toHaveLength(0);
  });
});

describe("emit", () => {
  it("appends a validated event to the combo journal", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, [
      "emit",
      "-n",
      "o-r-7",
      "coder_failed",
      "--field",
      "exit_code=3",
      "--field",
      "has_new_commits=true",
    ]);

    const events = readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("coder_failed");
    expect(events[0]?.["exit_code"]).toBe(3);
    expect(events[0]?.["has_new_commits"]).toBe(true);
  });

  it("accepts gate_status from the CLI with its current state", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, [
      "emit",
      "-n",
      "o-r-7",
      "gate_status",
      "--field",
      "state=fix_inflight",
      "--field",
      "head_sha=0123456789abcdef0123456789abcdef01234567",
    ]);

    const events = readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "gate_status",
      state: "fix_inflight",
      head_sha: "0123456789abcdef0123456789abcdef01234567",
    });
  });

  it("accepts post-PR event vocabulary with its required fields", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, [
      "emit",
      "-n",
      "o-r-7",
      "review_comment",
      "--field",
      "author=gordon",
      "--field",
      "kind=judge",
      "--field",
      "url=https://github.com/o/r/pull/7#discussion_r1",
    ]);
    await exec(deps, ["emit", "-n", "o-r-7", "lgtm", "--field", "sha=abc123"]);
    await exec(deps, [
      "emit",
      "-n",
      "o-r-7",
      "lgtm_stale",
      "--field",
      "old_sha=abc123",
      "--field",
      "new_sha=def456",
    ]);
    await exec(deps, ["emit", "-n", "o-r-7", "merged", "--field", "sha=def456", "--field", "by=maintainer"]);
    await exec(deps, ["emit", "-n", "o-r-7", "combo_closed"]);
    await exec(deps, ["emit", "-n", "o-r-7", "coder_retry"]);

    expect(readEvents(dir).map((event) => event.event)).toEqual([
      "review_comment",
      "lgtm",
      "lgtm_stale",
      "merged",
      "combo_closed",
      "coder_retry",
    ]);
  });

  it("records the opened PR URL in the runtime ledger", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: "2026-06-21T17:00:00.000Z",
    });
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, [
      "emit",
      "-n",
      "o-r-7",
      "pr_opened",
      "--field",
      "url=https://github.com/o/r/pull/7",
    ]);

    const ledger = JSON.parse(readFileSync(join(dir, "runtime-ledger.json"), "utf8")) as {
      comboId: string;
      prUrl?: string;
      commands: Record<string, string>;
    };
    expect(ledger.comboId).toBe("o-r-7");
    expect(ledger.prUrl).toBe("https://github.com/o/r/pull/7");
    expect(ledger.commands.closure).toContain("closure -n 'o-r-7'");
  });

  it("surfaces emitting to a combo that was never created (caller bug)", async () => {
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: home() } });
    await expect(exec(deps, ["emit", "-n", "ghost", "coder_started"])).rejects.toThrow(/ENOENT/);
  });

  for (const doneEvent of ["coder_done", "rower_done"] as const) {
    it(`persists the codex thread artifact when ${doneEvent} is emitted`, async () => {
      const h = home();
      const worktree = mkdtempSync(join(tmpdir(), "combo-chen-worktree-"));
      seedCodexGnhfRun(worktree);
      const dir = runDirFor(h, "o-r-7");
      writeCombo(dir, {
        id: "o-r-7",
        issueUrl: ISSUE,
        repoDir: "/repos/r",
        worktree,
        branch: "combo/issue-7",
        tmuxSession: "combo-chen-o-r-7",
        createdAt: new Date().toISOString(),
      });
      const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

      await exec(deps, ["emit", "-n", "o-r-7", doneEvent]);

      expect(JSON.parse(readFileSync(join(dir, CODER_THREAD_ARTIFACT), "utf8"))).toEqual({
        agent: "codex",
        thread_id: CODEX_THREAD_ID,
        source: ".gnhf/runs/implement-github-iss-e6510c/iteration-1.jsonl",
      });
      expect(readEvents(dir).map((event) => event.event)).toEqual(["coder_done"]);
    });
  }

  it("recreates the gatekeeper tmux window when gate_started is emitted", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "list-windows") return { status: 0, stdout: "coder\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["emit", "-n", "o-r-7", "gate_started"]);

    const gatekeeperWindow = calls.find(
      (call) => call[0] === "tmux" && call[1] === "new-window" && call.includes("gatekeeper"),
    );
    expect(gatekeeperWindow).toEqual([
      "tmux",
      "new-window",
      "-t",
      "combo-chen-o-r-7",
      "-n",
      "gatekeeper",
      expect.stringContaining("no-mistakes attach"),
    ]);
    expect(gatekeeperWindow?.at(-1)).toContain(worktree);
    expect(readEvents(dir).map((event) => event.event)).toEqual(["gate_started"]);
  });

  it("uses the launch config snapshot for gate_started window recovery after repo TOML changes", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      "[gatekeeper]\nattach_timeout_seconds = 42\nattach_retry_interval_seconds = 6\n",
    );
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    writeConfigSnapshot(dir, loadConfig({ repoDir, env: {} }));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      "[gatekeeper]\nattach_timeout_seconds = 3\nattach_retry_interval_seconds = 1\n",
    );
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "list-windows") return { status: 0, stdout: "coder\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["emit", "-n", "o-r-7", "gate_started"]);

    const gatekeeperCommand = calls.find(
      (call) => call[0] === "tmux" && call[1] === "new-window" && call.includes("gatekeeper"),
    )?.at(-1) ?? "";
    expect(gatekeeperCommand).toContain("timed out after 42 seconds");
    expect(gatekeeperCommand).toContain("attempt $attempt/7");
    expect(gatekeeperCommand).toContain("sleep 6");
    expect(gatekeeperCommand).not.toContain("timed out after 3 seconds");
  });

  it("refreshes the gatekeeper tmux window when gate_started is emitted with an existing gatekeeper", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "list-windows") return { status: 0, stdout: "gatekeeper\ncoder\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["emit", "-n", "o-r-7", "gate_started"]);

    const gatekeeperWindow = calls.find(
      (call) => call[0] === "tmux" && call[1] === "new-window" && call.includes("gatekeeper"),
    );
    expect(calls).toContainEqual(["tmux", "kill-window", "-t", "combo-chen-o-r-7:gatekeeper"]);
    expect(gatekeeperWindow).toEqual([
      "tmux",
      "new-window",
      "-t",
      "combo-chen-o-r-7",
      "-n",
      "gatekeeper",
      expect.stringContaining("no-mistakes attach"),
    ]);
    expect(gatekeeperWindow?.at(-1)).toContain(worktree);
    expect(readEvents(dir).map((event) => event.event)).toEqual(["gate_started"]);
  });

  it("keeps the gate_started journal event when window recovery cannot inspect tmux", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "list-windows") return { status: 1, stdout: "", stderr: "boom" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await exec(deps, ["emit", "-n", "o-r-7", "hodor_started"]);
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('tmux failed to list windows in "combo-chen-o-r-7": boom'),
      );
    } finally {
      stderr.mockRestore();
    }

    expect(readEvents(dir).map((event) => event.event)).toEqual(["gate_started"]);
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-window")).toBe(false);
  });
});

// -/ 2/4

describe("closure", () => {
  it("closes the named combo through the CLI command", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const runDir = runDirFor(h, "o-r-7");
    writeCombo(runDir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        calls.push(["gh", ...args]);
        return {
          status: 0,
          stdout: JSON.stringify({
            headRefOid: "head777",
            state: "MERGED",
            baseRefName: "main",
            mergeCommit: { oid: "merge777" },
            mergedBy: { login: "maintainer" },
          }),
          stderr: "",
        };
      },
    });

    await exec(deps, ["closure", "-n", "o-r-7"]);

    expect(readEvents(runDir)).toMatchObject([
      { event: "pr_opened" },
      { event: "merged", sha: "merge777", by: "maintainer", source: "closure" },
      { event: "combo_closed", source: "closure" },
    ]);
    expect(calls).toContainEqual(["tmux", "kill-session", "-t", "combo-chen-o-r-7"]);
    expect(out).toEqual(["closure: o-r-7 closed merged PR merge777 by maintainer; teardown complete"]);
  });
});

describe("reconcile", () => {
  it("scopes -n repairs to one combo", async () => {
    const h = home();
    const targetRepo = mkdtempSync(join(tmpdir(), "combo-chen-repo-target-"));
    const otherRepo = mkdtempSync(join(tmpdir(), "combo-chen-repo-other-"));
    const targetDir = runDirFor(h, "o-r-7");
    const otherDir = runDirFor(h, "o-r-8");
    writeCombo(targetDir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: targetRepo,
      worktree: join(targetRepo, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    writeCombo(otherDir, {
      id: "o-r-8",
      issueUrl: "https://github.com/o/r/issues/8",
      repoDir: otherRepo,
      worktree: join(otherRepo, ".worktrees", "issue-8"),
      branch: "combo/issue-8",
      tmuxSession: "combo-chen-o-r-8",
      createdAt: new Date().toISOString(),
    });
    appendEvent(targetDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(otherDir, "pr_opened", { url: "https://github.com/o/r/pull/8" });
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        calls.push(["gh", ...args]);
        return {
          status: 0,
          stdout: JSON.stringify({
            headRefOid: "head777",
            state: "MERGED",
            baseRefName: "main",
            mergeCommit: { oid: "merge777" },
            mergedBy: { login: "maintainer" },
          }),
          stderr: "",
        };
      },
    });

    await exec(deps, ["reconcile", "-n", "o-r-7", "--apply"]);

    expect(readEvents(targetDir)).toMatchObject([
      { event: "pr_opened" },
      { event: "merged", sha: "merge777", by: "maintainer", source: "reconcile" },
      { event: "combo_closed", source: "reconcile" },
    ]);
    expect(readEvents(otherDir).map((event) => event.event)).toEqual(["pr_opened"]);
    expect(calls.some((call) => call.includes("https://github.com/o/r/pull/8"))).toBe(false);
    expect(calls.some((call) => call.includes(`cwd=${otherRepo}`))).toBe(false);
    expect(out).toEqual(["reconcile: o-r-7 merged merge777 by maintainer; teardown complete"]);
  });
});

// -- 3/4 CORE · run (combo launch flow) --
describe("run", () => {
  it("runs overture directly for a clean issue without creating launch resources", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["overture", "--issue", ISSUE, "--repo", repoDir]);

    expect(out).toContain("overture o-r-7");
    expect(out).toContain(`OK work_item_readable: ${ISSUE}`);
    expect(out).toContain("OK branch_free: combo/issue-7");
    expect(out).toContain(`OK no_mistakes_available: ${repoDir}`);
    expect(out).toContain("OK no_mistakes_run_free: combo/issue-7 no active run");
    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(false);
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-session")).toBe(false);

    const artifact = JSON.parse(readFileSync(join(runDirFor(h, "o-r-7"), "overture.json"), "utf8")) as {
      ok: boolean;
      resources: { comboId: string; branch: string; worktree: string; tmuxSession: string };
      checks: Array<{ id: string; status: string; resource: string }>;
    };
    expect(artifact.ok).toBe(true);
    expect(artifact.resources).toMatchObject({
      comboId: "o-r-7",
      branch: "combo/issue-7",
      worktree: join(repoDir, ".worktrees", "issue-7"),
      tmuxSession: "combo-chen-o-r-7",
    });
    expect(artifact.checks).toContainEqual({
      id: "branch_free",
      status: "ok",
      resource: "combo/issue-7",
    });
    expect(artifact.checks).toContainEqual({
      id: "no_mistakes_available",
      status: "ok",
      resource: repoDir,
    });
  });

  it("runs overture directly for a clean local work plan and records the full resource ledger", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const planPath = join(repoDir, "launch-plan.md");
    writeFileSync(
      planPath,
      [
        "# Local plan runway",
        "",
        "## Problem",
        "A local plan should get the same deterministic runway as an issue.",
        "",
        "## Acceptance Criteria",
        "- The direct overture command records plan resources.",
      ].join("\n"),
    );
    const ghCalls: string[][] = [];
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      issueExists: () => {
        throw new Error("issue lookup should not run for --plan");
      },
      gh: (args) => {
        ghCalls.push(["gh", ...args]);
        return { status: 0, stdout: "[]", stderr: "" };
      },
    });

    await exec(deps, ["overture", "--plan", planPath, "--repo", repoDir, "--base", "origin/release-candidate"]);

    const id = out[0]?.replace(/^overture\s+/, "") ?? "";
    expect(id).toMatch(/^plan-local-plan-runway-[0-9a-f]{8}$/);
    expect(out).toContain(`OK work_item_readable: ${planPath}`);
    expect(out).toContain(`OK base_ref_resolved: origin/release-candidate`);
    expect(out.every((line) => !line.startsWith("X "))).toBe(true);
    expect(ghCalls).toEqual([]);
    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(false);
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-session")).toBe(false);

    const artifact = JSON.parse(readFileSync(join(runDirFor(h, id), "overture.json"), "utf8")) as {
      ok: boolean;
      resources: {
        comboId: string;
        base: string;
        baseRef: string;
        branch: string;
        runDir: string;
        sourceReference: string;
        sourceTitle: string;
        sourceType: string;
        tmuxSession: string;
        worktree: string;
      };
      checks: Array<{ id: string; status: string; resource: string }>;
    };
    expect(artifact.ok).toBe(true);
    expect(artifact.checks.every((check) => check.status === "ok")).toBe(true);
    expect(artifact.resources).toMatchObject({
      comboId: id,
      base: "origin/release-candidate",
      baseRef: "origin/release-candidate",
      branch: `combo/${id}`,
      runDir: runDirFor(h, id),
      sourceReference: "launch-plan.md",
      sourceTitle: "Local plan runway",
      sourceType: "local_file",
      tmuxSession: `combo-chen-${id}`,
      worktree: join(repoDir, ".worktrees", id),
    });
  });

  it("blocks an issue overture when the target repo origin cannot be confirmed", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "remote" && args[1] === "get-url" && args[2] === "origin") {
          return { status: 2, stdout: "", stderr: "error: No such remote 'origin'\n" };
        }
        if (args[0] === "branch" && args[1] === "--show-current") return { status: 0, stdout: "main\n", stderr: "" };
        if (args[0] === "status" && args[1] === "--porcelain") return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(exec(deps, ["overture", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /repo_matches_issue.*origin unavailable/,
    );

    expect(out).toContain("X repo_matches_issue: origin origin unavailable: error: No such remote 'origin'");
    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(false);
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-session")).toBe(false);

    const artifact = JSON.parse(readFileSync(join(runDirFor(h, "o-r-7"), "overture.json"), "utf8")) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; resource: string; detail?: string }>;
    };
    expect(artifact.ok).toBe(false);
    expect(artifact.checks).toContainEqual({
      id: "repo_matches_issue",
      status: "failed",
      resource: "origin",
      detail: "origin unavailable: error: No such remote 'origin'",
    });
  });

  it("creates the record, the runner script, the tmux session, and the birth event", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir]);

    const runDir = runDirFor(h, "o-r-7");
    expect(existsSync(join(runDir, "combo.json"))).toBe(true);
    const ledger = JSON.parse(readFileSync(join(runDir, "runtime-ledger.json"), "utf8")) as {
      schemaVersion: number;
      comboId: string;
      repoDir: string;
      runDir: string;
      roleWindows: Record<string, string>;
      logs: Record<string, string>;
      commands: Record<string, string>;
      workItem: Record<string, string>;
      prUrl?: string;
    };
    expect(ledger).toMatchObject({
      schemaVersion: 1,
      comboId: "o-r-7",
      repoDir,
      runDir,
      branch: "combo/issue-7",
      worktree: join(repoDir, ".worktrees", "issue-7"),
      tmuxSession: "combo-chen-o-r-7",
      roleWindows: {
        coder: "coder",
        journal: "journal",
        director: "director",
        gatekeeper: "gatekeeper",
        gateRunner: GATE_RUNNER_WINDOW,
        directorWatch: "director-watch",
      },
      logs: {
        gatekeeper: join(runDir, "gatekeeper.log"),
        autoclose: join(runDir, "autoclose.log"),
        rebase: join(runDir, "rebase.log"),
      },
      workItem: {
        sourceType: "github_issue",
        sourceReference: ISSUE,
        title: "Issue title",
        issueUrl: ISSUE,
      },
      promptTargets: {
        director: "combo-chen-o-r-7:director",
        workPlan: join(runDir, "work-plan.md"),
      },
    });
    expect(ledger.commands.resume).toContain("resume -n 'o-r-7'");
    expect(ledger.commands.eventsFollow).toContain("events --follow -n 'o-r-7'");
    expect(ledger.commands.attach).toContain("attach -n 'o-r-7'");
    expect(ledger.prUrl).toBeUndefined();
    expect(existsSync(join(runDir, CONFIG_SNAPSHOT_FILE))).toBe(true);
    expect(readConfigSnapshot(runDir).roles).toMatchObject({
      coder: "codex",
      gatekeeper: "no-mistakes",
      merge: "human",
    });
    const runner = readFileSync(join(runDir, "runner.sh"), "utf8");
    expect(runner).toContain("gnhf");
    const daemonStart = runner.indexOf("no-mistakes daemon start");
    const mirrorPush = runner.indexOf('git push -o "$mirror_intent" no-mistakes');
    const axiRun = runner.indexOf("no-mistakes axi run");
    expect(daemonStart).toBeGreaterThan(-1);
    expect(mirrorPush).toBeGreaterThan(daemonStart);
    expect(axiRun).toBeGreaterThan(daemonStart);
    expect(axiRun).toBeGreaterThan(mirrorPush);
    expect(runner).toContain("mirror_intent='no-mistakes.intent=");
    expect(runner).not.toContain("activate-coder");
    expect(runner).toContain("activate-reviewer -n 'o-r-7'");

    expect(calls).toContainEqual([
      "treehouse",
      `cwd=${repoDir}`,
      "get",
      "--lease",
      "--lease-holder",
      "o-r-7",
    ]);
    expect(calls).toContainEqual([
      "git",
      `cwd=${join(repoDir, ".worktrees", "issue-7")}`,
      "switch",
      "-c",
      "combo/issue-7",
      "origin/main",
    ]);
    expect(calls.some((c) => c[0] === "git" && c.includes("worktree") && c.includes("add"))).toBe(false);

    const tmuxNewSession = calls.find((c) => c[0] === "tmux" && c[1] === "new-session");
    expect(tmuxNewSession).toContain("combo-chen-o-r-7");
    expect(tmuxNewSession).toContain("coder");
    const tmuxNewWindows = calls.filter((c) => c[0] === "tmux" && c[1] === "new-window");
    const journalWindow = tmuxNewWindows.find((call) => call[call.indexOf("-n") + 1] === "journal");
    expect(journalWindow).toEqual([
      "tmux",
      "new-window",
      "-t",
      "combo-chen-o-r-7",
      "-n",
      "journal",
      expect.stringContaining("events --follow -n 'o-r-7'"),
    ]);
    const directorWindow = tmuxNewWindows.find((call) => call[call.indexOf("-n") + 1] === "director");
    expect(directorWindow).toEqual([
      "tmux",
      "new-window",
      "-t",
      "combo-chen-o-r-7",
      "-n",
      "director",
      expect.stringContaining("Combo director for o-r-7"),
    ]);
    expect(directorWindow?.at(-1)).toContain("claude");
    const gatekeeperWindow = tmuxNewWindows.find((call) => call.includes("gatekeeper"));
    expect(gatekeeperWindow).toEqual([
      "tmux",
      "new-window",
      "-t",
      "combo-chen-o-r-7",
      "-n",
      "gatekeeper",
      expect.stringContaining("no-mistakes attach"),
    ]);
    expect(gatekeeperWindow?.at(-1)).toContain(join(repoDir, ".worktrees", "issue-7"));
    const directorWatchWindow = tmuxNewWindows.find((call) => call.includes("director-watch"));
    expect(directorWatchWindow).toEqual([
      "tmux",
      "new-window",
      "-t",
      "combo-chen-o-r-7",
      "-n",
      "director-watch",
      expect.stringContaining("director-tick -n 'o-r-7'"),
    ]);
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "split-window")).toBe(false);
    expect(calls.some((call) => call[1] === "select-pane")).toBe(false);

    const events = readEvents(runDir);
    expect(events[0]?.event).toBe("combo_created");
  });

  it("preserves human-readable role topology through a first-pass READY and closure path", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const prUrl = "https://github.com/o/r/pull/7";
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const mergeSha = "cccccccccccccccccccccccccccccccccccccccc";
    let prState: "OPEN" | "MERGED" = "OPEN";
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        calls.push(["gh", ...args]);
        if (args[0] === "issue" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({ title: "Issue title", body: "Issue body" }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        if (args[0] === "pr" && args[1] === "edit") return { status: 0, stdout: "", stderr: "" };
        if (args[0] === "pr" && args[1] === "view") {
          const fields = args.at(-1) ?? "";
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: headSha,
              state: prState,
              baseRefName: "main",
              mergeStateStatus: "CLEAN",
              mergeCommit: prState === "MERGED" ? { oid: mergeSha } : null,
              mergedAt: prState === "MERGED" ? "2026-06-11T10:12:00.000Z" : null,
              mergedBy: prState === "MERGED" ? { login: "maintainer" } : null,
              ...(fields.includes("labels") ? { labels: [] } : {}),
              statusCheckRollup: [
                { __typename: "CheckRun", name: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
                { __typename: "CheckRun", name: "CodeRabbit", status: "COMPLETED", conclusion: "SUCCESS" },
              ],
            }),
            stderr: "",
          };
        }
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir]);

    expect(out).toContain(
      `   topology: coder=coder · journal=journal · gate-live=gatekeeper · gate-runner=${GATE_RUNNER_WINDOW} · director-watch=director-watch · coder-responding=lazy`,
    );
    const initialWindows = calls.filter((call) => call[0] === "tmux" && call[1] === "new-window");
    expect(calls.find((call) => call[0] === "tmux" && call[1] === "new-session")).toEqual([
      "tmux",
      "new-session",
      "-d",
      "-s",
      "combo-chen-o-r-7",
      "-n",
      "coder",
      expect.stringContaining("COMBO_CHEN_RUNNER_PROGRESS=1 sh"),
    ]);
    expect(initialWindows.map((call) => call[call.indexOf("-n") + 1])).toEqual([
      "journal",
      "director",
      "gatekeeper",
      "director-watch",
    ]);
    expect(initialWindows.find((call) => call.includes("journal"))?.at(-1)).toContain("events --follow");
    expect(initialWindows.find((call) => call.includes("gatekeeper"))?.at(-1)).toContain("no-mistakes attach");
    expect(initialWindows.find((call) => call.includes("director-watch"))?.at(-1)).toContain("director-tick");
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "split-window")).toBe(false);
    expect(calls.some((call) => call.includes("coder-responding"))).toBe(false);

    await exec(deps, ["emit", "-n", "o-r-7", "pr_opened", "--field", `url=${prUrl}`]);
    await exec(deps, ["emit", "-n", "o-r-7", "gate_validated", "--field", `sha=${headSha}`]);
    await exec(deps, ["emit", "-n", "o-r-7", "lgtm", "--field", `sha=${headSha}`]);
    await exec(deps, ["director-tick", "-n", "o-r-7"]);

    expect(readEvents(runDirFor(h, "o-r-7"))).toContainEqual(
      expect.objectContaining({ event: "ready_for_merge", sha: headSha, pr_url: prUrl }),
    );
    const postReadyWindows = calls.filter((call) => call[0] === "tmux" && call[1] === "new-window");
    expect(postReadyWindows.map((call) => call[call.indexOf("-n") + 1])).toEqual([
      "journal",
      "director",
      "gatekeeper",
      "director-watch",
    ]);
    expect(calls.some((call) => call.includes("coder-responding"))).toBe(false);
    expect(out.some((line) => line.startsWith("director: watch "))).toBe(true);
    expect(out.some((line) => line === "director: tick complete for o-r-7")).toBe(false);

    prState = "MERGED";
    await exec(deps, ["closure", "-n", "o-r-7"]);

    expect(readEvents(runDirFor(h, "o-r-7"))).toContainEqual(
      expect.objectContaining({ event: "combo_closed", source: "closure" }),
    );
    expect(calls).toContainEqual(["tmux", "kill-session", "-t", "combo-chen-o-r-7"]);
    expect(calls.some((call) => call.includes("coder-responding"))).toBe(false);
  });

  it("launches from a local markdown plan and persists the normalized work-plan artifact", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const planPath = join(repoDir, "launch-plan.md");
    writeFileSync(
      planPath,
      [
        "# Let plans launch combos",
        "",
        "## Problem",
        "GitHub issues are currently the only launch carrier.",
        "",
        "## Scope Boundaries",
        "- Accept a local markdown plan.",
        "- Do not require a GitHub issue URL.",
        "",
        "## Acceptance Criteria",
        "- `combo-chen run --plan launch-plan.md --repo .` starts a combo.",
        "- The run records the normalized plan artifact.",
        "",
        "## Validation Commands",
        "- `pnpm test`",
      ].join("\n"),
    );
    const ghCalls: string[][] = [];
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      issueExists: () => {
        throw new Error("issue lookup should not run for --plan");
      },
      gh: (args) => {
        ghCalls.push(["gh", ...args]);
        return { status: 0, stdout: "[]", stderr: "" };
      },
    });

    await exec(deps, ["run", "--plan", planPath, "--repo", repoDir]);

    expect(ghCalls).toEqual([]);
    const [combo] = listCombos(h);
    expect(combo).toMatchObject({
      workItemSourceType: "local_file",
      workItemSourceReference: "launch-plan.md",
      workItemTitle: "Let plans launch combos",
    });
    expect(combo?.id).toMatch(/^plan-let-plans-launch-combos-[0-9a-f]{8}$/);
    expect(combo?.branch).toBe(`combo/${combo?.id}`);
    expect(combo?.worktree).toBe(join(repoDir, ".worktrees", combo?.id ?? ""));

    const runDir = runDirFor(h, combo!.id);
    const ledger = JSON.parse(readFileSync(join(runDir, "runtime-ledger.json"), "utf8")) as {
      schemaVersion: number;
      comboId: string;
      workItem: Record<string, string>;
      roleWindows: Record<string, string>;
      commands: Record<string, string>;
    };
    expect(ledger).toMatchObject({
      schemaVersion: 1,
      comboId: combo!.id,
      repoDir,
      runDir,
      branch: combo!.branch,
      worktree: combo!.worktree,
      tmuxSession: combo!.tmuxSession,
      roleWindows: {
        coder: "coder",
        gatekeeper: "gatekeeper",
        gateRunner: GATE_RUNNER_WINDOW,
        directorWatch: "director-watch",
      },
      workItem: {
        sourceType: "local_file",
        sourceReference: "launch-plan.md",
        title: "Let plans launch combos",
      },
      promptTargets: {
        workPlan: join(runDir, "work-plan.md"),
      },
    });
    expect(ledger.commands.resume).toContain(`resume -n '${combo!.id}'`);

    const artifact = readFileSync(join(runDir, "work-plan.md"), "utf8");
    expect(artifact).toContain("# Let plans launch combos");
    expect(artifact).toContain("Source: local_file launch-plan.md");
    expect(artifact).not.toContain(planPath);
    expect(artifact).toContain("- The run records the normalized plan artifact.");

    const runner = readFileSync(join(runDir, "runner.sh"), "utf8");
    expect(runner).toContain("Implement work plan Let plans launch combos.");
    expect(runner).toContain("Read the normalized work plan artifact");
    expect(runner).toContain("no-mistakes axi run --intent");
    expect(runner).not.toContain("ensure-pr-autoclose");
    expect(runner).not.toContain("Fixes #");
    expect(spawnSync("sh", ["-n", join(runDir, "runner.sh")], { encoding: "utf8" }).status).toBe(0);

    expect(calls).toContainEqual([
      "treehouse",
      `cwd=${repoDir}`,
      "get",
      "--lease",
      "--lease-holder",
      combo!.id,
    ]);
    expect(calls).toContainEqual([
      "git",
      `cwd=${combo!.worktree}`,
      "switch",
      "-c",
      combo!.branch,
      "origin/main",
    ]);
    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(false);
    const events = readEvents(runDir);
    expect(events[0]).toMatchObject({
      event: "combo_created",
      work_item_source_type: "local_file",
      work_item_source_reference: "launch-plan.md",
      work_item_title: "Let plans launch combos",
    });
  });

  it("redacts external markdown plan source references before persistence", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const externalDir = mkdtempSync(join(tmpdir(), "combo-chen-private-user-"));
    const planPath = join(externalDir, "secret-plan.md");
    writeFileSync(
      planPath,
      [
        "# External work",
        "",
        "## Problem",
        "The plan lives outside the target repo.",
        "",
        "## Acceptance Criteria",
        "- Persisted source references do not expose the external path.",
      ].join("\n"),
    );
    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      issueExists: () => {
        throw new Error("issue lookup should not run for --plan");
      },
    });

    await exec(deps, ["run", "--plan", planPath, "--repo", repoDir]);

    const [combo] = listCombos(h);
    expect(combo?.workItemSourceType).toBe("local_file");
    expect(combo?.workItemSourceReference).toMatch(/^external:[0-9a-f]{12}$/);
    expect(combo?.workItemSourceReference).not.toContain(externalDir);
    expect(combo?.id).toContain("plan-external-work-");

    const artifact = readFileSync(join(runDirFor(h, combo!.id), "work-plan.md"), "utf8");
    expect(artifact).toContain(`Source: local_file ${combo!.workItemSourceReference}`);
    expect(artifact).not.toContain(externalDir);
  });

  it("shell-quotes the combo id in runner command invocations", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const hostileIssue = "https://github.com/o; echo pwn/r's/issues/7";
    const hostileId = "o; echo pwn-r's-7";
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["run", "--issue", hostileIssue, "--repo", repoDir]);

    const runnerPath = join(runDirFor(h, hostileId), "runner.sh");
    const runner = readFileSync(runnerPath, "utf8");
    expect(runner).toContain(`emit -n ${shellQuote(hostileId)} coder_started`);
    expect(runner).toContain(`emit -n ${shellQuote(hostileId)} pr_opened`);
    expect(runner).not.toContain("activate-coder");
    expect(runner).toContain(`activate-reviewer -n ${shellQuote(hostileId)}`);
    expect(runner).toContain(`ensure-pr-autoclose -n ${shellQuote(hostileId)} --pr-url`);
    expect(spawnSync("sh", ["-n", runnerPath], { encoding: "utf8" }).status).toBe(0);
  });

  it("uses configured gatekeeper attach retry settings in the gatekeeper tmux window", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      "[hodor]\nattach_timeout_seconds = 45\nattach_retry_interval_seconds = 15\n",
    );
    const { deps, calls } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir]);

    const gatekeeperWindow = calls.find(
      (call) => call[0] === "tmux" && call[1] === "new-window" && call.includes("gatekeeper"),
    );
    const command = gatekeeperWindow?.at(-1) ?? "";
    expect(command).toContain("expected_branch='combo/issue-7'");
    expect(command).toContain("expected_head=$(git rev-parse --short=7 HEAD 2>/dev/null || true)");
    expect(command).toContain('if [ "$attempt" -gt 3 ]; then');
    expect(command).toContain('echo "gatekeeper-attach: timed out after 45 seconds" >&2');
    expect(command).toContain('echo "gatekeeper-attach: waiting for gatekeeper on $expected_branch@$expected_head (attempt $attempt/3)..." >&2');
    expect(command).toContain("sleep 15");
  });

  it("waits for an active no-mistakes run before attaching when attach would exit cleanly", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir]);

    const gatekeeperWindow = calls.find(
      (call) => call[0] === "tmux" && call[1] === "new-window" && call.includes("gatekeeper"),
    );
    const command = gatekeeperWindow?.at(-1) ?? "";
    const head = "abc1234";
    const bin = mkdtempSync(join(tmpdir(), "combo-chen-bin-"));
    const noMistakesCalls = join(bin, "no-mistakes-calls");
    const statusAttempts = join(bin, "status-attempts");
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh
if [ "$1" = "rev-parse" ]; then
  printf '${head}\\n'
  exit 0
fi
exit 64
`,
    );
    writeFileSync(
      join(bin, "no-mistakes"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$NO_MISTAKES_CALLS"
if [ "$1" = "axi" ] && [ "$2" = "status" ]; then
  count=0
  if [ -f "$NO_MISTAKES_STATUS_ATTEMPTS" ]; then
    count=$(cat "$NO_MISTAKES_STATUS_ATTEMPTS")
  fi
  count=$((count + 1))
  printf '%s\\n' "$count" > "$NO_MISTAKES_STATUS_ATTEMPTS"
  if [ "$count" -lt 2 ]; then
    printf 'No active run.\\n'
  else
    printf 'run:\\n  id: 01ATTACH\\n  branch: combo/issue-7\\n  head: ${head}\\n  status: running\\n'
  fi
  exit 0
fi
if [ "$1" = "attach" ]; then
  printf 'attached\\n'
  exit 0
fi
exit 64
`,
    );
    writeFileSync(
      join(bin, "sleep"),
      `#!/bin/sh
printf 'sleep %s\\n' "$*" >> "$NO_MISTAKES_CALLS"
exit 0
`,
    );
    chmodSync(join(bin, "git"), 0o755);
    chmodSync(join(bin, "no-mistakes"), 0o755);
    chmodSync(join(bin, "sleep"), 0o755);

    const result = spawnSync("sh", ["-c", command], {
      encoding: "utf8",
      env: {
        ...process.env,
        COMBO_CHEN_GATEKEEPER_WINDOW_HOLD: "0",
        NO_MISTAKES_CALLS: noMistakesCalls,
        NO_MISTAKES_STATUS_ATTEMPTS: statusAttempts,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("attached");
    expect(readFileSync(noMistakesCalls, "utf8").trim().split(/\r?\n/)).toEqual([
      "axi status",
      "sleep 10",
      "axi status",
      "attach --run 01ATTACH",
    ]);
  });

  it("does not delete run state or worktree when journal-window rollback cannot kill tmux", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "has-session") return { status: 1, stdout: "", stderr: "" };
        if (args[0] === "new-session") return { status: 0, stdout: "", stderr: "" };
        if (args[0] === "list-windows") return { status: 0, stdout: "coder\n", stderr: "" };
        if (args[0] === "new-window" && args.includes("journal")) {
          return { status: 1, stdout: "", stderr: "window failed" };
        }
        if (args[0] === "kill-session") return { status: 1, stdout: "", stderr: "server busy" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /tmux rollback failed.*server busy/,
    );

    const runDir = runDirFor(h, "o-r-7");
    expect(existsSync(join(runDir, "combo.json"))).toBe(true);
    const killIndex = calls.findIndex((call) => call[0] === "tmux" && call[1] === "kill-session");
    expect(killIndex).toBeGreaterThan(-1);
    expect(calls.some((call) => call[0] === "git" && call.includes("remove"))).toBe(false);
    expect(calls.some((call) => call[0] === "git" && call.includes("-D"))).toBe(false);
  });

  it("rolls back run state after killing tmux when journal-window setup fails", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "has-session") return { status: 1, stdout: "", stderr: "" };
        if (args[0] === "new-session") return { status: 0, stdout: "", stderr: "" };
        if (args[0] === "list-windows") return { status: 0, stdout: "coder\n", stderr: "" };
        if (args[0] === "new-window" && args.includes("journal")) {
          return { status: 1, stdout: "", stderr: "window failed" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /journal.*window failed/,
    );

    const journalIndex = calls.findIndex(
      (call) => call[0] === "tmux" && call[1] === "new-window" && call.includes("journal"),
    );
    const killIndex = calls.findIndex((call) => call[0] === "tmux" && call[1] === "kill-session");
    const treehouseReturnIndex = calls.findIndex(
      (call) => call[0] === "treehouse" && call.includes("return"),
    );
    const branchDeleteIndex = calls.findIndex((call) => call[0] === "git" && call.includes("-D"));
    expect(journalIndex).toBeGreaterThan(-1);
    expect(killIndex).toBeGreaterThan(journalIndex);
    expect(treehouseReturnIndex).toBeGreaterThan(killIndex);
    expect(branchDeleteIndex).toBeGreaterThan(treehouseReturnIndex);
    expect(existsSync(join(runDirFor(h, "o-r-7"), "combo.json"))).toBe(false);
  });

  it("blocks an occupied run dir before creating a worktree", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const runDir = runDirFor(h, "o-r-7");
    mkdirSync(join(runDir, CONFIG_SNAPSHOT_FILE), { recursive: true });
    const { deps, calls } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(/run_dir_free/);

    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(false);
    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("remove"))).toBe(false);
    expect(calls.some((call) => call[0] === "git" && call.includes("-D"))).toBe(false);
    expect(existsSync(runDir)).toBe(true);
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-session")).toBe(false);
  });

  it("forces publish-only mode on a no-placeholder repo-level no-mistakes gatekeeper command", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const customGatekeeper =
      `printf '%s:%s' "\${intent}" "\${issue_body}" && no-mistakes axi run --intent "\${intent}"`;
    writeFileSync(join(repoDir, "combo-chen.toml"), `[gatekeeper]\ncommand = ${JSON.stringify(customGatekeeper)}\n`);
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir]);

    const runner = readFileSync(join(runDirFor(h, "o-r-7"), "runner.sh"), "utf8");
    expect(runner).toContain(customGatekeeper);
    expect(runner).toContain('no-mistakes axi run --intent "${intent}" --skip=ci');
    expect(runner).not.toContain("git push no-mistakes HEAD");
  });

  it("renders the default gatekeeper intent with an explicit issue autoclose keyword", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        if (args[0] === "issue" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              title: "Autoclose source issue",
              body: "This only mentions issue #7 without a closing keyword.",
            }),
            stderr: "",
          };
        }
        return { status: 0, stdout: "[]", stderr: "" };
      },
    });

    await exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir]);

    const runnerPath = join(runDirFor(h, "o-r-7"), "runner.sh");
    const runner = readFileSync(runnerPath, "utf8");
    expect(runner).toContain("no-mistakes axi run --intent");
    expect(runner).toContain("This only mentions issue #7 without a closing keyword.");
    expect(runner).toContain("Fixes #7");
    expect(spawnSync("sh", ["-n", runnerPath], { encoding: "utf8" }).status).toBe(0);
  });

  it("renders gatekeeper command placeholders with safely quoted issue facts in the runner", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const gatekeeperCommand =
      "no-mistakes axi run --yes --url {issue_url} --title {issue_title} --body {issue_body} --branch {branch}";
    writeFileSync(join(repoDir, "combo-chen.toml"), `[gatekeeper]\ncommand = ${JSON.stringify(gatekeeperCommand)}\n`);
    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        if (args[0] === "issue" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              title: `Title "double" and 'single'`,
              body: `First line
It's "quoted"; touch /tmp/gatekeeper-owned
$(echo boom)`,
            }),
            stderr: "",
          };
        }
        return { status: 0, stdout: "[]", stderr: "" };
      },
    });

    await exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir]);

    const runnerPath = join(runDirFor(h, "o-r-7"), "runner.sh");
    const runner = readFileSync(runnerPath, "utf8");
    expect(runner).toContain("--url 'https://github.com/o/r/issues/7'");
    expect(runner).toContain("--skip=ci");
    expect(runner).toContain(`--title 'Title "double" and '\\''single'\\'''`);
    expect(runner).toContain(`--body 'First line
It'\\''s "quoted"; touch /tmp/gatekeeper-owned
$(echo boom)'`);
    expect(runner).toContain("--branch 'combo/issue-7'");
    expect(spawnSync("sh", ["-n", runnerPath], { encoding: "utf8" }).status).toBe(0);
  });

  it("rejects unknown gatekeeper command placeholders during runner generation", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(join(repoDir, "combo-chen.toml"), '[gatekeeper]\ncommand = "no-mistakes axi run {isue_url}"\n');
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /Unknown gatekeeper placeholder \{isue_url\}/,
    );
  });

  it("refuses to run when the issue does not exist", async () => {
    const { deps } = fakeDeps({ issueExists: () => false });
    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", home()])).rejects.toThrow(/issue/i);
  });

  it("refuses a second combo for the same issue while the session lives", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });
    await exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir]);

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(/already/i);
  });
});

// -/ 3/4

// -- 4/4 HELPER · Remaining commands: resume, status, reviewer, events, park, stop, poll --
describe("resume", () => {
  it("uses the launch config snapshot for gatekeeper attach timing after repo TOML changes", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      "[gatekeeper]\nattach_timeout_seconds = 42\nattach_retry_interval_seconds = 6\n",
    );
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    writeConfigSnapshot(dir, loadConfig({ repoDir, env: {} }));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      "[gatekeeper]\nattach_timeout_seconds = 3\nattach_retry_interval_seconds = 1\n",
    );
    appendEvent(dir, "gate_started", {});
    appendEvent(dir, "gate_failed", { exit_code: 1 });

    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: () => ({
        status: 0,
        stdout: [
          "run:",
          "  branch: combo/issue-7",
          "  status: running",
          "  steps[1]{step,status,findings,duration_ms}:",
          "    ci,running,0,0",
        ].join("\n"),
        stderr: "",
      }),
    });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    const gatekeeperCommand = calls.find(
      (call) => call[0] === "tmux" && call[1] === "new-window" && call.includes("gatekeeper"),
    )?.at(-1) ?? "";
    expect(gatekeeperCommand).toContain("timed out after 42 seconds");
    expect(gatekeeperCommand).toContain("attempt $attempt/7");
    expect(gatekeeperCommand).toContain("sleep 6");
    expect(gatekeeperCommand).not.toContain("timed out after 3 seconds");
  });

  it("starts reviewer and director monitoring for an existing reviewer-ready PR without a fresh run", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const prUrl = "https://github.com/o/r/pull/7";
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: prUrl });
    appendEvent(dir, "gate_failed", { exit_code: 1 });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: () => ({
        status: 0,
        stdout: ["run:", "  branch: combo/issue-7", "  status: completed"].join("\n"),
        stderr: "",
      }),
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: headSha,
              state: "OPEN",
              statusCheckRollup: [
                { name: "test", conclusion: "SUCCESS" },
                { name: "CodeRabbit", conclusion: "SUCCESS" },
              ],
            }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(false);
    const newWindows = calls.filter((call) => call[0] === "tmux" && call[1] === "new-window");
    expect(newWindows.some((call) => call.includes("reviewer"))).toBe(true);
    expect(newWindows.some((call) => call.includes("director-watch"))).toBe(true);
    expect(out.join("\n")).toContain("resume: PR ready for reviewer");
  });

  it("monitors a live no-mistakes run instead of relaunching gatekeeper work", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "gate_started", {});
    appendEvent(dir, "gate_failed", { exit_code: 1 });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: () => ({
        status: 0,
        stdout: [
          "run:",
          "  branch: combo/issue-7",
          "  status: running",
          "  steps[2]{step,status,findings,duration_ms}:",
          "    review,completed,0,1",
          "    ci,running,0,0",
        ].join("\n"),
        stderr: "",
      }),
    });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(false);
    const recreatedSession = calls.find((call) => call[0] === "tmux" && call[1] === "new-session");
    expect(recreatedSession).toEqual([
      "tmux",
      "new-session",
      "-d",
      "-s",
      "combo-chen-o-r-7",
      "-n",
      "journal",
      expect.stringContaining("events --follow -n 'o-r-7'"),
    ]);
    expect(recreatedSession).not.toContain("coder");
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-window" && call.includes("gatekeeper"))).toBe(true);
    const gatekeeperCommand = calls.find(
      (call) => call[0] === "tmux" && call[1] === "new-window" && call.includes("gatekeeper"),
    )?.at(-1) ?? "";
    expect(gatekeeperCommand).toContain("no-mistakes attach");
    expect(gatekeeperCommand).not.toContain("axi run");
    expect(out.join("\n")).toContain("resume: no-mistakes running ci");
  });

  it("journals a discovered PR and starts reviewer monitoring while no-mistakes is already in CI", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const prUrl = "https://github.com/o/r/pull/7";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "gate_started", {});
    appendEvent(dir, "gate_status", {
      state: "fix_inflight",
      head_sha: "ffffffffffffffffffffffffffffffffffffffff",
    });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: () => ({
        status: 0,
        stdout: [
          "run:",
          "  branch: combo/issue-7",
          "  status: running",
          "  steps[2]{step,status,findings,duration_ms}:",
          "    review,completed,0,1",
          "    ci,running,0,0",
        ].join("\n"),
        stderr: "",
      }),
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "list") {
          return { status: 0, stdout: `${prUrl}\n`, stderr: "" };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    expect(readEvents(dir).at(-1)).toMatchObject({ event: "pr_opened", url: prUrl });
    const newWindows = calls.filter((call) => call[0] === "tmux" && call[1] === "new-window");
    expect(newWindows.some((call) => call.includes("gatekeeper"))).toBe(true);
    expect(newWindows.some((call) => call.includes("reviewer"))).toBe(true);
    expect(newWindows.some((call) => call.includes("director-watch"))).toBe(true);
    expect(out.join("\n")).toContain("resume: no-mistakes running ci");
    expect(out.join("\n")).toContain("reviewer/director monitoring ensured");
  });

  it("starts reviewer monitoring for an existing PR even when the worktree is gone", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const prUrl = "https://github.com/o/r/pull/7";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "missing-issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: prUrl });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return { status: 128, stdout: "", stderr: "not a git repository" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
              state: "OPEN",
              statusCheckRollup: [],
            }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 0, stdout: "[]", stderr: "" };
      },
    });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    const newWindows = calls.filter((call) => call[0] === "tmux" && call[1] === "new-window");
    expect(newWindows.some((call) => call.includes("reviewer"))).toBe(true);
    expect(newWindows.some((call) => call.includes("director-watch"))).toBe(true);
    expect(out.join("\n")).toContain(`resume: PR exists at ${prUrl}; reviewer/director monitoring ensured`);
  });

  it("deterministically relaunches the initial gate after coder finished but no PR was opened", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const headSha = "cccccccccccccccccccccccccccccccccccccccc";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "coder_done", {});
    appendEvent(dir, "gate_started", {});
    appendEvent(dir, "gate_status", { state: "failed", head_sha: headSha });
    appendEvent(dir, "gate_failed", { exit_code: 1 });

    const gitCalls: string[][] = [];
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        gitCalls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return { status: 0, stdout: `${headSha}\n`, stderr: "" };
        }
        if (args[0] === "status" && args[1] === "--porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      noMistakes: () => ({
        status: 0,
        stdout: ["run:", "  branch: combo/issue-7", "  status: cancelled", "outcome: failed"].join("\n"),
        stderr: "",
      }),
    });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    expect(gitCalls.some((call) => call.includes("worktree") && call.includes("add"))).toBe(false);
    expect(gitCalls.some((call) => call.includes("rev-parse") && call.includes("HEAD"))).toBe(true);
    expect(gitCalls.some((call) => call.includes("status") && call.includes("--porcelain"))).toBe(true);

    const gatekeeperWindow = calls.find(
      (call) => call[0] === "tmux" && call[1] === "new-window" && call.includes(GATEKEEPER_WINDOW),
    );
    expect(gatekeeperWindow).toBeDefined();
    const command = gatekeeperWindow?.at(-1) ?? "";
    expect(command).toContain("gatekeeper-initial-cccccccccccc.sh");
    expect(command).not.toContain("activate-coder");

    const scriptPath = join(dir, "gatekeeper-initial-cccccccccccc.sh");
    const script = readFileSync(scriptPath, "utf8");
    expect(script).toContain("no-mistakes daemon start");
    expect(script).toContain('git push -o "$mirror_intent" no-mistakes');
    expect(script).toContain("mirror_intent='no-mistakes.intent=");
    expect(script).toContain("no-mistakes axi run --intent");
    expect(script).toContain('no-mistakes axi status > "$status_probe_log" 2>&1');
    expect(script).toContain("exec no-mistakes attach");
    expect(script).toContain("branch: combo/issue-7");
    expect(script).toContain("pr_autoclose_failed");
    expect(script).toContain("emit -n 'o-r-7' pr_opened");
    expect(script).not.toContain("activate-coder");
    expect(script).toContain("activate-reviewer -n 'o-r-7'");
    expect(spawnSync("sh", ["-n", scriptPath], { encoding: "utf8" }).status).toBe(0);
    expect(out.join("\n")).toContain(`resume: initial gate relaunched for o-r-7 at ${headSha}`);
  });

  it("does not start a second gate when the journal still records an in-flight gate", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "coder_done", {});
    appendEvent(dir, "gate_started", {});
    appendEvent(dir, "gate_status", {
      state: "fix_inflight",
      head_sha: "dddddddddddddddddddddddddddddddddddddddd",
    });

    const { deps, calls, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-window")).toBe(false);
    expect(out.join("\n")).toContain("resume: gate journal is fix_inflight for o-r-7");
  });

  it("does not start a second gate when the in-flight gate SHA is abbreviated", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const headSha = "dddddddddddddddddddddddddddddddddddddddd";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "coder_done", {});
    appendEvent(dir, "gate_started", {});
    appendEvent(dir, "gate_status", { state: "fix_inflight", head_sha: headSha.slice(0, 8) });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args) => {
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return { status: 0, stdout: `${headSha}\n`, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-window")).toBe(false);
    expect(out.join("\n")).toContain("resume: gate journal is fix_inflight for o-r-7");
  });

  it("relaunches the initial gate when the recorded in-flight gate is stale", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const oldSha = "dddddddddddddddddddddddddddddddddddddddd";
    const newSha = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "coder_done", {});
    appendEvent(dir, "gate_started", {});
    appendEvent(dir, "gate_status", { state: "fix_inflight", head_sha: oldSha });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args) => {
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return { status: 0, stdout: `${newSha}\n`, stderr: "" };
        }
        if (args[0] === "status" && args[1] === "--porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      noMistakes: () => ({
        status: 0,
        stdout: ["run:", "  branch: combo/issue-7", "  status: cancelled", "outcome: cancelled"].join("\n"),
        stderr: "",
      }),
    });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    const gatekeeperWindow = calls.find(
      (call) => call[0] === "tmux" && call[1] === "new-window" && call.includes(GATEKEEPER_WINDOW),
    );
    expect(gatekeeperWindow).toBeDefined();
    const script = readFileSync(join(dir, "gatekeeper-initial-eeeeeeeeeeee.sh"), "utf8");
    expect(script).toContain('git push -o "$mirror_intent" no-mistakes');
    expect(script).toContain("no-mistakes axi run --intent");
    expect(out.join("\n")).toContain(`resume: initial gate relaunched for o-r-7 at ${newSha}`);
  });

  it("does not retry the initial gate when gate_failed exhaustion has been journaled", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const headSha = "dddddddddddddddddddddddddddddddddddddddd";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "coder_done", {});
    appendEvent(dir, "gate_started", {});
    appendEvent(dir, "gate_status", { state: "failed", head_sha: headSha });
    appendEvent(dir, "gate_failed", { exit_code: 1 });
    appendEvent(dir, "needs_human", { reason: "gate_failed" });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args) => {
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return { status: 0, stdout: `${headSha}\n`, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      noMistakes: () => ({
        status: 0,
        stdout: ["run:", "  branch: combo/issue-7", "  status: cancelled", "outcome: failed"].join("\n"),
        stderr: "",
      }),
    });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    const gatekeeperWindow = calls.find(
      (call) => call[0] === "tmux" && call[1] === "new-window" && call.includes("gatekeeper"),
    );
    expect(gatekeeperWindow).toBeUndefined();
    expect(out.join("\n")).toContain("resume: salvage required");
  });

  it("ensures reviewer and director monitoring when a PR already exists", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const prUrl = "https://github.com/o/r/pull/7";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: prUrl });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
              state: "OPEN",
              statusCheckRollup: [],
            }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 0, stdout: "[]", stderr: "" };
      },
    });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    const newWindows = calls.filter((call) => call[0] === "tmux" && call[1] === "new-window");
    expect(newWindows.some((call) => call.includes("reviewer"))).toBe(true);
    expect(newWindows.some((call) => call.includes("director-watch"))).toBe(true);
    expect(out.join("\n")).toContain(`resume: PR exists at ${prUrl}; reviewer/director monitoring ensured`);
  });

  it("runs closure instead of reviewer monitoring when the existing PR is already merged", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const prUrl = "https://github.com/o/r/pull/7";
    const runDir = runDirFor(h, "o-r-7");
    writeCombo(runDir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(runDir, "pr_opened", { url: prUrl });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        calls.push(["gh", ...args]);
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return {
          status: 0,
          stdout: JSON.stringify({
            headRefOid: "head777",
            state: "MERGED",
            baseRefName: "main",
            mergeCommit: { oid: "merge777" },
            mergedBy: { login: "maintainer" },
            statusCheckRollup: [],
          }),
          stderr: "",
        };
      },
    });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-window")).toBe(false);
    expect(calls).toContainEqual(["treehouse", `cwd=${repoDir}`, "return", "--force", join(repoDir, ".worktrees", "issue-7")]);
    expect(calls).toContainEqual(["git", `cwd=${repoDir}`, "branch", "-D", "combo/issue-7"]);
    expect(readEvents(runDir)).toMatchObject([
      { event: "pr_opened" },
      { event: "merged", sha: "merge777", by: "maintainer", source: "closure" },
      { event: "combo_closed", source: "closure" },
    ]);
    expect(out.join("\n")).toContain("resume: closure pending for o-r-7 (github); running closure");
    expect(out.join("\n")).toContain("closure: o-r-7 closed merged PR merge777 by maintainer; teardown complete");
  });

  it("surfaces exact no-mistakes gate findings and the respond command", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "gate_started", {});
    appendEvent(dir, "needs_human", { reason: "gate_waiting" });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: () => ({
        status: 0,
        stdout: [
          "run:",
          "  id: \"01KV-GATE\"",
          "  branch: combo/issue-7",
          "  status: waiting",
          "  findings: \"2 awaiting\"",
          "findings[2]{id,status,title}:",
          "  NM-1,awaiting,\"missing test\"",
          "  NM-2,awaiting,\"needs docs\"",
          "outcome: awaiting_approval",
          "next_step: \"no-mistakes axi respond --run 01KV-GATE --finding NM-1 --yes\"",
        ].join("\n"),
        stderr: "",
      }),
    });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    const text = out.join("\n");
    expect(text).toContain("resume: awaiting review gate: NM-1, NM-2");
    expect(text).toContain("respond: no-mistakes axi respond --run 01KV-GATE --finding NM-1 --yes");
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-window")).toBe(false);
  });

  it("marks a stopped coder before handoff as salvage-required with exact commands", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const baseSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "coder_started", {});
    appendEvent(dir, "coder_failed", {
      exit_code: 124,
      has_new_commits: true,
      base_sha: baseSha,
      head_sha: headSha,
      new_commit_count: 42,
    });

    const { deps, calls, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["resume", "-n", "o-r-7"]);

    const text = out.join("\n");
    expect(text).toContain("resume: salvage required for o-r-7; coder stopped before handoff");
    expect(text).toContain("coder failed with exit 124 after 42 new commits");
    expect(text).toContain(`cd ${shellQuote(worktree)}`);
    expect(text).toContain("git status --short");
    expect(text).toContain(`git log --oneline ${shellQuote(`${baseSha}..${headSha}`)}`);
    expect(text).toContain(`COMBO_CHEN_HOME=${shellQuote(h)}`);
    expect(text).toContain(" status --deep");
    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(false);
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-window")).toBe(false);
  });
});

describe("status", () => {
  it("prints one line per combo with phase and needs-human flag", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "coder_started", {});
    appendEvent(dir, "needs_human", { reason: "gate_decision" });

    const { deps, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });
    await exec(deps, ["status"]);

    const text = out.join("\n");
    expect(text).toContain("CAPSULE");
    expect(text).toContain("o-r-7");
    expect(text).toContain("CODING");
    expect(text).toContain("gate_decision");
  });

  it("prints plan work item source and title", async () => {
    const h = home();
    const id = "plan-let-plans-launch-combos-12345678";
    const planPath = "/plans/issue-134.md";
    const dir = runDirFor(h, id);
    writeCombo(dir, {
      id,
      issueUrl: "",
      workItemSourceType: "local_file",
      workItemSourceReference: planPath,
      workItemTitle: "Let plans launch combos",
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/plan-let-plans-launch-combos-12345678",
      branch: "combo/plan-let-plans-launch-combos-12345678",
      tmuxSession: `combo-chen-${id}`,
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "coder_started", {});
    appendEvent(dir, "needs_human", { reason: "gate_decision" });

    const { deps, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });
    await exec(deps, ["status"]);

    const text = out.join("\n");
    expect(text).toContain("WORK ITEM");
    expect(text).toContain("Let plans launch combos");
    expect(text).toContain(`local_file:${planPath}`);
  });

  it("prints the PR URL from the runtime ledger when the journal lacks pr_opened", async () => {
    const h = home();
    const prUrl = "https://github.com/o/r/pull/7";
    const dir = runDirFor(h, "o-r-7");
    const combo = {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    };
    writeCombo(dir, combo);
    writeRuntimeLedger(dir, buildRuntimeLedger({ combo, runDir: dir, cli: "combo-chen", prUrl }));
    appendEvent(dir, "gate_started", {});
    appendEvent(dir, "gate_failed", { exit_code: 1 });

    const { deps, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });
    await exec(deps, ["status"]);

    const text = out.join("\n");
    expect(text).toContain("o-r-7");
    expect(text).toContain("STALLED");
    expect(text).toContain(prUrl);
  });

  it("prints active branch-scoped gate lease ownership", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    const worktree = "/repos/r/.worktrees/issue-7";
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "coder_started", {});
    appendEvent(dir, "needs_human", { reason: "gate_decision" });
    acquireGateLease({
      home: h,
      owner: {
        comboId: "o-r-7",
        branch: "combo/issue-7",
        worktree,
        runDir: dir,
        headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });

    const { deps, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });
    await exec(deps, ["status"]);

    const text = out.join("\n");
    expect(text).toContain("GATE-LEASE");
    expect(text).toContain("o-r-7@combo/issue-7");
  });

  it("prints all active branch-scoped gate leases when no combos are actionable", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    const worktree = "/repos/r/.worktrees/issue-7";
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "combo_closed", {});
    acquireGateLease({
      home: h,
      owner: {
        comboId: "o-r-7",
        branch: "combo/issue-7",
        worktree,
        runDir: dir,
        headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });
    acquireGateLease({
      home: h,
      owner: {
        comboId: "o-r-8",
        branch: "combo/issue-8",
        worktree: "/repos/r/.worktrees/issue-8",
        runDir: runDirFor(h, "o-r-8"),
        headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    });

    const { deps, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });
    await exec(deps, ["status"]);

    const text = out.join("\n");
    expect(text).toContain("active gate leases: o-r-7@combo/issue-7, o-r-8@combo/issue-8");
    expect(text).toContain("no actionable combos. show history: combo-chen status --all");
  });

  it("hides terminal historical combos by default and preserves them with --all", async () => {
    const h = home();
    const liveDir = runDirFor(h, "o-r-live");
    writeCombo(liveDir, {
      id: "o-r-live",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-live",
      branch: "combo/issue-live",
      tmuxSession: "combo-chen-o-r-live",
      createdAt: new Date().toISOString(),
    });
    appendEvent(liveDir, "coder_started", {});

    const historicalDir = runDirFor(h, "o-r-merged");
    writeCombo(historicalDir, {
      id: "o-r-merged",
      issueUrl: "https://github.com/o/r/issues/8",
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-8",
      branch: "combo/issue-8",
      tmuxSession: "combo-chen-o-r-8",
      createdAt: new Date().toISOString(),
    });
    appendEvent(historicalDir, "pr_opened", { url: "https://github.com/o/r/pull/8" });
    appendEvent(historicalDir, "merged", { sha: "abc1234", by: "maintainer" });
    appendEvent(historicalDir, "combo_closed", {});

    const { deps, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });
    await exec(deps, ["status"]);

    const defaultText = out.join("\n");
    expect(defaultText).toContain("o-r-live");
    expect(defaultText).not.toContain("o-r-merged");

    out.length = 0;
    await exec(deps, ["status", "--all"]);

    const allText = out.join("\n");
    expect(allText).toContain("o-r-live");
    expect(allText).toContain("o-r-merged");
    expect(allText).toContain("STOPPED");
  });

  it("prints a history hint when default status has no actionable combos", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-stopped");
    writeCombo(dir, {
      id: "o-r-stopped",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "stopped", { by: "operator" });

    const { deps, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });
    await exec(deps, ["status"]);

    expect(out).toEqual(["no actionable combos. show history: combo-chen status --all"]);
  });

  it("reports merged PRs as closure pending while preserving closed-PR salvage", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const mergedDir = runDirFor(h, "o-r-merged");
    writeCombo(mergedDir, {
      id: "o-r-merged",
      issueUrl: "https://github.com/o/r/issues/8",
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-8"),
      branch: "combo/issue-8",
      tmuxSession: "combo-chen-o-r-merged",
      createdAt: new Date().toISOString(),
    });
    appendEvent(mergedDir, "pr_opened", { url: "https://github.com/o/r/pull/8" });

    const closedDir = runDirFor(h, "o-r-closed");
    writeCombo(closedDir, {
      id: "o-r-closed",
      issueUrl: "https://github.com/o/r/issues/9",
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-9"),
      branch: "combo/issue-9",
      tmuxSession: "combo-chen-o-r-closed",
      createdAt: new Date().toISOString(),
    });
    appendEvent(closedDir, "pr_opened", { url: "https://github.com/o/r/pull/9" });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        calls.push(["gh", ...args]);
        if (args[0] === "pr" && args[1] === "view" && args[2] === "https://github.com/o/r/pull/8") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: "head888",
              state: "MERGED",
              baseRefName: "main",
              mergeCommit: { oid: "merge888" },
              mergedBy: { login: "maintainer" },
            }),
            stderr: "",
          };
        }
        if (args[0] === "pr" && args[1] === "view" && args[2] === "https://github.com/o/r/pull/9") {
          return {
            status: 0,
            stdout: JSON.stringify({ headRefOid: "head999", state: "CLOSED", mergedBy: null }),
            stderr: "",
          };
        }
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["status"]);

    const text = out.join("\n");
    expect(text).toContain("CAPSULE");
    expect(text).toContain("o-r-merged");
    expect(text).toContain("STALLED");
    expect(text).toContain("closure_pending");
    expect(text).not.toContain("o-r-closed");
    expect(readEvents(mergedDir)).toMatchObject([
      { event: "pr_opened", url: "https://github.com/o/r/pull/8" },
      { event: "merged", sha: "merge888", by: "maintainer", source: "reconcile" },
    ]);
    expect(readEvents(mergedDir).some((event) => event.event === "combo_closed")).toBe(false);
    expect(readEvents(closedDir)).toMatchObject([
      { event: "pr_opened", url: "https://github.com/o/r/pull/9" },
      { event: "needs_human", reason: "pr_closed", source: "reconcile" },
      { event: "combo_closed", source: "reconcile" },
    ]);
    expect(calls).not.toContainEqual(["tmux", "kill-session", "-t", "combo-chen-o-r-merged"]);
    expect(calls).toContainEqual(["tmux", "kill-session", "-t", "combo-chen-o-r-closed"]);
    expect(calls).not.toContainEqual([
      "git",
      `cwd=${repoDir}`,
      "worktree",
      "remove",
      "--force",
      join(repoDir, ".worktrees", "issue-8"),
    ]);
    expect(
      calls.some(
        (call) =>
          call[0] === "git" &&
          call[2] === "branch" &&
          call[3] === "-D" &&
          call[4] === "combo/issue-8",
      ),
    ).toBe(false);
    expect(calls.some((call) => call[0] === "git" && call.includes(join(repoDir, ".worktrees", "issue-9")))).toBe(false);
    expect(
      calls.some(
        (call) =>
          call[0] === "git" &&
          call[2] === "branch" &&
          call[3] === "-D" &&
          call[4] === "combo/issue-9",
      ),
    ).toBe(false);
  });

  it("marks non-terminal combos with missing tmux sessions as needing human attention", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "coder_started", {});
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "has-session") return { status: 1, stdout: "", stderr: "no such session" };
        return { status: 0, stdout: "", stderr: "" };
      },
      gh: (args) => {
        calls.push(["gh", ...args]);
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({ headRefOid: "head777", state: "OPEN", mergedBy: null }),
            stderr: "",
          };
        }
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["status"]);

    expect(out.join("\n")).toContain("tmux_missing");
    expect(readEvents(dir)).toMatchObject([
      { event: "coder_started" },
      { event: "pr_opened", url: "https://github.com/o/r/pull/7" },
      { event: "needs_human", reason: "tmux_missing", source: "status" },
    ]);
    expect(calls).toContainEqual(["tmux", "has-session", "-t", "combo-chen-o-r-7"]);
  });

  it("does not mark parked combos as tmux_missing", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "coder_started", {});
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(dir, "parked", { by: "operator", summary_path: "/repos/r/.worktrees/issue-7/park-handoff.md" });
    const before = readEvents(dir);

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "has-session") return { status: 1, stdout: "", stderr: "no such session" };
        return { status: 0, stdout: "", stderr: "" };
      },
      gh: (args) => {
        calls.push(["gh", ...args]);
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({ headRefOid: "head777", state: "OPEN", mergedBy: null }),
            stderr: "",
          };
        }
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["status"]);

    expect(out.join("\n")).toContain("o-r-7");
    expect(out.join("\n")).not.toContain("tmux_missing");
    expect(readEvents(dir)).toEqual(before);
    expect(calls).not.toContainEqual(["tmux", "has-session", "-t", "combo-chen-o-r-7"]);
  });

  it("prints downstream no-mistakes CI state in deep mode for stale stalled combos", async () => {
    const h = home();
    const worktree = "/repos/r/.worktrees/issue-7";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "gate_started", {});
    appendEvent(dir, "gate_failed", { exit_code: 1 });

    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: (args: string[], cwd: string) => {
        expect(args).toEqual(["axi", "status"]);
        expect(cwd).toBe(worktree);
        return {
          status: 0,
          stdout: [
            "run:",
            "  id: \"01KV-CI\"",
            "  branch: combo/issue-7",
            "  status: running",
            "  head: abc1234",
            "  steps[9]{step,status,findings,duration_ms}:",
            "    intent,completed,0,1",
            "    review,completed,0,1",
            "    ci,running,0,0",
          ].join("\n"),
          stderr: "",
        };
      },
    });
    await exec(deps, ["status", "--deep"]);

    const text = out.join("\n");
    expect(text).toContain("STALLED");
    expect(text).toContain("gate_failed");
    expect(text).toContain("no-mistakes running ci");
  });

  it("syncs combo PR labels from status --deep with fake GitHub state", async () => {
    const h = home();
    const worktree = "/repos/r/.worktrees/issue-7";
    const prUrl = "https://github.com/o/r/pull/7";
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: prUrl });
    appendEvent(dir, "gate_started", {});

    let liveLabels: Array<{ name: string }> = [];
    const { deps, calls } = fakeDeps({
      env: {
        COMBO_CHEN_HOME: h,
        COMBO_CHEN_PR_LABEL_GREEN_CHECK_NAMES: "ExternalReview Pro",
      },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "has-session") return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
      noMistakes: () => ({
        status: 0,
        stdout: [
          "run:",
          "  branch: combo/issue-7",
          "  status: running",
          "  steps[1]{step,status,findings,duration_ms}:",
          "    ci,running,0,0",
        ].join("\n"),
        stderr: "",
      }),
      gh: (args) => {
        calls.push(["gh", ...args]);
        if (args[0] === "pr" && args[1] === "view") {
          const fields = args.at(-1) ?? "";
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: headSha,
              state: "OPEN",
              ...(fields.includes("labels") ? { labels: liveLabels } : {}),
              ...(fields.includes("statusCheckRollup")
                ? {
                    statusCheckRollup: [
                      { name: "test", conclusion: "SUCCESS" },
                      { name: "ExternalReview", conclusion: "FAILURE" },
                      { name: "ExternalReview Pro", conclusion: "SUCCESS" },
                    ],
                  }
                : {}),
            }),
            stderr: "",
          };
        }
        if (args[0] === "pr" && args[1] === "edit") {
          if (args[3] === "--add-label") {
            liveLabels = liveLabels.concat(String(args[4] ?? "").split(",").map((name) => ({ name })));
          }
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["status", "--deep"]);

    expect(calls).toContainEqual([
      "gh",
      "pr",
      "edit",
      prUrl,
      "--add-label",
      "combo:working-gate,combo:external-review-green",
    ]);
    expect(readEvents(dir)).toContainEqual(
      expect.objectContaining({
        event: "pr_labels_updated",
        pr_url: prUrl,
        head_sha: headSha,
        old_labels: [],
        new_labels: ["combo:working-gate", "combo:external-review-green"],
        added_labels: ["combo:working-gate", "combo:external-review-green"],
        removed_labels: [],
        reason: "current",
        source: "status-deep",
      }),
    );
  });

  it("prints awaiting no-mistakes gate finding ids and respond command in deep mode", async () => {
    const h = home();
    const worktree = "/repos/r/.worktrees/issue-7";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "gate_started", {});
    appendEvent(dir, "needs_human", { reason: "gate_waiting" });

    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: () => ({
        status: 0,
        stdout: [
          "run:",
          "  id: \"01KV-GATE\"",
          "  branch: combo/issue-7",
          "  status: waiting",
          "  findings: \"2 awaiting\"",
          "findings[2]{id,status,title}:",
          "  NM-1,awaiting,\"missing test\"",
          "  NM-2,awaiting,\"needs docs\"",
          "outcome: awaiting_approval",
          "next_step: \"no-mistakes axi respond --run 01KV-GATE --finding NM-1 --yes\"",
        ].join("\n"),
        stderr: "",
      }),
    });
    await exec(deps, ["status", "--deep"]);

    const text = out.join("\n");
    expect(text).toContain("awaiting review gate: NM-1, NM-2");
    expect(text).toContain("respond: no-mistakes axi respond --run 01KV-GATE --finding NM-1 --yes");
  });

  it("does not classify zero awaiting findings as an awaiting review gate in deep mode", async () => {
    const h = home();
    const worktree = "/repos/r/.worktrees/issue-7";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "gate_started", {});

    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: () => ({
        status: 0,
        stdout: [
          "run:",
          "  branch: combo/issue-7",
          "  status: running",
          "  findings: \"0 awaiting\"",
          "steps[1]{step,status,findings,duration_ms}:",
          "  review,running,0,0",
        ].join("\n"),
        stderr: "",
      }),
    });
    await exec(deps, ["status", "--deep"]);

    const text = out.join("\n");
    expect(text).toContain("no-mistakes running review");
    expect(text).not.toContain("awaiting review gate");
  });

  it("prints PR ready for reviewer in deep mode when GitHub checks are green and no reviewer pin exists", async () => {
    const h = home();
    const worktree = "/repos/r/.worktrees/issue-7";
    const prUrl = "https://github.com/o/r/pull/7";
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: prUrl });
    appendEvent(dir, "gate_failed", { exit_code: 1 });

    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: () => ({
        status: 0,
        stdout: ["run:", "  branch: combo/issue-7", "  status: completed"].join("\n"),
        stderr: "",
      }),
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: headSha,
              state: "OPEN",
              statusCheckRollup: [
                { name: "test", conclusion: "SUCCESS" },
                { name: "CodeRabbit", conclusion: "SUCCESS" },
              ],
            }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });
    await exec(deps, ["status", "--deep"]);

    const text = out.join("\n");
    expect(text).toContain("STALLED");
    expect(text).toContain("gate_failed");
    expect(text).toContain("PR ready for reviewer");
  });

  it("uses the runtime ledger PR URL for deep GitHub status when the journal lacks pr_opened", async () => {
    const h = home();
    const worktree = "/repos/r/.worktrees/issue-7";
    const prUrl = "https://github.com/o/r/pull/7";
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const dir = runDirFor(h, "o-r-7");
    const combo = {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    };
    writeCombo(dir, combo);
    writeRuntimeLedger(dir, buildRuntimeLedger({ combo, runDir: dir, cli: "combo-chen", prUrl }));
    appendEvent(dir, "gate_started", {});
    appendEvent(dir, "gate_failed", { exit_code: 1 });

    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: () => ({
        status: 1,
        stdout: "No active run.\n",
        stderr: "",
      }),
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: headSha,
              state: "OPEN",
              statusCheckRollup: [
                { name: "test", conclusion: "SUCCESS" },
                { name: "CodeRabbit", conclusion: "SUCCESS" },
              ],
            }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });
    await exec(deps, ["status", "--deep"]);

    const text = out.join("\n");
    expect(text).toContain(prUrl);
    expect(text).toContain("PR ready for reviewer");
  });

  it("allows configured required READY checks to be the only green checks in deep mode", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      [
        "[ready]",
        'required_checks = ["reviewdog"]',
      ].join("\n"),
    );
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const prUrl = "https://github.com/o/r/pull/7";
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: prUrl });
    appendEvent(dir, "gate_failed", { exit_code: 1 });

    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: () => ({
        status: 0,
        stdout: ["run:", "  branch: combo/issue-7", "  status: completed"].join("\n"),
        stderr: "",
      }),
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: headSha,
              state: "OPEN",
              statusCheckRollup: [{ name: "ReviewDog", conclusion: "SUCCESS" }],
            }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });
    await exec(deps, ["status", "--deep"]);

    expect(out.join("\n")).toContain("PR ready for reviewer");
  });

  it("does not report PR ready for reviewer when a configured required READY check fails", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      [
        "[ready]",
        'required_checks = ["reviewdog"]',
      ].join("\n"),
    );
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const prUrl = "https://github.com/o/r/pull/7";
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: prUrl });
    appendEvent(dir, "gate_failed", { exit_code: 1 });

    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: () => ({
        status: 0,
        stdout: ["run:", "  branch: combo/issue-7", "  status: completed"].join("\n"),
        stderr: "",
      }),
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: headSha,
              state: "OPEN",
              statusCheckRollup: [{ name: "ReviewDog", conclusion: "FAILURE" }],
            }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });
    await exec(deps, ["status", "--deep"]);

    expect(out.join("\n")).not.toContain("PR ready for reviewer");
  });

  it("does not report PR ready for reviewer when a required READY check is skipped", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      [
        "[ready]",
        'required_checks = ["CodeRabbit"]',
      ].join("\n"),
    );
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const prUrl = "https://github.com/o/r/pull/7";
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: prUrl });
    appendEvent(dir, "gate_failed", { exit_code: 1 });

    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: () => ({
        status: 1,
        stdout: "No active run.\n",
        stderr: "",
      }),
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: headSha,
              state: "OPEN",
              statusCheckRollup: [
                { name: "test", conclusion: "SUCCESS" },
                { name: "CodeRabbit", conclusion: "SKIPPED" },
              ],
            }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["status", "--deep"]);

    expect(out.join("\n")).not.toContain("PR ready for reviewer");
  });

  it("uses the launch config snapshot for deep downstream status after repo TOML changes", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(join(repoDir, "combo-chen.toml"), '[reviewer]\nambient = ["launch-bot"]\n');
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const prUrl = "https://github.com/o/r/pull/7";
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    writeConfigSnapshot(dir, loadConfig({ repoDir, env: {} }));
    writeFileSync(join(repoDir, "combo-chen.toml"), '[reviewer]\nambient = ["drift-bot"]\n');
    appendEvent(dir, "pr_opened", { url: prUrl });
    appendEvent(dir, "gate_failed", { exit_code: 1 });

    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: () => ({
        status: 0,
        stdout: ["run:", "  branch: combo/issue-7", "  status: completed"].join("\n"),
        stderr: "",
      }),
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: headSha,
              state: "OPEN",
              statusCheckRollup: [
                { name: "launch-bot", conclusion: "FAILURE" },
                { name: "test", conclusion: "SUCCESS" },
                { name: "CodeRabbit", conclusion: "SUCCESS" },
              ],
            }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["status", "--deep"]);

    expect(out.join("\n")).toContain("PR ready for reviewer");
  });
});

describe("forensics", () => {
  function seedIssueCombo(homeDir: string, id: string, issueNumber: number): string {
    const dir = runDirFor(homeDir, id);
    writeCombo(dir, {
      id,
      issueUrl: `https://github.com/o/r/issues/${issueNumber}`,
      repoDir: "/repos/r",
      worktree: `/repos/r/.worktrees/issue-${issueNumber}`,
      branch: `combo/issue-${issueNumber}`,
      tmuxSession: `combo-chen-${id}`,
      createdAt: "2026-06-11T10:00:00.000Z",
    });
    return dir;
  }

  it("renders a markdown report for selected issue numbers from local run logs", async () => {
    const h = home();
    const dir = seedIssueCombo(h, "o-r-7", 7);
    seedIssueCombo(h, "o-r-8", 8);
    writeFileSync(
      join(dir, "journal.jsonl"),
      [
        { t: "2026-06-11T10:00:00.000Z", event: "combo_created", issue_url: "https://github.com/o/r/issues/7" },
        { t: "2026-06-11T10:01:00.000Z", event: "coder_started" },
        { t: "2026-06-11T10:05:00.000Z", event: "coder_done" },
        { t: "2026-06-11T10:08:00.000Z", event: "pr_opened", url: "https://github.com/o/r/pull/9" },
        { t: "2026-06-11T10:10:00.000Z", event: "lgtm", sha: "abc123" },
        { t: "2026-06-11T10:12:00.000Z", event: "lgtm_stale", old_sha: "abc123", new_sha: "def456" },
      ].map((event) => JSON.stringify(event)).join("\n"),
    );
    const { deps, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["forensics", "--issues", "7"]);

    expect(out.join("\n")).toContain("# combo-chen forensics");
    expect(out.join("\n")).toContain("## o-r-7");
    expect(out.join("\n")).toContain("Coder: 4m");
    expect(out.join("\n")).toContain("stale_lgtm_after_push");
    expect(out.join("\n")).not.toContain("## o-r-8");
  });

  it("reports an actionable no-match message for issue outcome lookups", async () => {
    const h = home();
    seedIssueCombo(h, "o-r-7", 7);
    const { deps, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["forensics", "--issues", "210"]);

    expect(out.join("\n")).toContain("# combo-chen forensics");
    expect(out.join("\n")).toContain(
      "No matching issue-backed combos for --issues 210 in this COMBO_CHEN_HOME.",
    );
    expect(out.join("\n")).toContain("Use -n <combo-id> for plan-backed runs or rerun after launch.");
  });

  it("refuses to record an incomplete outcome without a PR link and head SHA", async () => {
    const h = home();
    seedIssueCombo(h, "o-r-7", 7);
    const ghCalls: string[][] = [];
    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        ghCalls.push(args);
        if (args[0] === "issue" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({ state: "OPEN", closedAt: null }),
            stderr: "",
          };
        }
        if (args[0] === "issue" && args[1] === "comment") {
          return { status: 0, stdout: "https://github.com/o/r/issues/7#issuecomment-1\n", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await expect(exec(deps, ["forensics", "--issues", "7", "--record-outcome"])).rejects.toThrow(
      "Cannot record forensics outcome for o-r-7: missing PR link and head SHA",
    );

    expect(ghCalls.some((args) => args[0] === "issue" && args[1] === "comment")).toBe(false);
  });

  it("records the generated outcome block on the source issue when requested", async () => {
    const h = home();
    const dir = seedIssueCombo(h, "o-r-7", 7);
    writeFileSync(
      join(dir, "journal.jsonl"),
      [
        { t: "2026-06-11T10:00:00.000Z", event: "combo_created", issue_url: "https://github.com/o/r/issues/7" },
        { t: "2026-06-11T10:08:00.000Z", event: "pr_opened", url: "https://github.com/o/r/pull/9" },
        { t: "2026-06-11T10:09:00.000Z", event: "gate_validated", sha: "def4560" },
        { t: "2026-06-11T10:10:00.000Z", event: "lgtm", sha: "def4560" },
      ].map((event) => JSON.stringify(event)).join("\n"),
    );
    const ghCalls: string[][] = [];
    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        ghCalls.push(args);
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: "def4560",
              state: "OPEN",
              mergeStateStatus: "CLEAN",
              statusCheckRollup: [
                { __typename: "CheckRun", name: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
                { __typename: "CheckRun", name: "CodeRabbit", status: "COMPLETED", conclusion: "SUCCESS" },
              ],
            }),
            stderr: "",
          };
        }
        if (args[0] === "issue" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({ state: "OPEN", closedAt: null }),
            stderr: "",
          };
        }
        if (args[0] === "api" && args.join(" ").includes("issues/9/comments")) {
          return {
            status: 0,
            stdout: JSON.stringify([
              { body: "lgtm @ def4560", user: { login: "claude" }, created_at: "2026-06-11T10:10:00Z" },
            ]),
            stderr: "",
          };
        }
        if (args[0] === "api" && args.join(" ").includes("pulls/9/reviews")) {
          return { status: 0, stdout: "[]", stderr: "" };
        }
        if (args[0] === "issue" && args[1] === "comment") {
          return { status: 0, stdout: "https://github.com/o/r/issues/7#issuecomment-1\n", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["forensics", "--issues", "7", "--record-outcome"]);

    const commentCall = ghCalls.find((args) => args[0] === "issue" && args[1] === "comment");
    expect(commentCall).toEqual([
      "issue",
      "comment",
      "https://github.com/o/r/issues/7",
      "--body",
      expect.stringContaining("combo-chen forensics outcome for `o-r-7`"),
    ]);
    const body = commentCall?.[4] ?? "";
    expect(body).toContain("- PR link: https://github.com/o/r/pull/9");
    expect(body).toContain("- Head SHA: def4560");
    expect(body).toContain("- Review/check state: reviewer=current");
    expect(body).toContain("- Failures found: none");
    expect(body).toContain("- Follow-up bugs: none recorded");
    expect(out.join("\n")).toContain(
      "forensics: recorded outcome for o-r-7 on https://github.com/o/r/issues/7",
    );
  });

  it("emits JSON reports with the same core facts", async () => {
    const h = home();
    const dir = seedIssueCombo(h, "o-r-7", 7);
    writeFileSync(
      join(dir, "journal.jsonl"),
      [
        { t: "2026-06-11T10:00:00.000Z", event: "combo_created", issue_url: "https://github.com/o/r/issues/7" },
        { t: "2026-06-11T10:08:00.000Z", event: "pr_opened", url: "https://github.com/o/r/pull/9" },
      ].map((event) => JSON.stringify(event)).join("\n"),
    );
    const { deps, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["forensics", "--issues", "7", "--format", "json"]);

    const parsed = JSON.parse(out.join("\n")) as { reports: Array<{ id: string; prUrl?: string }> };
    expect(parsed.reports).toHaveLength(1);
    expect(parsed.reports[0]).toMatchObject({
      id: "o-r-7",
      prUrl: "https://github.com/o/r/pull/9",
    });
  });

  it("enriches reports with live GitHub PR and issue facts", async () => {
    const h = home();
    const openDir = seedIssueCombo(h, "o-r-7", 7);
    const mergedDir = seedIssueCombo(h, "o-r-8", 8);
    writeFileSync(
      join(openDir, "journal.jsonl"),
      [
        { t: "2026-06-11T10:00:00.000Z", event: "combo_created", issue_url: "https://github.com/o/r/issues/7" },
        { t: "2026-06-11T10:07:00.000Z", event: "pr_opened", url: "https://github.com/o/r/pull/9" },
        { t: "2026-06-11T10:08:00.000Z", event: "gate_validated", sha: "def456" },
      ].map((event) => JSON.stringify(event)).join("\n"),
    );
    writeFileSync(
      join(mergedDir, "journal.jsonl"),
      [
        { t: "2026-06-11T11:00:00.000Z", event: "combo_created", issue_url: "https://github.com/o/r/issues/8" },
        { t: "2026-06-11T11:07:00.000Z", event: "pr_opened", url: "https://github.com/o/r/pull/10" },
      ].map((event) => JSON.stringify(event)).join("\n"),
    );
    const ghCalls: string[][] = [];
    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        ghCalls.push(args);
        if (args[0] === "pr" && args[1] === "view" && args[2] === "https://github.com/o/r/pull/9") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: "def456",
              state: "OPEN",
              mergeStateStatus: "CLEAN",
              statusCheckRollup: [
                { __typename: "CheckRun", name: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
                { __typename: "CheckRun", name: "ExternalReview", status: "COMPLETED", conclusion: "SUCCESS" },
              ],
            }),
            stderr: "",
          };
        }
        if (args[0] === "pr" && args[1] === "view" && args[2] === "https://github.com/o/r/pull/10") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: "999aaa",
              state: "MERGED",
              mergedAt: "2026-06-11T11:20:00.000Z",
              mergeStateStatus: "CLEAN",
              statusCheckRollup: [
                { __typename: "CheckRun", name: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
              ],
            }),
            stderr: "",
          };
        }
        if (args[0] === "issue" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({ state: "OPEN", closedAt: null }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["forensics", "--issues", "7,8", "--format", "json"]);

    const parsed = JSON.parse(out.join("\n")) as {
      reports: Array<{
        id: string;
        timeline: { mergedAt?: string };
        gates: { ci: string; issueClosed: boolean | "unknown"; reviewer: { current: boolean; headSha?: string } };
        incidents: Array<{ id: string }>;
      }>;
    };
    const open = parsed.reports.find((report) => report.id === "o-r-7");
    const merged = parsed.reports.find((report) => report.id === "o-r-8");
    expect(open).toMatchObject({
      gates: {
        ci: "success",
        reviewer: { current: false, headSha: "def456" },
        issueClosed: false,
      },
    });
    expect(open?.incidents.map((incident) => incident.id)).toContain("missing_reviewer_verdict");
    expect(merged).toMatchObject({
      timeline: { mergedAt: "2026-06-11T11:20:00.000Z" },
      gates: { ci: "success", issueClosed: false },
    });
    expect(merged?.incidents.map((incident) => incident.id)).toContain("merged_pr_open_issue");
    expect(ghCalls).toContainEqual([
      "pr",
      "view",
      "https://github.com/o/r/pull/9",
      "--json",
      "headRefOid,state,mergedAt,mergeStateStatus,statusCheckRollup",
    ]);
    expect(ghCalls).toContainEqual([
      "issue",
      "view",
      "https://github.com/o/r/issues/8",
      "--json",
      "state,closedAt",
    ]);
  });

  it("uses the launch config snapshot for GitHub check classification after repo TOML changes", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(join(repoDir, "combo-chen.toml"), '[reviewer]\nambient = ["launch-bot"]\n');
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: "https://github.com/o/r/issues/7",
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: "2026-06-11T10:00:00.000Z",
    });
    writeConfigSnapshot(dir, loadConfig({ repoDir, env: {} }));
    writeFileSync(join(repoDir, "combo-chen.toml"), '[reviewer]\nambient = ["drift-bot"]\n');
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/9" });

    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: "def456",
              state: "OPEN",
              mergeStateStatus: "CLEAN",
              statusCheckRollup: [
                { __typename: "CheckRun", name: "launch-bot", status: "COMPLETED", conclusion: "FAILURE" },
                { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
              ],
            }),
            stderr: "",
          };
        }
        if (args[0] === "issue" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({ state: "OPEN", closedAt: null }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["forensics", "--issues", "7", "--format", "json"]);

    const parsed = JSON.parse(out.join("\n")) as {
      reports: Array<{ gates: { ci: string; ambientReviewer: string } }>;
    };
    expect(parsed.reports[0]?.gates).toMatchObject({
      ci: "success",
      ambientReviewer: "failure",
    });
  });

  it("reports plan work item facts by name without fetching a GitHub issue", async () => {
    const h = home();
    const id = "plan-let-plans-launch-combos-12345678";
    const planPath = "/plans/issue-134.md";
    const dir = runDirFor(h, id);
    writeCombo(dir, {
      id,
      issueUrl: "",
      workItemSourceType: "local_file",
      workItemSourceReference: planPath,
      workItemTitle: "Let plans launch combos",
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/plan-let-plans-launch-combos-12345678",
      branch: "combo/plan-let-plans-launch-combos-12345678",
      tmuxSession: `combo-chen-${id}`,
      createdAt: "2026-06-11T10:00:00.000Z",
    });
    appendEvent(dir, "combo_created", {
      issue_url: "",
      work_item_source_type: "local_file",
      work_item_source_reference: planPath,
      work_item_title: "Let plans launch combos",
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/44" });

    const ghCalls: string[][] = [];
    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        ghCalls.push(args);
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: "def456",
              state: "OPEN",
              statusCheckRollup: [{ __typename: "CheckRun", name: "CI", conclusion: "SUCCESS" }],
            }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["forensics", "-n", id, "--format", "json"]);

    const parsed = JSON.parse(out.join("\n")) as {
      reports: Array<{ workItem?: { title?: string; sourceType: string; sourceReference?: string } }>;
    };
    expect(parsed.reports[0]?.workItem).toMatchObject({
      title: "Let plans launch combos",
      sourceType: "local_file",
      sourceReference: planPath,
    });
    expect(ghCalls.some((call) => call[0] === "issue" && call[1] === "view")).toBe(false);
  });
});

describe("activate-reviewer", () => {
  it("opens a reviewer tmux window with the configured judge command for the opened PR", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      [
        '[roles]',
        'gordon = ["local"]',
        '',
        '[gordon]',
        'prompt = "local reviewer instructions 8034"',
        '',
        '[gordon.local]',
        'command = "judge-bot --pr {pr_url} --prompt {prompt}"',
        '',
        '[limits]',
        'babysit_poll_seconds = 17',
        'watch_failure_limit = 4',
        '',
      ].join("\n"),
    );
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const { deps, calls, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });
    await exec(deps, ["activate-reviewer", "-n", "o-r-7"]);

    const judgeWindow = calls.find(
      (c) => c[0] === "tmux" && c[1] === "new-window" && c.includes("reviewer"),
    );
    expect(judgeWindow).toBeDefined();
    expect(judgeWindow).toContain("combo-chen-o-r-7");

    const command = judgeWindow?.at(-1) ?? "";
    expect(command).toContain("judge-bot");
    expect(command).toContain("'https://github.com/o/r/pull/7'");
    expect(command).toContain("local reviewer instructions 8034");
    expect(command).toContain("COMMENT reviews");
    expect(command).toContain("lgtm @ <sha>");

    const watchWindow = calls.find(
      (c) => c[0] === "tmux" && c[1] === "new-window" && c.includes("director-watch"),
    );
    expect(watchWindow).toBeDefined();
    expect(watchWindow).toContain("combo-chen-o-r-7");

    const watchCommand = watchWindow?.at(-1) ?? "";
    expect(watchCommand).toContain(`COMBO_CHEN_HOME='${h}'`);
    expect(watchCommand).toContain("director-tick -n 'o-r-7'");
    expect(watchCommand).toContain("reviewer: (merged|closed|already terminal)");
    expect(watchCommand).not.toContain("status=$?");
    expect(watchCommand).not.toContain('"$status"');
    expect(watchCommand).toContain("watch_error");
    expect(watchCommand).toContain("watch_dead");
    expect(watchCommand).toContain('[ "$failures" -ge 4 ]');
    expect(watchCommand).toContain("sleep 17");
    expect(out.join("\n")).toContain("reviewer");
    expect(out.join("\n")).toContain("director-watch");
  });

  it("refuses activation before the combo has an opened PR in the journal", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });

    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });
    await expect(exec(deps, ["activate-reviewer", "-n", "o-r-7"])).rejects.toThrow(/pr_opened/);
  });

  it("checks for existing reviewer windows before replacing them", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "list-windows") {
          return { status: 0, stdout: "coder\nreviewer\nreviewer-watch\ndirector-watch\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["activate-reviewer", "-n", "o-r-7"]);

    const listIndex = calls.findIndex((c) => c[1] === "list-windows");
    const killReviewerIndex = calls.findIndex((c) => c.join(" ") === "tmux kill-window -t combo-chen-o-r-7:reviewer");
    const newReviewerIndex = calls.findIndex(
      (c) => c[1] === "new-window" && c.includes("reviewer"),
    );
    expect(listIndex).toBeGreaterThan(-1);
    expect(killReviewerIndex).toBeGreaterThan(listIndex);
    expect(killReviewerIndex).toBeLessThan(newReviewerIndex);
  });
});

describe("director-watch command", () => {
  it("uses the launch config snapshot while emitting one compact dashboard line per tick", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(join(repoDir, "combo-chen.toml"), "[limits]\nbabysit_poll_seconds = 42\n");
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    writeConfigSnapshot(dir, loadConfig({ repoDir, env: {} }));
    writeFileSync(join(repoDir, "combo-chen.toml"), "[limits]\nbabysit_poll_seconds = 3\n");
    const { deps, calls, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["director-watch", "-n", "o-r-7", "--iterations", "2"]);

    expect(calls).toContainEqual(["sleep", "42000"]);
    expect(calls).not.toContainEqual(["sleep", "3000"]);
    const statusLines = out.filter((line) => line.startsWith("director: watch "));
    expect(statusLines).toHaveLength(2);
    expect(statusLines.every((line) => line.includes("combo=o-r-7"))).toBe(true);
    expect(statusLines.every((line) => line.includes("gh=not-polled next=42s"))).toBe(true);
    expect(statusLines.every((line) => line.includes("ready=["))).toBe(true);
    expect(statusLines.every((line) => line.includes('action="'))).toBe(true);
    expect(statusLines.every((line) => line.trimStart().startsWith("{"))).toBe(false);
    expect(out).toEqual(statusLines);
    expect(out.some((line) => line === "director: tick complete for o-r-7")).toBe(false);
  });

  it("survives one failed director tick, journals watch_error, and runs the next tick", () => {
    const h = home();
    const tickCount = join(h, "tick-count");
    const watchEvents = join(h, "watch-events.log");
    const fakeCli = join(h, "fake-combo-chen");
    writeExecutable(
      fakeCli,
      [
        "#!/bin/sh",
        `tick_count=${shellQuote(tickCount)}`,
        `watch_events=${shellQuote(watchEvents)}`,
        'command="$1"',
        "shift",
        'if [ "$command" = "director-tick" ]; then',
        "  count=0",
        '  [ -f "$tick_count" ] && count=$(cat "$tick_count")',
        "  count=$((count + 1))",
        '  printf "%s\\n" "$count" > "$tick_count"',
        '  if [ "$count" -eq 1 ]; then',
        '    echo "secondary rate limit" >&2',
        "    exit 2",
        "  fi",
        '  echo "reviewer: already terminal"',
        "  exit 0",
        "fi",
        'if [ "$command" = "emit" ]; then',
        '  printf "%s\\n" "$*" >> "$watch_events"',
        "  exit 0",
        "fi",
        'echo "unexpected command: $command" >&2',
        "exit 99",
        "",
      ].join("\n"),
    );

    const command = buildDirectorWatchCommand({
      cli: shellQuote(fakeCli),
      comboHome: h,
      comboId: "o-r-7",
      pollSeconds: 0,
      watchFailureLimit: 3,
      watchBackoffMaxSeconds: 3600,
    });

    const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });

    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    expect(readFileSync(tickCount, "utf8").trim()).toBe("2");
    const events = readFileSync(watchEvents, "utf8");
    expect(events.match(/\bwatch_error\b/g)).toHaveLength(1);
    expect(events).toContain("exit_code=2");
    expect(events).toContain("stderr=secondary rate limit");
    expect(events).not.toContain("watch_dead");
  });

  it("backs off when director-tick reports an exit-zero transient failure marker", () => {
    const h = home();
    const tickCount = join(h, "tick-count");
    const watchEvents = join(h, "watch-events.log");
    const fakeCli = join(h, "fake-combo-chen");
    writeExecutable(
      fakeCli,
      [
        "#!/bin/sh",
        `tick_count=${shellQuote(tickCount)}`,
        `watch_events=${shellQuote(watchEvents)}`,
        'command="$1"',
        "shift",
        'if [ "$command" = "director-tick" ]; then',
        "  count=0",
        '  [ -f "$tick_count" ] && count=$(cat "$tick_count")',
        "  count=$((count + 1))",
        '  printf "%s\\n" "$count" > "$tick_count"',
        '  if [ "$count" -eq 1 ]; then',
        '    echo "reviewer: transient_failure: gh pr view failed for o-r-7 (status 1): API rate limit exceeded"',
        "    exit 0",
        "  fi",
        '  echo "reviewer: already terminal"',
        "  exit 0",
        "fi",
        'if [ "$command" = "emit" ]; then',
        '  printf "%s\\n" "$*" >> "$watch_events"',
        "  exit 0",
        "fi",
        'echo "unexpected command: $command" >&2',
        "exit 99",
        "",
      ].join("\n"),
    );

    const command = buildDirectorWatchCommand({
      cli: shellQuote(fakeCli),
      comboHome: h,
      comboId: "o-r-7",
      pollSeconds: 0,
      watchFailureLimit: 3,
      watchBackoffMaxSeconds: 3600,
    });

    const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });

    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    expect(readFileSync(tickCount, "utf8").trim()).toBe("2");
    const events = readFileSync(watchEvents, "utf8");
    expect(events.match(/\bwatch_error\b/g)).toHaveLength(1);
    expect(events).toContain("exit_code=75");
    expect(events).toContain("gh pr view failed");
    expect(events).not.toContain("watch_dead");
  });

  it("journals watch_dead and exits non-zero after the configured consecutive failure limit", () => {
    const h = home();
    const tickCount = join(h, "tick-count");
    const watchEvents = join(h, "watch-events.log");
    const fakeCli = join(h, "fake-combo-chen");
    writeExecutable(
      fakeCli,
      [
        "#!/bin/sh",
        `tick_count=${shellQuote(tickCount)}`,
        `watch_events=${shellQuote(watchEvents)}`,
        'command="$1"',
        "shift",
        'if [ "$command" = "director-tick" ]; then',
        "  count=0",
        '  [ -f "$tick_count" ] && count=$(cat "$tick_count")',
        "  count=$((count + 1))",
        '  printf "%s\\n" "$count" > "$tick_count"',
        '  echo "gh secondary rate limit" >&2',
        "  exit 7",
        "fi",
        'if [ "$command" = "emit" ]; then',
        '  printf "%s\\n" "$*" >> "$watch_events"',
        "  exit 0",
        "fi",
        'echo "unexpected command: $command" >&2',
        "exit 99",
        "",
      ].join("\n"),
    );

    const command = buildDirectorWatchCommand({
      cli: shellQuote(fakeCli),
      comboHome: h,
      comboId: "o-r-7",
      pollSeconds: 0,
      watchFailureLimit: 3,
      watchBackoffMaxSeconds: 3600,
    });

    const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });

    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 7 });
    expect(readFileSync(tickCount, "utf8").trim()).toBe("3");
    const events = readFileSync(watchEvents, "utf8");
    expect(events.match(/\bwatch_error\b/g)).toHaveLength(3);
    expect(events.match(/\bwatch_dead\b/g)).toHaveLength(1);
    expect(events).toContain("consecutive_failures=3");
    expect(events).toContain("exit_code=7");
    expect(events).toContain("stderr=gh secondary rate limit");
  });

  it("doubles backoff on each consecutive failure", () => {
    const h = home();
    const tickCount = join(h, "tick-count");
    const sleepLog = join(h, "sleep-log");
    const fakeCli = join(h, "fake-combo-chen");
    const fakeSleep = join(h, "sleep");
    writeExecutable(
      fakeSleep,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$1" >> ${shellQuote(sleepLog)}`,
        "",
      ].join("\n"),
    );
    writeExecutable(
      fakeCli,
      [
        "#!/bin/sh",
        `tick_count=${shellQuote(tickCount)}`,
        'command="$1"',
        "shift",
        'if [ "$command" = "director-tick" ]; then',
        "  count=0",
        '  [ -f "$tick_count" ] && count=$(cat "$tick_count")',
        "  count=$((count + 1))",
        '  printf "%s\\n" "$count" > "$tick_count"',
        '  echo "gh secondary rate limit" >&2',
        "  exit 7",
        "fi",
        'echo "unexpected command: $command" >&2',
        "exit 99",
        "",
      ].join("\n"),
    );

    const command = buildDirectorWatchCommand({
      cli: shellQuote(fakeCli),
      comboHome: h,
      comboId: "o-r-7",
      pollSeconds: 5,
      watchFailureLimit: 6,
      watchBackoffMaxSeconds: 3600,
    });

    const result = spawnSync("/bin/sh", ["-c", command], {
      encoding: "utf8",
      env: { PATH: `${h}:/usr/bin:/bin`, HOME: process.env["HOME"] },
    });

    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 7 });
    const sleeps = readFileSync(sleepLog, "utf8").trim().split("\n").map(Number);
    expect(sleeps).toEqual([5, 10, 20, 40, 80]);
  });

  it("caps backoff at 3600 when the doubling exceeds 1800", () => {
    const h = home();
    const tickCount = join(h, "tick-count");
    const sleepLog = join(h, "sleep-log");
    const fakeCli = join(h, "fake-combo-chen");
    const fakeSleep = join(h, "sleep");
    writeExecutable(
      fakeSleep,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$1" >> ${shellQuote(sleepLog)}`,
        "",
      ].join("\n"),
    );
    writeExecutable(
      fakeCli,
      [
        "#!/bin/sh",
        `tick_count=${shellQuote(tickCount)}`,
        'command="$1"',
        "shift",
        'if [ "$command" = "director-tick" ]; then',
        "  count=0",
        '  [ -f "$tick_count" ] && count=$(cat "$tick_count")',
        "  count=$((count + 1))",
        '  printf "%s\\n" "$count" > "$tick_count"',
        '  echo "gh secondary rate limit" >&2',
        "  exit 7",
        "fi",
        'echo "unexpected command: $command" >&2',
        "exit 99",
        "",
      ].join("\n"),
    );

    const command = buildDirectorWatchCommand({
      cli: shellQuote(fakeCli),
      comboHome: h,
      comboId: "o-r-7",
      pollSeconds: 5,
      watchFailureLimit: 12,
      watchBackoffMaxSeconds: 3600,
    });

    const result = spawnSync("/bin/sh", ["-c", command], {
      encoding: "utf8",
      env: { PATH: `${h}:/usr/bin:/bin`, HOME: process.env["HOME"] },
    });

    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 7 });
    const sleeps = readFileSync(sleepLog, "utf8").trim().split("\n").map(Number);
    expect(sleeps).toEqual([5, 10, 20, 40, 80, 160, 320, 640, 1280, 2560, 3600]);
  });

  it("uses the configured max backoff for the first failed sleep and later doublings", () => {
    const h = home();
    const tickCount = join(h, "tick-count");
    const sleepLog = join(h, "sleep-log");
    const fakeCli = join(h, "fake-combo-chen");
    const fakeSleep = join(h, "sleep");
    writeExecutable(
      fakeSleep,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$1" >> ${shellQuote(sleepLog)}`,
        "",
      ].join("\n"),
    );
    writeExecutable(
      fakeCli,
      [
        "#!/bin/sh",
        `tick_count=${shellQuote(tickCount)}`,
        'command="$1"',
        "shift",
        'if [ "$command" = "director-tick" ]; then',
        "  count=0",
        '  [ -f "$tick_count" ] && count=$(cat "$tick_count")',
        "  count=$((count + 1))",
        '  printf "%s\\n" "$count" > "$tick_count"',
        '  echo "reviewer: transient_failure: gh pr view failed for o-r-7 (status 1): rate limit"',
        "  exit 0",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );

    const command = buildDirectorWatchCommand({
      cli: shellQuote(fakeCli),
      comboHome: h,
      comboId: "o-r-7",
      pollSeconds: 99,
      watchFailureLimit: 4,
      watchBackoffMaxSeconds: 7,
    });

    const result = spawnSync("/bin/sh", ["-c", command], {
      encoding: "utf8",
      env: { PATH: `${h}:/usr/bin:/bin`, HOME: process.env["HOME"] },
    });

    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 75 });
    const sleeps = readFileSync(sleepLog, "utf8").trim().split("\n").map(Number);
    expect(sleeps).toEqual([7, 7, 7]);
  });
});

describe("reviewer-tick", () => {
  it("marks gh pr view failures as transient for director-watch backoff", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: () => ({ status: 1, stdout: "", stderr: "API rate limit exceeded" }),
    });

    await exec(deps, ["reviewer-tick", "-n", "o-r-7"]);

    expect(out.join("\n")).toContain("reviewer: transient_failure:");
    expect(out.join("\n")).toContain("gh pr view failed");
    expect(out.join("\n")).toContain("API rate limit exceeded");
    expect(readEvents(dir).map((event) => event.event)).toEqual(["pr_opened"]);
  });

  it("marks invalid gh pr view JSON as transient for director-watch backoff", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: () => ({ status: 0, stdout: "not json", stderr: "" }),
    });

    await exec(deps, ["reviewer-tick", "-n", "o-r-7"]);

    expect(out.join("\n")).toContain("reviewer: transient_failure:");
    expect(out.join("\n")).toContain("failed to parse PR data");
    expect(readEvents(dir).map((event) => event.event)).toEqual(["pr_opened"]);
  });

  it("journals a merged PR as closure pending and leaves cleanup to closure", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        return { status: 0, stdout: "", stderr: "" };
      },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        return { status: 0, stdout: "", stderr: "" };
      },
      gh: (args) => {
        calls.push(["gh", ...args]);
        return {
          status: 0,
          stdout: JSON.stringify({
            headRefOid: "head456",
            mergeCommit: { oid: "squash789" },
            state: "MERGED",
            mergedAt: "2026-06-11T11:20:00.000Z",
            mergedBy: { login: "maintainer" },
          }),
          stderr: "",
        };
      },
    });

    await exec(deps, ["reviewer-tick", "-n", "o-r-7"]);

    expect(readEvents(dir).map((event) => event.event)).toEqual(["pr_opened", "merged"]);
    expect(readEvents(dir).slice(-1)).toMatchObject([
      {
        event: "merged",
        sha: "squash789",
        by: "maintainer",
        mergedAt: "2026-06-11T11:20:00.000Z",
        source: "reviewer",
      },
    ]);
    expect(readEvents(dir).some((event) => event.event === "combo_closed")).toBe(false);
    expect(calls.some((c) => c[0] === "tmux")).toBe(false);
    expect(calls.some((c) => c[0] === "git")).toBe(false);

    const prView = calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "view");
    expect(prView).toContain("--json");
    expect(prView).toContain("headRefOid,state,mergedAt,mergedBy,mergeCommit");
    expect(out).toEqual(["reviewer: merged squash789 by maintainer; closure pending: combo-chen closure -n o-r-7"]);
  });

  it("keeps already journaled merged PRs closure-pending without duplicate terminal close", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(dir, "merged", { sha: "squash789", by: "maintainer" });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        calls.push(["gh", ...args]);
        return {
          status: 0,
          stdout:
            '{"headRefOid":"head456","baseRefName":"main","mergeCommit":{"oid":"squash789"},"state":"MERGED","mergedBy":{"login":"maintainer"}}',
          stderr: "",
        };
      },
    });

    await exec(deps, ["reviewer-tick", "-n", "o-r-7"]);

    expect(readEvents(dir).map((event) => event.event)).toEqual(["pr_opened", "merged"]);
    expect(readEvents(dir).filter((event) => event.event === "merged")).toHaveLength(1);
    expect(calls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "view")).toBe(true);
    expect(calls.some((c) => c[0] === "tmux" && c[1] === "kill-session")).toBe(false);
    expect(out.join("\n")).toContain("closure pending: combo-chen closure -n o-r-7");
    expect(out.join("\n")).not.toContain("already terminal");
  });

  it("does not duplicate a legacy merged event that used the PR head sha", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(dir, "merged", { sha: "head456", by: "maintainer" });

    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: () => ({
        status: 0,
        stdout:
          '{"headRefOid":"head456","baseRefName":"main","mergeCommit":{"oid":"squash789"},"state":"MERGED","mergedBy":{"login":"maintainer"}}',
        stderr: "",
      }),
    });

    await exec(deps, ["reviewer-tick", "-n", "o-r-7"]);

    expect(readEvents(dir).map((event) => event.event)).toEqual(["pr_opened", "merged"]);
    expect(readEvents(dir).filter((event) => event.event === "merged")).toHaveLength(1);
  });

  it("journals a closed PR for human salvage, stops the combo, and keeps local work", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        calls.push(["gh", ...args]);
        return {
          status: 0,
          stdout: '{"headRefOid":"def456","state":"CLOSED","mergedBy":null}',
          stderr: "",
        };
      },
    });

    await exec(deps, ["reviewer-tick", "-n", "o-r-7"]);

    expect(readEvents(dir).slice(-2)).toMatchObject([
      { event: "needs_human", reason: "pr_closed" },
      { event: "combo_closed" },
    ]);

    const killSession = calls.find((c) => c[0] === "tmux" && c[1] === "kill-session");
    expect(killSession).toEqual(["tmux", "kill-session", "-t", "combo-chen-o-r-7"]);
    expect(calls.some((c) => c[0] === "git")).toBe(false);
    expect(out.join("\n")).toContain("closed");
  });

  it("stales a pinned LGTM on a new PR head and starts an incremental re-review", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      [
        '[roles]',
        'gordon = ["local"]',
        '',
        '[gordon]',
        'prompt = "local reviewer instructions 8034"',
        '',
        '[gordon.local]',
        'command = "judge-bot --pr {pr_url} --prompt {prompt}"',
        '',
      ].join("\n"),
    );
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(dir, "lgtm", { sha: "abc1230" });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        calls.push(["gh", ...args]);
        return { status: 0, stdout: '{"headRefOid":"def4560"}', stderr: "" };
      },
    });

    await exec(deps, ["reviewer-tick", "-n", "o-r-7"]);

    const stale = readEvents(dir).at(-1);
    expect(stale).toMatchObject({
      event: "lgtm_stale",
      old_sha: "abc1230",
      new_sha: "def4560",
    });

    const judgeWindow = calls.find(
      (c) => c[0] === "tmux" && c[1] === "new-window" && c.includes("reviewer"),
    );
    expect(judgeWindow).toBeDefined();

    const command = judgeWindow?.at(-1) ?? "";
    expect(command).toContain("judge-bot");
    expect(command).toContain("abc1230..def4560");
    expect(command).toContain("lgtm @ def4560");
    expect(command).toContain("COMMENT reviews");
    expect(out.join("\n")).toContain("lgtm_stale abc1230 -> def4560");
  });

  it("derives a pinned LGTM from GitHub comments and stales it on a new PR head", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      [
        '[roles]',
        'gordon = ["local"]',
        '',
        '[gordon.local]',
        'command = "judge-bot --pr {pr_url} --prompt {prompt}"',
        '',
      ].join("\n"),
    );
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        calls.push(["gh", ...args]);
        if (args[0] === "pr") {
          return { status: 0, stdout: '{"headRefOid":"def4560"}', stderr: "" };
        }
        if (args.join(" ").includes("issues/7/comments")) {
          return {
            status: 0,
            stdout:
              '[{"body":"lgtm @ abc1230","user":{"login":"local"},"created_at":"2026-06-11T00:00:00Z"}]',
            stderr: "",
          };
        }
        if (args.join(" ").includes("pulls/7/reviews")) {
          return { status: 0, stdout: "[]", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["reviewer-tick", "-n", "o-r-7"]);

    expect(readEvents(dir).map((event) => event.event)).toEqual([
      "pr_opened",
      "lgtm",
      "lgtm_stale",
    ]);
    expect(readEvents(dir)[1]).toMatchObject({ event: "lgtm", sha: "abc1230" });
    expect(readEvents(dir)[2]).toMatchObject({
      event: "lgtm_stale",
      old_sha: "abc1230",
      new_sha: "def4560",
    });
    expect(calls.some((c) => c.join(" ").includes("issues/7/comments"))).toBe(true);
    expect(calls.some((c) => c.join(" ").includes("pulls/7/reviews"))).toBe(true);
  });

  it("ignores negated GitHub LGTM pins", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        if (args[0] === "pr") {
          return { status: 0, stdout: '{"headRefOid":"def4560"}', stderr: "" };
        }
        if (args.join(" ").includes("issues/7/comments")) {
          return {
            status: 0,
            stdout: JSON.stringify([
              { body: "no lgtm @ aa11bb0", user: { login: "claude" }, created_at: "2026-06-11T00:00:00Z" },
              { body: "NO LGTM @ cc22dd0", user: { login: "claude" }, created_at: "2026-06-11T00:01:00Z" },
              { body: "review result: not lgtm @ ee33ff0", user: { login: "claude" }, created_at: "2026-06-11T00:02:00Z" },
              { body: "sin lgtm @ 123abc0", user: { login: "claude" }, created_at: "2026-06-11T00:03:00Z" },
            ]),
            stderr: "",
          };
        }
        if (args.join(" ").includes("pulls/7/reviews")) {
          return { status: 0, stdout: "[]", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["reviewer-tick", "-n", "o-r-7"]);

    expect(readEvents(dir).map((event) => event.event)).toEqual(["pr_opened"]);
    expect(out.join("\n")).toContain("reviewer: no pinned lgtm for o-r-7");
  });

  it("skips punctuated negated pins before accepting a later current LGTM", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        if (args[0] === "pr") {
          return { status: 0, stdout: '{"headRefOid":"def4560"}', stderr: "" };
        }
        if (args.join(" ").includes("issues/7/comments")) {
          return {
            status: 0,
            stdout: JSON.stringify([
              { body: "no, lgtm @ aa11bb0", user: { login: "claude" }, created_at: "2026-06-11T00:00:00Z" },
              { body: "lgtm @ def4560", user: { login: "claude" }, created_at: "2026-06-11T00:01:00Z" },
              { body: "no. lgtm @ bb22cc0", user: { login: "claude" }, created_at: "2026-06-11T00:02:00Z" },
              { body: "no! lgtm @ cc33dd0", user: { login: "claude" }, created_at: "2026-06-11T00:03:00Z" },
              { body: "no - lgtm @ dd44ee0", user: { login: "claude" }, created_at: "2026-06-11T00:04:00Z" },
              { body: "no: lgtm @ ee55ff0", user: { login: "claude" }, created_at: "2026-06-11T00:05:00Z" },
              { body: "no; lgtm @ ff66aa0", user: { login: "claude" }, created_at: "2026-06-11T00:06:00Z" },
            ]),
            stderr: "",
          };
        }
        if (args.join(" ").includes("pulls/7/reviews")) {
          return { status: 0, stdout: "[]", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["reviewer-tick", "-n", "o-r-7"]);

    expect(out.join("\n")).toContain("reviewer: lgtm current at def4560");
    expect(calls.some((c) => c[0] === "tmux" && c[1] === "new-window")).toBe(false);
    expect(readEvents(dir).map((event) => event.event)).toEqual(["pr_opened", "lgtm"]);
    expect(readEvents(dir)[1]).toMatchObject({ sha: "def4560" });
  });

  it("finds a GitHub LGTM pin from paginated comment arrays", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      [
        '[roles]',
        'gordon = ["local"]',
        '',
        '[gordon.local]',
        'command = "judge-bot --pr {pr_url} --prompt {prompt}"',
        '',
      ].join("\n"),
    );
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        if (args[0] === "pr") {
          return { status: 0, stdout: '{"headRefOid":"def4560"}', stderr: "" };
        }
        if (args.join(" ").includes("issues/7/comments")) {
          return {
            status: 0,
            stdout:
              '[]\n[{"body":"lgtm @ abc1230","user":{"login":"local"},"created_at":"2026-06-11T00:01:00Z"}]',
            stderr: "",
          };
        }
        if (args.join(" ").includes("pulls/7/reviews")) {
          return { status: 0, stdout: "[]", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["reviewer-tick", "-n", "o-r-7"]);

    expect(readEvents(dir)[1]).toMatchObject({ event: "lgtm", sha: "abc1230" });
  });

  it("treats a short GitHub LGTM pin as current when it prefixes the full PR head", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      [
        '[roles]',
        'gordon = ["local"]',
        '',
        '[gordon.local]',
        'command = "judge-bot --pr {pr_url} --prompt {prompt}"',
        '',
      ].join("\n"),
    );
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const fullSha = "e4e7dd43c6cc0d5f1234567890abcdef12345678";
    const shortSha = fullSha.slice(0, 7);
    expect(fullSha).toHaveLength(40);

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        if (args[0] === "pr") {
          return { status: 0, stdout: `{"headRefOid":"${fullSha}"}`, stderr: "" };
        }
        if (args.join(" ").includes("issues/7/comments")) {
          return {
            status: 0,
            stdout: `[{"body":"lgtm @ ${shortSha}","user":{"login":"local"},"created_at":"2026-06-11T00:00:00Z"}]`,
            stderr: "",
          };
        }
        if (args.join(" ").includes("pulls/7/reviews")) {
          return { status: 0, stdout: "[]", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["reviewer-tick", "-n", "o-r-7"]);
    await exec(deps, ["reviewer-tick", "-n", "o-r-7"]);

    expect(out.join("\n")).toContain(`reviewer: lgtm current at ${fullSha}`);
    expect(calls.some((c) => c[0] === "tmux" && c[1] === "new-window")).toBe(false);

    const events = readEvents(dir);
    expect(events.filter((event) => event.event === "lgtm_stale")).toHaveLength(0);
    const lgtms = events.filter((event) => event.event === "lgtm");
    expect(lgtms).toHaveLength(1);
    expect(lgtms[0]).toMatchObject({ sha: fullSha });
  });

  it("does not consume a pinned LGTM when the incremental re-review window fails to start", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      [
        '[roles]',
        'gordon = ["local"]',
        '',
        '[gordon.local]',
        'command = "judge-bot --pr {pr_url} --prompt {prompt}"',
        '',
      ].join("\n"),
    );
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(dir, "lgtm", { sha: "abc123" });

    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) =>
        args[0] === "pr"
          ? { status: 0, stdout: '{"headRefOid":"def456"}', stderr: "" }
          : { status: 0, stdout: "[]", stderr: "" },
      tmux: (args) =>
        args[0] === "new-window"
          ? { status: 1, stdout: "", stderr: "window limit reached" }
          : { status: 0, stdout: "", stderr: "" },
    });

    await expect(exec(deps, ["reviewer-tick", "-n", "o-r-7"])).rejects.toThrow(/re-review/);

    expect(readEvents(dir).map((event) => event.event)).toEqual(["pr_opened", "lgtm"]);
  });
});

describe("events", () => {
  it("renders post-PR events through --follow", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "merged", { sha: "def456", by: "maintainer" });

    const stop = new Error("observed followed event");
    const out: string[] = [];
    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h, COMBO_CHEN_POLL_MS: "1" },
      out: (line) => {
        out.push(line);
        if (line.includes('"event":"merged"')) throw stop;
      },
    });

    await expect(exec(deps, ["events", "-n", "o-r-7", "--follow"])).rejects.toBe(stop);
    expect(JSON.parse(out[0] ?? "{}")).toMatchObject({
      event: "merged",
      sha: "def456",
      by: "maintainer",
    });
  });
});

describe("stop", () => {
  it("kills the tmux session and journals who stopped it", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });

    const { deps, calls } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });
    await exec(deps, ["stop", "-n", "o-r-7"]);

    expect(calls.some((c) => c[0] === "tmux" && c[1] === "kill-session")).toBe(true);
    const events = readEvents(dir);
    expect(events.at(-1)?.event).toBe("stopped");
  });

  it("does not journal stopped when the tmux kill fails (the journal never lies)", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });

    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) =>
        args[0] === "kill-session"
          ? { status: 1, stdout: "", stderr: "no server running" }
          : { status: 0, stdout: "", stderr: "" },
    });

    await expect(exec(deps, ["stop", "-n", "o-r-7"])).rejects.toThrow(/kill/i);
    expect(readEvents(dir)).toEqual([]);
  });
});

describe("park", () => {
  it("uses the launch config snapshot for handoff downstream status after repo TOML changes", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(join(repoDir, "combo-chen.toml"), '[reviewer]\nambient = ["launch-bot"]\n');
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    writeConfigSnapshot(dir, loadConfig({ repoDir, env: {} }));
    writeFileSync(join(repoDir, "combo-chen.toml"), '[reviewer]\nambient = ["drift-bot"]\n');
    const prUrl = "https://github.com/o/r/pull/7";
    appendEvent(dir, "pr_opened", { url: prUrl });

    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              state: "OPEN",
              statusCheckRollup: [
                { name: "launch-bot", conclusion: "FAILURE" },
                { name: "test", conclusion: "SUCCESS" },
                { name: "CodeRabbit", conclusion: "SUCCESS" },
              ],
            }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["park", "-n", "o-r-7", "--by", "maintainer"]);

    const summaryPath = readEvents(dir).at(-1)?.summary_path;
    expect(typeof summaryPath).toBe("string");
    const summary = readFileSync(summaryPath as string, "utf8");
    expect(summary).toContain("downstream: PR ready for reviewer");
  });

  it("writes a resumable handoff summary and stops tmux without terminally stopping the combo", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "coder_started", {});
    appendEvent(dir, "coder_failed", { exit_code: 124, has_new_commits: true });

    const { deps, calls, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["park", "-n", "o-r-7", "--by", "maintainer"]);

    expect(calls.some((c) => c[0] === "tmux" && c[1] === "kill-session")).toBe(true);
    const events = readEvents(dir);
    expect(events.at(-1)?.event).toBe("parked");
    expect(events.some((event) => event.event === "stopped")).toBe(false);
    expect(events.at(-1)).toMatchObject({ by: "maintainer" });
    const summaryPath = events.at(-1)?.summary_path;
    expect(typeof summaryPath).toBe("string");
    const summary = readFileSync(summaryPath as string, "utf8");
    expect(summary).toContain("# Parked combo o-r-7");
    expect(summary).toContain("branch: combo/issue-7");
    expect(summary).toContain("phase: STALLED");
    expect(summary).toContain(`COMBO_CHEN_HOME=${shellQuote(h)}`);
    expect(summary).toContain(`resume -n ${shellQuote("o-r-7")}`);
    expect(summary).toContain("status --deep");
    expect(out).toEqual([`parked o-r-7 (handoff ${summaryPath}; resume with combo-chen resume -n o-r-7)`]);
  });

  it("still writes a resumable handoff when the tmux session is already gone", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "coder_started", {});

    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) =>
        args[0] === "kill-session"
          ? { status: 1, stdout: "", stderr: "can't find session: combo-chen-o-r-7" }
          : args[0] === "has-session"
            ? { status: 1, stdout: "", stderr: "can't find session: combo-chen-o-r-7" }
          : { status: 0, stdout: "", stderr: "" },
    });

    await exec(deps, ["park", "-n", "o-r-7", "--by", "reboot"]);

    const events = readEvents(dir);
    expect(events.at(-1)).toMatchObject({ event: "parked", by: "reboot" });
    const summaryPath = events.at(-1)?.summary_path;
    expect(typeof summaryPath).toBe("string");
    expect(readFileSync(summaryPath as string, "utf8")).toContain("last event: coder_started");
    expect(out.at(-1)).toContain("parked o-r-7");
  });
});

describe("resolvePollMs", () => {
  it("reads COMBO_CHEN_POLL_MS and falls back to undefined (core default applies)", async () => {
    const { resolvePollMs } = await import("./main.js");
    expect(resolvePollMs({ COMBO_CHEN_POLL_MS: "250" })).toBe(250);
    expect(resolvePollMs({ COMBO_CHEN_POLL_MS: "nonsense" })).toBeUndefined();
    expect(resolvePollMs({})).toBeUndefined();
  });
});

describe("run ordering and safety", () => {
  it("leases the combo worktree from Treehouse and creates the branch from origin/main", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir]);

    expect(calls).toContainEqual(["git", `cwd=${repoDir}`, "fetch", "origin", "main"]);
    expect(calls).toContainEqual([
      "treehouse",
      `cwd=${repoDir}`,
      "get",
      "--lease",
      "--lease-holder",
      "o-r-7",
    ]);
    expect(calls).toContainEqual([
      "git",
      `cwd=${join(repoDir, ".worktrees", "issue-7")}`,
      "switch",
      "-c",
      "combo/issue-7",
      "origin/main",
    ]);
    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(false);
  });

  it("allows --base to override the combo branch base ref", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir, "--base", "origin/release-candidate"]);

    expect(calls).toContainEqual([
      "git",
      `cwd=${join(repoDir, ".worktrees", "issue-7")}`,
      "switch",
      "-c",
      "combo/issue-7",
      "origin/release-candidate",
    ]);
  });

  it("refuses to launch from a dirty source checkout before creating the worktree", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "branch" && args[1] === "--show-current") return { status: 0, stdout: "main\n", stderr: "" };
        if (args[0] === "status" && args[1] === "--porcelain") return { status: 0, stdout: " M src/x.ts\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(/uncommitted changes/);

    expect(calls.some((c) => c[0] === "git" && c.includes("worktree") && c.includes("add"))).toBe(false);
  });

  it("prints overture and blocks an existing local branch before creating launch resources", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "branch" && args[1] === "--show-current") return { status: 0, stdout: "main\n", stderr: "" };
        if (args[0] === "branch" && args[1] === "--list") return { status: 0, stdout: "combo/issue-7\n", stderr: "" };
        if (args[0] === "status" && args[1] === "--porcelain") return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /branch.*combo\/issue-7.*exists locally/,
    );

    expect(out).toContain("overture o-r-7");
    expect(out).toContain("X branch_free: combo/issue-7 already exists locally");
    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(false);
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-session")).toBe(false);

    const artifact = JSON.parse(readFileSync(join(runDirFor(h, "o-r-7"), "overture.json"), "utf8")) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; detail?: string }>;
    };
    expect(artifact.ok).toBe(false);
    expect(artifact.checks).toContainEqual({
      id: "branch_free",
      resource: "combo/issue-7",
      status: "failed",
      detail: "already exists locally",
    });
  });

  it("prints overture and blocks an existing worktree path before creating launch resources", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    mkdirSync(worktree, { recursive: true });
    const { deps, calls, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /worktree_free.*path already exists/,
    );

    expect(out).toContain("overture o-r-7");
    expect(out).toContain(`X worktree_free: ${worktree} path already exists`);
    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(false);
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-session")).toBe(false);
    expect(existsSync(join(runDirFor(h, "o-r-7"), "combo.json"))).toBe(false);

    const artifact = JSON.parse(readFileSync(join(runDirFor(h, "o-r-7"), "overture.json"), "utf8")) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; resource: string; detail?: string }>;
    };
    expect(artifact.ok).toBe(false);
    expect(artifact.checks).toContainEqual({
      id: "worktree_free",
      resource: worktree,
      status: "failed",
      detail: "path already exists",
    });
  });

  it("prints overture and blocks an existing tmux session before creating launch resources", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "has-session" && args.at(-1) === "combo-chen-o-r-7") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /tmux_session_free.*session already exists/,
    );

    expect(out).toContain("overture o-r-7");
    expect(out).toContain("X tmux_session_free: combo-chen-o-r-7 session already exists");
    expect(calls).toContainEqual(["tmux", "has-session", "-t", "combo-chen-o-r-7"]);
    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(false);
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-session")).toBe(false);
    expect(existsSync(join(runDirFor(h, "o-r-7"), "combo.json"))).toBe(false);

    const artifact = JSON.parse(readFileSync(join(runDirFor(h, "o-r-7"), "overture.json"), "utf8")) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; resource: string; detail?: string }>;
    };
    expect(artifact.ok).toBe(false);
    expect(artifact.checks).toContainEqual({
      id: "tmux_session_free",
      resource: "combo-chen-o-r-7",
      status: "failed",
      detail: "session already exists",
    });
  });

  it("blocks an active no-mistakes run for the derived branch before creating launch resources", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: (args, cwd) => {
        calls.push(["no-mistakes", `cwd=${cwd}`, ...args]);
        expect(cwd).toBe(repoDir);
        if (args[0] === "status") return { status: 0, stdout: "daemon: running\n", stderr: "" };
        expect(args).toEqual(["axi", "status"]);
        return {
          status: 0,
          stdout: [
            "run:",
            "  id: \"01KV-OLD\"",
            "  branch: combo/issue-7",
            "  status: running",
            "  worktree: /repos/r/.worktrees/issue-7",
            "  steps[1]{step,status,findings,duration_ms}:",
            "    ci,running,0,0",
          ].join("\n"),
          stderr: "",
        };
      },
    });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /no_mistakes_run_free.*combo\/issue-7/,
    );

    expect(out).toContain("X no_mistakes_run_free: combo/issue-7 active no-mistakes run is running");
    expect(calls).toContainEqual(["no-mistakes", `cwd=${repoDir}`, "status"]);
    expect(calls).toContainEqual(["no-mistakes", `cwd=${repoDir}`, "axi", "status"]);
    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(false);
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-session")).toBe(false);

    const artifact = JSON.parse(readFileSync(join(runDirFor(h, "o-r-7"), "overture.json"), "utf8")) as {
      ok: boolean;
      resources: { noMistakes?: { branch?: string; status?: string; worktree?: string } };
      checks: Array<{ id: string; status: string; resource: string; detail?: string }>;
    };
    expect(artifact.ok).toBe(false);
    expect(artifact.resources.noMistakes).toMatchObject({
      branch: "combo/issue-7",
      status: "running",
      worktree: "/repos/r/.worktrees/issue-7",
    });
    expect(artifact.checks).toContainEqual({
      id: "no_mistakes_run_free",
      resource: "combo/issue-7",
      status: "failed",
      detail: "active no-mistakes run is running",
    });
  });

  it("blocks an active no-mistakes run for the same worktree even when its branch differs", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: (args, cwd) => {
        calls.push(["no-mistakes", `cwd=${cwd}`, ...args]);
        if (args[0] === "status") return { status: 0, stdout: "daemon: running\n", stderr: "" };
        return {
          status: 0,
          stdout: [
            "run:",
            "  id: \"01KV-OLD\"",
            "  branch: combo/sibling-branch",
            "  status: running",
            `      worktree: "${worktree}"`,
            "  steps[1]{step,status,findings,duration_ms}:",
            "    ci,running,0,0",
          ].join("\n"),
          stderr: "",
        };
      },
    });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /no_mistakes_run_free.*issue-7/,
    );

    expect(out).toContain(`X no_mistakes_run_free: ${worktree} active no-mistakes run is running`);
    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(false);
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-session")).toBe(false);

    const artifact = JSON.parse(readFileSync(join(runDirFor(h, "o-r-7"), "overture.json"), "utf8")) as {
      ok: boolean;
      resources: { noMistakes?: { branch?: string; status?: string; worktree?: string } };
      checks: Array<{ id: string; status: string; resource: string; detail?: string }>;
    };
    expect(artifact.ok).toBe(false);
    expect(artifact.resources.noMistakes).toMatchObject({
      branch: "combo/sibling-branch",
      status: "running",
      worktree,
    });
    expect(artifact.checks).toContainEqual({
      id: "no_mistakes_run_free",
      resource: worktree,
      status: "failed",
      detail: "active no-mistakes run is running",
    });
  });

  it("blocks a non-origin base ref that cannot be resolved locally before creating launch resources", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "rev-parse" && args[1] === "--verify") {
          return { status: 128, stdout: "", stderr: "fatal: Needed a single revision\n" };
        }
        if (args[0] === "branch" && args[1] === "--show-current") return { status: 0, stdout: "main\n", stderr: "" };
        if (args[0] === "status" && args[1] === "--porcelain") return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(
      exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir, "--base", "feature/missing"]),
    ).rejects.toThrow(/base_ref_resolved.*feature\/missing/);

    expect(out).toContain(
      "X base_ref_resolved: feature/missing git rev-parse --verify feature/missing failed: fatal: Needed a single revision",
    );
    expect(calls).toContainEqual(["git", `cwd=${repoDir}`, "rev-parse", "--verify", "feature/missing"]);
    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(false);
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-session")).toBe(false);

    const artifact = JSON.parse(readFileSync(join(runDirFor(h, "o-r-7"), "overture.json"), "utf8")) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; resource: string; detail?: string }>;
    };
    expect(artifact.ok).toBe(false);
    expect(artifact.checks).toContainEqual({
      id: "base_ref_resolved",
      resource: "feature/missing",
      status: "failed",
      detail: "git rev-parse --verify feature/missing failed: fatal: Needed a single revision",
    });
  });

  it("refuses to launch from a non-main source checkout before creating the worktree", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "branch" && args[1] === "--show-current") return { status: 0, stdout: "docs/launch-combo-resume\n", stderr: "" };
        if (args[0] === "status" && args[1] === "--porcelain") return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(/must be on main/);

    expect(calls.some((c) => c[0] === "git" && c.includes("worktree") && c.includes("add"))).toBe(false);
  });

  it("allows the required source branch to come from run config", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(join(repoDir, "combo-chen.toml"), '[run]\nsource_branch = "develop"\n');
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "branch" && args[1] === "--show-current") return { status: 0, stdout: "develop\n", stderr: "" };
        if (args[0] === "status" && args[1] === "--porcelain") return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir]);

    expect(calls).toContainEqual([
      "git",
      `cwd=${join(repoDir, ".worktrees", "issue-7")}`,
      "switch",
      "-c",
      "combo/issue-7",
      "origin/main",
    ]);
  });

  it("rejects an unsafe gnhf coder command before creating a worktree or tmux session", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      '[coder.codex]\ncommand = "npx -y gnhf --agent codex --current-branch {prompt}"\n',
    );
    const { deps, calls } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /Unsafe coder invocation/,
    );

    expect(calls.some((c) => c[0] === "git" && c.includes("worktree") && c.includes("add"))).toBe(false);
    expect(calls.some((c) => c[0] === "tmux" && c[1] === "new-session")).toBe(false);
    expect(existsSync(join(runDirFor(h, "o-r-7"), "overture.json"))).toBe(true);
    expect(existsSync(join(runDirFor(h, "o-r-7"), "combo.json"))).toBe(false);
  });

  it("rejects an unsafe reviewer command before creating a worktree or tmux session", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      '[reviewer.claude]\ncommand = "claude {prompt} && rm -f /tmp/review.md"\n',
    );
    const { deps, calls } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /reviewer command must be one plain command/,
    );

    expect(calls.some((c) => c[0] === "git" && c.includes("worktree") && c.includes("add"))).toBe(false);
    expect(calls.some((c) => c[0] === "tmux" && c[1] === "new-session")).toBe(false);
    expect(existsSync(join(runDirFor(h, "o-r-7"), "overture.json"))).toBe(true);
    expect(existsSync(join(runDirFor(h, "o-r-7"), "combo.json"))).toBe(false);
  });

  it("journals combo_created before the tmux session starts", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    let journalAtSessionStart: string[] | undefined;
    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        if (args[0] === "has-session") return { status: 1, stdout: "", stderr: "" };
        if (args[0] === "new-session") {
          journalAtSessionStart = readEvents(runDirFor(h, "o-r-7")).map((e) => e.event);
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir]);

    expect(journalAtSessionStart).toEqual(["combo_created"]);
  });

  it("prints overture and blocks a repo origin mismatch before creating launch resources", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const mismatchedOrigin = "git@github.com:someone/else.git";
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "remote" && args[1] === "get-url" && args[2] === "origin") {
          return { status: 0, stdout: `${mismatchedOrigin}\n`, stderr: "" };
        }
        if (args[0] === "branch" && args[1] === "--show-current") return { status: 0, stdout: "main\n", stderr: "" };
        if (args[0] === "status" && args[1] === "--porcelain") return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /repo_matches_issue.*someone\/else/,
    );

    expect(out).toContain("overture o-r-7");
    expect(out).toContain(
      `X repo_matches_issue: ${mismatchedOrigin} origin mismatch; issue belongs to o/r`,
    );
    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(false);
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-session")).toBe(false);
    expect(existsSync(join(runDirFor(h, "o-r-7"), "combo.json"))).toBe(false);

    const artifact = JSON.parse(readFileSync(join(runDirFor(h, "o-r-7"), "overture.json"), "utf8")) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; resource: string; detail?: string }>;
    };
    expect(artifact.ok).toBe(false);
    expect(artifact.checks).toContainEqual({
      id: "repo_matches_issue",
      resource: mismatchedOrigin,
      status: "failed",
      detail: "origin mismatch; issue belongs to o/r",
    });
  });

  it("refuses an origin that merely contains the issue's owner/repo as a prefix", async () => {
    // o/r-fork contains "o/r"; only exact slug equality may pass the guard.
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const origin = "git@github.com:o/r-fork.git";
    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args) =>
        args[0] === "remote"
          ? { status: 0, stdout: `${origin}\n`, stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
    });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(/origin/i);

    const artifact = JSON.parse(readFileSync(join(runDirFor(h, "o-r-7"), "overture.json"), "utf8")) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; resource: string; detail?: string }>;
    };
    expect(artifact.ok).toBe(false);
    expect(artifact.checks).toContainEqual({
      id: "repo_matches_issue",
      resource: origin,
      status: "failed",
      detail: "origin mismatch; issue belongs to o/r",
    });
  });

  it("rolls back the run dir, the worktree, and the branch when config snapshot write fails", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const runDir = runDirFor(h, "o-r-7");
    const snapshotPath = join(runDir, CONFIG_SNAPSHOT_FILE);
    const teardownSnapshots: Array<{ step: string; runDirExists: boolean; comboExists: boolean }> = [];
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "branch" && args[1] === "--show-current") return { status: 0, stdout: "main\n", stderr: "" };
        if (args[0] === "status" && args[1] === "--porcelain") return { status: 0, stdout: "", stderr: "" };
        if (args[0] === "switch" && args[1] === "-c") {
          mkdirSync(snapshotPath, { recursive: true });
        }
        if (args[0] === "branch" && args[1] === "-D") {
          teardownSnapshots.push({
            step: "branch-delete",
            runDirExists: existsSync(runDir),
            comboExists: existsSync(join(runDir, "combo.json")),
          });
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      treehouse: (args, cwd) => {
        calls.push(["treehouse", `cwd=${cwd}`, ...args]);
        if (args[0] === "return") {
          teardownSnapshots.push({
            step: "treehouse-return",
            runDirExists: existsSync(runDir),
            comboExists: existsSync(join(runDir, "combo.json")),
          });
        }
        return { status: 0, stdout: `${join(repoDir, ".worktrees", "issue-7")}\n`, stderr: "" };
      },
    });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(CONFIG_SNAPSHOT_FILE);

    const treehouseGetIndex = calls.findIndex((c) => c[0] === "treehouse" && c.includes("get"));
    const treehouseReturnIndex = calls.findIndex((c) => c[0] === "treehouse" && c.includes("return"));
    const branchDeleteIndex = calls.findIndex((c) => c[0] === "git" && c.includes("branch") && c.includes("-D"));
    expect(treehouseGetIndex).toBeGreaterThan(-1);
    expect(calls[treehouseReturnIndex]).toEqual([
      "treehouse",
      `cwd=${repoDir}`,
      "return",
      "--force",
      join(repoDir, ".worktrees", "issue-7"),
    ]);
    expect(calls[branchDeleteIndex]).toEqual(["git", `cwd=${repoDir}`, "branch", "-D", "combo/issue-7"]);
    expect(treehouseReturnIndex).toBeGreaterThan(treehouseGetIndex);
    expect(branchDeleteIndex).toBeGreaterThan(treehouseReturnIndex);
    expect(teardownSnapshots).toEqual([
      { step: "treehouse-return", runDirExists: false, comboExists: false },
      { step: "branch-delete", runDirExists: false, comboExists: false },
    ]);
    expect(existsSync(runDir)).toBe(false);
    expect(calls.some((c) => c[0] === "tmux" && c[1] === "new-session")).toBe(false);
  });

  it("rolls back the run dir, the worktree, and the branch when tmux fails to start the session", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) =>
        args[0] === "new-session"
          ? { status: 1, stdout: "", stderr: "no terminal" }
          : { status: 1, stdout: "", stderr: "" },
    });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(/tmux/i);

    const treehouseReturnIndex = calls.findIndex((c) => c[0] === "treehouse" && c.includes("return"));
    const treehouseReturn = calls[treehouseReturnIndex];
    expect(treehouseReturn).toBeDefined();
    expect(treehouseReturn).toContain("return");
    expect(treehouseReturn).toContain("--force");
    expect(treehouseReturn).toContain(join(repoDir, ".worktrees", "issue-7"));

    // Retry after a tmux failure must be idempotent: the branch created by
    // `git switch -c` has to go too, and only after Treehouse returned the
    // worktree so the branch is no longer checked out there.
    const branchDeleteIndex = calls.findIndex(
      (c) => c[0] === "git" && c.includes("branch") && c.includes("-D"),
    );
    const branchDelete = calls[branchDeleteIndex];
    expect(branchDelete).toBeDefined();
    expect(branchDelete).toContain(`cwd=${repoDir}`);
    expect(branchDelete).toContain("combo/issue-7");
    expect(treehouseReturnIndex).toBeLessThan(branchDeleteIndex);

    expect(existsSync(runDirFor(h, "o-r-7"))).toBe(false);
  });

  it("rejects and rolls back a dirty Treehouse lease before creating the combo branch", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "branch" && args[1] === "--show-current") {
          return { status: 0, stdout: "main\n", stderr: "" };
        }
        if (args[0] === "status" && args[1] === "--porcelain" && cwd.includes(".worktrees/issue-7")) {
          return { status: 0, stdout: "?? residue\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /treehouse lease returned dirty worktree/,
    );

    expect(calls).toContainEqual([
      "treehouse",
      `cwd=${repoDir}`,
      "return",
      "--force",
      join(repoDir, ".worktrees", "issue-7"),
    ]);
    expect(calls).toContainEqual(["git", `cwd=${repoDir}`, "branch", "-D", "combo/issue-7"]);
    expect(calls.some((c) => c[0] === "git" && c.includes("switch"))).toBe(false);
    expect(existsSync(runDirFor(h, "o-r-7"))).toBe(false);
  });

  it("accepts an exact owner/repo match in ssh and https shapes, case-insensitively", async () => {
    for (const remoteUrl of [
      "git@github.com:o/r.git",
      "https://github.com/o/r.git",
      "https://github.com/O/R",
    ]) {
      const { deps } = fakeDeps({
        env: { COMBO_CHEN_HOME: home() },
        git: (args) =>
          args[0] === "remote"
            ? { status: 0, stdout: `${remoteUrl}\n`, stderr: "" }
            : args[0] === "branch" && args[1] === "--show-current"
              ? { status: 0, stdout: "main\n", stderr: "" }
              : { status: 0, stdout: "", stderr: "" },
      });

      await expect(
        exec(deps, ["run", "--issue", ISSUE, "--repo", mkdtempSync(join(tmpdir(), "combo-chen-repo-"))]),
      ).resolves.toBeUndefined();
    }
  });
});
// -/ 4/4
