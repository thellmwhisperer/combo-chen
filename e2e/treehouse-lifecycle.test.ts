/**
 * @overview Hermetic end-to-end coverage for combo-chen's capsule-engine
 *   lifecycle. Uses the built CLI as a subprocess, real git repos/worktrees,
 *   and process shims for external services. ~1200 lines, capsule topology.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at the describe block     <- launch, journal, close, topology.
 *   2. Then prepareHarness             <- temp repo, config, PATH isolation.
 *   3. Then fixture shims              <- process-boundary fakes in PATH.
 *
 *   MAIN FLOW
 *   ---------
 *   built CLI -> run plan -> Treehouse git worktree lease -> capsule topology -> closure
 *
 * @exports none
 * @deps vitest, node:{child_process,fs,path,url}
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { appendEvent } from "../src/core/events.js";
import { CODER_THREAD_ARTIFACT } from "../src/roles/coder-invocation.js";

// -- 1/3 HELPER · Command runner + JSON helpers --
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(repoRoot, "dist", "cli.mjs");
const LAUNCH_TIMEOUT_MS = 20_000;
const LIFECYCLE_TEST_TIMEOUT_MS = 30_000;

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface Harness {
  root: string;
  repo: string;
  comboHome: string;
  workPlanExtra: string[];
  env: NodeJS.ProcessEnv;
  logs: {
    gh: string;
    noMistakes: string;
    treehouse: string;
    tmux: string;
  };
}

interface HarnessOptions {
  executeRunner?: boolean;
  executeGatekeeperWindows?: boolean;
  activeNoMistakes?: boolean;
  workerStallTicks?: number;
  workerRecoveryAttempts?: number;
  workPlanExtra?: string[];
  permissionPromptPolicy?: "auto-approve-known-safe" | "recreate-non-interactive" | "escalate";
  coderRole?: string;
  coderCommand?: string;
  coderResumeCommand?: string;
  teamLines?: string[];
}

interface ComboRecordJson {
  id: string;
  branch: string;
  repoDir: string;
  worktree: string;
  worktreeProvider?: string;
  treehouseLeaseHolder?: string;
  tmuxSession: string;
}

interface RuntimeLedgerJson {
  comboId: string;
  prUrl?: string;
  worktree: string;
  roleWindows: Record<string, string>;
}

interface JournalEventJson {
  event: string;
  [key: string]: unknown;
}

interface LogEntryJson {
  cwd?: string;
  args: string[];
}

interface TmuxStateJson {
  sessions: Record<string, { windows: Record<string, { panes: number; visibleText?: string }> }>;
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): RunResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: options.timeoutMs,
  });
  const out = {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  if (out.status !== 0) {
    throw new Error(
      [
        `command failed: ${command} ${args.join(" ")}`,
        `cwd: ${options.cwd}`,
        `exit: ${out.status}`,
        result.error === undefined ? "" : `error: ${result.error.message}`,
        "stdout:",
        out.stdout,
        "stderr:",
        out.stderr,
      ].join("\n"),
    );
  }
  return out;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

function installShim(path: string, fixtureName: string): void {
  copyFileSync(join(repoRoot, "e2e", "fixtures", "shims", fixtureName), path);
  chmodSync(path, 0o755);
}

function singleRunDir(comboHome: string): string {
  const runs = readdirSync(join(comboHome, "runs"));
  expect(runs).toHaveLength(1);
  return join(comboHome, "runs", runs[0]!);
}

function commitPlan(harness: Harness): string {
  const planPath = join(harness.repo, "plans", "treehouse-lifecycle.md");
  mkdirSync(join(harness.repo, "plans"), { recursive: true });
  writeFileSync(
    planPath,
    [
      "# Treehouse lifecycle E2E",
      "",
      "## Problem",
      "Exercise combo-chen launch and closure through the built CLI.",
      ...harness.workPlanExtra,
      "",
      "## Acceptance Criteria",
      "- The combo leases a Treehouse worktree.",
      "- Closure returns the leased worktree.",
      "",
    ].join("\n"),
  );
  run("git", ["add", "plans/treehouse-lifecycle.md"], { cwd: harness.repo });
  run("git", ["commit", "-m", "add e2e work plan"], { cwd: harness.repo });
  run("git", ["push", "origin", "main"], { cwd: harness.repo });
  run("git", ["fetch", "origin", "main"], { cwd: harness.repo });
  const mergeSha = run("git", ["rev-parse", "HEAD"], { cwd: harness.repo }).stdout.trim();
  harness.env.E2E_MERGE_SHA = mergeSha;
  harness.env.E2E_HEAD_SHA = mergeSha;
  return planPath;
}

function launchPlanCombo(harness: Harness): { combo: ComboRecordJson; runDir: string; launch: RunResult } {
  const planPath = commitPlan(harness);
  const launch = run(process.execPath, [cliPath, "run", "--plan", planPath, "--repo", harness.repo], {
    cwd: harness.repo,
    env: harness.env,
    timeoutMs: LAUNCH_TIMEOUT_MS,
  });
  const runDir = singleRunDir(harness.comboHome);
  const combo = readJson<ComboRecordJson>(join(runDir, "combo.json"));
  return { combo, runDir, launch };
}

function _writeCoderThreadArtifact(runDir: string): void {
  writeFileSync(
    join(runDir, CODER_THREAD_ARTIFACT),
    `${JSON.stringify({
      agent: "codex",
      thread_id: "019eeee0-0000-7000-8000-000000000001",
      source: ".gnhf/runs/e2e/iteration-1.jsonl",
    })}\n`,
  );
}

/**
 * Open a PR by writing a pr_opened journal event (emit CLI is retired in v1;
 * the capsule engine writes events directly via appendEvent).
 */
function journalPrOpened(runDir: string, prUrl = "https://github.com/o/r/pull/1"): void {
  appendEvent(runDir, "pr_opened", { url: prUrl });
}
// -/ 1/3

// -- 2/3 CORE · Treehouse lifecycle E2E <- START HERE --
describe("treehouse-backed combo lifecycle e2e", { timeout: LIFECYCLE_TEST_TIMEOUT_MS }, () => {
  it("does not synchronously execute the journal follower in the fake tmux shim", () => {
    const tmpBase = join(repoRoot, ".tmp");
    mkdirSync(tmpBase, { recursive: true });
    const root = mkdtempSync(join(tmpBase, "e2e-tmux-shim-"));
    const statePath = join(root, "tmux-state.json");
    let passed = false;

    try {
      const result = spawnSync(
        process.execPath,
        [
          join(repoRoot, "e2e", "fixtures", "shims", "tmux.mjs"),
          "new-session",
          "-d",
          "-s",
          "combo-chen-shim-regression",
          "-n",
          "journal",
          `${process.execPath} -e "setInterval(() => {}, 1000)" events --follow -n combo-chen-shim-regression`,
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            E2E_TMUX_RUN_NEW_SESSION: "1",
            E2E_TMUX_STATE: statePath,
          },
          encoding: "utf8",
          timeout: 500,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const state = readJson<TmuxStateJson>(statePath);
      expect(Object.keys(state.sessions["combo-chen-shim-regression"]?.windows ?? {})).toEqual(["journal"]);
      passed = true;
    } finally {
      if (passed) rmSync(root, { recursive: true, force: true });
      else process.stderr.write(`kept failing e2e harness at ${root}\n`);
    }
  });

  it("returns success after fake tmux creates a window whose command exits nonzero", () => {
    const tmpBase = join(repoRoot, ".tmp");
    mkdirSync(tmpBase, { recursive: true });
    const root = mkdtempSync(join(tmpBase, "e2e-tmux-shim-"));
    const statePath = join(root, "tmux-state.json");
    const sessionName = "combo-chen-shim-window-status";
    let passed = false;

    try {
      const env = {
        ...process.env,
        E2E_TMUX_RUN_NEW_SESSION: "1",
        E2E_TMUX_STATE: statePath,
      };
      const tmuxShim = join(repoRoot, "e2e", "fixtures", "shims", "tmux.mjs");
      const session = spawnSync(
        process.execPath,
        [tmuxShim, "new-session", "-d", "-s", sessionName, "-n", "journal", "true"],
        { cwd: repoRoot, env, encoding: "utf8" },
      );
      expect(session.status).toBe(0);

      const result = spawnSync(
        process.execPath,
        [
          tmuxShim,
          "new-window",
          "-t",
          sessionName,
          "-n",
          "coder",
          `${process.execPath} -e "process.exit(7)"`,
        ],
        { cwd: repoRoot, env, encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      const state = readJson<TmuxStateJson>(statePath);
      expect(Object.keys(state.sessions[sessionName]?.windows ?? {})).toContain("coder");
      passed = true;
    } finally {
      if (passed) rmSync(root, { recursive: true, force: true });
      else process.stderr.write(`kept failing e2e harness at ${root}\n`);
    }
  });

  it("launches a plan-backed combo in a leased git worktree and returns it on closure", () => {
    const harness = prepareHarness();
    let passed = false;

    try {
      const { combo, launch, runDir } = launchPlanCombo(harness);
      expect(launch.stdout).toContain("worktree");

      expect(combo.worktreeProvider).toBe("treehouse");
      expect(combo.treehouseLeaseHolder).toBe(combo.id);
      expect(combo.repoDir).toBe(harness.repo);
      expect(existsSync(combo.worktree)).toBe(true);
      expect(run("git", ["branch", "--show-current"], { cwd: combo.worktree }).stdout.trim()).toBe(
        combo.branch,
      );
      expect(run("git", ["worktree", "list", "--porcelain"], { cwd: harness.repo }).stdout).toContain(
        combo.worktree,
      );

      const treehouseLaunchLog = readJsonLines<LogEntryJson>(harness.logs.treehouse);
      expect(treehouseLaunchLog).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ args: ["status"] }),
          expect.objectContaining({ args: ["get", "--lease", "--lease-holder", combo.id] }),
        ]),
      );

      journalPrOpened(runDir);

      const closure = run(process.execPath, [cliPath, "closure", "-n", combo.id], {
        cwd: harness.repo,
        env: harness.env,
      });
      expect(closure.stdout).toContain("teardown complete");

      const events = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl")).map(
        (event) => event.event,
      );
      expect(events).toContain("combo_created");
      expect(events).toContain("pr_opened");
      expect(events).toContain("merged");
      expect(events).toContain("combo_closed");
      expect(existsSync(combo.worktree)).toBe(false);
      expect(run("git", ["branch", "--list", combo.branch], { cwd: harness.repo }).stdout.trim()).toBe("");

      const treehouseClosureLog = readJsonLines<LogEntryJson>(harness.logs.treehouse);
      expect(treehouseClosureLog).toContainEqual(
        expect.objectContaining({ args: ["return", "--force", combo.worktree] }),
      );

      const tmuxLog = readJsonLines<LogEntryJson>(harness.logs.tmux);
      expect(tmuxLog).toContainEqual(
        expect.objectContaining({ args: ["kill-session", "-t", combo.tmuxSession] }),
      );

      passed = true;
    } finally {
      if (passed) {
        rmSync(harness.root, { recursive: true, force: true });
      } else {
        process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
      }
    }
  });

  it(
    "launches with declared gnhf codex team identity resolved from tool configs",
    () => {
      const coderIdentity = { binary: "npx", agent: "gnhf/codex", model: "gpt-5.5" };
      const harness = prepareHarness({
        coderRole: "codex",
        coderCommand: [
          "npx -y gnhf@0.1.41",
          "--agent codex",
          "--max-iterations 12",
          "--stop-when done",
          "--prevent-sleep on",
          "--meteor-frequency 0",
          "--current-branch {prompt}",
        ].join(" "),
        teamLines: [
          "[team.coder]",
          `binary = ${JSON.stringify(coderIdentity.binary)}`,
          `agent = ${JSON.stringify(coderIdentity.agent)}`,
          `model = ${JSON.stringify(coderIdentity.model)}`,
        ],
      });
      const operatorHome = join(harness.root, "operator-home");
      const codexHome = join(harness.root, "codex-home");
      let passed = false;

      try {
        mkdirSync(join(operatorHome, ".gnhf"), { recursive: true });
        mkdirSync(codexHome, { recursive: true });
        writeFileSync(
          join(operatorHome, ".gnhf", "config.yml"),
          ["agentArgsOverride:", "  codex:", "    - --profile", "    - sitter"].join("\n"),
        );
        writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5"\n');
        writeFileSync(join(codexHome, "sitter.config.toml"), 'model = "gpt-5.5"\n');
        harness.env.HOME = operatorHome;
        harness.env.CODEX_HOME = codexHome;

        const { launch, runDir } = launchPlanCombo(harness);

        expect(launch.stdout).toContain("OK team_identity: team");
        expect(launch.stdout).toContain("coder | npx/gnhf/codex/gpt-5.5 | npx/gnhf/codex/gpt-5.5 | match");
        expect(
          readJson<{ resolvedTeam?: unknown }>(join(runDir, "config.snapshot.json")).resolvedTeam,
        ).toEqual({
          coder: coderIdentity,
        });
        expect(readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl"))).toContainEqual(
          expect.objectContaining({ event: "team", roles: { coder: coderIdentity } }),
        );

        passed = true;
      } finally {
        if (passed) {
          rmSync(harness.root, { recursive: true, force: true });
        } else {
          process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
        }
      }
    },
    LAUNCH_TIMEOUT_MS,
  );

  it("auto-closes a GitHub-merged combo from a director tick without a manual closure command", () => {
    const harness = prepareHarness();
    let passed = false;

    try {
      const { combo, runDir } = launchPlanCombo(harness);
      journalPrOpened(runDir);

      const tick = run(process.execPath, [cliPath, "director-tick", "-n", combo.id], {
        cwd: harness.repo,
        env: {
          ...harness.env,
          E2E_PR_STATE: "MERGED",
        },
      });

      expect(tick.stdout).toContain(`reviewer: merged ${harness.env.E2E_MERGE_SHA} by e2e-maintainer`);
      expect(tick.stdout).toContain(`closure: ${combo.id} closed merged PR ${harness.env.E2E_MERGE_SHA}`);

      const events = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl")).map(
        (event) => event.event,
      );
      expect(events).toContain("merged");
      expect(events).toContain("combo_closed");
      expect(existsSync(combo.worktree)).toBe(false);
      expect(run("git", ["branch", "--list", combo.branch], { cwd: harness.repo }).stdout.trim()).toBe("");

      const treehouseLog = readJsonLines<LogEntryJson>(harness.logs.treehouse);
      expect(treehouseLog).toContainEqual(
        expect.objectContaining({ args: ["return", "--force", combo.worktree] }),
      );

      const status = run(process.execPath, [cliPath, "status", "--all"], {
        cwd: harness.repo,
        env: harness.env,
      });
      expect(status.stdout).toContain(combo.id);
      expect(status.stdout).toContain("STOPPED");

      const tmuxLog = readJsonLines<LogEntryJson>(harness.logs.tmux);
      expect(tmuxLog).toContainEqual(
        expect.objectContaining({ args: ["kill-session", "-t", combo.tmuxSession] }),
      );

      passed = true;
    } finally {
      if (passed) {
        rmSync(harness.root, { recursive: true, force: true });
      } else {
        process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
      }
    }
  });

  it("launches the capsule topology without a runner script (v1 engine)", () => {
    const harness = prepareHarness();
    let passed = false;

    try {
      const { combo, launch, runDir } = launchPlanCombo(harness);

      expect(launch.stdout).toContain(
        "topology: capsule=capsule · journal=journal · director=director · coder=coder · gatekeeper=gatekeeper · reviewer=reviewer · coder-response=coder",
      );

      expect(existsSync(join(runDir, "runner.sh"))).toBe(false);

      const ledger = readJson<RuntimeLedgerJson>(join(runDir, "runtime-ledger.json"));
      expect(ledger.roleWindows).toMatchObject({
        capsule: "capsule",
        journal: "journal",
        director: "director",
        coder: "coder",
        gatekeeper: "gatekeeper",
        reviewer: "reviewer",
      });
      expect(ledger.roleWindows).not.toHaveProperty("directorWatch");
      expect(ledger.roleWindows).not.toHaveProperty("gateRunner");

      const configSnapshot = readJson<{ runEngine?: string }>(join(runDir, "config.snapshot.json"));
      expect(configSnapshot.runEngine === undefined || configSnapshot.runEngine === "capsule").toBe(true);

      const tmuxLog = readJsonLines<LogEntryJson>(harness.logs.tmux);
      const newSession = tmuxLog.find((entry) => entry.args[0] === "new-session");
      expect(newSession).toBeDefined();
      const sessionArgIdx = newSession!.args.indexOf("-n") + 1;
      expect(newSession!.args[sessionArgIdx]).toBe("capsule");
      expect(newSession!.args.at(-1)).toContain("capsule");

      const newWindowNames = tmuxLog
        .filter((entry) => entry.args[0] === "new-window")
        .map((entry) => entry.args[entry.args.indexOf("-n") + 1]);
      expect(newWindowNames.sort()).toEqual(["coder", "director", "gatekeeper", "journal", "reviewer"]);
      expect(newWindowNames).not.toContain("director-watch");
      expect(newWindowNames).not.toContain("gate-runner");

      const tmuxState = readJson<TmuxStateJson>(harness.env.E2E_TMUX_STATE!);
      const comboSession = tmuxState.sessions[combo.tmuxSession];
      expect(Object.keys(comboSession!.windows).sort()).toEqual([
        "capsule",
        "coder",
        "director",
        "gatekeeper",
        "journal",
        "reviewer",
      ]);

      const events = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl")).map(
        (event) => event.event,
      );
      expect(events).toContain("combo_created");

      passed = true;
    } finally {
      if (passed) {
        rmSync(harness.root, { recursive: true, force: true });
      } else {
        process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
      }
    }
  });

  it("exposes the capsule role-window topology and recreates missing windows on resume", () => {
    const harness = prepareHarness();
    let passed = false;

    try {
      const { combo, launch, runDir } = launchPlanCombo(harness);
      expect(launch.stdout).toContain(
        "topology: capsule=capsule · journal=journal · director=director · coder=coder · gatekeeper=gatekeeper · reviewer=reviewer · coder-response=coder",
      );

      let ledger = readJson<RuntimeLedgerJson>(join(runDir, "runtime-ledger.json"));
      expect(ledger.roleWindows).toMatchObject({
        capsule: "capsule",
        journal: "journal",
        director: "director",
        coder: "coder",
        gatekeeper: "gatekeeper",
        reviewer: "reviewer",
      });
      expect(ledger.roleWindows).not.toHaveProperty("directorWatch");

      let tmuxState = readJson<TmuxStateJson>(harness.env.E2E_TMUX_STATE!);
      expect(Object.keys(tmuxState.sessions[combo.tmuxSession]!.windows).sort()).toEqual([
        "capsule",
        "coder",
        "director",
        "gatekeeper",
        "journal",
        "reviewer",
      ]);

      journalPrOpened(runDir);
      const journalBeforeResume = readFileSync(join(runDir, "journal.jsonl"), "utf8");

      for (const windowName of ["journal", "director", "gatekeeper"]) {
        run("tmux", ["kill-window", "-t", `${combo.tmuxSession}:${windowName}`], {
          cwd: harness.repo,
          env: harness.env,
        });
      }

      const resume = run(process.execPath, [cliPath, "resume", "-n", combo.id], {
        cwd: harness.repo,
        env: { ...harness.env, E2E_PR_STATE: "OPEN" },
      });
      expect(resume.stdout).toContain("resume: capsule engine");
      expect(readFileSync(join(runDir, "journal.jsonl"), "utf8").startsWith(journalBeforeResume)).toBe(true);

      tmuxState = readJson<TmuxStateJson>(harness.env.E2E_TMUX_STATE!);
      expect(Object.keys(tmuxState.sessions[combo.tmuxSession]!.windows).length).toBeGreaterThanOrEqual(6);

      ledger = readJson<RuntimeLedgerJson>(join(runDir, "runtime-ledger.json"));
      expect(ledger.roleWindows?.capsule).toBeDefined();
      expect(ledger.roleWindows).not.toHaveProperty("directorWatch");

      const tmuxLog = readJsonLines<LogEntryJson>(harness.logs.tmux);
      expect(tmuxLog.some((entry) => entry.args.includes("director-watch"))).toBe(false);

      passed = true;
    } finally {
      if (passed) {
        rmSync(harness.root, { recursive: true, force: true });
      } else {
        process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
      }
    }
  });

  it("parks and resumes a freshly launched combo with the default capsule snapshot", () => {
    const harness = prepareHarness();
    let passed = false;

    try {
      const { combo, runDir } = launchPlanCombo(harness);
      const snapshot = readJson<{ runEngine?: string }>(join(runDir, "config.snapshot.json"));
      expect(snapshot.runEngine).toBe("capsule");

      const park = run(process.execPath, [cliPath, "park", "-n", combo.id, "--by", "e2e"], {
        cwd: harness.repo,
        env: harness.env,
      });
      expect(park.stdout).toContain(`parked ${combo.id}`);
      expect(existsSync(join(runDir, "park-handoff.md"))).toBe(true);
      let tmuxState = readJson<TmuxStateJson>(harness.env.E2E_TMUX_STATE!);
      expect(tmuxState.sessions[combo.tmuxSession]).toBeUndefined();
      const parkedEvents = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl"));
      expect(parkedEvents).toContainEqual(expect.objectContaining({ event: "parked", by: "e2e" }));

      const resume = run(process.execPath, [cliPath, "resume", "-n", combo.id], {
        cwd: harness.repo,
        env: { ...harness.env, E2E_PR_STATE: "OPEN" },
      });
      expect(resume.stdout).toContain("resume: capsule engine");
      expect(resume.stdout).toContain("(recreated tmux session)");
      expect(resume.stdout).not.toContain("migrated frozen v0 engine snapshot");

      tmuxState = readJson<TmuxStateJson>(harness.env.E2E_TMUX_STATE!);
      expect(Object.keys(tmuxState.sessions[combo.tmuxSession]!.windows).sort()).toEqual([
        "capsule",
        "coder",
        "director",
        "gatekeeper",
        "journal",
        "reviewer",
      ]);

      passed = true;
    } finally {
      if (passed) rmSync(harness.root, { recursive: true, force: true });
      else process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
    }
  });

  it("migrates an old frozen v0 snapshot to capsule across park and resume", () => {
    const harness = prepareHarness();
    let passed = false;

    try {
      const { combo, runDir } = launchPlanCombo(harness);

      // Rewrite the frozen artifact to what a v0-era launch persisted.
      const snapshotPath = join(runDir, "config.snapshot.json");
      const frozen = readJson<Record<string, unknown>>(snapshotPath);
      writeFileSync(snapshotPath, `${JSON.stringify({ ...frozen, runEngine: "v0" }, null, 2)}\n`);

      const park = run(process.execPath, [cliPath, "park", "-n", combo.id, "--by", "e2e"], {
        cwd: harness.repo,
        env: harness.env,
      });
      expect(park.stdout).toContain(`parked ${combo.id}`);
      expect(existsSync(join(runDir, "park-handoff.md"))).toBe(true);

      const resume = run(process.execPath, [cliPath, "resume", "-n", combo.id], {
        cwd: harness.repo,
        env: { ...harness.env, E2E_PR_STATE: "OPEN" },
      });
      expect(resume.stdout).toContain(
        `resume: migrated frozen v0 engine snapshot to capsule for ${combo.id}`,
      );
      expect(resume.stdout).toContain("resume: capsule engine");

      const migrated = readJson<{ runEngine?: string }>(snapshotPath);
      expect(migrated.runEngine).toBe("capsule");

      const tmuxState = readJson<TmuxStateJson>(harness.env.E2E_TMUX_STATE!);
      const windows = Object.keys(tmuxState.sessions[combo.tmuxSession]!.windows);
      expect(windows).toContain("capsule");
      expect(windows).not.toContain("director-watch");
      expect(windows).not.toContain("gate-runner");

      passed = true;
    } finally {
      if (passed) rmSync(harness.root, { recursive: true, force: true });
      else process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
    }
  });

  it("resumes a GitHub-merged combo by converging closure instead of restarting review", () => {
    const harness = prepareHarness();
    let passed = false;

    try {
      const { combo, runDir } = launchPlanCombo(harness);
      journalPrOpened(runDir);

      const resume = run(process.execPath, [cliPath, "resume", "-n", combo.id], {
        cwd: harness.repo,
        env: { ...harness.env, E2E_TREEHOUSE_UNAVAILABLE_ON_RETURN: "1" },
      });
      expect(resume.stdout).toContain(`resume: closure pending for ${combo.id} (github); running closure`);
      expect(resume.stdout).toContain("teardown complete");

      const events = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl")).map(
        (event) => event.event,
      );
      expect(events).toContain("merged");
      expect(events).toContain("combo_closed");
      expect(existsSync(combo.worktree)).toBe(false);
      expect(run("git", ["branch", "--list", combo.branch], { cwd: harness.repo }).stdout.trim()).toBe("");

      const tmuxLog = readJsonLines<LogEntryJson>(harness.logs.tmux);
      expect(tmuxLog).toContainEqual(
        expect.objectContaining({ args: ["kill-session", "-t", combo.tmuxSession] }),
      );
      expect(
        tmuxLog.some(
          (entry) =>
            entry.args[0] === "set-buffer" &&
            entry.args.includes(`combo-chen-nudge-${combo.tmuxSession}-reviewer`),
        ),
      ).toBe(false);

      passed = true;
    } finally {
      if (passed) {
        rmSync(harness.root, { recursive: true, force: true });
      } else {
        process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
      }
    }
  });

  it("closes a merged combo even when the tmux session already disappeared", () => {
    const harness = prepareHarness();
    let passed = false;

    try {
      const { combo, runDir } = launchPlanCombo(harness);
      journalPrOpened(runDir);
      run("tmux", ["kill-session", "-t", combo.tmuxSession], { cwd: harness.repo, env: harness.env });

      const closure = run(process.execPath, [cliPath, "closure", "-n", combo.id], {
        cwd: harness.repo,
        env: harness.env,
      });
      expect(closure.stdout).toContain("tmux session already gone");
      expect(
        readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl")).map((event) => event.event),
      ).toContain("combo_closed");

      passed = true;
    } finally {
      if (passed) rmSync(harness.root, { recursive: true, force: true });
      else process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
    }
  });

  it("escalates a known worker permission prompt without auto-approving it", () => {
    const harness = prepareHarness({ permissionPromptPolicy: "auto-approve-known-safe" });
    let passed = false;

    try {
      const { combo, runDir } = launchPlanCombo(harness);
      const headSha = run("git", ["rev-parse", "HEAD"], { cwd: combo.worktree }).stdout.trim();
      journalPrOpened(runDir);

      const tick = run(process.execPath, [cliPath, "director-tick", "-n", combo.id], {
        cwd: harness.repo,
        env: {
          ...harness.env,
          E2E_HEAD_SHA: headSha,
          E2E_PR_STATE: "OPEN",
          E2E_TMUX_CAPTURE_REVIEWER: "Do you want to proceed? [y/N]\n",
        },
      });

      expect(tick.stdout).toContain("director: worker reviewer permission prompt requested");
      const events = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl"));
      expect(events.some((event) => event.event === "needs_human")).toBe(true);

      const tmuxLog = readJsonLines<LogEntryJson>(harness.logs.tmux);
      expect(tmuxLog).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ args: ["send-keys", "-t", `${combo.tmuxSession}:reviewer`, "y", "C-m"] }),
        ]),
      );

      passed = true;
    } finally {
      if (passed) rmSync(harness.root, { recursive: true, force: true });
      else process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
    }
  });

  it("relaunches the capsule for a dead pre-PR coder, then escalates once the budget is exhausted", () => {
    const harness = prepareHarness({ workerRecoveryAttempts: 1 });
    let passed = false;

    try {
      const { combo, runDir } = launchPlanCombo(harness);
      appendEvent(runDir, "coder_started", {});

      const deadPane = ['{"success": false, "should_fully_stop": false}', "Run gnhf again to resume."].join(
        "\n",
      );
      const tickEnv = { ...harness.env, E2E_TMUX_CAPTURE_CODER: deadPane };

      const firstTick = run(process.execPath, [cliPath, "director-tick", "-n", combo.id], {
        cwd: harness.repo,
        env: tickEnv,
      });
      expect(firstTick.stdout).toContain(
        "director: coder dead (worker_dead); relaunched capsule sequencer attempt 1/1",
      );

      let events = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl"));
      expect(events).toContainEqual(
        expect.objectContaining({
          event: "worker_recovered",
          worker: "coder",
          reason: "worker_dead",
          attempt: 1,
          max_attempts: 1,
        }),
      );
      expect(events.some((event) => event.event === "needs_human")).toBe(false);

      const tmuxLog = readJsonLines<LogEntryJson>(harness.logs.tmux);
      expect(tmuxLog).toContainEqual(
        expect.objectContaining({ args: ["kill-window", "-t", `${combo.tmuxSession}:capsule`] }),
      );
      const capsuleWindow = tmuxLog.find(
        (entry) => entry.args[0] === "new-window" && entry.args.includes("capsule"),
      );
      expect(capsuleWindow).toBeDefined();
      expect(capsuleWindow!.args.at(-1)).toContain(" capsule ");
      expect(capsuleWindow!.args.at(-1)).not.toContain("runner.sh");

      const secondTick = run(process.execPath, [cliPath, "director-tick", "-n", combo.id], {
        cwd: harness.repo,
        env: tickEnv,
      });
      expect(secondTick.stdout).toContain("recovery attempts exhausted after 1");

      events = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl"));
      expect(events).toContainEqual(
        expect.objectContaining({
          event: "needs_human",
          reason: "worker_dead",
          worker: "coder",
        }),
      );

      passed = true;
    } finally {
      if (passed) rmSync(harness.root, { recursive: true, force: true });
      else process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
    }
  });

  it("does not flag the coder as stalled when gnhf log shows recent activity", () => {
    const harness = prepareHarness();
    let passed = false;

    try {
      const { combo, runDir } = launchPlanCombo(harness);
      appendEvent(runDir, "coder_started", {});

      const gnhfRunsDir = join(combo.worktree, ".gnhf", "runs", "e2e-ghnf-alive");
      mkdirSync(gnhfRunsDir, { recursive: true });
      writeFileSync(join(gnhfRunsDir, "gnhf.log"), '{"event":"iteration:start","iteration":3}\n');

      const gnhfPane = ["22:00:00  ·  15.2M in  ·  45K out  ·  0 commits", "iteration 3  working..."].join(
        "\n",
      );

      const tickEnv = { ...harness.env, E2E_TMUX_CAPTURE_CODER: gnhfPane };

      for (let i = 0; i < 3; i += 1) {
        const tick = run(process.execPath, [cliPath, "director-tick", "-n", combo.id], {
          cwd: harness.repo,
          env: tickEnv,
        });
        if (i === 2) {
          expect(tick.stdout).toContain("gnhf is actively progressing");
          expect(tick.stdout).not.toContain("worker_stalled");
        }
      }

      const events = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl"));
      expect(events.some((e) => e.event === "needs_human" && e["reason"] === "worker_stalled")).toBe(false);

      passed = true;
    } finally {
      if (passed) rmSync(harness.root, { recursive: true, force: true });
      else process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
    }
  });

  it(
    "flags an unchanged coder pane when the fresh gnhf log already ended",
    () => {
      const harness = prepareHarness({ workerStallTicks: 2 });
      let passed = false;

      try {
        const { combo, runDir } = launchPlanCombo(harness);
        appendEvent(runDir, "coder_started", {});

        const gnhfRunsDir = join(combo.worktree, ".gnhf", "runs", "e2e-gnhf-ended");
        mkdirSync(gnhfRunsDir, { recursive: true });
        writeFileSync(
          join(gnhfRunsDir, "gnhf.log"),
          [
            '{"event":"iteration:start","iteration":3}',
            '{"event":"orchestrator:end","status":"stopped","successCount":0}',
            "",
          ].join("\n"),
        );

        const gnhfPane = ["22:00:00  ·  15.2M in  ·  45K out  ·  0 commits", "iteration 3  working..."].join(
          "\n",
        );
        const tickEnv = { ...harness.env, E2E_TMUX_CAPTURE_CODER: gnhfPane };

        run(process.execPath, [cliPath, "director-tick", "-n", combo.id], {
          cwd: harness.repo,
          env: tickEnv,
        });
        const tick = run(process.execPath, [cliPath, "director-tick", "-n", combo.id], {
          cwd: harness.repo,
          env: tickEnv,
        });

        expect(tick.stdout).toContain("no orchestrator evidence");
        const events = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl"));
        expect(events).toContainEqual(
          expect.objectContaining({ event: "needs_human", reason: "worker_stalled", worker: "coder" }),
        );

        passed = true;
      } finally {
        if (passed) rmSync(harness.root, { recursive: true, force: true });
        else process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
      }
    },
    LIFECYCLE_TEST_TIMEOUT_MS,
  );
});
// -/ 2/3

// -- 3/3 HELPER · Harness and process shims --
function prepareHarness(options: HarnessOptions = {}): Harness {
  if (!existsSync(cliPath)) {
    throw new Error(`missing built CLI at ${cliPath}; run pnpm build before pnpm test:e2e`);
  }

  const tmpBase = join(repoRoot, ".tmp");
  mkdirSync(tmpBase, { recursive: true });
  const root = mkdtempSync(join(tmpBase, "e2e-treehouse-"));
  const bin = join(root, "bin");
  const comboHome = join(root, "combo-home");
  const xdgConfig = join(root, "xdg-config");
  const repo = join(root, "repo");
  const origin = join(root, "origin.git");
  const logs = {
    gh: join(root, "gh.jsonl"),
    noMistakes: join(root, "no-mistakes.jsonl"),
    treehouse: join(root, "treehouse.jsonl"),
    tmux: join(root, "tmux.jsonl"),
  };

  mkdirSync(bin, { recursive: true });
  mkdirSync(comboHome, { recursive: true });
  mkdirSync(xdgConfig, { recursive: true });
  mkdirSync(repo, { recursive: true });

  writeTreehouseShim(join(bin, "treehouse"));
  writeTmuxShim(join(bin, "tmux"));
  writeGhShim(join(bin, "gh"));
  writeNoMistakesShim(join(bin, "no-mistakes"));
  writeE2eCoderShim(join(bin, "e2e-coder"));
  writeRepoConfig(repo, options);
  writeNoMistakesConfig(repo);
  prepareGitRepo(repo, origin);

  const mergeSha = run("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.trim();
  return {
    root,
    repo,
    comboHome,
    workPlanExtra: options.workPlanExtra ?? [],
    logs,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      COMBO_CHEN_HOME: comboHome,
      XDG_CONFIG_HOME: xdgConfig,
      E2E_TREEHOUSE_LOG: logs.treehouse,
      E2E_TREEHOUSE_ROOT: join(repo, ".worktrees"),
      E2E_TMUX_LOG: logs.tmux,
      E2E_TMUX_STATE: join(root, "tmux-state.json"),
      E2E_GH_LOG: logs.gh,
      E2E_GH_STATE: join(root, "gh-state.json"),
      E2E_GH_MISSING_COMBO_LABELS_ON_FIRST_ADD: "0",
      E2E_MERGE_SHA: mergeSha,
      E2E_HEAD_SHA: mergeSha,
      E2E_PR_URL: "https://github.com/o/r/pull/1",
      E2E_TMUX_RUN_NEW_SESSION: options.executeRunner === true ? "1" : "0",
      E2E_TMUX_RUN_GATEKEEPER_WINDOW: options.executeGatekeeperWindows === true ? "1" : "0",
      E2E_NO_MISTAKES_ACTIVE: options.activeNoMistakes === true ? "1" : "0",
      TREEHOUSE_NO_UPDATE_CHECK: "1",
    },
  };
}

function prepareGitRepo(repo: string, origin: string): void {
  run("git", ["init", "--initial-branch=main"], { cwd: repo });
  run("git", ["config", "user.email", "combo-chen-e2e@example.invalid"], { cwd: repo });
  run("git", ["config", "user.name", "combo-chen e2e"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  run("git", ["add", "README.md", "combo-chen.toml", ".no-mistakes.yaml"], { cwd: repo });
  run("git", ["commit", "-m", "initial fixture"], { cwd: repo });
  run("git", ["init", "--bare", "--initial-branch=main", origin], { cwd: repo });
  run("git", ["remote", "add", "origin", origin], { cwd: repo });
  run("git", ["push", "-u", "origin", "main"], { cwd: repo });
  run("git", ["fetch", "origin", "main"], { cwd: repo });
}

function writeRepoConfig(repo: string, options: HarnessOptions): void {
  const coderRole = options.coderRole ?? "e2e-coder";
  const coderCommand = options.coderCommand ?? "e2e-coder";
  const coderResumeCommand = options.coderResumeCommand ?? "true";
  const monitorLines = [
    ...(options.workerStallTicks === undefined ? [] : [`worker_stall_ticks = ${options.workerStallTicks}`]),
    ...(options.workerRecoveryAttempts === undefined
      ? []
      : [`worker_recovery_attempts = ${options.workerRecoveryAttempts}`]),
    ...(options.permissionPromptPolicy === undefined
      ? []
      : [`permission_prompt_policy = ${JSON.stringify(options.permissionPromptPolicy)}`]),
  ];
  writeFileSync(
    join(repo, "combo-chen.toml"),
    [
      "[roles]",
      `coder = ${JSON.stringify(coderRole)}`,
      'reviewer = ["e2e-reviewer"]',
      "",
      ...(options.teamLines === undefined || options.teamLines.length === 0
        ? []
        : [...options.teamLines, ""]),
      `[coder.${coderRole}]`,
      `command = ${JSON.stringify(coderCommand)}`,
      `resume_command = ${JSON.stringify(coderResumeCommand)}`,
      "",
      "[reviewer.e2e-reviewer]",
      'command = "true"',
      "",
      "[director]",
      'command = "true"',
      "",
      "[gatekeeper]",
      'command = "true"',
      "",
      "[limits]",
      "babysit_poll_seconds = 1",
      "teardown_git_retries = 0",
      "teardown_git_backoff_seconds = 1",
      "watch_failure_limit = 1",
      "watch_backoff_max_seconds = 1",
      "",
      ...(monitorLines.length === 0 ? [] : ["[monitor]", ...monitorLines, ""]),
      "",
      "[run]",
      'source_branch = "main"',
      "",
    ].join("\n"),
  );
}

function writeNoMistakesConfig(repo: string): void {
  writeFileSync(
    join(repo, ".no-mistakes.yaml"),
    ["commands:", "  test: echo e2e", "  lint: echo e2e", "  build: echo e2e", ""].join("\n"),
  );
}

function writeTreehouseShim(path: string): void {
  installShim(path, "treehouse.mjs");
}

function writeTmuxShim(path: string): void {
  installShim(path, "tmux.mjs");
}

function writeGhShim(path: string): void {
  installShim(path, "gh.mjs");
}

function writeNoMistakesShim(path: string): void {
  installShim(path, "no-mistakes.mjs");
}

function writeE2eCoderShim(path: string): void {
  installShim(path, "e2e-coder.mjs");
}
// -/ 3/3
