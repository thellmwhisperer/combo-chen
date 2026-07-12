/**
 * @overview Contract tests for the in-process no-mistakes gate engine.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at config-copy race truth table <- complete shell parity matrix.
 *   2. Then gate journal contracts           <- externally visible sequencing.
 *   3. Finish at gate predicates             <- output/status classification.
 *
 *   MAIN FLOW
 *   ---------
 *   fake awaited processes -> runInProcessGate -> direct journal events
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   combo, processRunner, eventShapes
 *
 * @exports none
 * @deps ../../core/events, ../../core/gate-lease, ../../core/state, ./in-process-gate, node:fs, node:os, node:path, vitest
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readEvents } from "../../core/events.js";
import { readGateLease } from "../../core/gate-lease.js";
import { runDirFor, writeCombo, type ComboRecord } from "../../core/state.js";
import {
  abortPreviousRun,
  axiHeadMatches,
  copyConfigToActiveRun,
  gateFailureReason,
  gateIsAwaitingApproval,
  parseAxiStatus,
  publishGateMirror,
  resolveConfigCopyRace,
  runGatekeeperAndConfigCopy,
  runInProcessGate,
  shouldRecoverChecksPassed,
  withGateLease,
  type GateProcessRequest,
  type GateProcessResult,
} from "./in-process-gate.js";

// -- 1/3 HELPER · fixtures --
function combo(root: string): ComboRecord {
  return {
    id: "o-r-7",
    issueUrl: "https://github.com/o/r/issues/7",
    repoDir: join(root, "repo"),
    worktree: join(root, "worktree"),
    branch: "combo/issue-7",
    tmuxSession: "combo-chen-o-r-7",
    createdAt: new Date(0).toISOString(),
  };
}

function eventShapes(runDir: string): Array<Record<string, unknown>> {
  return readEvents(runDir).map(({ t: _timestamp, ...event }) => event);
}

function processRunner(
  responses: Array<{ command: string; result: GateProcessResult }>,
  calls: GateProcessRequest[],
): (request: GateProcessRequest) => Promise<GateProcessResult> {
  return async (request) => {
    calls.push(request);
    const response = responses.shift();
    if (response === undefined)
      throw new Error(`unexpected process: ${request.command} ${request.args.join(" ")}`);
    expect(`${request.command} ${request.args.join(" ")}`).toContain(response.command);
    return response.result;
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
// -/ 1/3

// -- 2/3 CORE · config-copy race truth table <- START HERE --
describe("config-copy race truth table", () => {
  const rows: Array<{
    name: string;
    configPresent: boolean;
    gateFinishedBeforeConfig: boolean;
    gateExitCode: number;
    configOutcome: "copied" | "failed" | "killed" | "not_started";
    exitCode: number;
    configFailed: boolean;
  }> = [
    {
      name: "no config + gate passes",
      configPresent: false,
      gateFinishedBeforeConfig: false,
      gateExitCode: 0,
      configOutcome: "not_started",
      exitCode: 0,
      configFailed: false,
    },
    {
      name: "no config + gate fails",
      configPresent: false,
      gateFinishedBeforeConfig: false,
      gateExitCode: 42,
      configOutcome: "not_started",
      exitCode: 42,
      configFailed: false,
    },
    {
      name: "config copied first + gate passes",
      configPresent: true,
      gateFinishedBeforeConfig: false,
      gateExitCode: 0,
      configOutcome: "copied",
      exitCode: 0,
      configFailed: false,
    },
    {
      name: "config copied first + gate fails",
      configPresent: true,
      gateFinishedBeforeConfig: false,
      gateExitCode: 42,
      configOutcome: "copied",
      exitCode: 42,
      configFailed: false,
    },
    {
      name: "copy fails first + gate passes",
      configPresent: true,
      gateFinishedBeforeConfig: false,
      gateExitCode: 0,
      configOutcome: "failed",
      exitCode: 1,
      configFailed: true,
    },
    {
      name: "copy fails first + gate fails",
      configPresent: true,
      gateFinishedBeforeConfig: false,
      gateExitCode: 42,
      configOutcome: "failed",
      exitCode: 1,
      configFailed: true,
    },
    {
      name: "gate passes before copy",
      configPresent: true,
      gateFinishedBeforeConfig: true,
      gateExitCode: 0,
      configOutcome: "copied",
      exitCode: 1,
      configFailed: true,
    },
    {
      name: "gate fails before copy and watcher is killed",
      configPresent: true,
      gateFinishedBeforeConfig: true,
      gateExitCode: 42,
      configOutcome: "killed",
      exitCode: 1,
      configFailed: true,
    },
    {
      name: "intentional kill alone is forgiven",
      configPresent: true,
      gateFinishedBeforeConfig: false,
      gateExitCode: 42,
      configOutcome: "killed",
      exitCode: 42,
      configFailed: false,
    },
  ];

  for (const row of rows) {
    it(row.name, () => {
      expect(resolveConfigCopyRace(row)).toEqual({
        exitCode: row.exitCode,
        rawExitCode: row.gateExitCode,
        configFailed: row.configFailed,
      });
    });
  }

  it("observes gate completion before a later successful copy", async () => {
    const gate = deferred<GateProcessResult>();
    const copy = deferred<"copied">();
    const resultPromise = runGatekeeperAndConfigCopy({
      configPresent: true,
      gate: () => gate.promise,
      copyConfig: async () => copy.promise,
    });

    gate.resolve({ exitCode: 0, stdout: "", stderr: "" });
    await Promise.resolve();
    copy.resolve("copied");

    await expect(resultPromise).resolves.toMatchObject({
      exitCode: 1,
      rawExitCode: 0,
      configFailed: true,
    });
  });

  it("contains a config watcher rejection after the failed gate aborts it", async () => {
    const gate = deferred<GateProcessResult>();
    const resultPromise = runGatekeeperAndConfigCopy({
      configPresent: true,
      gate: () => gate.promise,
      copyConfig: async (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("watcher aborted")), { once: true });
        }),
    });

    gate.resolve({ exitCode: 42, stdout: "", stderr: "gate failed" });

    await expect(resultPromise).resolves.toMatchObject({
      exitCode: 1,
      rawExitCode: 42,
      configFailed: true,
    });
  });

  it("copies the config only into the active matching branch worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "combo-chen-config-copy-"));
    const worktree = join(root, "combo-worktree");
    const gatePath = join(root, "data", "repos", "repo-id.git");
    const daemonWorktree = join(root, "data", "worktrees", "repo-id", "01RUN");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(daemonWorktree, { recursive: true });
    writeFileSync(join(worktree, ".no-mistakes.yaml"), "commands:\n  test: pnpm test\n");
    const runProcess = async (request: GateProcessRequest): Promise<GateProcessResult> => {
      const stdout =
        request.args[0] === "status"
          ? `daemon: running\ngate: ${gatePath}\n`
          : "id: 01RUN\nbranch: combo/issue-7\nstatus: running\n";
      return { exitCode: 0, stdout, stderr: "" };
    };

    await expect(
      copyConfigToActiveRun({
        combo: { branch: "combo/issue-7", worktree },
        runProcess,
        attempts: 1,
        retryDelayMs: 0,
      }),
    ).resolves.toBe("copied");
    expect(readFileSync(join(daemonWorktree, ".no-mistakes.yaml"), "utf8")).toBe(
      "commands:\n  test: pnpm test\n",
    );
  });
});
// -/ 2/3

// -- 3/3 CORE · gate journal contracts and predicates --
describe("in-process post-address gate", () => {
  it("preserves the successful recovery event sequence", async () => {
    const root = mkdtempSync(join(tmpdir(), "combo-chen-in-process-gate-"));
    const record = combo(root);
    const runDir = join(root, "run");
    mkdirSync(record.repoDir, { recursive: true });
    mkdirSync(record.worktree, { recursive: true });
    mkdirSync(runDir);
    writeFileSync(join(runDir, "journal.jsonl"), "");
    const calls: GateProcessRequest[] = [];
    const runProcess = processRunner(
      [
        { command: "git rev-parse HEAD", result: { exitCode: 0, stdout: "local-head\n", stderr: "" } },
        { command: "git remote get-url no-mistakes", result: { exitCode: 2, stdout: "", stderr: "" } },
        { command: "no-mistakes axi status", result: { exitCode: 0, stdout: "status: done\n", stderr: "" } },
        { command: "no-mistakes daemon start", result: { exitCode: 0, stdout: "", stderr: "" } },
        {
          command: "sh -c gate-command",
          result: { exitCode: 42, stdout: "outcome: checks-passed\nci.log: context canceled\n", stderr: "" },
        },
      ],
      calls,
    );

    const result = await runInProcessGate({
      combo: record,
      runDir,
      kind: "post",
      gatekeeperCommand: "gate-command",
      mirrorIntent: "intent",
      prUrl: "https://github.com/o/r/pull/7",
      runProcess,
      resolvePrHead: async () => "pr-head",
      ensurePrAutoclose: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });

    expect(result).toEqual({ status: "validated", exitCode: 0, headSha: "pr-head" });
    expect(eventShapes(runDir)).toEqual([
      { event: "gate_started" },
      { event: "gate_status", state: "fix_inflight", head_sha: "local-head" },
      {
        event: "gate_status",
        state: "idle",
        head_sha: "pr-head",
        recovery: "checks_passed_context_canceled",
      },
      { event: "gate_validated", sha: "pr-head" },
    ]);
    expect(calls.map((call) => call.command)).toEqual(["git", "git", "no-mistakes", "no-mistakes", "sh"]);
  });

  it("preserves awaiting-approval and failure event sequences", async () => {
    const cases = [
      {
        output: "outcome: awaiting_approval\n",
        exitCode: 0,
        expected: [
          { event: "gate_started" },
          { event: "gate_status", state: "fix_inflight", head_sha: "head" },
          { event: "gate_status", state: "awaiting_approval", head_sha: "head" },
          { event: "needs_human", reason: "gate_waiting" },
        ],
      },
      {
        output: "daemon died: ECONNREFUSED\n",
        exitCode: 9,
        expected: [
          { event: "gate_started" },
          { event: "gate_status", state: "fix_inflight", head_sha: "head" },
          { event: "gate_status", state: "failed", head_sha: "head" },
          { event: "gate_failed", exit_code: 9, reason: "daemon_dead" },
        ],
      },
    ];

    for (const testCase of cases) {
      const root = mkdtempSync(join(tmpdir(), "combo-chen-in-process-gate-"));
      const record = combo(root);
      const runDir = join(root, "run");
      mkdirSync(record.worktree, { recursive: true });
      mkdirSync(runDir);
      writeFileSync(join(runDir, "journal.jsonl"), "");
      const calls: GateProcessRequest[] = [];
      const responses = [
        { command: "git rev-parse HEAD", result: { exitCode: 0, stdout: "head\n", stderr: "" } },
        { command: "no-mistakes axi status", result: { exitCode: 0, stdout: "status: done\n", stderr: "" } },
        { command: "no-mistakes daemon start", result: { exitCode: 0, stdout: "", stderr: "" } },
        {
          command: "sh -c gate-command",
          result: { exitCode: testCase.exitCode, stdout: testCase.output, stderr: "" },
        },
      ];
      if (testCase.exitCode !== 0) {
        responses.push({
          command: "no-mistakes axi status",
          result: { exitCode: 0, stdout: "status: done\n", stderr: "" },
        });
      }
      const runProcess = processRunner(responses, calls);
      await runInProcessGate({
        combo: record,
        runDir,
        kind: "post",
        gatekeeperCommand: "gate-command",
        prUrl: "pr",
        runProcess,
      });
      expect(eventShapes(runDir)).toEqual(testCase.expected);
    }
  });
});

describe("gate output and axi status predicates", () => {
  it("parses quoted fields and applies prefix-tolerant head matching", () => {
    expect(
      parseAxiStatus('id: "01RUN"\n branch: combo/issue-7\n head: "abcdef12"\n status: running\n'),
    ).toEqual({
      id: "01RUN",
      branch: "combo/issue-7",
      head: "abcdef12",
      status: "running",
    });
    expect(axiHeadMatches("abcdef12", "abcdef1234567890")).toBe(true);
    expect(axiHeadMatches("", "abcdef1234567890")).toBe(false);
  });

  it("keeps the first status field like the shell sed parser", () => {
    expect(parseAxiStatus("id: first\nid: second\nstatus: running\nstatus: done\n")).toEqual({
      id: "first",
      status: "running",
    });
  });

  it("classifies approval, recovery, and daemon death from captured output", () => {
    expect(gateIsAwaitingApproval("outcome: awaiting_approval\n")).toBe(true);
    expect(shouldRecoverChecksPassed(42, "outcome: checks-passed\nfoo context canceled\n", false)).toBe(true);
    expect(shouldRecoverChecksPassed(42, "outcome: checks-passed\nfoo context canceled\n", true)).toBe(false);
    expect(gateFailureReason("connection refused")).toBe("daemon_dead");
    expect(gateFailureReason("tests failed")).toBe("gate_failed");
  });
});

describe("mirror and lease orchestration", () => {
  it("TOMBSTONE: resumes custody of a matching active run without publishing a duplicate", async () => {
    const root = mkdtempSync(join(tmpdir(), "combo-chen-in-process-gate-"));
    const record = combo(root);
    const runDir = join(root, "run");
    mkdirSync(record.worktree, { recursive: true });
    mkdirSync(runDir);
    const calls: string[] = [];
    let driverCrashed = false;
    let publishAttempts = 0;
    let driverCalls = 0;
    const runProcess = async (request: GateProcessRequest): Promise<GateProcessResult> => {
      const call = `${request.command} ${request.args.join(" ")}`;
      calls.push(call);
      if (call === "git rev-parse HEAD") {
        return { exitCode: 0, stdout: "abcdef123456\n", stderr: "" };
      }
      if (call === "no-mistakes axi status") {
        if (!driverCrashed) return { exitCode: 0, stdout: "status: done\n", stderr: "" };
        return {
          exitCode: 0,
          stdout: "id: 01ORPHAN\nbranch: combo/issue-7\nhead: abcdef12\nstatus: running\n",
          stderr: "",
        };
      }
      if (call === "git remote get-url no-mistakes") {
        publishAttempts += 1;
        return { exitCode: 2, stdout: "", stderr: "no mirror" };
      }
      if (call === "no-mistakes daemon start") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (call === "sh -c gate-command") {
        driverCalls += 1;
        if (!driverCrashed) {
          driverCrashed = true;
          throw new Error("capsule killed after gate start");
        }
        return { exitCode: 0, stdout: "outcome: checks-passed\n", stderr: "" };
      }
      throw new Error(`duplicate pipeline operation: ${call}`);
    };

    await expect(
      runInProcessGate({
        combo: record,
        runDir,
        kind: "initial",
        gatekeeperCommand: "gate-command",
        mirrorIntent: "intent",
        runProcess,
      }),
    ).rejects.toThrow("capsule killed after gate start");

    await expect(
      runInProcessGate({
        combo: record,
        runDir,
        kind: "initial",
        gatekeeperCommand: "gate-command",
        mirrorIntent: "intent",
        runProcess,
        findPrUrl: async () => "https://github.com/o/r/pull/7",
        resolvePrHead: async () => "published",
      }),
    ).resolves.toEqual({ status: "validated", exitCode: 0, headSha: "published" });
    expect(publishAttempts).toBe(1);
    expect(driverCalls).toBe(2);
    expect(calls.slice(-3)).toEqual(["git rev-parse HEAD", "no-mistakes axi status", "sh -c gate-command"]);
    expect(eventShapes(runDir)).toEqual([
      { event: "gate_started" },
      { event: "gate_status", state: "fix_inflight", head_sha: "abcdef123456" },
      { event: "gate_started" },
      { event: "gate_status", state: "fix_inflight", head_sha: "abcdef123456" },
      { event: "gate_reattached", run_id: "01ORPHAN", head_sha: "abcdef123456" },
      { event: "gate_status", state: "idle", head_sha: "published" },
      { event: "pr_opened", url: "https://github.com/o/r/pull/7" },
    ]);
  });

  it("forgives an abort failure when the run became inactive on its own", async () => {
    const statuses = [
      "id: 01RUN\nbranch: combo/issue-7\nstatus: running\n",
      "id: 01RUN\nbranch: combo/issue-7\nstatus: done\n",
    ];
    const runProcess = async (request: GateProcessRequest): Promise<GateProcessResult> => {
      if (request.args.join(" ") === "axi status") {
        return { exitCode: 0, stdout: statuses.shift() ?? "", stderr: "" };
      }
      expect(request.args).toEqual(["axi", "abort"]);
      return { exitCode: 1, stdout: "", stderr: "already finished" };
    };

    await expect(
      abortPreviousRun({
        combo: { branch: "combo/issue-7", worktree: "/worktree" },
        runProcess,
        retryDelayMs: 0,
      }),
    ).resolves.toBe(true);
  });

  it("checks for an attachable run after mirror publication fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "combo-chen-in-process-gate-"));
    const record = combo(root);
    const runDir = join(root, "run");
    mkdirSync(record.worktree, { recursive: true });
    mkdirSync(runDir);
    const calls: GateProcessRequest[] = [];
    const runProcess = processRunner(
      [
        { command: "git rev-parse HEAD", result: { exitCode: 0, stdout: "abcdef123456\n", stderr: "" } },
        {
          command: "git remote get-url no-mistakes",
          result: { exitCode: 0, stdout: "mirror\n", stderr: "" },
        },
        { command: "no-mistakes daemon start", result: { exitCode: 0, stdout: "", stderr: "" } },
        { command: "no-mistakes axi status", result: { exitCode: 0, stdout: "status: done\n", stderr: "" } },
        { command: "git ls-remote", result: { exitCode: 1, stdout: "", stderr: "mirror unavailable" } },
        {
          command: "no-mistakes axi status",
          result: {
            exitCode: 0,
            stdout: "id: 01LIVE\nbranch: combo/issue-7\nhead: abcdef12\nstatus: running\n",
            stderr: "",
          },
        },
        {
          command: "sh -c gate-command",
          result: { exitCode: 0, stdout: "outcome: checks-passed\n", stderr: "" },
        },
      ],
      calls,
    );

    await expect(
      runInProcessGate({
        combo: record,
        runDir,
        kind: "initial",
        gatekeeperCommand: "gate-command",
        mirrorIntent: "intent",
        runProcess,
        findPrUrl: async () => "https://github.com/o/r/pull/7",
        resolvePrHead: async () => "published",
      }),
    ).resolves.toEqual({
      status: "validated",
      exitCode: 0,
      headSha: "published",
    });
    expect(eventShapes(runDir)).toEqual([
      { event: "gate_started" },
      { event: "gate_status", state: "fix_inflight", head_sha: "abcdef123456" },
      { event: "gate_reattached", run_id: "01LIVE", head_sha: "abcdef123456" },
      { event: "gate_status", state: "idle", head_sha: "published" },
      { event: "pr_opened", url: "https://github.com/o/r/pull/7" },
    ]);
  });

  it("reuses an already-running daemon, aborts the old run, and force-publishes HEAD", async () => {
    const calls: string[] = [];
    const runProcess = async (request: GateProcessRequest): Promise<GateProcessResult> => {
      const call = `${request.command} ${request.args.join(" ")}`;
      calls.push(call);
      if (call === "git remote get-url no-mistakes") return { exitCode: 0, stdout: "mirror\n", stderr: "" };
      if (call === "no-mistakes daemon start") return { exitCode: 1, stdout: "", stderr: "already running" };
      if (call === "no-mistakes status") return { exitCode: 0, stdout: "daemon: running\n", stderr: "" };
      if (call === "no-mistakes axi status") return { exitCode: 0, stdout: "status: done\n", stderr: "" };
      if (call === "git ls-remote --heads no-mistakes combo/issue-7") {
        return { exitCode: 0, stdout: "aaaaaaaa\trefs/heads/combo/issue-7\n", stderr: "" };
      }
      if (call.startsWith("git push ")) return { exitCode: 0, stdout: "", stderr: "" };
      throw new Error(`unexpected process: ${call}`);
    };

    await expect(
      publishGateMirror({
        combo: { branch: "combo/issue-7", worktree: "/worktree" },
        intent: "base64-intent",
        runProcess,
      }),
    ).resolves.toMatchObject({ daemonStarted: true, previousRunAborted: true, published: true });
    expect(calls.at(-1)).toBe(
      "git push -o no-mistakes.intent=base64-intent no-mistakes --force-with-lease=refs/heads/combo/issue-7:aaaaaaaa HEAD:refs/heads/combo/issue-7",
    );
  });

  it("always releases an acquired branch lease", async () => {
    const home = mkdtempSync(join(tmpdir(), "combo-chen-in-process-lease-"));
    const runDir = runDirFor(home, "o-r-7");
    writeCombo(runDir, combo(home));

    await expect(
      withGateLease({
        home,
        comboId: "o-r-7",
        headSha: "abcdef123456",
        action: async () => {
          expect(readGateLease(home)?.comboId).toBe("o-r-7");
          return "done";
        },
      }),
    ).resolves.toEqual({ acquired: true, value: "done" });
    expect(readGateLease(home)).toBeUndefined();
    expect(
      existsSync(join(home, "gate-leases.lock", encodeURIComponent("combo/issue-7"), "lease.json")),
    ).toBe(false);
  });
});
// -/ 3/3
