/**
 * @overview Shared fake runtime and imports for split CLI integration tests.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at fakeDeps             <- deterministic git/tmux/GitHub universe.
 *   2. Use exec                     <- dispatch a real Commander command.
 *   3. Use seed helpers             <- persist common combo fixtures.
 *
 *   MAIN FLOW
 *   ---------
 *   test -> fakeDeps -> createProgram -> command handler -> recorded calls/output
 *
 *   PUBLIC API
 *   ----------
 *   fakeDeps, idleActiveRuntime, exec, home, seedNeedsHumanCombo, seedCodexGnhfRun, writeCoderThreadArtifact,
 *   writeExecutable, decodedGeneratedGatekeeperIntent, ISSUE, CODEX_THREAD_ID
 *
 *   INTERNALS
 *   ---------
 *   None.
 *
 * @exports fakeDeps, idleActiveRuntime, exec, home, seedNeedsHumanCombo, seedCodexGnhfRun, writeCoderThreadArtifact, writeExecutable, decodedGeneratedGatekeeperIntent, ISSUE, CODEX_THREAD_ID
 * @deps ../app/gate/gate, ../cli/main, ../core/combo, ../core/events, ../core/gate-lease, ../core/runtime-ledger, ../core/state, ../core/work-plan, ../infra/config, ../infra/config-snapshot, ../roles/coder-invocation, ../roles/gatekeeper, ../update/index, node:child_process, node:crypto, node:fs, node:os, node:path, node:url, vitest
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
import { CODER_THREAD_ARTIFACT } from "../roles/coder-invocation.js";
import { buildIssuePrIntent, buildWorkPlanPrIntent } from "../roles/gatekeeper.js";
import { GATEKEEPER_WINDOW } from "../app/gate/gate.js";
import {
  buildDirectorWatchCommand,
  createProgram,
  defaultDeps,
  isDirectRun,
  type Deps,
} from "../cli/main.js";
import {
  PASSIVE_UPDATE_CACHE_FILE,
  PASSIVE_UPDATE_DISABLE_ENV,
  formatReleaseMetadata,
  refreshPostUpdateLocalState,
  releaseMetadata,
} from "../update/index.js";

export {
  CONFIG_SNAPSHOT_FILE,
  CODER_THREAD_ARTIFACT,
  GATEKEEPER_WINDOW,
  PASSIVE_UPDATE_CACHE_FILE,
  PASSIVE_UPDATE_DISABLE_ENV,
  acquireGateLease,
  appendEvent,
  buildDirectorWatchCommand,
  buildIssuePrIntent,
  buildRuntimeLedger,
  buildWorkPlanPrIntent,
  chmodSync,
  createHash,
  createProgram,
  defaultDeps,
  describe,
  existsSync,
  expect,
  formatReleaseMetadata,
  isDirectRun,
  it,
  join,
  listCombos,
  loadConfig,
  mkdirSync,
  mkdtempSync,
  normalizeMarkdownWorkPlan,
  pathToFileURL,
  readConfigSnapshot,
  readEvents,
  readFileSync,
  refreshPostUpdateLocalState,
  releaseMetadata,
  renderWorkPlanMarkdown,
  rmSync,
  runDirFor,
  shellQuote,
  spawnSync,
  symlinkSync,
  tmpdir,
  vi,
  writeCombo,
  writeConfigSnapshot,
  writeFileSync,
  writeRuntimeLedger,
};
export type { Deps };

// -- 1/2 CORE · fakeDeps <- START HERE --
export function home(): string {
  return mkdtempSync(join(tmpdir(), "combo-chen-cli-"));
}

export function decodedGeneratedGatekeeperIntent(script: string): string {
  const encoded = /COMBO_CHEN_GATEKEEPER_INTENT_B64='([^']+)'/.exec(script)?.[1];
  if (encoded === undefined) throw new Error("generated script did not contain a gatekeeper intent payload");
  return Buffer.from(encoded, "base64").toString("utf8");
}

export function idleActiveRuntime() {
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

export function fakeDeps(overrides: Partial<Deps> = {}): { deps: Deps; calls: string[][]; out: string[] } {
  const calls: string[][] = [];
  const out: string[] = [];
  const sessions = new Set<string>();
  const { env: envOverride, update: updateOverride, ...restOverrides } = overrides;
  const deps: Deps = {
    env: { [PASSIVE_UPDATE_DISABLE_ENV]: "1", ...envOverride },
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
      calls.push(["git", "cwd=" + cwd, ...args]);
      if (args[0] === "branch" && args[1] === "--show-current") {
        return { status: 0, stdout: "main\n", stderr: "" };
      }
      if (args[0] === "status" && args[1] === "--porcelain") {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    treehouse: (args, cwd) => {
      calls.push(["treehouse", "cwd=" + cwd, ...args]);
      if (args[0] === "get" && args.includes("--lease")) {
        const holderIndex = args.indexOf("--lease-holder");
        const holder =
          holderIndex === -1 ? "treehouse-worktree" : (args[holderIndex + 1] ?? "treehouse-worktree");
        const suffix = holder === "o-r-7" ? "issue-7" : holder;
        const worktree = join(cwd, ".worktrees", suffix);
        mkdirSync(worktree, { recursive: true });
        return { status: 0, stdout: worktree + "\n", stderr: "" };
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
      calls.push(["no-mistakes", "cwd=" + cwd, ...args]);
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
    ...restOverrides,
    update: {
      activeRuntime: idleActiveRuntime,
      postUpdateRefresh: (detection) =>
        refreshPostUpdateLocalState({
          detection,
          noMistakes: (args) => {
            calls.push(["no-mistakes", ...args]);
            return { status: 0, stdout: "daemon: running\n", stderr: "" };
          },
        }),
      ...updateOverride,
    },
  };
  return { deps, calls, out };
}
// -/ 1/2

// -- 2/2 HELPER · Dispatch and fixtures --
export const ISSUE = "https://github.com/o/r/issues/7";
export const CODEX_THREAD_ID = "019eb3f5-c135-76d2-88c5-0aa8edfe4c84";

export async function exec(deps: Deps, argv: string[]): Promise<void> {
  const program = createProgram(deps);
  await program.parseAsync(["node", "combo-chen", ...argv]);
}

export function seedNeedsHumanCombo(homeDir: string): string {
  const dir = runDirFor(homeDir, "o-r-needs");
  writeCombo(dir, {
    id: "o-r-needs",
    issueUrl: ISSUE,
    repoDir: "/repos/r",
    worktree: "/repos/r/.worktrees/issue-7",
    branch: "combo/issue-7",
    tmuxSession: "combo-chen-o-r-needs",
    createdAt: "2026-06-11T10:00:00.000Z",
  });
  return dir;
}

export function seedCodexGnhfRun(worktree: string): void {
  const gnhfRun = join(worktree, ".gnhf", "runs", "implement-github-iss-e6510c");
  mkdirSync(gnhfRun, { recursive: true });
  writeFileSync(
    join(gnhfRun, "iteration-1.jsonl"),
    JSON.stringify({ type: "thread.started", thread_id: CODEX_THREAD_ID }) + "\n",
  );
}

export function writeCoderThreadArtifact(runDir: string): void {
  writeFileSync(
    join(runDir, CODER_THREAD_ARTIFACT),
    JSON.stringify({
      agent: "codex",
      thread_id: CODEX_THREAD_ID,
      source: ".gnhf/runs/implement-github-iss-e6510c/iteration-1.jsonl",
    }) + "\n",
  );
}

export function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}
// -/ 2/2
