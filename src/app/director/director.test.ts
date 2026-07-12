/**
 * @overview Unit tests for director CLI helpers. ~2420 lines, initial-gate retry, READY, conflict recovery, auto-closure, worker monitoring, and worker recovery.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at READY pure helpers    <- extracted current-head predicates.
 *   2. Then tickDirector tests        <- PR label sync, current-head READY, auto-closure, and gate routing.
 *   3. Test harness helpers           <- combo fixture and fake deps.
 *
 *   MAIN FLOW
 *   ---------
 *   fake journal/gh/git/tmux -> tickDirector -> journal events and gate scripts
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   combo, event, fakeDeps, seedReadyCandidate, writeCoderThreadArtifact
 *
 * @exports none
 * @deps ../../core/events, ../../core/state, ../../infra/config, ../../infra/config-snapshot, ../../roles/coder-invocation, ../gate/gate, ../runtime/sessions, ./director, node:fs, node:os, node:path, vitest
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appendEvent, readEvents, type ComboEvent } from "../../core/events.js";
import { runDirFor, writeCombo, type ComboRecord } from "../../core/state.js";
import { loadConfig } from "../../infra/config.js";
import { writeConfigSnapshot } from "../../infra/config-snapshot.js";
import { CODER_THREAD_ARTIFACT } from "../../roles/coder-invocation.js";
import {
  gateStateAllowsReady,
  headStateAllowsReady,
  reviewStateAllowsReady,
  tickDirector,
  type DirectorDeps,
} from "./director.js";
import { GATEKEEPER_WINDOW } from "../gate/gate.js";
import { idleRoleWindowCommand } from "../runtime/sessions.js";

// -- 1/2 HELPER · Fixtures --
const ISSUE = "https://github.com/o/r/issues/7";
const CODEX_THREAD_ID = "019eb3f5-c135-76d2-88c5-0aa8edfe4c84";

function combo(overrides: Partial<ComboRecord> = {}): ComboRecord {
  const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
  return {
    id: "o-r-7",
    issueUrl: ISSUE,
    repoDir,
    worktree: join(repoDir, ".worktrees", "issue-7"),
    branch: "combo/issue-7",
    tmuxSession: "combo-chen-o-r-7",
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function successfulRollup(): unknown[] {
  return [
    { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "CodeRabbit", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "ExternalReview", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "StatusContext", context: "coverage", state: "SUCCESS" },
  ];
}

function event(name: ComboEvent["event"], payload: Record<string, unknown> = {}): ComboEvent {
  return { t: new Date(0).toISOString(), event: name, ...payload };
}

function seedReadyCandidate(input: {
  homeDir: string;
  headSha: string;
  gateSha?: string;
  lgtmSha?: string;
}): { record: ComboRecord; runDir: string } {
  const record = combo();
  const runDir = runDirFor(input.homeDir, record.id);
  writeCombo(runDir, record);
  appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
  appendEvent(runDir, "gate_validated", { sha: input.gateSha ?? input.headSha });
  appendEvent(runDir, "lgtm", { sha: input.lgtmSha ?? input.headSha });
  return { record, runDir };
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

function fakeDeps(input: {
  homeDir: string;
  record: ComboRecord;
  prHeadSha: string;
  worktreeHeadSha?: string;
  rollup?: unknown[];
  externalReviewComments?: Array<{ body: string; commitSha?: string; submittedAt?: string }>;
  externalCommentLogin?: string;
  issueComments?: unknown[];
  prComments?: unknown[];
  prLabels?: unknown[];
  prState?: string;
  mergeStateStatus?: string;
  mergeable?: string;
  mergeSha?: string;
  mergedBy?: string;
  mergedAt?: string;
  env?: Record<string, string | undefined>;
  git?: DirectorDeps["git"];
  sleep?: DirectorDeps["sleep"];
  tmux?: DirectorDeps["tmux"];
  treehouse?: DirectorDeps["treehouse"];
  noMistakes?: DirectorDeps["noMistakes"];
}): { deps: DirectorDeps; calls: string[][]; out: string[] } {
  const calls: string[][] = [];
  const out: string[] = [];
  let livePrLabels = [...(input.prLabels ?? [])];
  const deps: DirectorDeps = {
    env: { COMBO_CHEN_HOME: input.homeDir, ...input.env },
    out: (line) => out.push(line),
    tmux: (args) => {
      calls.push(["tmux", ...args]);
      return input.tmux?.(args) ?? { status: 0, stdout: "", stderr: "" };
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
      if (args[0] === "pr" && args[1] === "view") {
        const fields = args.at(-1) ?? "";
        const base = {
          headRefOid: input.prHeadSha,
          baseRefName: "main",
          state: input.prState ?? "OPEN",
          ...(input.mergeStateStatus !== undefined ? { mergeStateStatus: input.mergeStateStatus } : {}),
          ...(input.mergeable !== undefined ? { mergeable: input.mergeable } : {}),
          ...(input.mergeSha !== undefined ? { mergeCommit: { oid: input.mergeSha } } : {}),
          ...(input.mergedBy !== undefined ? { mergedBy: { login: input.mergedBy } } : {}),
          ...(input.mergedAt !== undefined ? { mergedAt: input.mergedAt } : {}),
        };
        return {
          status: 0,
          stdout: JSON.stringify(
            fields.includes("statusCheckRollup")
              ? {
                  ...base,
                  statusCheckRollup: input.rollup ?? successfulRollup(),
                  ...(fields.includes("comments") ? { comments: input.prComments ?? [] } : {}),
                  ...(fields.includes("labels") ? { labels: livePrLabels } : {}),
                }
              : {
                  ...base,
                  ...(fields.includes("comments") ? { comments: input.prComments ?? [] } : {}),
                  ...(fields.includes("labels") ? { labels: livePrLabels } : {}),
                },
          ),
          stderr: "",
        };
      }
      if (args[0] === "pr" && args[1] === "edit") {
        if (args[3] === "--remove-label") {
          const removed = new Set(String(args[4] ?? "").split(","));
          livePrLabels = livePrLabels.filter((label) => {
            const name = testLabelName(label);
            return name === undefined || !removed.has(name);
          });
        }
        if (args[3] === "--add-label") {
          livePrLabels = livePrLabels.concat(
            String(args[4] ?? "")
              .split(",")
              .map((name) => ({ name })),
          );
        }
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "comment") {
        return { status: 0, stdout: "", stderr: "" };
      }
      const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
      if (endpoint.endsWith("/issues/7/comments")) {
        return { status: 0, stdout: JSON.stringify(input.issueComments ?? []), stderr: "" };
      }
      if (endpoint.endsWith("/pulls/7/comments")) {
        return { status: 0, stdout: "[]", stderr: "" };
      }
      if (endpoint.endsWith("/pulls/7/reviews")) {
        const comments = input.externalReviewComments ?? [
          {
            body: "ExternalReview review complete. No issues found.",
            commitSha: input.prHeadSha,
            submittedAt: "2026-06-15T00:00:00Z",
          },
        ];
        return {
          status: 0,
          stdout: JSON.stringify(
            comments.map((comment, index) => ({
              body: comment.body,
              commit_id: comment.commitSha ?? input.prHeadSha,
              html_url: `https://github.com/o/r/pull/7#pullrequestreview-${index + 1}`,
              state: "COMMENTED",
              submitted_at: comment.submittedAt ?? `2026-06-15T00:00:0${index}Z`,
              user: { login: input.externalCommentLogin ?? "external-reviewer" },
            })),
          ),
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
    },
    git:
      input.git ??
      ((args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "remote" && args[1] === "get-url" && args[2] === "no-mistakes") {
          return { status: 2, stdout: "", stderr: "No such remote 'no-mistakes'" };
        }
        if (cwd === input.record.repoDir && args[0] === "fetch") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (cwd === input.record.repoDir && args[0] === "merge-base") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (cwd === input.record.repoDir && args[0] === "branch" && args[1] === "-D") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (cwd === input.record.worktree && args[0] === "rev-parse" && args[1] === "HEAD") {
          return { status: 0, stdout: `${input.worktreeHeadSha ?? input.prHeadSha}\n`, stderr: "" };
        }
        if (args[0] === "status" && args[1] === "--porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
      }),
    treehouse:
      input.treehouse ??
      ((args, cwd) => {
        calls.push(["treehouse", `cwd=${cwd}`, ...args]);
        return { status: 0, stdout: "", stderr: "" };
      }),
    noMistakes:
      input.noMistakes ??
      ((args, cwd) => {
        calls.push(["no-mistakes", `cwd=${cwd}`, ...args]);
        return { status: 1, stdout: "", stderr: "No active run." };
      }),
    sleep: input.sleep ?? (() => Promise.resolve()),
  };
  return { deps, calls, out };
}

function testLabelName(label: unknown): string | undefined {
  if (typeof label === "string") return label;
  if (typeof label === "object" && label !== null && typeof (label as { name?: unknown }).name === "string") {
    return (label as { name: string }).name;
  }
  return undefined;
}
// -/ 1/2

// -- 2/2 CORE · READY helpers and tickDirector tests <- START HERE --
describe("READY pure state helpers", () => {
  it("allows only open, not-yet-ready PR heads through the head-state check", () => {
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    expect(headStateAllowsReady([], { headSha, state: "OPEN" })).toBe(true);
    expect(headStateAllowsReady([], { headSha, state: "MERGED" })).toBe(false);
    expect(
      headStateAllowsReady(
        [event("ready_for_merge", { sha: headSha, pr_url: "https://github.com/o/r/pull/7" })],
        { headSha, state: "OPEN" },
      ),
    ).toBe(false);
  });

  it("requires the latest gate state to be published and non-blocking for the current head", () => {
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const oldSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    expect(gateStateAllowsReady([event("gate_validated", { sha: headSha })], headSha)).toBe(true);
    expect(gateStateAllowsReady([event("gate_validated", { sha: oldSha })], headSha)).toBe(false);
    expect(
      gateStateAllowsReady(
        [
          event("gate_validated", { sha: headSha }),
          event("gate_status", { state: "failed", head_sha: headSha }),
        ],
        headSha,
      ),
    ).toBe(false);
  });

  it("requires a live reviewer LGTM pinned to the current head", () => {
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const oldSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    expect(reviewStateAllowsReady([event("lgtm", { sha: headSha })], headSha)).toBe(true);
    expect(reviewStateAllowsReady([event("lgtm", { sha: oldSha })], headSha)).toBe(false);
    expect(
      reviewStateAllowsReady(
        [event("lgtm", { sha: headSha }), event("lgtm_stale", { old_sha: headSha, new_sha: oldSha })],
        headSha,
      ),
    ).toBe(false);
  });

  it("rejects dirty or conflicting PR mergeability for READY", () => {
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    expect(headStateAllowsReady([], { headSha, state: "OPEN", mergeStateStatus: "DIRTY" })).toBe(false);
    expect(headStateAllowsReady([], { headSha, state: "OPEN", mergeable: "CONFLICTING" })).toBe(false);
  });
});

describe("tickDirector", () => {
  it("auto-retries a pre-PR gate_failed after the configured backoff", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(h, record.id);
    mkdirSync(record.worktree, { recursive: true });
    writeCombo(runDir, record);
    appendEvent(runDir, "coder_done", {});
    appendEvent(runDir, "gate_started", {});
    appendEvent(runDir, "gate_failed", { exit_code: 1, reason: "gate_failed" });
    const headSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const sleeps: number[] = [];
    const { deps, calls, out } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
      worktreeHeadSha: headSha,
      env: {
        COMBO_CHEN_GATEKEEPER_INITIAL_GATE_RETRY_ATTEMPTS: "2",
        COMBO_CHEN_GATEKEEPER_INITIAL_GATE_RETRY_BACKOFF_SECONDS: "1",
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(sleeps).toEqual([1000]);
    const scriptPath = join(runDir, `gatekeeper-initial-${headSha.slice(0, 12)}.sh`);
    const gatekeeperWindow = calls.find(
      (call) => call[0] === "tmux" && call[1] === "new-window" && call.includes(GATEKEEPER_WINDOW),
    );
    expect(gatekeeperWindow?.at(-1)).toContain(`sh '${scriptPath}'`);
    expect(gatekeeperWindow?.at(-1)).toContain(
      "[combo-chen] gatekeeper idle; waiting for the next current-head run.",
    );
    const script = readFileSync(scriptPath, "utf8");
    expect(script).toContain("initial gate retry for o-r-7");
    expect(script).toContain("emit -n 'o-r-7' --skip-gate-window-recovery gate_started");
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "gate_started",
        source: "director_retry",
        attempt: 1,
        max_attempts: 2,
      }),
    );
    expect(readEvents(runDir).some((entry) => entry.event === "needs_human")).toBe(false);
    expect(out).toContain("director: retrying initial gate for o-r-7 after gate_failed (attempt 1/2)");

    const callsAfterRetry = calls.length;
    appendEvent(runDir, "gate_failed", { exit_code: 1, reason: "gate_failed" });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(sleeps).toEqual([1000, 1000]);
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "gate_started",
        source: "director_retry",
        attempt: 2,
        max_attempts: 2,
      }),
    );
    expect(out).toContain("director: retrying initial gate for o-r-7 after gate_failed (attempt 2/2)");
    expect(
      calls
        .slice(callsAfterRetry)
        .some((call) => call[0] === "tmux" && call[1] === "new-window" && call.includes("gatekeeper")),
    ).toBe(true);

    const callsAfterSecondRetry = calls.length;
    appendEvent(runDir, "gate_failed", { exit_code: 1, reason: "gate_failed" });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(
      readEvents(runDir).some((entry) => entry.event === "needs_human" && entry["reason"] === "gate_failed"),
    ).toBe(true);
    expect(out).toContain("director: initial gate retries exhausted for o-r-7 after 2 retries");
    expect(
      calls
        .slice(callsAfterSecondRetry)
        .some((call) => call[0] === "tmux" && call[1] === "new-window" && call.includes("gatekeeper")),
    ).toBe(false);

    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(
      calls
        .slice(callsAfterSecondRetry)
        .some((call) => call[0] === "tmux" && call[1] === "new-window" && call.includes("gatekeeper")),
    ).toBe(false);
  });

  it("journals a canonical gate_started before fallback gate_failed when retry launch fails", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(h, record.id);
    mkdirSync(record.worktree, { recursive: true });
    writeCombo(runDir, record);
    appendEvent(runDir, "coder_done", {});
    appendEvent(runDir, "gate_started", {});
    appendEvent(runDir, "gate_failed", { exit_code: 1, reason: "gate_failed" });
    const headSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { deps, calls } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
      worktreeHeadSha: headSha,
      env: {
        COMBO_CHEN_GATEKEEPER_INITIAL_GATE_RETRY_ATTEMPTS: "2",
        COMBO_CHEN_GATEKEEPER_INITIAL_GATE_RETRY_BACKOFF_SECONDS: "0",
      },
    });
    deps.tmux = (args) => {
      calls.push(["tmux", ...args]);
      if (args[0] === "new-window" && args.includes(GATEKEEPER_WINDOW)) {
        return { status: 1, stdout: "", stderr: "no server running" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    const events = readEvents(runDir);
    expect(events.map((entry) => entry.event).slice(-2)).toEqual(["gate_started", "gate_failed"]);
    expect(events.at(-1)).toMatchObject({
      event: "gate_failed",
      exit_code: 1,
      reason: "retry_start_failed",
    });
  });

  it("journals needs_human after configured pre-PR gate_failed retries are exhausted", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(h, record.id);
    mkdirSync(record.worktree, { recursive: true });
    writeCombo(runDir, record);
    appendEvent(runDir, "coder_done", {});
    appendEvent(runDir, "gate_started", {});
    appendEvent(runDir, "gate_failed", { exit_code: 1, reason: "gate_failed" });
    appendEvent(runDir, "hodor_started", {});
    appendEvent(runDir, "hodor_failed", { exit_code: 2, reason: "gate_failed" });
    const { deps, calls, out } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      env: {
        COMBO_CHEN_GATEKEEPER_INITIAL_GATE_RETRY_ATTEMPTS: "1",
        COMBO_CHEN_GATEKEEPER_INITIAL_GATE_RETRY_BACKOFF_SECONDS: "0",
      },
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({ event: "needs_human", reason: "gate_failed" }),
    );
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-window")).toBe(false);
    expect(out).toContain("director: initial gate retries exhausted for o-r-7 after 1 retry");
  });

  it("inspects pre-PR coder panes and escalates unchanged CODING stalls", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(h, record.id);
    writeCombo(runDir, record);
    appendEvent(runDir, "coder_started", {});
    const { deps, out } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      env: { COMBO_CHEN_WORKER_STALL_TICKS: "2" },
    });
    deps.tmux = (args) => {
      if (args[0] === "list-windows") return { status: 0, stdout: "coder\n", stderr: "" };
      if (args[0] === "list-panes") return { status: 0, stdout: "12345\n", stderr: "" };
      if (args[0] === "capture-pane") return { status: 0, stdout: "still coding\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });
    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({ event: "needs_human", reason: "worker_stalled", worker: "coder" }),
    );
    expect(out).toContainEqual(expect.stringContaining("worker coder unchanged pane for 2 ticks"));
  });

  it("restarts a dead pre-PR coder runner without journaling needs_human", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(h, record.id);
    const windows = new Set(["coder"]);
    writeCombo(runDir, record);
    writeFileSync(join(runDir, "runner.sh"), "#!/bin/sh\nexit 0\n");
    appendEvent(runDir, "coder_started", {});
    const { deps, calls, out } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      env: { COMBO_CHEN_WORKER_RECOVERY_ATTEMPTS: "2" },
      tmux: (args) => {
        if (args[0] === "list-windows") {
          return { status: 0, stdout: `${[...windows].join("\n")}\n`, stderr: "" };
        }
        if (args[0] === "list-panes") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "kill-window") {
          windows.delete("coder");
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "new-window") {
          windows.add(String(args.at(4) ?? ""));
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "worker_recovered",
        reason: "worker_dead",
        worker: "coder",
        detail: "dead pane",
        attempt: 1,
        max_attempts: 2,
      }),
    );
    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(false);
    expect(calls).toEqual(
      expect.arrayContaining([
        ["tmux", "kill-window", "-t", "combo-chen-o-r-7:coder"],
        [
          "tmux",
          "new-window",
          "-t",
          "combo-chen-o-r-7",
          "-n",
          "coder",
          `COMBO_CHEN_RUNNER_PROGRESS=1 sh '${join(runDir, "runner.sh").replaceAll("'", "'\\''")}'`,
        ],
      ]),
    );
    expect(out).toContain("director: restarted dead coder attempt 1/2");
  });

  it("does not recover the initial coder after coder_done is journaled", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(h, record.id);
    writeCombo(runDir, record);
    writeFileSync(join(runDir, "runner.sh"), "#!/bin/sh\nexit 0\n");
    appendEvent(runDir, "coder_started", {});
    appendEvent(runDir, "coder_done", {});
    const { deps, calls } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      env: { COMBO_CHEN_WORKER_RECOVERY_ATTEMPTS: "2" },
      tmux: (args) => {
        if (args[0] === "list-windows") return { status: 0, stdout: "coder\n", stderr: "" };
        if (args[0] === "list-panes") return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir).some((event) => event.event === "worker_recovered")).toBe(false);
    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(false);
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "kill-window")).toBe(false);
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-window")).toBe(false);
  });

  it("monitors the gatekeeper successor after coder_done before gate_started", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(h, record.id);
    writeCombo(runDir, record);
    writeFileSync(join(runDir, "runner.sh"), "#!/bin/sh\nexit 0\n");
    appendEvent(runDir, "coder_started", {});
    appendEvent(runDir, "coder_done", {});
    const { deps, calls } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      env: { COMBO_CHEN_WORKER_RECOVERY_ATTEMPTS: "2" },
      tmux: (args) => {
        if (args[0] === "list-windows") return { status: 0, stdout: "coder\ngatekeeper\n", stderr: "" };
        if (args[0] === "list-panes" && String(args.at(-1)).endsWith(":gatekeeper")) {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "list-panes" && String(args.at(-1)).endsWith(":coder")) {
          return { status: 1, stdout: "", stderr: "coder should not be monitored" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "needs_human",
        reason: "worker_dead",
        worker: "gatekeeper",
        detail: "dead pane",
      }),
    );
    expect(readEvents(runDir).some((event) => event.event === "worker_recovered")).toBe(false);
    expect(
      calls.some(
        (call) =>
          call[0] === "tmux" && call[1] === "list-panes" && call.at(-1) === `${record.tmuxSession}:coder`,
      ),
    ).toBe(false);
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "kill-window")).toBe(false);
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-window")).toBe(false);
  });

  it("recovers the initial coder after coder_failed with a dead pane", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(h, record.id);
    const windows = new Set(["coder"]);
    writeCombo(runDir, record);
    writeFileSync(join(runDir, "runner.sh"), "#!/bin/sh\nexit 0\n");
    appendEvent(runDir, "coder_started", {});
    appendEvent(runDir, "coder_failed", { exit_code: 1, has_new_commits: false });
    const { deps, calls, out } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      env: { COMBO_CHEN_WORKER_RECOVERY_ATTEMPTS: "2" },
      tmux: (args) => {
        if (args[0] === "list-windows") {
          return { status: 0, stdout: `${[...windows].join("\n")}\n`, stderr: "" };
        }
        if (args[0] === "list-panes") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "kill-window") {
          windows.delete("coder");
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "new-window") {
          windows.add(String(args.at(4) ?? ""));
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "worker_recovered",
        reason: "worker_dead",
        worker: "coder",
        detail: "dead pane",
        attempt: 1,
        max_attempts: 2,
      }),
    );
    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(false);
    expect(calls).toEqual(
      expect.arrayContaining([
        ["tmux", "kill-window", "-t", "combo-chen-o-r-7:coder"],
        [
          "tmux",
          "new-window",
          "-t",
          "combo-chen-o-r-7",
          "-n",
          "coder",
          `COMBO_CHEN_RUNNER_PROGRESS=1 sh '${join(runDir, "runner.sh").replaceAll("'", "'\\''")}'`,
        ],
      ]),
    );
    expect(out).toContain("director: restarted dead coder attempt 1/2");
  });

  it("escalates a dead pre-PR coder after the restart attempt budget is exhausted", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(h, record.id);
    writeCombo(runDir, record);
    writeFileSync(join(runDir, "runner.sh"), "#!/bin/sh\nexit 0\n");
    appendEvent(runDir, "coder_started", {});
    appendEvent(runDir, "worker_recovered", {
      worker: "coder",
      reason: "worker_dead",
      detail: "dead pane",
      attempt: 1,
      max_attempts: 2,
    });
    appendEvent(runDir, "worker_recovered", {
      worker: "coder",
      reason: "worker_dead",
      detail: "dead pane",
      attempt: 2,
      max_attempts: 2,
    });
    const { deps, calls } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      env: { COMBO_CHEN_WORKER_RECOVERY_ATTEMPTS: "2" },
      tmux: (args) => {
        if (args[0] === "list-windows") {
          return { status: 0, stdout: "coder\n", stderr: "" };
        }
        if (args[0] === "list-panes") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "needs_human",
        reason: "worker_dead",
        worker: "coder",
        detail: "recovery attempts exhausted after 2; dead pane",
      }),
    );
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "kill-window")).toBe(false);
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-window")).toBe(false);
  });

  it("escalates a dead post-PR coder responder without restarting the initial runner", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(h, record.id);
    writeCombo(runDir, record);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    const { deps, calls } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      mergeStateStatus: "CLEAN",
      tmux: (args) => {
        if (args[0] === "list-windows") {
          return { status: 0, stdout: "coder\n", stderr: "" };
        }
        if (args[0] === "list-panes") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir)).not.toContainEqual(
      expect.objectContaining({ event: "needs_human", reason: "worker_dead" }),
    );
    expect(
      calls.some((call) => call[0] === "tmux" && call[1] === "new-window" && call.includes("coder")),
    ).toBe(false);
  });

  it("inspects pre-PR gatekeeper panes and escalates unchanged GATING stalls", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(h, record.id);
    writeCombo(runDir, record);
    appendEvent(runDir, "coder_done", {});
    appendEvent(runDir, "gate_started", {});
    const { deps, out } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      env: { COMBO_CHEN_WORKER_STALL_TICKS: "2" },
    });
    deps.tmux = (args) => {
      if (args[0] === "list-windows") return { status: 0, stdout: "gatekeeper\n", stderr: "" };
      if (args[0] === "list-panes") return { status: 0, stdout: "12345\n", stderr: "" };
      if (args[0] === "capture-pane") return { status: 0, stdout: "still gating\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });
    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({ event: "needs_human", reason: "worker_stalled", worker: "gatekeeper" }),
    );
    expect(out).toContainEqual(expect.stringContaining("worker gatekeeper unchanged pane for 2 ticks"));
  });

  it("recovers stalled coder responding until the configured attempt budget is exhausted", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(h, record.id);
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const windows = new Set(["coder"]);
    writeCombo(runDir, record);
    writeCoderThreadArtifact(runDir);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(runDir, "review_comment", {
      author: "external-reviewer",
      kind: "review_comment",
      url: "https://github.com/o/r/pull/7#discussion_r1",
    });
    const { deps, calls, out } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
      env: {
        COMBO_CHEN_WORKER_STALL_TICKS: "2",
        COMBO_CHEN_WORKER_RECOVERY_ATTEMPTS: "2",
      },
      tmux: (args) => {
        if (args[0] === "list-windows") {
          return { status: 0, stdout: `${[...windows].join("\n")}\n`, stderr: "" };
        }
        if (args[0] === "list-panes") {
          const target = String(args.at(2) ?? "");
          const window = target.split(":").at(1) ?? "";
          return windows.has(window)
            ? { status: 0, stdout: "0\n", stderr: "" }
            : { status: 1, stdout: "", stderr: "missing window" };
        }
        if (args[0] === "capture-pane") {
          return { status: 0, stdout: "waiting for coder responding\n", stderr: "" };
        }
        if (args[0] === "kill-window") {
          const target = String(args.at(2) ?? "");
          const window = target.split(":").at(1) ?? "";
          windows.delete(window);
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "new-window") {
          windows.add(String(args.at(4) ?? ""));
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });
    expect(calls.filter((call) => call[0] === "tmux" && call[1] === "kill-window")).toHaveLength(0);
    expect(readEvents(runDir).filter((event) => event.event === "worker_recovered")).toHaveLength(0);
    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(false);

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });
    expect(calls.filter((call) => call[0] === "tmux" && call[1] === "kill-window")).toHaveLength(1);
    expect(readEvents(runDir).filter((event) => event.event === "worker_recovered")).toHaveLength(1);
    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(false);

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });
    expect(calls.filter((call) => call[0] === "tmux" && call[1] === "kill-window")).toHaveLength(1);
    expect(readEvents(runDir).filter((event) => event.event === "worker_recovered")).toHaveLength(1);
    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(false);

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });
    expect(calls.filter((call) => call[0] === "tmux" && call[1] === "kill-window")).toHaveLength(2);
    expect(readEvents(runDir).filter((event) => event.event === "worker_recovered")).toHaveLength(2);
    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(false);

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });
    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(false);

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(calls.filter((call) => call[0] === "tmux" && call[1] === "kill-window")).toHaveLength(2);
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "needs_human",
        reason: "worker_stalled",
        worker: "coder",
        detail: "recovery attempts exhausted after 2; unchanged pane for 2 ticks",
      }),
    );
    expect(out).toContain("director: recovered stalled coder attempt 1/2");
    expect(out).toContain("director: recovered stalled coder attempt 2/2");
  });

  it("does not recycle coder-responding while an intent needs_human hold is active", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(h, record.id);
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    writeCombo(runDir, record);
    writeCoderThreadArtifact(runDir);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(runDir, "gate_validated", { sha: headSha });
    appendEvent(runDir, "needs_human", {
      reason: "intent_decision_required",
      decision: "must_make_passive_update_cache_miss_time_bounded",
      head_sha: headSha,
      source: "director_hold",
    });

    const { deps, calls, out } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
      externalReviewComments: [],
      env: {
        COMBO_CHEN_WORKER_STALL_TICKS: "2",
      },
      tmux: (args) => {
        if (args[0] === "list-windows")
          return { status: 0, stdout: "reviewer\ncoder-responding\n", stderr: "" };
        if (args[0] === "list-panes") return { status: 0, stdout: "0\n", stderr: "" };
        if (args[0] === "capture-pane")
          return { status: 0, stdout: "waiting for coder responding...\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });
    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(out).toContain("director: worker recovery paused: needs_human intent_decision_required");
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "kill-window")).toBe(false);
    expect(
      calls.some(
        (call) => call[0] === "tmux" && call[1] === "new-window" && call.includes("coder-responding"),
      ),
    ).toBe(false);
    expect(readEvents(runDir).some((event) => event.event === "worker_recovered")).toBe(false);
    expect(
      readEvents(runDir).some(
        (event) => event.event === "needs_human" && event["reason"] === "worker_stalled",
      ),
    ).toBe(false);
  });

  it("keeps polling post-PR reviewer verdicts without treating retained coder and gatekeeper panes as active workers", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(h, record.id);
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    writeCombo(runDir, record);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(runDir, "gate_validated", { sha: headSha });
    const { deps, calls, out } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
      env: {
        COMBO_CHEN_WORKER_STALL_TICKS: "2",
      },
      externalReviewComments: [
        {
          body: ["combo-chen-reviewer-verdict:", `head: ${headSha}`, "code: 1"].join("\n"),
          commitSha: headSha,
          submittedAt: "2026-06-15T00:01:00Z",
        },
      ],
    });
    deps.tmux = (args) => {
      calls.push(["tmux", ...args]);
      if (args[0] === "list-windows") {
        return { status: 0, stdout: "coder\nreviewer\ngatekeeper\ncoder-responding\n", stderr: "" };
      }
      if (args[0] === "list-panes" && args.includes("#{pane_dead}")) {
        return { status: 0, stdout: "0\n", stderr: "" };
      }
      if (args[0] === "list-panes") return { status: 0, stdout: "12345\n", stderr: "" };
      if (args[0] === "capture-pane") return { status: 0, stdout: "idle pane\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir).some((entry) => entry.event === "needs_human")).toBe(false);
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "review_comment",
        author: "external-reviewer",
        kind: "review",
        url: "https://github.com/o/r/pull/7#pullrequestreview-1",
        head_sha: headSha,
      }),
    );
    expect(calls).toContainEqual(["tmux", "send-keys", "-t", "combo-chen-o-r-7:coder", "C-m"]);
    expect(
      calls.some(
        (call) =>
          call[1] === "list-panes" &&
          call.includes("combo-chen-o-r-7:coder") &&
          !call.includes("#{pane_dead}"),
      ),
    ).toBe(false);
    expect(calls.some((call) => call.includes("combo-chen-o-r-7:gatekeeper"))).toBe(false);
    expect(out).toContain("nudged https://github.com/o/r/pull/7#pullrequestreview-1");
  });

  it("does not inspect worker panes before a pre-PR worker phase starts", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(h, record.id);
    writeCombo(runDir, record);
    const { deps, calls } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(calls.some((call) => call[0] === "tmux" && call[1] === "list-windows")).toBe(false);
    expect(readEvents(runDir).some((entry) => entry.event === "needs_human")).toBe(false);
  });

  it("escalates a reviewer permission prompt instead of silently waiting for LGTM", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { record, runDir } = seedReadyCandidate({ homeDir: h, headSha, lgtmSha: undefined });
    const { deps, out } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
    });
    deps.tmux = (args) => {
      if (args[0] === "list-windows") return { status: 0, stdout: "reviewer\n", stderr: "" };
      if (args[0] === "list-panes") return { status: 0, stdout: "12345\n", stderr: "" };
      if (args[0] === "capture-pane")
        return { status: 0, stdout: "Do you want to proceed? [y/N]\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "needs_human",
        reason: "worker_permission_prompt",
        worker: "reviewer",
      }),
    );
    expect(out).toContainEqual(expect.stringContaining("worker reviewer permission prompt"));
  });

  it("auto-approves a reviewer permission prompt when configured", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { record, runDir } = seedReadyCandidate({ homeDir: h, headSha, lgtmSha: undefined });
    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      "[monitor]\npermission_prompt_policy = 'auto-approve-known-safe'\n",
    );
    const { deps, calls, out } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
    });
    deps.tmux = (args) => {
      calls.push(["tmux", ...args]);
      if (args[0] === "list-windows") return { status: 0, stdout: "reviewer\n", stderr: "" };
      if (args[0] === "list-panes") return { status: 0, stdout: "12345\n", stderr: "" };
      if (args[0] === "capture-pane")
        return { status: 0, stdout: "Do you want to proceed? [y/N]\n", stderr: "" };
      if (args[0] === "send-keys") return { status: 0, stdout: "", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(false);
    expect(calls).toContainEqual(["tmux", "send-keys", "-t", "combo-chen-o-r-7:reviewer", "y", "C-m"]);
    expect(out).toContainEqual(expect.stringContaining("worker reviewer permission prompt auto-approved"));
  });

  it("escalates a persistent auto-approved reviewer prompt after the configured recovery budget", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { record, runDir } = seedReadyCandidate({ homeDir: h, headSha, lgtmSha: undefined });
    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      [
        "[monitor]",
        "permission_prompt_policy = 'auto-approve-known-safe'",
        "worker_recovery_attempts = 1",
      ].join("\n"),
    );
    const { deps, calls } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
    });
    deps.tmux = (args) => {
      calls.push(["tmux", ...args]);
      if (args[0] === "list-windows") return { status: 0, stdout: "reviewer\n", stderr: "" };
      if (args[0] === "list-panes") return { status: 0, stdout: "12345\n", stderr: "" };
      if (args[0] === "capture-pane")
        return { status: 0, stdout: "Do you want to proceed? [y/N]\n", stderr: "" };
      if (args[0] === "send-keys") return { status: 0, stdout: "", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });
    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(calls.filter((call) => call[0] === "tmux" && call[1] === "send-keys")).toHaveLength(1);
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "needs_human",
        reason: "worker_permission_prompt",
        worker: "reviewer",
        detail: "recovery attempts exhausted after 1; permission prompt",
      }),
    );
  });

  it("recreates a permission-prompted coder responding worker until the recovery budget is exhausted", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const windows = new Set(["coder"]);
    const record = combo();
    const runDir = runDirFor(h, record.id);
    writeCombo(runDir, record);
    writeCoderThreadArtifact(runDir);
    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      [
        "[monitor]",
        "permission_prompt_policy = 'recreate-non-interactive'",
        "worker_recovery_attempts = 1",
      ].join("\n"),
    );
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(runDir, "review_comment", {
      author: "external-reviewer",
      kind: "review_comment",
      url: "https://github.com/o/r/pull/7#discussion_r1",
    });
    const { deps, calls, out } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
      tmux: (args) => {
        if (args[0] === "list-windows") {
          return { status: 0, stdout: `${[...windows].join("\n")}\n`, stderr: "" };
        }
        if (args[0] === "list-panes") {
          const target = String(args.at(2) ?? "");
          const window = target.split(":").at(1) ?? "";
          return windows.has(window)
            ? { status: 0, stdout: "0\n", stderr: "" }
            : { status: 1, stdout: "", stderr: "missing window" };
        }
        if (args[0] === "capture-pane") {
          return { status: 0, stdout: "Do you want to proceed? [y/N]\n", stderr: "" };
        }
        if (args[0] === "kill-window") {
          const target = String(args.at(2) ?? "");
          const window = target.split(":").at(1) ?? "";
          windows.delete(window);
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "new-window") {
          windows.add(String(args.at(4) ?? ""));
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(calls.filter((call) => call[0] === "tmux" && call[1] === "kill-window")).toHaveLength(1);
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "worker_recovered",
        reason: "worker_permission_prompt",
        worker: "coder",
        attempt: 1,
        max_attempts: 1,
      }),
    );
    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(false);
    expect(out).toContain("director: recovered coder after worker_permission_prompt attempt 1/1");

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(calls.filter((call) => call[0] === "tmux" && call[1] === "kill-window")).toHaveLength(1);
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "needs_human",
        reason: "worker_permission_prompt",
        worker: "coder",
        detail: "recovery attempts exhausted after 1; permission prompt",
      }),
    );
  });

  it("passes configured permission prompt patterns into worker pane inspection", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { record, runDir } = seedReadyCandidate({ homeDir: h, headSha, lgtmSha: undefined });
    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      "[monitor]\npermission_prompt_patterns = ['^CUSTOM TOOL APPROVAL REQUIRED$']\n",
    );
    const { deps } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
    });
    deps.tmux = (args) => {
      if (args[0] === "list-windows") return { status: 0, stdout: "reviewer\n", stderr: "" };
      if (args[0] === "list-panes") return { status: 0, stdout: "12345\n", stderr: "" };
      if (args[0] === "capture-pane")
        return { status: 0, stdout: "CUSTOM TOOL APPROVAL REQUIRED\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "needs_human",
        reason: "worker_permission_prompt",
        worker: "reviewer",
      }),
    );
  });

  it("keeps director worker monitoring on the launch config snapshot after repo TOML changes", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { record, runDir } = seedReadyCandidate({ homeDir: h, headSha, lgtmSha: undefined });
    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      "[monitor]\npermission_prompt_patterns = ['^LAUNCH APPROVAL$']\n",
    );
    writeConfigSnapshot(runDir, loadConfig({ repoDir: record.repoDir, env: {} }));
    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      "[monitor]\npermission_prompt_patterns = ['^DRIFT APPROVAL$']\n",
    );
    const { deps } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
    });
    deps.tmux = (args) => {
      if (args[0] === "list-windows") return { status: 0, stdout: "reviewer\n", stderr: "" };
      if (args[0] === "list-panes") return { status: 0, stdout: "12345\n", stderr: "" };
      if (args[0] === "capture-pane") return { status: 0, stdout: "LAUNCH APPROVAL\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "needs_human",
        reason: "worker_permission_prompt",
        worker: "reviewer",
      }),
    );
  });

  it("does not escalate an unchanged reviewer pane when a reviewer artifact was just journaled", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const record = combo();
    const runDir = runDirFor(h, record.id);
    writeCombo(runDir, record);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(runDir, "lgtm", { sha: headSha });
    const { deps, out } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
      env: { COMBO_CHEN_WORKER_STALL_TICKS: "2" },
    });
    deps.tmux = (args) => {
      if (args[0] === "list-windows") return { status: 0, stdout: "reviewer\n", stderr: "" };
      if (args[0] === "list-panes") return { status: 0, stdout: "12345\n", stderr: "" };
      if (args[0] === "capture-pane") return { status: 0, stdout: "review complete\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });
    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir)).not.toContainEqual(
      expect.objectContaining({ event: "needs_human", reason: "worker_stalled", worker: "reviewer" }),
    );
    expect(out).toContainEqual(expect.stringContaining("reviewer artifact recent"));
  });

  it("leaves repeated director-watch PR label projections as no-ops when labels already match", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const record = combo();
    const runDir = runDirFor(h, record.id);
    writeCombo(runDir, record);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    const { deps, calls } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
      rollup: [
        { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", name: "ExternalReview", status: "COMPLETED", conclusion: "FAILURE" },
        { __typename: "CheckRun", name: "ExternalReview Pro", status: "COMPLETED", conclusion: "SUCCESS" },
      ],
      externalReviewComments: [],
      prLabels: [{ name: "documentation" }],
    });
    deps.tmux = (args) => {
      if (args[0] === "list-windows") return { status: 0, stdout: "reviewer\n", stderr: "" };
      if (args[0] === "list-panes") return { status: 0, stdout: "12345\n", stderr: "" };
      if (args[0] === "capture-pane") return { status: 0, stdout: "reviewing\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });
    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    const labelEditCalls = calls.filter((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "edit");
    expect(labelEditCalls).toEqual([
      ["gh", "pr", "edit", "https://github.com/o/r/pull/7", "--add-label", "combo:working"],
    ]);
    expect(readEvents(runDir).filter((event) => event.event === "pr_labels_updated")).toEqual([
      expect.objectContaining({
        event: "pr_labels_updated",
        pr_url: "https://github.com/o/r/pull/7",
        head_sha: headSha,
        old_labels: ["documentation"],
        new_labels: ["documentation", "combo:working"],
        added_labels: ["combo:working"],
        removed_labels: [],
        reason: "working",
        source: "director-watch",
      }),
    ]);
  });

  it("does not project reviewer work from a precreated idle reviewer window", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const oldSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const record = combo();
    const runDir = runDirFor(h, record.id);
    writeCombo(runDir, record);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(runDir, "gate_started", {});
    appendEvent(runDir, "gate_status", { state: "idle", head_sha: oldSha });
    appendEvent(runDir, "gate_validated", { sha: oldSha });
    const { deps, calls } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
      prLabels: [{ name: "combo:stale" }],
    });
    deps.tmux = (args) => {
      if (args[0] === "list-windows") return { status: 0, stdout: "reviewer\ngatekeeper\n", stderr: "" };
      if (args[0] === "list-panes") return { status: 0, stdout: "0\n", stderr: "" };
      if (args[0] === "capture-pane") {
        return { status: 0, stdout: idleRoleWindowCommand("reviewer"), stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(calls).toContainEqual([
      "gh",
      "pr",
      "edit",
      "https://github.com/o/r/pull/7",
      "--add-label",
      "combo:working",
    ]);
  });

  it("removes combo:ready when a required READY check is skipped", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { record, runDir } = seedReadyCandidate({ homeDir: h, headSha });
    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      ["[ready]", 'required_checks = ["CodeRabbit"]'].join("\n"),
    );
    appendEvent(runDir, "ready_for_merge", { sha: headSha, pr_url: "https://github.com/o/r/pull/7" });
    const { deps, calls } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
      rollup: [
        { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", name: "CodeRabbit", status: "COMPLETED", conclusion: "SKIPPED" },
      ],
      prLabels: [{ name: "combo:ready" }],
      externalReviewComments: [],
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(calls).not.toContainEqual([
      "gh",
      "pr",
      "edit",
      "https://github.com/o/r/pull/7",
      "--remove-label",
      "combo:ready",
    ]);
    expect(readEvents(runDir).filter((event) => event.event === "pr_labels_updated")).toEqual([]);
  });

  it("emits READY when gate, reviewer, required checks, and normal checks all agree on the current head", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { record, runDir } = seedReadyCandidate({ homeDir: h, headSha });
    const { deps } = fakeDeps({ homeDir: h, record, prHeadSha: headSha });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "ready_for_merge",
        sha: headSha,
        pr_url: "https://github.com/o/r/pull/7",
      }),
    );
  });

  it("does not prompt the director on the deterministic READY happy path", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { record, runDir } = seedReadyCandidate({ homeDir: h, headSha });
    const { deps, calls } = fakeDeps({ homeDir: h, record, prHeadSha: headSha });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    const events = readEvents(runDir);
    const directorTarget = `${record.tmuxSession}:director`;
    const directorBuffer = `combo-chen-nudge-${record.tmuxSession}-director`;
    expect(events).toContainEqual(expect.objectContaining({ event: "ready_for_merge", sha: headSha }));
    expect(events.some((entry) => entry.event === "director_prompted")).toBe(false);
    expect(calls.some((call) => call[0] === "tmux" && call.includes(directorTarget))).toBe(false);
    expect(calls.some((call) => call[0] === "tmux" && call.includes(directorBuffer))).toBe(false);
  });

  it("invalidates old READY and routes a deterministic rebase action to coder responding", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { record, runDir } = seedReadyCandidate({ homeDir: h, headSha });
    appendEvent(runDir, "ready_for_merge", { sha: headSha, pr_url: "https://github.com/o/r/pull/7" });
    writeCoderThreadArtifact(runDir);
    const { deps, calls, out } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
      mergeStateStatus: "DIRTY",
      mergeable: "CONFLICTING",
      externalReviewComments: [],
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });
    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    const conflictEvents = readEvents(runDir).filter((event) => event.event === "pr_conflict");
    expect(conflictEvents).toHaveLength(1);
    expect(conflictEvents[0]).toMatchObject({
      event: "pr_conflict",
      sha: headSha,
      pr_url: "https://github.com/o/r/pull/7",
      merge_state: "DIRTY",
      mergeable: "CONFLICTING",
      action: "rebase_required",
      source: "github",
    });
    expect(out).toContain(`director: pr_conflict ${headSha} DIRTY; action rebase_required`);
    const conflictPrompts = calls.filter(
      (call) =>
        call[0] === "tmux" &&
        call[1] === "set-buffer" &&
        typeof call.at(-1) === "string" &&
        call.at(-1)?.includes("PR conflict recovery for coder responding mode"),
    );
    expect(conflictPrompts).toHaveLength(1);
    expect(conflictPrompts[0]?.at(-1)).toContain(`head: ${headSha}`);
    expect(conflictPrompts[0]?.at(-1)).toContain("merge_state: DIRTY");
    expect(conflictPrompts[0]?.at(-1)).toContain("Rebase the combo worktree");
    expect(calls).toContainEqual([
      "tmux",
      "paste-buffer",
      "-d",
      "-b",
      "combo-chen-nudge-combo-chen-o-r-7-coder",
      "-t",
      "combo-chen-o-r-7:coder",
    ]);
  });

  it("retries the pr_conflict nudge when coder response startup fails", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { record, runDir } = seedReadyCandidate({ homeDir: h, headSha });
    appendEvent(runDir, "ready_for_merge", { sha: headSha, pr_url: "https://github.com/o/r/pull/7" });
    writeCoderThreadArtifact(runDir);

    const firstTickDeps = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
      mergeStateStatus: "DIRTY",
      externalReviewComments: [],
      tmux: (args) => {
        if (args[0] === "new-window" && args.includes("coder")) {
          return { status: 1, stdout: "", stderr: "can't find window" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await tickDirector({
      deps: firstTickDeps.deps,
      home: h,
      comboId: record.id,
      cli: "node /repo/dist/cli.mjs",
    });

    const afterFirst = readEvents(runDir).filter((e) => e.event === "pr_conflict");
    expect(afterFirst).toHaveLength(0);
    expect(firstTickDeps.out.some((line) => line.includes(`pr_conflict nudge failed for ${record.id}`))).toBe(
      true,
    );

    const secondTickDeps = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
      mergeStateStatus: "DIRTY",
      externalReviewComments: [],
    });

    await tickDirector({
      deps: secondTickDeps.deps,
      home: h,
      comboId: record.id,
      cli: "node /repo/dist/cli.mjs",
    });

    const afterSecond = readEvents(runDir).filter((e) => e.event === "pr_conflict");
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]).toMatchObject({
      event: "pr_conflict",
      sha: headSha,
      merge_state: "DIRTY",
      action: "rebase_required",
    });
    expect(secondTickDeps.out).toContain(`director: pr_conflict ${headSha} DIRTY; action rebase_required`);
  });

  it("never requests external review while waiting for its required check", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { record, runDir } = seedReadyCandidate({ homeDir: h, headSha, lgtmSha: undefined });
    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      [
        "[ready]",
        'required_checks = ["CodeRabbit"]',
        "",
        "[external_comments]",
        'agents = ["coderabbitai"]',
      ].join("\n"),
    );
    const { deps, calls, out } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
      rollup: [
        { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "StatusContext", context: "CodeRabbit", state: "PENDING" },
      ],
      externalReviewComments: [
        {
          body: [`lgtm @ ${headSha}`, "", "combo-chen-reviewer-verdict:", `head: ${headSha}`, "code: 0"].join(
            "\n",
          ),
          submittedAt: "2026-06-15T00:00:00Z",
        },
      ],
      externalCommentLogin: "teseo",
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir)).toContainEqual(expect.objectContaining({ event: "lgtm", sha: headSha }));
    expect(readEvents(runDir)).not.toContainEqual(
      expect.objectContaining({
        event: "external_review_requested",
        sha: headSha,
        command: "@coderabbitai review",
        pr_url: "https://github.com/o/r/pull/7",
      }),
    );
    const commentCall = calls.find((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "comment");
    expect(commentCall).toBeUndefined();
    expect(out).not.toContain(`director: requested external review @coderabbitai review at ${headSha}`);
    expect(readEvents(runDir).some((event) => event.event === "ready_for_merge")).toBe(false);

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(
      calls.filter((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "comment"),
    ).toHaveLength(0);
  });

  it("does not emit READY when the required external check is SUCCESS but its PR comment says review skipped", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { record, runDir } = seedReadyCandidate({ homeDir: h, headSha });
    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      [
        "[ready]",
        'required_checks = ["CodeRabbit"]',
        "",
        "[external_comments]",
        'agents = ["coderabbitai"]',
      ].join("\n"),
    );
    const { deps, calls, out } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
      rollup: [
        { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "StatusContext", context: "CodeRabbit", state: "SUCCESS" },
      ],
      prComments: [
        {
          author: { login: "coderabbitai[bot]" },
          body: "## Review skipped\nAuto reviews are disabled. Invoke @coderabbitai review.",
        },
      ],
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir)).not.toContainEqual(
      expect.objectContaining({
        event: "external_review_requested",
        sha: headSha,
        command: "@coderabbitai review",
      }),
    );
    expect(readEvents(runDir).some((event) => event.event === "ready_for_merge")).toBe(false);
    expect(
      calls.filter((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "comment"),
    ).toHaveLength(0);
    expect(out).not.toContain(`director: requested external review @coderabbitai review at ${headSha}`);
  });

  it("emits READY without an external clean comment when configured required checks pass", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { record, runDir } = seedReadyCandidate({ homeDir: h, headSha });
    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      ["[ready]", 'required_checks = ["ExternalReview"]'].join("\n"),
    );
    const { deps } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
      externalReviewComments: [
        {
          body: "Review skipped: rate limited for this account.",
          submittedAt: "2026-06-15T00:01:00Z",
        },
      ],
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "ready_for_merge",
        sha: headSha,
        pr_url: "https://github.com/o/r/pull/7",
      }),
    );
  });

  it("does not emit READY until every configured required check is present with SUCCESS", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { record, runDir } = seedReadyCandidate({ homeDir: h, headSha });
    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      ["[ready]", 'required_checks = ["ExternalReview", "ReviewDog"]'].join("\n"),
    );
    const { deps } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
      rollup: [
        { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", name: "ExternalReview", status: "COMPLETED", conclusion: "SUCCESS" },
      ],
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir).some((event) => event.event === "ready_for_merge")).toBe(false);
  });

  it("does not emit READY when a configured READY check is skipped", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { record, runDir } = seedReadyCandidate({ homeDir: h, headSha });
    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      ["[ready]", 'required_checks = ["CodeRabbit"]'].join("\n"),
    );
    const { deps } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
      rollup: [
        { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", name: "CodeRabbit", status: "COMPLETED", conclusion: "SKIPPED" },
      ],
      externalReviewComments: [],
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir).some((event) => event.event === "ready_for_merge")).toBe(false);
  });

  it("uses the configured external comment agent instead of a hardcoded provider", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { record, runDir } = seedReadyCandidate({ homeDir: h, headSha });
    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      [
        "[external_comments]",
        'agents = ["reviewdog"]',
        "",
        "[reviewer.claude]",
        'command = "claude {prompt}"',
      ].join("\n"),
    );
    const { deps } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
      externalCommentLogin: "reviewdog",
      rollup: [
        { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", name: "CodeRabbit", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", name: "ReviewDog", status: "COMPLETED", conclusion: "SUCCESS" },
      ],
      externalReviewComments: [
        {
          body: "ReviewDog review complete. No issues found.",
          commitSha: headSha,
          submittedAt: "2026-06-15T00:00:00Z",
        },
      ],
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "ready_for_merge",
        sha: headSha,
        pr_url: "https://github.com/o/r/pull/7",
      }),
    );
  });

  it("keeps READY ambient reviewer matching on the launch config snapshot after repo TOML changes", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { record, runDir } = seedReadyCandidate({ homeDir: h, headSha });
    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      ["[reviewer]", 'ambient = ["reviewdog"]', "", "[reviewer.claude]", 'command = "claude {prompt}"'].join(
        "\n",
      ),
    );
    writeConfigSnapshot(runDir, loadConfig({ repoDir: record.repoDir, env: {} }));
    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      ["[reviewer]", 'ambient = ["driftbot"]', "", "[reviewer.claude]", 'command = "claude {prompt}"'].join(
        "\n",
      ),
    );
    const { deps } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
      externalCommentLogin: "reviewdog",
      rollup: [
        { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", name: "CodeRabbit", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", name: "ReviewDog", status: "COMPLETED", conclusion: "SUCCESS" },
      ],
      externalReviewComments: [
        {
          body: "ReviewDog review complete. No issues found.",
          commitSha: headSha,
          submittedAt: "2026-06-15T00:00:00Z",
        },
      ],
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "ready_for_merge",
        sha: headSha,
        pr_url: "https://github.com/o/r/pull/7",
      }),
    );
  });

  it("reuses each paginated GitHub API endpoint within one director tick", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { record } = seedReadyCandidate({ homeDir: h, headSha });
    const { deps, calls } = fakeDeps({ homeDir: h, record, prHeadSha: headSha });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    const apiEndpoints = calls
      .filter((call) => call[0] === "gh" && call[1] === "api")
      .map((call) => call.find((part) => part.startsWith("repos/")));

    expect(apiEndpoints).toEqual([
      "repos/o/r/issues/7/comments",
      "repos/o/r/pulls/7/comments",
      "repos/o/r/pulls/7/reviews",
    ]);
  });

  it("emits READY even when an external comment agent only reports a rate-limited review skip", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { record, runDir } = seedReadyCandidate({ homeDir: h, headSha });
    const { deps } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
      externalReviewComments: [
        {
          body: "ExternalReview review complete. No issues found.",
          submittedAt: "2026-06-15T00:00:00Z",
        },
        {
          body: "Review skipped: rate limited for this account.",
          submittedAt: "2026-06-15T00:01:00Z",
        },
      ],
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({ event: "ready_for_merge", sha: headSha }),
    );
  });

  it("does not emit READY when the current head has a failing check rollup", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { record, runDir } = seedReadyCandidate({ homeDir: h, headSha });
    const { deps } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
      rollup: [
        { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" },
        { __typename: "CheckRun", name: "ExternalReview", status: "COMPLETED", conclusion: "SUCCESS" },
      ],
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir).some((event) => event.event === "ready_for_merge")).toBe(false);
  });

  it("does not emit READY when the journaled gate and LGTM belong to a stale SHA", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const oldSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const newSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { record, runDir } = seedReadyCandidate({
      homeDir: h,
      headSha: newSha,
      gateSha: oldSha,
      lgtmSha: oldSha,
    });
    const { deps } = fakeDeps({ homeDir: h, record, prHeadSha: newSha, worktreeHeadSha: oldSha });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir).some((event) => event.event === "ready_for_merge")).toBe(false);
  });

  it("restores READY after a conflict only after new-head gate and reviewer agreement", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const oldSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const newSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { record, runDir } = seedReadyCandidate({
      homeDir: h,
      headSha: oldSha,
    });
    appendEvent(runDir, "ready_for_merge", { sha: oldSha, pr_url: "https://github.com/o/r/pull/7" });
    appendEvent(runDir, "pr_conflict", {
      sha: oldSha,
      pr_url: "https://github.com/o/r/pull/7",
      merge_state: "DIRTY",
      action: "rebase_required",
      source: "github",
    });
    appendEvent(runDir, "address_done", { head_sha: newSha });
    appendEvent(runDir, "gate_stale", { old_sha: oldSha, new_sha: newSha });
    appendEvent(runDir, "gate_validated", { sha: newSha });
    appendEvent(runDir, "lgtm_stale", { old_sha: oldSha, new_sha: newSha });
    appendEvent(runDir, "lgtm", { sha: newSha });
    const { deps } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: newSha,
      worktreeHeadSha: newSha,
      externalReviewComments: [],
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "ready_for_merge",
        sha: newSha,
        pr_url: "https://github.com/o/r/pull/7",
      }),
    );
  });

  it("re-pins a local gate SHA to the pushed PR head when GitHub checks are green", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const localSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const prHeadSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const record = combo();
    const runDir = runDirFor(h, record.id);
    writeCombo(runDir, record);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(runDir, "gate_status", { state: "idle", head_sha: localSha });
    appendEvent(runDir, "lgtm", { sha: prHeadSha });
    const { deps } = fakeDeps({ homeDir: h, record, prHeadSha });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({ event: "gate_validated", sha: prHeadSha, source: "github" }),
    );
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({ event: "ready_for_merge", sha: prHeadSha }),
    );
  });

  it("recovers READY when no-mistakes daemon dies after CI passes at the PR head", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const localSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const prHeadSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const record = combo();
    const runDir = runDirFor(h, record.id);
    writeCombo(runDir, record);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(runDir, "gate_status", { state: "failed", head_sha: localSha });
    appendEvent(runDir, "gate_failed", { exit_code: "1", reason: "daemon_dead" });
    appendEvent(runDir, "lgtm", { sha: prHeadSha });
    const { deps } = fakeDeps({ homeDir: h, record, prHeadSha });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({ event: "gate_status", state: "idle", head_sha: prHeadSha, source: "github" }),
    );
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({ event: "ready_for_merge", sha: prHeadSha }),
    );
  });

  it("does not recover READY from a generic no-mistakes gate failure", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const localSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const prHeadSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const record = combo();
    const runDir = runDirFor(h, record.id);
    writeCombo(runDir, record);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(runDir, "gate_status", { state: "failed", head_sha: localSha });
    appendEvent(runDir, "gate_failed", { exit_code: "1", reason: "gate_failed" });
    appendEvent(runDir, "lgtm", { sha: prHeadSha });
    const { deps } = fakeDeps({ homeDir: h, record, prHeadSha });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir).some((event) => event.event === "ready_for_merge")).toBe(false);
    expect(
      readEvents(runDir).some((event) => event.event === "gate_validated" && event["source"] === "github"),
    ).toBe(false);
  });

  it("auto-closes a merged PR after reviewer records closure pending", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(h, record.id);
    writeCombo(runDir, record);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(runDir, "gate_status", { state: "idle", head_sha: "head456" });
    const { deps, calls, out } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: "head456",
      prState: "MERGED",
      mergeSha: "merge789",
      mergedBy: "maintainer",
      mergedAt: "2026-06-11T11:20:00.000Z",
      issueComments: [
        {
          html_url: "https://github.com/o/r/pull/7#issuecomment-1",
          user: { login: "reviewer" },
          body: "Please handle this.",
        },
      ],
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "merged",
        sha: "merge789",
        by: "maintainer",
        source: "reviewer",
      }),
    );
    expect(readEvents(runDir).some((event) => event.event === "review_comment")).toBe(false);
    expect(readEvents(runDir).some((event) => event.event === "gate_stale")).toBe(false);
    expect(readEvents(runDir).some((event) => event.event === "ready_for_merge")).toBe(false);
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({ event: "combo_closed", source: "closure" }),
    );
    expect(calls).toContainEqual([
      "treehouse",
      `cwd=${record.repoDir}`,
      "return",
      "--force",
      record.worktree,
    ]);
    expect(calls).toContainEqual(["git", `cwd=${record.repoDir}`, "branch", "-D", record.branch]);
    expect(calls).toContainEqual(["tmux", "kill-session", "-t", record.tmuxSession]);
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-window")).toBe(false);
    expect(out).toContain(
      "reviewer: merged merge789 by maintainer; closure pending: combo-chen closure -n o-r-7",
    );
    expect(out).toContain("closure: o-r-7 closed merged PR merge789 by maintainer; teardown complete");
    expect(out.some((line) => line.startsWith("director: watch "))).toBe(true);
    expect(out.some((line) => line === "director: tick complete for o-r-7")).toBe(false);
  });

  it("does not trigger closure convergence again once combo_closed is already journaled", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(h, record.id);
    writeCombo(runDir, record);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(runDir, "merged", { sha: "merge789", by: "maintainer", source: "reviewer" });
    appendEvent(runDir, "combo_closed", { source: "closure" });
    const { deps, calls, out } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: "head456",
      prState: "MERGED",
      mergeSha: "merge789",
      mergedBy: "maintainer",
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(calls.some((call) => call[0] === "treehouse")).toBe(false);
    expect(calls.some((call) => call[0] === "no-mistakes")).toBe(false);
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "kill-session")).toBe(false);
    expect(readEvents(runDir).filter((event) => event.event === "combo_closed")).toHaveLength(1);
    expect(out).toContain("reviewer: already terminal at combo_closed");
    expect(out).not.toContain("closure: o-r-7 already closed");
  });

  it("retries closure convergence on a later tick when no-mistakes stops blocking teardown", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(h, record.id);
    writeCombo(runDir, record);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    let noMistakesActive = true;
    const { deps, calls, out } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: "head456",
      prState: "MERGED",
      mergeSha: "merge789",
      mergedBy: "maintainer",
      noMistakes: (args, cwd) => {
        calls.push(["no-mistakes", `cwd=${cwd}`, ...args]);
        if (!noMistakesActive) return { status: 1, stdout: "", stderr: "No active run." };
        return {
          status: 0,
          stdout: [
            "run:",
            "  branch: combo/issue-7",
            "  status: running",
            "  steps[1]{step,status,findings,duration_ms}:",
            "    test,running,0,0",
          ].join("\n"),
          stderr: "",
        };
      },
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({ event: "merged", sha: "merge789", source: "reviewer" }),
    );
    expect(readEvents(runDir).some((event) => event.event === "combo_closed")).toBe(false);
    expect(calls.some((call) => call[0] === "treehouse")).toBe(false);
    expect(out).toContain(
      "closure: o-r-7 refused: no-mistakes active run remains for combo/issue-7 (no-mistakes running test)",
    );

    noMistakesActive = false;
    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir).filter((event) => event.event === "merged")).toHaveLength(1);
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({ event: "combo_closed", source: "closure" }),
    );
    expect(calls).toContainEqual([
      "treehouse",
      `cwd=${record.repoDir}`,
      "return",
      "--force",
      record.worktree,
    ]);
    expect(calls).toContainEqual(["tmux", "kill-session", "-t", record.tmuxSession]);
  });

  it("starts a post-address gate only when an actionable nudge is followed by a new committed HEAD", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(repoDir, ".no-mistakes.yaml"), "commands:\n  test: pnpm test\n");
    const record = combo({ repoDir, worktree });
    const runDir = runDirFor(h, record.id);
    const oldSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const newSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    writeCombo(runDir, record);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(runDir, "gate_status", { state: "idle", head_sha: oldSha });
    writeCoderThreadArtifact(runDir);
    const gitCalls: string[][] = [];
    const { deps, calls, out } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: oldSha,
      externalReviewComments: [],
      issueComments: [
        {
          html_url: "https://github.com/o/r/pull/7#issuecomment-1",
          user: { login: "reviewer" },
          body: "Please handle this.",
        },
      ],
      git: (args, cwd) => {
        gitCalls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "remote" && args[1] === "get-url" && args[2] === "no-mistakes") {
          return { status: 2, stdout: "", stderr: "No such remote 'no-mistakes'" };
        }
        if (cwd === worktree && args[0] === "rev-parse" && args[1] === "HEAD") {
          return { status: 0, stdout: `${newSha}\n`, stderr: "" };
        }
        if (args[0] === "status" && args[1] === "--porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (
          args[0] === "merge-base" &&
          args[1] === "--is-ancestor" &&
          args[2] === oldSha &&
          args[3] === newSha
        ) {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
      },
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({ event: "address_done", head_sha: newSha }),
    );
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({ event: "gate_stale", old_sha: oldSha, new_sha: newSha }),
    );
    const gatekeeperWindow = calls.find(
      (call) => call[0] === "tmux" && call[1] === "new-window" && call.includes(GATEKEEPER_WINDOW),
    );
    const scriptPath = join(runDir, `gatekeeper-post-${newSha.slice(0, 12)}.sh`);
    expect(gatekeeperWindow?.at(-1)).toContain(`sh '${scriptPath}'`);
    expect(gatekeeperWindow?.at(-1)).toContain(
      "[combo-chen] gatekeeper idle; waiting for the next current-head run.",
    );
    expect(readFileSync(scriptPath, "utf8")).toContain("post-address gate");
    expect(readFileSync(join(worktree, ".no-mistakes.yaml"), "utf8")).toBe("commands:\n  test: pnpm test\n");
    expect(out).toContain(`no-mistakes: copied local config to ${worktree}/.no-mistakes.yaml`);
  });

  it("starts the post-conflict gate after coder rebases to a new committed HEAD", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const oldSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const newSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { record, runDir } = seedReadyCandidate({ homeDir: h, headSha: oldSha });
    appendEvent(runDir, "ready_for_merge", { sha: oldSha, pr_url: "https://github.com/o/r/pull/7" });
    appendEvent(runDir, "pr_conflict", {
      sha: oldSha,
      pr_url: "https://github.com/o/r/pull/7",
      merge_state: "DIRTY",
      action: "rebase_required",
      source: "github",
    });
    const { deps, calls } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: newSha,
      worktreeHeadSha: newSha,
      externalReviewComments: [],
      git: (args, cwd) => {
        if (args[0] === "remote" && args[1] === "get-url" && args[2] === "no-mistakes") {
          return { status: 2, stdout: "", stderr: "No such remote 'no-mistakes'" };
        }
        if (cwd === record.worktree && args[0] === "rev-parse" && args[1] === "HEAD") {
          return { status: 0, stdout: `${newSha}\n`, stderr: "" };
        }
        if (args[0] === "status" && args[1] === "--porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (
          args[0] === "merge-base" &&
          args[1] === "--is-ancestor" &&
          args[2] === oldSha &&
          args[3] === newSha
        ) {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
      },
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({ event: "address_done", head_sha: newSha }),
    );
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({ event: "gate_stale", old_sha: oldSha, new_sha: newSha }),
    );
    const gatekeeperWindow = calls.find(
      (call) => call[0] === "tmux" && call[1] === "new-window" && call.includes(GATEKEEPER_WINDOW),
    );
    const scriptPath = join(runDir, `gatekeeper-post-${newSha.slice(0, 12)}.sh`);
    expect(gatekeeperWindow?.at(-1)).toContain(`sh '${scriptPath}'`);
    expect(gatekeeperWindow?.at(-1)).toContain(
      "[combo-chen] gatekeeper idle; waiting for the next current-head run.",
    );
    expect(readFileSync(scriptPath, "utf8")).toContain("post-address gate");
  });

  it("routes local worktree sync recovery when the worktree is behind the published PR head", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    mkdirSync(worktree, { recursive: true });
    const record = combo({ repoDir, worktree });
    const runDir = runDirFor(h, record.id);
    const localSha = "70550c6f2fd5b5c6b372bba10c6a01be0e8756d0";
    const publishedSha = "7b93e50b160e564952f850ca5db12cf5c52d40b3";
    writeCombo(runDir, record);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(runDir, "gate_status", { state: "idle", head_sha: publishedSha });
    appendEvent(runDir, "gate_validated", { sha: publishedSha });
    appendEvent(runDir, "lgtm", { sha: publishedSha });
    appendEvent(runDir, "ready_for_merge", {
      sha: publishedSha,
      pr_url: "https://github.com/o/r/pull/7",
    });
    writeCoderThreadArtifact(runDir);
    const { deps, calls, out } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: publishedSha,
      worktreeHeadSha: localSha,
      externalReviewComments: [],
      issueComments: [
        {
          html_url: "https://github.com/o/r/pull/7#issuecomment-1",
          user: { login: "coderabbitai[bot]" },
          body: "Please address this actionable review comment.",
          created_at: "2026-06-24T07:22:48Z",
        },
      ],
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (cwd === worktree && args[0] === "rev-parse" && args[1] === "HEAD") {
          return { status: 0, stdout: `${localSha}\n`, stderr: "" };
        }
        if (args[0] === "status" && args[1] === "--porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (
          cwd === worktree &&
          args[0] === "merge-base" &&
          args[1] === "--is-ancestor" &&
          args[2] === publishedSha &&
          args[3] === localSha
        ) {
          return { status: 1, stdout: "", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
      },
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir).some((event) => event.event === "address_done")).toBe(false);
    expect(readEvents(runDir).some((event) => event.event === "gate_stale")).toBe(false);
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "pr_conflict",
        sha: localSha,
        published_sha: publishedSha,
        local_sha: localSha,
        pr_url: "https://github.com/o/r/pull/7",
        merge_state: "LOCAL_OUT_OF_SYNC",
        action: "rebase_required",
        source: "local_worktree",
      }),
    );
    expect(calls.some((call) => call[0] === "tmux" && call.includes("gatekeeper"))).toBe(false);
    expect(out).toContain(
      `director: worktree HEAD ${localSha} does not include published gate ${publishedSha}; waiting for coder sync before post-address gate`,
    );
    expect(out).toContain(
      `director: local worktree ${localSha} does not include published gate ${publishedSha}; action rebase_required`,
    );
    const syncPrompts = calls.filter(
      (call) =>
        call[0] === "tmux" &&
        call[1] === "set-buffer" &&
        typeof call.at(-1) === "string" &&
        call.at(-1)?.includes("Local PR head sync recovery for coder responding mode"),
    );
    expect(syncPrompts).toHaveLength(1);
    expect(syncPrompts[0]?.at(-1)).toContain(`published_gate: ${publishedSha}`);
    expect(syncPrompts[0]?.at(-1)).toContain(`local_head: ${localSha}`);
  });

  it("does not start a post-address gate for LGTM/bookkeeping artifacts without a coder HEAD change", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const previousGateSha = "8ad6cca0d0d0b5d33be0e4e529b397aa7a33c0f4";
    const currentHead = "73f80173a96fc2d70af0972c6ee936cc59ad5f19";
    const { record, runDir } = seedReadyCandidate({
      homeDir: h,
      headSha: currentHead,
      gateSha: previousGateSha,
      lgtmSha: currentHead,
    });
    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      ["[external_comments]", 'agents = ["external-reviewer"]'].join("\n"),
    );
    const { deps, calls } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: currentHead,
      worktreeHeadSha: currentHead,
      issueComments: [
        {
          body: [
            "@external-reviewer review",
            "",
            "Codex -- Re-running external-reviewer for current PR #82 head 73f80173.",
          ].join("\n"),
          html_url: "https://github.com/o/r/pull/7#issuecomment-1",
          user: { login: "maintainer-bot" },
          created_at: "2026-06-15T02:51:55Z",
        },
      ],
      externalReviewComments: [
        {
          body: `lgtm @ ${currentHead}\n\nRuntime review. No findings.`,
          commitSha: currentHead,
          submittedAt: "2026-06-15T02:54:18Z",
        },
      ],
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir).filter((event) => event.event === "review_comment")).toEqual([]);
    expect(readEvents(runDir).some((event) => event.event === "address_done")).toBe(false);
    expect(readEvents(runDir).some((event) => event.event === "gate_stale")).toBe(false);
    expect(calls.some((call) => call[0] === "tmux" && call.includes("gatekeeper"))).toBe(false);
  });
});
// -/ 2/2
