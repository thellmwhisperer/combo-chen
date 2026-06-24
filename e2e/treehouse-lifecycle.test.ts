/**
 * @overview Hermetic end-to-end coverage for combo-chen's Treehouse-backed
 *   lifecycle. Uses the built CLI as a subprocess, real git repos/worktrees,
 *   and process shims for external services. ~1750 lines, log-derived regressions.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at the describe block     <- launch, journal PR, close.
 *   2. Then prepareHarness             <- temp repo, config, PATH isolation.
 *   3. Then fixture shims              <- process-boundary fakes copied into PATH.
 *
 *   MAIN FLOW
 *   ---------
 *   built CLI -> run plan -> Treehouse git worktree lease -> runner/gate regressions -> closure
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   command runner, temp repo/bootstrap helpers, fixture shim installer.
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

import { CODER_THREAD_ARTIFACT } from "../src/roles/coder.js";

// -- 1/3 HELPER · Command runner + JSON helpers --
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(repoRoot, "dist", "cli.mjs");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface Harness {
  root: string;
  repo: string;
  comboHome: string;
  env: NodeJS.ProcessEnv;
  logs: {
    gh: string;
    treehouse: string;
    tmux: string;
  };
}

interface HarnessOptions {
  executeRunner?: boolean;
  executeGatekeeperWindows?: boolean;
  activeNoMistakes?: boolean;
  activateNoMistakesOnAxiRun?: boolean;
  failNoMistakesAxiRun?: boolean;
  failNoMistakesAttach?: boolean;
  gatekeeperCommand?: string;
  gatekeeperAttachTimeoutSeconds?: number;
  externalCommentAgents?: string[];
  readyRequiredChecks?: string[];
  greenCheckNames?: string[];
  reviewerLogins?: string[];
  quoteNoMistakesRunId?: boolean;
  noMistakesRunDelayMs?: number;
  missingComboLabelsOnFirstAdd?: boolean;
  workerStallTicks?: number;
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
}

interface JournalEventJson {
  event: string;
  [key: string]: unknown;
}

interface LogEntryJson {
  cwd?: string;
  args: string[];
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
  });
  const runDir = singleRunDir(harness.comboHome);
  const combo = readJson<ComboRecordJson>(join(runDir, "combo.json"));
  return { combo, runDir, launch };
}

function writeCoderThreadArtifact(runDir: string): void {
  writeFileSync(
    join(runDir, CODER_THREAD_ARTIFACT),
    `${JSON.stringify({
      agent: "codex",
      thread_id: "019eeee0-0000-7000-8000-000000000001",
      source: ".gnhf/runs/e2e/iteration-1.jsonl",
    })}\n`,
  );
}
// -/ 1/3

// -- 2/3 CORE · Treehouse lifecycle E2E <- START HERE --
describe("treehouse-backed combo lifecycle e2e", () => {
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
      expect(run("git", ["branch", "--show-current"], { cwd: combo.worktree }).stdout.trim()).toBe(combo.branch);
      expect(run("git", ["worktree", "list", "--porcelain"], { cwd: harness.repo }).stdout).toContain(combo.worktree);

      const treehouseLaunchLog = readJsonLines<LogEntryJson>(harness.logs.treehouse);
      expect(treehouseLaunchLog).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ args: ["status"] }),
          expect.objectContaining({ args: ["get", "--lease", "--lease-holder", combo.id] }),
        ]),
      );

      const prUrl = "https://github.com/o/r/pull/1";
      run(process.execPath, [cliPath, "emit", "-n", combo.id, "pr_opened", "--field", `url=${prUrl}`], {
        cwd: harness.repo,
        env: harness.env,
      });
      expect(readJson<RuntimeLedgerJson>(join(runDir, "runtime-ledger.json")).prUrl).toBe(prUrl);

      const closure = run(process.execPath, [cliPath, "closure", "-n", combo.id], {
        cwd: harness.repo,
        env: harness.env,
      });
      expect(closure.stdout).toContain("teardown complete");

      const events = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl")).map((event) => event.event);
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
      expect(readJson<RuntimeLedgerJson>(join(runDir, "runtime-ledger.json")).worktree).toBe(combo.worktree);

      const tmuxLog = readJsonLines<LogEntryJson>(harness.logs.tmux);
      expect(tmuxLog).toContainEqual(expect.objectContaining({ args: ["kill-session", "-t", combo.tmuxSession] }));

      passed = true;
    } finally {
      if (passed) {
        rmSync(harness.root, { recursive: true, force: true });
      } else {
        process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
      }
    }
  });

  it("auto-closes a GitHub-merged combo from a director tick without a manual closure command", () => {
    const harness = prepareHarness();
    let passed = false;

    try {
      const { combo, runDir } = launchPlanCombo(harness);
      const prUrl = "https://github.com/o/r/pull/1";
      run(process.execPath, [cliPath, "emit", "-n", combo.id, "pr_opened", "--field", `url=${prUrl}`], {
        cwd: harness.repo,
        env: harness.env,
      });

      const tick = run(process.execPath, [cliPath, "director-tick", "-n", combo.id], {
        cwd: harness.repo,
        env: {
          ...harness.env,
          E2E_PR_STATE: "MERGED",
        },
      });

      expect(tick.stdout).toContain(`reviewer: merged ${harness.env.E2E_MERGE_SHA} by e2e-maintainer`);
      expect(tick.stdout).toContain(`closure: ${combo.id} closed merged PR ${harness.env.E2E_MERGE_SHA}`);

      const events = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl")).map((event) => event.event);
      expect(events).toContain("merged");
      expect(events).toContain("combo_closed");
      expect(existsSync(combo.worktree)).toBe(false);
      expect(run("git", ["branch", "--list", combo.branch], { cwd: harness.repo }).stdout.trim()).toBe("");

      const treehouseLog = readJsonLines<LogEntryJson>(harness.logs.treehouse);
      expect(treehouseLog).toContainEqual(
        expect.objectContaining({ args: ["return", "--force", combo.worktree] }),
      );
      expect(run("treehouse", ["status"], { cwd: harness.repo, env: harness.env }).stdout).toContain("treehouse ok");
      const status = run(process.execPath, [cliPath, "status", "--all"], {
        cwd: harness.repo,
        env: harness.env,
      });
      expect(status.stdout).toContain(combo.id);
      expect(status.stdout).toContain("STOPPED");

      const tmuxLog = readJsonLines<LogEntryJson>(harness.logs.tmux);
      expect(tmuxLog).toContainEqual(expect.objectContaining({ args: ["kill-session", "-t", combo.tmuxSession] }));

      passed = true;
    } finally {
      if (passed) {
        rmSync(harness.root, { recursive: true, force: true });
      } else {
        process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
      }
    }
  });

  it("resumes a GitHub-merged combo by converging closure instead of restarting review", () => {
    const harness = prepareHarness();
    let passed = false;

    try {
      const { combo, runDir } = launchPlanCombo(harness);
      const prUrl = "https://github.com/o/r/pull/1";
      run(process.execPath, [cliPath, "emit", "-n", combo.id, "pr_opened", "--field", `url=${prUrl}`], {
        cwd: harness.repo,
        env: harness.env,
      });

      const resume = run(process.execPath, [cliPath, "resume", "-n", combo.id], {
        cwd: harness.repo,
        env: { ...harness.env, E2E_TREEHOUSE_UNAVAILABLE_ON_RETURN: "1" },
      });
      expect(resume.stdout).toContain(`resume: closure pending for ${combo.id} (github); running closure`);
      expect(resume.stdout).toContain("teardown complete");

      const events = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl")).map((event) => event.event);
      expect(events).toContain("merged");
      expect(events).toContain("combo_closed");
      expect(existsSync(combo.worktree)).toBe(false);
      expect(run("git", ["branch", "--list", combo.branch], { cwd: harness.repo }).stdout.trim()).toBe("");

      const treehouseLog = readJsonLines<LogEntryJson>(harness.logs.treehouse);
      expect(treehouseLog).toContainEqual(
        expect.objectContaining({ args: ["return", "--force", combo.worktree] }),
      );
      const tmuxLog = readJsonLines<LogEntryJson>(harness.logs.tmux);
      expect(tmuxLog).toContainEqual(expect.objectContaining({ args: ["kill-session", "-t", combo.tmuxSession] }));
      expect(tmuxLog).not.toContainEqual(
        expect.objectContaining({ args: ["new-window", "-t", combo.tmuxSession, "-n", "reviewer", expect.any(String)] }),
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

  it("executes the generated runner and copies no-mistakes config into the active gate worktree", () => {
    const harness = prepareHarness({ executeRunner: true, activeNoMistakes: true });
    let passed = false;

    try {
      const { combo, launch, runDir } = launchPlanCombo(harness);
      expect(launch.stdout).toContain(combo.branch);

      const events = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl")).map((event) => event.event);
      expect(events).toEqual(
        expect.arrayContaining(["combo_created", "coder_started", "coder_done", "gate_started", "gate_status", "pr_opened"]),
      );
      expect(readJson<RuntimeLedgerJson>(join(runDir, "runtime-ledger.json")).prUrl).toBe(harness.env.E2E_PR_URL);
      const runner = readFileSync(join(runDir, "runner.sh"), "utf8");
      expect(runner).not.toContain("coder_log=");
      expect(runner).not.toContain("2>&1 | tee");
      expect(existsSync(join(runDir, "coder.log"))).toBe(false);

      const gateConfig = join(harness.root, "no-mistakes", "worktrees", "e2e", "e2e-run", ".no-mistakes.yaml");
      expect(readFileSync(gateConfig, "utf8")).toContain("commands:");
      expect(readFileSync(join(runDir, "gatekeeper.log"), "utf8")).toContain("copied .no-mistakes.yaml");

      const closure = run(process.execPath, [cliPath, "closure", "-n", combo.id], {
        cwd: harness.repo,
        env: harness.env,
      });
      expect(closure.stdout).toContain("teardown complete");
      expect(existsSync(combo.worktree)).toBe(false);

      passed = true;
    } finally {
      if (passed) rmSync(harness.root, { recursive: true, force: true });
      else process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
    }
  }, 15_000);

  it("resumes a broken combo when no-mistakes creates the run only after gate restart", () => {
    const harness = prepareHarness({
      activateNoMistakesOnAxiRun: true,
      gatekeeperCommand: "no-mistakes daemon start && no-mistakes axi run --intent e2e-resume",
      noMistakesRunDelayMs: 1200,
      quoteNoMistakesRunId: true,
    });
    let passed = false;

    try {
      const { combo, runDir } = launchPlanCombo(harness);
      const headSha = run("git", ["rev-parse", "HEAD"], { cwd: combo.worktree }).stdout.trim();

      const restart = run(process.execPath, [cliPath, "gate-restart", "-n", combo.id], {
        cwd: harness.repo,
        env: {
          ...harness.env,
          E2E_TMUX_RUN_GATEKEEPER_WINDOW: "1",
          COMBO_CHEN_GATEKEEPER_WINDOW_HOLD: "0",
          COMBO_CHEN_NO_MISTAKES_CONFIG_COPY_ATTEMPTS: "5",
        },
        timeoutMs: 10_000,
      });
      expect(restart.stdout).toContain(`initial gate restarted for ${combo.id}`);

      const gatekeeperLog = readFileSync(join(runDir, `gatekeeper-initial-${headSha.slice(0, 12)}.log`), "utf8");
      expect(gatekeeperLog).toContain("outcome: checks-passed");
      expect(gatekeeperLog).toContain("copied .no-mistakes.yaml");
      const gateConfig = join(harness.root, "no-mistakes", "worktrees", "e2e", "e2e-run", ".no-mistakes.yaml");
      expect(readFileSync(gateConfig, "utf8")).toContain("commands:");

      const events = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl")).map((event) => event.event);
      expect(events).toEqual(expect.arrayContaining(["gate_started", "gate_status", "pr_opened"]));
      expect(readJson<RuntimeLedgerJson>(join(runDir, "runtime-ledger.json")).prUrl).toBe(harness.env.E2E_PR_URL);

      passed = true;
    } finally {
      if (passed) rmSync(harness.root, { recursive: true, force: true });
      else process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
    }
  }, 15_000);

  it("recreates a missing tmux room before restarting the initial gate", () => {
    const harness = prepareHarness({
      activateNoMistakesOnAxiRun: true,
      gatekeeperCommand: "no-mistakes daemon start && no-mistakes axi run --intent e2e-resume",
      noMistakesRunDelayMs: 1200,
      quoteNoMistakesRunId: true,
    });
    let passed = false;

    try {
      const { combo, runDir } = launchPlanCombo(harness);
      const headSha = run("git", ["rev-parse", "HEAD"], { cwd: combo.worktree }).stdout.trim();
      run("tmux", ["kill-session", "-t", combo.tmuxSession], { cwd: harness.repo, env: harness.env });

      const restart = run(process.execPath, [cliPath, "gate-restart", "-n", combo.id], {
        cwd: harness.repo,
        env: {
          ...harness.env,
          E2E_TMUX_RUN_GATEKEEPER_WINDOW: "1",
          COMBO_CHEN_GATEKEEPER_WINDOW_HOLD: "0",
          COMBO_CHEN_NO_MISTAKES_CONFIG_COPY_ATTEMPTS: "5",
        },
        timeoutMs: 10_000,
      });
      expect(restart.stdout).toContain("recreated tmux session");
      expect(restart.stdout).toContain(`initial gate restarted for ${combo.id}`);

      const tmuxLog = readJsonLines<LogEntryJson>(harness.logs.tmux);
      expect(tmuxLog).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            args: [
              "new-session",
              "-d",
              "-s",
              combo.tmuxSession,
              "-n",
              "journal",
              expect.stringContaining("events --follow"),
            ],
          }),
          expect.objectContaining({
            args: [
              "new-window",
              "-t",
              combo.tmuxSession,
              "-n",
              "gatekeeper",
              expect.stringContaining("no-mistakes attach --run"),
            ],
          }),
        ]),
      );
      expect(tmuxLog).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ args: ["new-session", "-d", "-s", combo.tmuxSession, "-n", "coder", expect.stringContaining("events --follow")] }),
        ]),
      );

      const gatekeeperScript = readFileSync(join(runDir, `gatekeeper-initial-${headSha.slice(0, 12)}.sh`), "utf8");
      expect(gatekeeperScript).toContain('tee "$gatekeeper_log"');
      const gatekeeperLog = readFileSync(join(runDir, `gatekeeper-initial-${headSha.slice(0, 12)}.log`), "utf8");
      expect(gatekeeperLog).toContain("outcome: checks-passed");

      passed = true;
    } finally {
      if (passed) rmSync(harness.root, { recursive: true, force: true });
      else process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
    }
  }, 15_000);

  it("closes a merged combo even when the tmux session already disappeared", () => {
    const harness = prepareHarness();
    let passed = false;

    try {
      const { combo, runDir } = launchPlanCombo(harness);
      const prUrl = "https://github.com/o/r/pull/1";
      run(process.execPath, [cliPath, "emit", "-n", combo.id, "pr_opened", "--field", `url=${prUrl}`], {
        cwd: harness.repo,
        env: harness.env,
      });
      run("tmux", ["kill-session", "-t", combo.tmuxSession], { cwd: harness.repo, env: harness.env });

      const closure = run(process.execPath, [cliPath, "closure", "-n", combo.id], {
        cwd: harness.repo,
        env: harness.env,
      });
      expect(closure.stdout).toContain("tmux session already gone");
      expect(readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl")).map((event) => event.event)).toContain(
        "combo_closed",
      );

      passed = true;
    } finally {
      if (passed) rmSync(harness.root, { recursive: true, force: true });
      else process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
    }
  });

  it("recreates the gatekeeper window when gate_started follows an exited no-mistakes attach", () => {
    const harness = prepareHarness();
    let passed = false;

    try {
      const { combo } = launchPlanCombo(harness);
      run("tmux", ["kill-window", "-t", `${combo.tmuxSession}:gatekeeper`], { cwd: harness.repo, env: harness.env });
      const before = readJsonLines<LogEntryJson>(harness.logs.tmux).filter(
        (entry) => entry.args[0] === "new-window" && entry.args.includes("gatekeeper"),
      ).length;

      run(process.execPath, [cliPath, "emit", "-n", combo.id, "gate_started"], {
        cwd: harness.repo,
        env: harness.env,
      });

      const after = readJsonLines<LogEntryJson>(harness.logs.tmux).filter(
        (entry) => entry.args[0] === "new-window" && entry.args.includes("gatekeeper"),
      ).length;
      expect(after).toBe(before + 1);

      passed = true;
    } finally {
      if (passed) rmSync(harness.root, { recursive: true, force: true });
      else process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
    }
  });

  it("routes a new external review comment that arrives after READY", () => {
    const harness = prepareHarness({ externalCommentAgents: ["coderabbitai"] });
    let passed = false;

    try {
      const { combo, runDir } = launchPlanCombo(harness);
      writeCoderThreadArtifact(runDir);
      const prUrl = "https://github.com/o/r/pull/1";
      const headSha = run("git", ["rev-parse", "HEAD"], { cwd: combo.worktree }).stdout.trim();

      for (const [event, fields] of [
        ["pr_opened", [`url=${prUrl}`]],
        ["gate_status", ["state=idle", `head_sha=${headSha}`]],
        ["gate_validated", [`sha=${headSha}`]],
        ["lgtm", [`sha=${headSha}`]],
        ["ready_for_merge", [`sha=${headSha}`, `pr_url=${prUrl}`]],
      ] satisfies Array<[string, string[]]>) {
        run(process.execPath, [cliPath, "emit", "-n", combo.id, event, ...fields.flatMap((field) => ["--field", field])], {
          cwd: harness.repo,
          env: harness.env,
        });
      }

      const tick = run(process.execPath, [cliPath, "director-tick", "-n", combo.id], {
        cwd: harness.repo,
        env: {
          ...harness.env,
          E2E_HEAD_SHA: headSha,
          E2E_PR_STATE: "OPEN",
          E2E_CODERABBIT_REVIEW: "1",
        },
      });
      expect(tick.stdout).toContain("nudged https://github.com/o/r/pull/1#discussion_r1");

      const reviewEvents = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl")).filter(
        (event) => event.event === "review_comment",
      );
      expect(reviewEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            author: "coderabbitai[bot]",
            kind: "review_comment",
            url: "https://github.com/o/r/pull/1#discussion_r1",
            head_sha: headSha,
          }),
        ]),
      );

      const tmuxLog = readJsonLines<LogEntryJson>(harness.logs.tmux);
      expect(tmuxLog).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            args: [
              "paste-buffer",
              "-d",
              "-b",
              `combo-chen-nudge-${combo.tmuxSession}-coder-responding`,
              "-t",
              `${combo.tmuxSession}:coder-responding`,
            ],
          }),
          expect.objectContaining({ args: ["send-keys", "-t", `${combo.tmuxSession}:coder-responding`, "C-m"] }),
        ]),
      );

      passed = true;
    } finally {
      if (passed) rmSync(harness.root, { recursive: true, force: true });
      else process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
    }
  });

  it("does not mark READY when a required external review status was skipped", () => {
    const harness = prepareHarness({
      externalCommentAgents: ["coderabbitai"],
      readyRequiredChecks: ["CodeRabbit"],
      greenCheckNames: ["CodeRabbit"],
    });
    let passed = false;

    try {
      const { combo, runDir } = launchPlanCombo(harness);
      writeCoderThreadArtifact(runDir);
      const prUrl = "https://github.com/o/r/pull/1";
      const headSha = run("git", ["rev-parse", "HEAD"], { cwd: combo.worktree }).stdout.trim();

      for (const [event, fields] of [
        ["pr_opened", [`url=${prUrl}`]],
        ["gate_status", ["state=idle", `head_sha=${headSha}`]],
        ["gate_validated", [`sha=${headSha}`]],
        ["lgtm", [`sha=${headSha}`]],
      ] satisfies Array<[string, string[]]>) {
        run(process.execPath, [cliPath, "emit", "-n", combo.id, event, ...fields.flatMap((field) => ["--field", field])], {
          cwd: harness.repo,
          env: harness.env,
        });
      }

      const tick = run(process.execPath, [cliPath, "director-tick", "-n", combo.id], {
        cwd: harness.repo,
        env: {
          ...harness.env,
          E2E_HEAD_SHA: headSha,
          E2E_PR_STATE: "OPEN",
          E2E_CODERABBIT_SKIPPED_STATUS: "1",
        },
      });

      expect(tick.stdout).toContain("waiting for checks");
      expect(tick.stdout).toContain("ready=[pr:yes gate:yes reviewer:yes checks:no ci:yes]");

      const events = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl"));
      expect(events.some((event) => event.event === "ready_for_merge")).toBe(false);

      const ghState = readJson<{ prLabels: string[] }>(harness.env.E2E_GH_STATE!);
      expect(ghState.prLabels).not.toContain("combo:external-review-green");
      expect(ghState.prLabels).not.toContain("combo:ready");

      passed = true;
    } finally {
      if (passed) rmSync(harness.root, { recursive: true, force: true });
      else process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
    }
  });

  it("accepts current-head reviewer code 0 even when GitHub author differs from reviewer.logins", () => {
    const harness = prepareHarness({ reviewerLogins: ["trusted-reviewer"] });
    let passed = false;

    try {
      const { combo, runDir } = launchPlanCombo(harness);
      writeCoderThreadArtifact(runDir);
      const prUrl = "https://github.com/o/r/pull/1";
      const headSha = run("git", ["rev-parse", "HEAD"], { cwd: combo.worktree }).stdout.trim();

      for (const [event, fields] of [
        ["pr_opened", [`url=${prUrl}`]],
        ["gate_status", ["state=idle", `head_sha=${headSha}`]],
        ["gate_validated", [`sha=${headSha}`]],
      ] satisfies Array<[string, string[]]>) {
        run(process.execPath, [cliPath, "emit", "-n", combo.id, event, ...fields.flatMap((field) => ["--field", field])], {
          cwd: harness.repo,
          env: harness.env,
        });
      }

      const tick = run(process.execPath, [cliPath, "director-tick", "-n", combo.id], {
        cwd: harness.repo,
        env: {
          ...harness.env,
          E2E_HEAD_SHA: headSha,
          E2E_PR_STATE: "OPEN",
          E2E_REVIEWER_CODE0_LOGIN: "teseo",
        },
      });

      expect(tick.stdout).toContain(`reviewer: lgtm current at ${headSha}`);
      expect(tick.stdout).toContain("ready=[pr:yes gate:yes reviewer:yes");

      const events = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl"));
      expect(events).toContainEqual(expect.objectContaining({ event: "lgtm", sha: headSha }));
      expect(events.some((event) => event.event === "needs_human")).toBe(false);

      passed = true;
    } finally {
      if (passed) rmSync(harness.root, { recursive: true, force: true });
      else process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
    }
  });

  it("routes a reviewer code 1 verdict without treating retained coder and gatekeeper panes as active workers", () => {
    const harness = prepareHarness({ workerStallTicks: 2 });
    let passed = false;

    try {
      const { combo, runDir } = launchPlanCombo(harness);
      writeCoderThreadArtifact(runDir);
      const prUrl = "https://github.com/o/r/pull/1";
      const headSha = run("git", ["rev-parse", "HEAD"], { cwd: combo.worktree }).stdout.trim();

      for (const [event, fields] of [
        ["pr_opened", [`url=${prUrl}`]],
        ["gate_status", ["state=idle", `head_sha=${headSha}`]],
        ["gate_validated", [`sha=${headSha}`]],
      ] satisfies Array<[string, string[]]>) {
        run(process.execPath, [cliPath, "emit", "-n", combo.id, event, ...fields.flatMap((field) => ["--field", field])], {
          cwd: harness.repo,
          env: harness.env,
        });
      }
      for (const window of ["reviewer", "gatekeeper", "coder-responding"]) {
        run("tmux", ["new-window", "-t", combo.tmuxSession, "-n", window, "true"], {
          cwd: harness.repo,
          env: harness.env,
        });
      }

      const tick = run(process.execPath, [cliPath, "director-tick", "-n", combo.id], {
        cwd: harness.repo,
        env: {
          ...harness.env,
          COMBO_CHEN_WORKER_STALL_TICKS: "2",
          E2E_HEAD_SHA: headSha,
          E2E_PR_STATE: "OPEN",
          E2E_REVIEWER_CODE1: "1",
        },
      });
      expect(tick.stdout).not.toContain("director: worker coder:");
      expect(tick.stdout).not.toContain("director: worker gatekeeper:");
      expect(tick.stdout).toContain("nudged https://github.com/o/r/pull/1#pullrequestreview-reviewer-code-1");

      const events = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl"));
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "review_comment",
            author: "e2e-reviewer",
            kind: "review",
            url: "https://github.com/o/r/pull/1#pullrequestreview-reviewer-code-1",
            head_sha: headSha,
          }),
        ]),
      );
      expect(events.some((event) => event.event === "needs_human" && event["reason"] === "worker_stalled")).toBe(false);

      const tmuxLog = readJsonLines<LogEntryJson>(harness.logs.tmux);
      expect(tmuxLog).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ args: ["send-keys", "-t", `${combo.tmuxSession}:coder-responding`, "C-m"] }),
        ]),
      );

      passed = true;
    } finally {
      if (passed) rmSync(harness.root, { recursive: true, force: true });
      else process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
    }
  });

  it("escalates when gnhf reaches an unsuccessful terminal hold before PR opens", () => {
    const harness = prepareHarness();
    let passed = false;

    try {
      const { combo, runDir } = launchPlanCombo(harness);
      run(process.execPath, [cliPath, "emit", "-n", combo.id, "coder_started"], {
        cwd: harness.repo,
        env: harness.env,
      });
      writeFileSync(join(combo.worktree, "coder-output.txt"), "implemented\n");
      run("git", ["add", "coder-output.txt"], { cwd: combo.worktree });
      run("git", ["commit", "-m", "simulate coder local commits"], { cwd: combo.worktree });

      const gnhfPane = [
        "00:47:43  ·  21.8M in  ·  92K out  ·  7 commits",
        '{"success":false,"summary":"The branch already contains commits, and GitHub has no PR yet."}',
        "[ctrl+c to stop, gnhf again to resume]",
        "",
      ].join("\n");

      const tick = run(process.execPath, [cliPath, "director-tick", "-n", combo.id], {
        cwd: harness.repo,
        env: {
          ...harness.env,
          E2E_TMUX_CAPTURE_CODER: gnhfPane,
        },
      });

      expect(tick.stdout).toContain("director: worker coder gnhf stopped without success");
      const events = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl"));
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "needs_human",
            reason: "worker_stalled",
            worker: "coder",
          }),
        ]),
      );
      expect(events.find((event) => event.event === "needs_human" && event["worker"] === "coder")).toMatchObject({
        detail: expect.stringContaining("gnhf stopped without success"),
      });

      passed = true;
    } finally {
      if (passed) rmSync(harness.root, { recursive: true, force: true });
      else process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
    }
  });

  it("starts a post-address gate after coder commits fixes for routed external comments", () => {
    const harness = prepareHarness({ externalCommentAgents: ["coderabbitai"] });
    let passed = false;

    try {
      const { combo, runDir } = launchPlanCombo(harness);
      writeCoderThreadArtifact(runDir);
      const prUrl = "https://github.com/o/r/pull/1";
      const publishedSha = run("git", ["rev-parse", "HEAD"], { cwd: combo.worktree }).stdout.trim();

      for (const [event, fields] of [
        ["pr_opened", [`url=${prUrl}`]],
        ["gate_status", ["state=idle", `head_sha=${publishedSha}`]],
        ["gate_validated", [`sha=${publishedSha}`]],
        ["lgtm", [`sha=${publishedSha}`]],
        ["ready_for_merge", [`sha=${publishedSha}`, `pr_url=${prUrl}`]],
      ] satisfies Array<[string, string[]]>) {
        run(process.execPath, [cliPath, "emit", "-n", combo.id, event, ...fields.flatMap((field) => ["--field", field])], {
          cwd: harness.repo,
          env: harness.env,
        });
      }

      writeFileSync(join(combo.worktree, "coderabbit-fix.txt"), "addressed\n");
      run("git", ["add", "coderabbit-fix.txt"], { cwd: combo.worktree });
      run("git", ["commit", "-m", "fix: address external review"], { cwd: combo.worktree });
      const localSha = run("git", ["rev-parse", "HEAD"], { cwd: combo.worktree }).stdout.trim();
      expect(localSha).not.toBe(publishedSha);

      const before = readJsonLines<LogEntryJson>(harness.logs.tmux).filter(
        (entry) => entry.args[0] === "new-window" && entry.args.includes("gatekeeper"),
      ).length;
      const tick = run(process.execPath, [cliPath, "director-tick", "-n", combo.id], {
        cwd: harness.repo,
        env: {
          ...harness.env,
          E2E_HEAD_SHA: publishedSha,
          E2E_PR_STATE: "OPEN",
          E2E_CODERABBIT_REVIEW: "1",
        },
      });

      expect(tick.stdout).toContain("nudged https://github.com/o/r/pull/1#discussion_r1");
      expect(tick.stdout).toContain(`director: post-address gate started for ${combo.id} at ${localSha}`);
      expect(tick.stdout).not.toContain("director: no coder HEAD change");

      const events = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl"));
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "review_comment",
            kind: "review_comment",
            url: "https://github.com/o/r/pull/1#discussion_r1",
            head_sha: publishedSha,
          }),
          expect.objectContaining({ event: "address_done", head_sha: localSha }),
          expect.objectContaining({ event: "gate_stale", old_sha: publishedSha, new_sha: localSha }),
        ]),
      );

      const after = readJsonLines<LogEntryJson>(harness.logs.tmux).filter(
        (entry) => entry.args[0] === "new-window" && entry.args.includes("gatekeeper"),
      ).length;
      expect(after).toBe(before + 1);
      expect(existsSync(join(runDir, `gatekeeper-post-${localSha.slice(0, 12)}.sh`))).toBe(true);

      passed = true;
    } finally {
      if (passed) rmSync(harness.root, { recursive: true, force: true });
      else process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
    }
  });

  it("surfaces a failed post-address gate without waiting for the attach timeout", () => {
    const harness = prepareHarness({
      activateNoMistakesOnAxiRun: true,
      externalCommentAgents: ["coderabbitai"],
      failNoMistakesAttach: true,
      failNoMistakesAxiRun: true,
      gatekeeperAttachTimeoutSeconds: 5,
      gatekeeperCommand: "no-mistakes daemon start && no-mistakes axi run --intent e2e-post-address",
      noMistakesRunDelayMs: 1200,
    });
    let passed = false;

    try {
      const { combo, runDir } = launchPlanCombo(harness);
      writeCoderThreadArtifact(runDir);
      const prUrl = "https://github.com/o/r/pull/1";
      const publishedSha = run("git", ["rev-parse", "HEAD"], { cwd: combo.worktree }).stdout.trim();

      for (const [event, fields] of [
        ["pr_opened", [`url=${prUrl}`]],
        ["gate_status", ["state=idle", `head_sha=${publishedSha}`]],
        ["gate_validated", [`sha=${publishedSha}`]],
        ["lgtm", [`sha=${publishedSha}`]],
        ["ready_for_merge", [`sha=${publishedSha}`, `pr_url=${prUrl}`]],
      ] satisfies Array<[string, string[]]>) {
        run(process.execPath, [cliPath, "emit", "-n", combo.id, event, ...fields.flatMap((field) => ["--field", field])], {
          cwd: harness.repo,
          env: harness.env,
        });
      }

      writeFileSync(join(combo.worktree, "coderabbit-parser-fix.txt"), "addressed\n");
      run("git", ["add", "coderabbit-parser-fix.txt"], { cwd: combo.worktree });
      run("git", ["commit", "-m", "fix: address parser review"], { cwd: combo.worktree });
      const localSha = run("git", ["rev-parse", "HEAD"], { cwd: combo.worktree }).stdout.trim();

      run(process.execPath, [cliPath, "director-tick", "-n", combo.id], {
        cwd: harness.repo,
        env: {
          ...harness.env,
          E2E_HEAD_SHA: publishedSha,
          E2E_PR_STATE: "OPEN",
          E2E_CODERABBIT_REVIEW: "1",
        },
      });

      const tmuxLog = readJsonLines<LogEntryJson>(harness.logs.tmux);
      const gatekeeperWindowCommand = tmuxLog
        .filter((entry) => entry.args[0] === "new-window" && entry.args.includes("gatekeeper"))
        .at(-1)?.args.at(-1);
      expect(gatekeeperWindowCommand).toBeDefined();

      const pane = spawnSync("sh", ["-c", gatekeeperWindowCommand!], {
        cwd: harness.repo,
        env: {
          ...harness.env,
          COMBO_CHEN_GATEKEEPER_WINDOW_HOLD: "0",
        },
        encoding: "utf8",
        timeout: 15_000,
      });
      const paneOutput = `${pane.stdout ?? ""}\n${pane.stderr ?? ""}`;

      expect(pane.status).toBe(1);
      expect(paneOutput).toContain("gatekeeper-attach: gate script finished before attach became available");
      expect(paneOutput).toContain("JSON output findings[1].action must match one of the allowed values");
      expect(paneOutput).not.toContain("gatekeeper-attach: timed out");

      const events = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl"));
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "gate_status", state: "failed", head_sha: localSha }),
          expect.objectContaining({ event: "gate_failed", reason: "gate_failed" }),
        ]),
      );

      passed = true;
    } finally {
      if (passed) rmSync(harness.root, { recursive: true, force: true });
      else process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
    }
  }, 15_000);

  it("routes local sync recovery instead of post-address gating from a worktree behind the PR head", () => {
    const harness = prepareHarness({ externalCommentAgents: ["coderabbitai"] });
    let passed = false;

    try {
      const { combo, runDir } = launchPlanCombo(harness);
      writeCoderThreadArtifact(runDir);
      const prUrl = "https://github.com/o/r/pull/1";
      const localSha = run("git", ["rev-parse", "HEAD"], { cwd: combo.worktree }).stdout.trim();

      writeFileSync(join(combo.worktree, "published-only.txt"), "published\n");
      run("git", ["add", "published-only.txt"], { cwd: combo.worktree });
      run("git", ["commit", "-m", "test: published pr head"], { cwd: combo.worktree });
      const publishedSha = run("git", ["rev-parse", "HEAD"], { cwd: combo.worktree }).stdout.trim();
      expect(publishedSha).not.toBe(localSha);
      run("git", ["reset", "--hard", localSha], { cwd: combo.worktree });
      expect(run("git", ["rev-parse", "HEAD"], { cwd: combo.worktree }).stdout.trim()).toBe(localSha);

      for (const [event, fields] of [
        ["pr_opened", [`url=${prUrl}`]],
        ["gate_status", ["state=idle", `head_sha=${publishedSha}`]],
        ["gate_validated", [`sha=${publishedSha}`]],
        ["lgtm", [`sha=${publishedSha}`]],
        ["ready_for_merge", [`sha=${publishedSha}`, `pr_url=${prUrl}`]],
      ] satisfies Array<[string, string[]]>) {
        run(process.execPath, [cliPath, "emit", "-n", combo.id, event, ...fields.flatMap((field) => ["--field", field])], {
          cwd: harness.repo,
          env: harness.env,
        });
      }

      const before = readJsonLines<LogEntryJson>(harness.logs.tmux).filter(
        (entry) => entry.args[0] === "new-window" && entry.args.includes("gatekeeper"),
      ).length;
      const tick = run(process.execPath, [cliPath, "director-tick", "-n", combo.id], {
        cwd: harness.repo,
        env: {
          ...harness.env,
          E2E_HEAD_SHA: publishedSha,
          E2E_PR_STATE: "OPEN",
          E2E_CODERABBIT_REVIEW: "1",
        },
      });

      expect(tick.stdout).toContain("nudged https://github.com/o/r/pull/1#discussion_r1");
      expect(tick.stdout).toContain(
        `director: worktree HEAD ${localSha} does not include published gate ${publishedSha}; waiting for coder sync before post-address gate`,
      );
      expect(tick.stdout).toContain(
        `director: local worktree ${localSha} does not include published gate ${publishedSha}; action rebase_required`,
      );
      expect(tick.stdout).not.toContain("director: post-address gate started");

      const events = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl"));
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "review_comment",
            kind: "review_comment",
            url: "https://github.com/o/r/pull/1#discussion_r1",
            head_sha: publishedSha,
          }),
          expect.objectContaining({
            event: "pr_conflict",
            sha: localSha,
            published_sha: publishedSha,
            local_sha: localSha,
            pr_url: prUrl,
            merge_state: "LOCAL_OUT_OF_SYNC",
            action: "rebase_required",
            source: "local_worktree",
          }),
        ]),
      );
      expect(events.some((event) => event.event === "address_done")).toBe(false);
      expect(events.some((event) => event.event === "gate_stale")).toBe(false);

      const syncPrompt = readJsonLines<LogEntryJson>(harness.logs.tmux).find(
        (entry) =>
          entry.args[0] === "set-buffer" &&
          typeof entry.args.at(-1) === "string" &&
          entry.args.at(-1)?.includes("Local PR head sync recovery for coder responding mode"),
      );
      expect(syncPrompt?.args.at(-1)).toContain(`published_gate: ${publishedSha}`);
      expect(syncPrompt?.args.at(-1)).toContain(`local_head: ${localSha}`);

      const afterTick = readJsonLines<LogEntryJson>(harness.logs.tmux).filter(
        (entry) => entry.args[0] === "new-window" && entry.args.includes("gatekeeper"),
      ).length;
      expect(afterTick).toBe(before);
      expect(existsSync(join(runDir, `gatekeeper-post-${localSha.slice(0, 12)}.sh`))).toBe(false);

      const restart = run(process.execPath, [cliPath, "gate-restart", "-n", combo.id], {
        cwd: harness.repo,
        env: harness.env,
      });
      expect(restart.stdout).toContain("coder_worktree_out_of_sync");
      expect(restart.stdout).toContain(`does not include published gate ${publishedSha}`);
      const afterRestart = readJsonLines<LogEntryJson>(harness.logs.tmux).filter(
        (entry) => entry.args[0] === "new-window" && entry.args.includes("gatekeeper"),
      ).length;
      expect(afterRestart).toBe(before);
      expect(existsSync(join(runDir, `gatekeeper-post-${localSha.slice(0, 12)}.sh`))).toBe(false);

      passed = true;
    } finally {
      if (passed) rmSync(harness.root, { recursive: true, force: true });
      else process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
    }
  });

  it("removes stale READY labels while a newer local addressed head is in gate", () => {
    const harness = prepareHarness({ greenCheckNames: ["ExternalReview"] });
    let passed = false;

    try {
      const { combo, runDir } = launchPlanCombo(harness);
      const prUrl = "https://github.com/o/r/pull/1";
      const publishedSha = run("git", ["rev-parse", "HEAD"], { cwd: combo.worktree }).stdout.trim();

      writeFileSync(join(combo.worktree, "label-fix.txt"), "addressed\n");
      run("git", ["add", "label-fix.txt"], { cwd: combo.worktree });
      run("git", ["commit", "-m", "fix: addressed local head"], { cwd: combo.worktree });
      const localSha = run("git", ["rev-parse", "HEAD"], { cwd: combo.worktree }).stdout.trim();
      expect(localSha).not.toBe(publishedSha);

      writeFileSync(
        harness.env.E2E_GH_STATE!,
        `${JSON.stringify({
          prLabels: ["combo:working-gate", "combo:lgtm", "combo:external-review-green", "combo:ready"],
          knownLabels: ["combo:working-gate", "combo:lgtm", "combo:external-review-green", "combo:ready", "combo:stale"],
          failedMissingLabelAdd: false,
        }, null, 2)}\n`,
      );

      for (const [event, fields] of [
        ["pr_opened", [`url=${prUrl}`]],
        ["gate_status", ["state=idle", `head_sha=${publishedSha}`]],
        ["gate_validated", [`sha=${publishedSha}`]],
        ["lgtm", [`sha=${publishedSha}`]],
        ["ready_for_merge", [`sha=${publishedSha}`, `pr_url=${prUrl}`]],
        ["review_comment", [
          "author=coderabbitai[bot]",
          "kind=review_comment",
          "url=https://github.com/o/r/pull/1#discussion_r1",
          `head_sha=${publishedSha}`,
        ]],
        ["address_done", [`head_sha=${localSha}`]],
        ["gate_stale", [`old_sha=${publishedSha}`, `new_sha=${localSha}`]],
        ["gate_started", []],
        ["gate_status", ["state=fix_inflight", `head_sha=${localSha}`]],
      ] satisfies Array<[string, string[]]>) {
        run(process.execPath, [cliPath, "emit", "-n", combo.id, event, ...fields.flatMap((field) => ["--field", field])], {
          cwd: harness.repo,
          env: harness.env,
        });
      }

      const tick = run(process.execPath, [cliPath, "director-tick", "-n", combo.id], {
        cwd: harness.repo,
        env: {
          ...harness.env,
          E2E_HEAD_SHA: publishedSha,
          E2E_PR_STATE: "OPEN",
        },
      });

      expect(tick.stdout).toContain("gate already in flight");
      const ghState = readJson<{ prLabels: string[] }>(harness.env.E2E_GH_STATE!);
      expect(ghState.prLabels).toEqual(["combo:working-gate", "combo:stale"]);

      const ghLog = readJsonLines<LogEntryJson>(harness.logs.gh);
      expect(ghLog).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            args: ["pr", "edit", prUrl, "--remove-label", "combo:lgtm,combo:external-review-green,combo:ready"],
          }),
          expect.objectContaining({
            args: ["pr", "edit", prUrl, "--add-label", "combo:stale"],
          }),
        ]),
      );

      const labelEvents = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl")).filter(
        (event) => event.event === "pr_labels_updated",
      );
      expect(labelEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pr_url: prUrl,
            head_sha: publishedSha,
            removed_labels: ["combo:lgtm", "combo:external-review-green", "combo:ready"],
            reason: "stale",
            source: "director-watch",
          }),
          expect.objectContaining({
            pr_url: prUrl,
            head_sha: publishedSha,
            added_labels: ["combo:stale"],
            reason: "stale",
            source: "director-watch",
          }),
        ]),
      );

      passed = true;
    } finally {
      if (passed) rmSync(harness.root, { recursive: true, force: true });
      else process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
    }
  });

  it("keeps the coder owner label with stale after a newer local addressed head fails gate", () => {
    const harness = prepareHarness({ greenCheckNames: ["ExternalReview"] });
    let passed = false;

    try {
      const { combo, runDir } = launchPlanCombo(harness);
      const prUrl = "https://github.com/o/r/pull/1";
      const publishedSha = run("git", ["rev-parse", "HEAD"], { cwd: combo.worktree }).stdout.trim();

      writeFileSync(join(combo.worktree, "label-failed-gate-fix.txt"), "addressed\n");
      run("git", ["add", "label-failed-gate-fix.txt"], { cwd: combo.worktree });
      run("git", ["commit", "-m", "fix: addressed local head before failed gate"], { cwd: combo.worktree });
      const localSha = run("git", ["rev-parse", "HEAD"], { cwd: combo.worktree }).stdout.trim();
      expect(localSha).not.toBe(publishedSha);

      writeFileSync(
        harness.env.E2E_GH_STATE!,
        `${JSON.stringify({
          prLabels: ["combo:stale"],
          knownLabels: ["combo:working-coder", "combo:stale"],
          failedMissingLabelAdd: false,
        }, null, 2)}\n`,
      );

      for (const [event, fields] of [
        ["pr_opened", [`url=${prUrl}`]],
        ["gate_status", ["state=idle", `head_sha=${publishedSha}`]],
        ["gate_validated", [`sha=${publishedSha}`]],
        ["lgtm", [`sha=${publishedSha}`]],
        ["ready_for_merge", [`sha=${publishedSha}`, `pr_url=${prUrl}`]],
        ["review_comment", [
          "author=teseo",
          "kind=review",
          "url=https://github.com/o/r/pull/1#pullrequestreview-code-1",
          `head_sha=${publishedSha}`,
        ]],
        ["address_done", [`head_sha=${localSha}`]],
        ["gate_stale", [`old_sha=${publishedSha}`, `new_sha=${localSha}`]],
        ["gate_started", []],
        ["gate_status", ["state=fix_inflight", `head_sha=${localSha}`]],
        ["gate_status", ["state=failed", `head_sha=${localSha}`]],
        ["gate_failed", ["exit_code=1", "reason=gate_failed"]],
      ] satisfies Array<[string, string[]]>) {
        run(process.execPath, [cliPath, "emit", "-n", combo.id, event, ...fields.flatMap((field) => ["--field", field])], {
          cwd: harness.repo,
          env: harness.env,
        });
      }

      const tick = run(process.execPath, [cliPath, "director-tick", "-n", combo.id], {
        cwd: harness.repo,
        env: {
          ...harness.env,
          E2E_HEAD_SHA: publishedSha,
          E2E_PR_STATE: "OPEN",
        },
      });

      expect(tick.stdout).toContain("post-address gate already failed");
      const ghState = readJson<{ prLabels: string[] }>(harness.env.E2E_GH_STATE!);
      expect(ghState.prLabels).toEqual(["combo:stale", "combo:working-coder"]);

      const ghLog = readJsonLines<LogEntryJson>(harness.logs.gh);
      expect(ghLog).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            args: ["pr", "edit", prUrl, "--add-label", "combo:working-coder"],
          }),
        ]),
      );

      const labelEvents = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl")).filter(
        (event) => event.event === "pr_labels_updated",
      );
      expect(labelEvents).toEqual([
        expect.objectContaining({
          pr_url: prUrl,
          head_sha: publishedSha,
          old_labels: ["combo:stale"],
          new_labels: ["combo:stale", "combo:working-coder"],
          added_labels: ["combo:working-coder"],
          removed_labels: [],
          reason: "stale",
          source: "director-watch",
        }),
      ]);

      passed = true;
    } finally {
      if (passed) rmSync(harness.root, { recursive: true, force: true });
      else process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
    }
  });

  it("removes retained worker labels when READY is current at the PR head", () => {
    const harness = prepareHarness();
    let passed = false;

    try {
      const { combo, runDir } = launchPlanCombo(harness);
      const prUrl = "https://github.com/o/r/pull/1";
      const headSha = run("git", ["rev-parse", "HEAD"], { cwd: combo.worktree }).stdout.trim();

      writeFileSync(
        harness.env.E2E_GH_STATE!,
        `${JSON.stringify({
          prLabels: ["combo:working-reviewer", "combo:lgtm", "combo:ready"],
          knownLabels: ["combo:working-reviewer", "combo:lgtm", "combo:ready"],
          failedMissingLabelAdd: false,
        }, null, 2)}\n`,
      );

      for (const [event, fields] of [
        ["pr_opened", [`url=${prUrl}`]],
        ["gate_status", ["state=idle", `head_sha=${headSha}`]],
        ["gate_validated", [`sha=${headSha}`]],
        ["lgtm", [`sha=${headSha}`]],
        ["ready_for_merge", [`sha=${headSha}`, `pr_url=${prUrl}`]],
      ] satisfies Array<[string, string[]]>) {
        run(process.execPath, [cliPath, "emit", "-n", combo.id, event, ...fields.flatMap((field) => ["--field", field])], {
          cwd: harness.repo,
          env: harness.env,
        });
      }

      run("tmux", ["new-window", "-t", combo.tmuxSession, "-n", "reviewer", "true"], {
        cwd: harness.repo,
        env: harness.env,
      });

      const tick = run(process.execPath, [cliPath, "director-tick", "-n", combo.id], {
        cwd: harness.repo,
        env: {
          ...harness.env,
          E2E_HEAD_SHA: headSha,
          E2E_PR_STATE: "OPEN",
        },
      });

      expect(tick.stdout).toContain("action=\"waiting for human merge\"");
      const ghState = readJson<{ prLabels: string[] }>(harness.env.E2E_GH_STATE!);
      expect(ghState.prLabels).toEqual(["combo:lgtm", "combo:ready"]);

      const ghLog = readJsonLines<LogEntryJson>(harness.logs.gh);
      expect(ghLog).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            args: ["pr", "edit", prUrl, "--remove-label", "combo:working-reviewer"],
          }),
        ]),
      );

      const labelEvents = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl")).filter(
        (event) => event.event === "pr_labels_updated",
      );
      expect(labelEvents).toEqual([
        expect.objectContaining({
          pr_url: prUrl,
          head_sha: headSha,
          old_labels: ["combo:working-reviewer", "combo:lgtm", "combo:ready"],
          new_labels: ["combo:lgtm", "combo:ready"],
          added_labels: [],
          removed_labels: ["combo:working-reviewer"],
          reason: "current",
          source: "director-watch",
        }),
      ]);

      passed = true;
    } finally {
      if (passed) rmSync(harness.root, { recursive: true, force: true });
      else process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
    }
  });

  it("provisions missing combo labels during director-watch label sync", () => {
    const harness = prepareHarness({ missingComboLabelsOnFirstAdd: true });
    let passed = false;

    try {
      const { combo, runDir } = launchPlanCombo(harness);
      const prUrl = "https://github.com/o/r/pull/1";
      const headSha = run("git", ["rev-parse", "HEAD"], { cwd: combo.worktree }).stdout.trim();

      for (const [event, fields] of [
        ["pr_opened", [`url=${prUrl}`]],
        ["gate_started", []],
      ] satisfies Array<[string, string[]]>) {
        run(process.execPath, [cliPath, "emit", "-n", combo.id, event, ...fields.flatMap((field) => ["--field", field])], {
          cwd: harness.repo,
          env: harness.env,
        });
      }

      const tick = run(process.execPath, [cliPath, "director-tick", "-n", combo.id], {
        cwd: harness.repo,
        env: {
          ...harness.env,
          E2E_HEAD_SHA: headSha,
          E2E_PR_STATE: "OPEN",
        },
      });

      expect(tick.stdout).toContain('action="waiting for current-head gate"');
      expect(tick.stdout).not.toContain("PR label sync failed");

      const ghLog = readJsonLines<LogEntryJson>(harness.logs.gh);
      expect(ghLog).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            args: ["pr", "edit", prUrl, "--add-label", "combo:working-gate"],
          }),
          expect.objectContaining({
            args: [
              "label",
              "create",
              "combo:working-gate",
              "--color",
              "FBCA04",
              "--description",
              "Combo gatekeeper is validating or is the current active worker.",
              "--force",
              "--repo",
              "o/r",
            ],
          }),
        ]),
      );

      const labelEvents = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl")).filter(
        (event) => event.event === "pr_labels_updated",
      );
      expect(labelEvents).toEqual([
        expect.objectContaining({
          pr_url: prUrl,
          head_sha: headSha,
          old_labels: [],
          new_labels: ["combo:working-gate"],
          added_labels: ["combo:working-gate"],
          removed_labels: [],
          reason: "current",
          source: "director-watch",
        }),
      ]);

      passed = true;
    } finally {
      if (passed) rmSync(harness.root, { recursive: true, force: true });
      else process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
    }
  });

  it("does not re-add working-gate from a retained idle gatekeeper window", () => {
    const harness = prepareHarness();
    let passed = false;

    try {
      const { combo, runDir } = launchPlanCombo(harness);
      const prUrl = "https://github.com/o/r/pull/1";
      const publishedSha = run("git", ["rev-parse", "HEAD"], { cwd: combo.worktree }).stdout.trim();

      writeFileSync(join(combo.worktree, "published-after-gate.txt"), "published\n");
      run("git", ["add", "published-after-gate.txt"], { cwd: combo.worktree });
      run("git", ["commit", "-m", "fix: published after gate"], { cwd: combo.worktree });
      const prHeadSha = run("git", ["rev-parse", "HEAD"], { cwd: combo.worktree }).stdout.trim();
      expect(prHeadSha).not.toBe(publishedSha);

      writeFileSync(
        harness.env.E2E_GH_STATE!,
        `${JSON.stringify({
          prLabels: ["combo:stale"],
          knownLabels: ["combo:working-gate", "combo:stale"],
          failedMissingLabelAdd: false,
        }, null, 2)}\n`,
      );

      for (const [event, fields] of [
        ["pr_opened", [`url=${prUrl}`]],
        ["gate_started", []],
        ["gate_status", ["state=idle", `head_sha=${publishedSha}`]],
        ["gate_validated", [`sha=${publishedSha}`]],
      ] satisfies Array<[string, string[]]>) {
        run(process.execPath, [cliPath, "emit", "-n", combo.id, event, ...fields.flatMap((field) => ["--field", field])], {
          cwd: harness.repo,
          env: harness.env,
        });
      }

      const tick = run(process.execPath, [cliPath, "director-tick", "-n", combo.id], {
        cwd: harness.repo,
        env: {
          ...harness.env,
          E2E_HEAD_SHA: prHeadSha,
          E2E_PR_STATE: "OPEN",
        },
      });

      expect(tick.stdout).toContain("waiting for current-head gate");
      const ghState = readJson<{ prLabels: string[] }>(harness.env.E2E_GH_STATE!);
      expect(ghState.prLabels).toEqual(["combo:stale"]);

      const ghLog = readJsonLines<LogEntryJson>(harness.logs.gh);
      expect(ghLog).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            args: ["pr", "edit", prUrl, "--add-label", "combo:working-gate"],
          }),
        ]),
      );

      const labelEvents = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl")).filter(
        (event) => event.event === "pr_labels_updated",
      );
      expect(labelEvents).toEqual([]);

      passed = true;
    } finally {
      if (passed) rmSync(harness.root, { recursive: true, force: true });
      else process.stderr.write(`kept failing e2e harness at ${harness.root}\n`);
    }
  });
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
  const noMistakesRoot = join(root, "no-mistakes");
  const logs = {
    gh: join(root, "gh.jsonl"),
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
      E2E_GH_MISSING_COMBO_LABELS_ON_FIRST_ADD: options.missingComboLabelsOnFirstAdd === true ? "1" : "0",
      E2E_MERGE_SHA: mergeSha,
      E2E_HEAD_SHA: mergeSha,
      E2E_PR_URL: "https://github.com/o/r/pull/1",
      E2E_TMUX_RUN_NEW_SESSION: options.executeRunner === true ? "1" : "0",
      E2E_TMUX_RUN_GATEKEEPER_WINDOW: options.executeGatekeeperWindows === true ? "1" : "0",
      E2E_NO_MISTAKES_ACTIVE: options.activeNoMistakes === true ? "1" : "0",
      E2E_NO_MISTAKES_ACTIVATE_ON_AXI_RUN: options.activateNoMistakesOnAxiRun === true ? "1" : "0",
      E2E_NO_MISTAKES_FAIL_AXI_RUN: options.failNoMistakesAxiRun === true ? "1" : "0",
      E2E_NO_MISTAKES_ATTACH_FAIL: options.failNoMistakesAttach === true ? "1" : "0",
      E2E_NO_MISTAKES_QUOTE_RUN_ID: options.quoteNoMistakesRunId === true ? "1" : "0",
      E2E_NO_MISTAKES_GATE: join(noMistakesRoot, "repos", "e2e.git"),
      E2E_NO_MISTAKES_STATE: join(root, "no-mistakes-state.json"),
      E2E_NO_MISTAKES_RUN_DELAY_MS: String(options.noMistakesRunDelayMs ?? 0),
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
  const gatekeeperCommand = options.gatekeeperCommand ?? "true";
  const externalCommentAgents = options.externalCommentAgents ?? [];
  const readyRequiredChecks = options.readyRequiredChecks ?? [];
  const greenCheckNames = options.greenCheckNames ?? [];
  writeFileSync(
    join(repo, "combo-chen.toml"),
    [
      "[roles]",
      'coder = "e2e-coder"',
      'reviewer = ["e2e-reviewer"]',
      "",
      ...(options.reviewerLogins === undefined
        ? []
        : [
            "[reviewer]",
            `logins = ${JSON.stringify(options.reviewerLogins)}`,
            "",
          ]),
      "[coder.e2e-coder]",
      'command = "e2e-coder"',
      'resume_command = "true"',
      "",
      "[reviewer.e2e-reviewer]",
      'command = "true"',
      "",
      "[director]",
      'command = "true"',
      "",
      "[gatekeeper]",
      `command = ${JSON.stringify(gatekeeperCommand)}`,
      `attach_timeout_seconds = ${options.gatekeeperAttachTimeoutSeconds ?? 1}`,
      "attach_retry_interval_seconds = 1",
      "initial_gate_retry_attempts = 0",
      "",
      ...(externalCommentAgents.length === 0
        ? []
        : [
            "[external_comments]",
            `agents = ${JSON.stringify(externalCommentAgents)}`,
            "",
          ]),
      ...(readyRequiredChecks.length === 0
        ? []
        : [
            "[ready]",
            `required_checks = ${JSON.stringify(readyRequiredChecks)}`,
            "",
          ]),
      ...(greenCheckNames.length === 0
        ? []
        : [
            "[pr_labels]",
            `green_check_names = ${JSON.stringify(greenCheckNames)}`,
            "",
          ]),
      "[limits]",
      "babysit_poll_seconds = 1",
      "teardown_git_retries = 0",
      "teardown_git_backoff_seconds = 1",
      "watch_failure_limit = 1",
      "watch_backoff_max_seconds = 1",
      "",
      ...(options.workerStallTicks === undefined
        ? []
        : [
            "[monitor]",
            `worker_stall_ticks = ${options.workerStallTicks}`,
            "",
          ]),
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
    [
      "commands:",
      "  test: echo e2e",
      "  lint: echo e2e",
      "  build: echo e2e",
      "",
    ].join("\n"),
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
