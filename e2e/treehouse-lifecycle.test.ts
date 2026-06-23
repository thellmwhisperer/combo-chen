/**
 * @overview Hermetic end-to-end coverage for combo-chen's Treehouse-backed
 *   lifecycle. Uses the built CLI as a subprocess, real git repos/worktrees,
 *   and process shims for external services. ~890 lines, log-derived regressions.
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
  gatekeeperCommand?: string;
  externalCommentAgents?: string[];
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
  });

  it("resumes a broken combo when no-mistakes creates the run only after gate restart", () => {
    const harness = prepareHarness({
      activateNoMistakesOnAxiRun: true,
      gatekeeperCommand: "no-mistakes daemon start && no-mistakes axi run --intent e2e-resume",
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
  });

  it("recreates a missing tmux room before restarting the initial gate", () => {
    const harness = prepareHarness({
      activateNoMistakesOnAxiRun: true,
      gatekeeperCommand: "no-mistakes daemon start && no-mistakes axi run --intent e2e-resume",
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
          expect.objectContaining({ args: ["new-session", "-d", "-s", combo.tmuxSession, "-n", "coder", expect.any(String)] }),
          expect.objectContaining({ args: ["new-window", "-t", combo.tmuxSession, "-n", "gatekeeper", expect.stringContaining("window retained for inspection until closure")] }),
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
  });

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

  it("routes a reviewer code 1 verdict even when retained worker panes are stalled", () => {
    const harness = prepareHarness({ workerStallTicks: 1 });
    let passed = false;

    try {
      const { combo, runDir } = launchPlanCombo(harness);
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
          COMBO_CHEN_WORKER_STALL_TICKS: "1",
          E2E_HEAD_SHA: headSha,
          E2E_PR_STATE: "OPEN",
          E2E_REVIEWER_CODE1: "1",
        },
      });
      expect(tick.stdout).toContain("director: worker coder: unchanged_ticks=1");
      expect(tick.stdout).toContain("nudged https://github.com/o/r/pull/1#pullrequestreview-reviewer-code-1");

      const events = readJsonLines<JournalEventJson>(join(runDir, "journal.jsonl"));
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "needs_human", reason: "worker_stalled", worker: "coder" }),
          expect.objectContaining({
            event: "review_comment",
            author: "e2e-reviewer",
            kind: "review",
            url: "https://github.com/o/r/pull/1#pullrequestreview-reviewer-code-1",
            head_sha: headSha,
          }),
        ]),
      );

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

  it("starts a post-address gate after coder commits fixes for routed external comments", () => {
    const harness = prepareHarness({ externalCommentAgents: ["coderabbitai"] });
    let passed = false;

    try {
      const { combo, runDir } = launchPlanCombo(harness);
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
  writeFileSync(
    join(repo, "combo-chen.toml"),
    [
      "[roles]",
      'coder = "e2e-coder"',
      'reviewer = ["e2e-reviewer"]',
      "",
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
      "attach_timeout_seconds = 1",
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
