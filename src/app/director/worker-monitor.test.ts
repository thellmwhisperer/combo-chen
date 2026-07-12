/**
 * @overview Unit tests for worker pane monitoring. ~1060 lines, permission
 *   prompt learning/escalation, unchanged-pane stall, and dead-pane escalation.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at inspectWorkerPanes tests <- one tick of worker inspection.
 *   2. Use fixture helpers              <- fake combo/run dir + tmux outputs.
 *
 *   MAIN FLOW
 *   ---------
 *   fake tmux panes -> inspectWorkerPanes -> learning/needs_human events + snapshot file
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   combo, fakeDeps
 *
 * @exports none
 * @deps ../../core/events, ../../core/state, ../runtime/sessions, ./worker-monitor, node:fs, node:os, node:path, vitest
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appendEvent, readEvents } from "../../core/events.js";
import { runDirFor, writeCombo, type ComboRecord } from "../../core/state.js";
import { idleRoleWindowCommand } from "../runtime/sessions.js";
import { inspectWorkerPanes, type WorkerMonitorDeps } from "./worker-monitor.js";

// -- 1/1 CORE · inspectWorkerPanes tests <- START HERE --
function combo(): { record: ComboRecord; runDir: string } {
  const home = mkdtempSync(join(tmpdir(), "combo-chen-worker-home-"));
  const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-worker-repo-"));
  const record: ComboRecord = {
    id: "o-r-7",
    issueUrl: "https://github.com/o/r/issues/7",
    repoDir,
    worktree: join(repoDir, ".worktrees", "issue-7"),
    branch: "combo/issue-7",
    tmuxSession: "combo-chen-o-r-7",
    createdAt: new Date(0).toISOString(),
  };
  const runDir = runDirFor(home, record.id);
  writeCombo(runDir, record);
  return { record, runDir };
}

function fakeDeps(panes: Record<string, string | undefined>): {
  deps: WorkerMonitorDeps;
  out: string[];
  calls: string[][];
} {
  const out: string[] = [];
  const calls: string[][] = [];
  return {
    out,
    calls,
    deps: {
      out: (line) => out.push(line),
      tmux: (args) => {
        calls.push(args);
        if (args[0] === "list-windows") {
          return { status: 0, stdout: `${Object.keys(panes).join("\n")}\n`, stderr: "" };
        }
        if (args[0] === "list-panes") {
          const target = String(args.at(2) ?? "");
          const window = target.split(":").at(1) ?? "";
          return panes[window] === undefined
            ? { status: 0, stdout: "", stderr: "" }
            : { status: 0, stdout: "12345\n", stderr: "" };
        }
        if (args[0] === "capture-pane") {
          const target = String(args.at(-1) ?? "");
          const window = target.split(":").at(1) ?? "";
          const pane = panes[window];
          return pane === undefined
            ? { status: 1, stdout: "", stderr: "pane dead" }
            : { status: 0, stdout: pane, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    },
  };
}

describe("inspectWorkerPanes", () => {
  it("emits needs_human within one tick when a worker is waiting on a permission prompt", () => {
    const { record, runDir } = combo();
    const { deps, out } = fakeDeps({
      reviewer: "Do you want to proceed? [y/N]\n",
    });

    const result = inspectWorkerPanes({ deps, combo: record, runDir, workerWindows: ["reviewer"] });

    expect(result.escalated).toBe(true);
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "needs_human",
        reason: "worker_permission_prompt",
        worker: "reviewer",
      }),
    );
    expect(out).toContainEqual(expect.stringContaining("worker reviewer permission prompt"));
  });

  it("captures the requested tool and command as a learning signal without approving it", () => {
    const { record, runDir } = combo();
    const { deps, calls } = fakeDeps({
      reviewer: "This command requires approval: node scripts/review.js\n",
    });

    const result = inspectWorkerPanes({
      deps,
      combo: record,
      runDir,
      workerWindows: ["reviewer"],
      permissionPromptPolicy: "auto-approve-known-safe",
    });

    expect(result.escalated).toBe(true);
    expect(calls.some((call) => call[0] === "send-keys")).toBe(false);
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "permission_prompt_detected",
        worker: "reviewer",
        tool: "node",
        command: "node scripts/review.js",
      }),
    );
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "needs_human",
        reason: "worker_permission_prompt",
        worker: "reviewer",
        detail: expect.stringContaining("add the tool to reviewer's allowed_tools"),
      }),
    );
  });

  it("does not treat ordinary review prose about permission prompts as an interactive prompt", () => {
    const { record, runDir } = combo();
    const { deps } = fakeDeps({
      reviewer: "The review skill mentions permission prompt handling and asks whether to continue?\n",
    });

    const result = inspectWorkerPanes({ deps, combo: record, runDir, workerWindows: ["reviewer"] });

    expect(result.escalated).toBe(false);
    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(false);
  });

  it("uses configured permission prompt patterns", () => {
    const { record, runDir } = combo();
    const { deps } = fakeDeps({
      reviewer: "CUSTOM TOOL APPROVAL REQUIRED\n",
    });

    const result = inspectWorkerPanes({
      deps,
      combo: record,
      runDir,
      workerWindows: ["reviewer"],
      permissionPromptPatterns: ["^CUSTOM TOOL APPROVAL REQUIRED$"],
    });

    expect(result.escalated).toBe(true);
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "needs_human",
        reason: "worker_permission_prompt",
        worker: "reviewer",
      }),
    );
  });

  it("never recreates a permission-prompted worker instead of recording the decision", () => {
    const { record, runDir } = combo();
    const { deps } = fakeDeps({
      "coder-responding": "Do you want to proceed? [y/N]\n",
    });

    const result = inspectWorkerPanes({
      deps,
      combo: record,
      runDir,
      workerWindows: ["coder-responding"],
      recoverablePermissionPromptWorkers: ["coder-responding"],
      permissionPromptPolicy: "recreate-non-interactive",
    });

    expect(result.escalated).toBe(true);
    expect(result.findings).toEqual([
      {
        worker: "coder-responding",
        reason: "worker_permission_prompt",
        detail: expect.stringContaining("grant, add the tool"),
        needsHumanRecorded: true,
      },
    ]);
    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(true);
  });

  it("uses the configured unchanged-pane threshold", () => {
    const { record, runDir } = combo();
    const { deps } = fakeDeps({
      reviewer: "waiting for review...\n",
    });

    expect(
      inspectWorkerPanes({ deps, combo: record, runDir, workerWindows: ["reviewer"], stallTicks: 2 })
        .escalated,
    ).toBe(false);
    const result = inspectWorkerPanes({
      deps,
      combo: record,
      runDir,
      workerWindows: ["reviewer"],
      stallTicks: 2,
    });

    expect(result.escalated).toBe(true);
    expect(result.summaries).toContain("worker reviewer: unchanged_ticks=2; no orchestrator evidence");
  });

  it("does not flag a stalled-looking gatekeeper when no-mistakes has an active run for the combo branch", () => {
    const { record, runDir } = combo();
    const { deps, out } = fakeDeps({
      gatekeeper: "validating quietly...\n",
    });
    const noMistakesDeps: WorkerMonitorDeps = {
      ...deps,
      noMistakes: (args, cwd) => {
        expect(args).toEqual(["axi", "status"]);
        expect(cwd).toBe(record.worktree);
        return {
          status: 0,
          stdout: [
            "id: e2e-run",
            `  branch: ${record.branch}`,
            "  status: active",
            "steps[0]{",
            "  test,running",
            "}",
            "",
          ].join("\n"),
          stderr: "",
        };
      },
    };

    expect(
      inspectWorkerPanes({
        deps: noMistakesDeps,
        combo: record,
        runDir,
        workerWindows: ["gatekeeper"],
        stallTicks: 2,
        gatekeeperStatusTimeoutMs: 5000,
      }).escalated,
    ).toBe(false);
    const result = inspectWorkerPanes({
      deps: noMistakesDeps,
      combo: record,
      runDir,
      workerWindows: ["gatekeeper"],
      stallTicks: 2,
      gatekeeperStatusTimeoutMs: 5000,
    });

    expect(result.escalated).toBe(false);
    expect(result.summaries).toContain("worker gatekeeper: unchanged_ticks=2; gate run active");
    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(false);
    expect(out).toContainEqual(expect.stringContaining("gate run active"));
  });

  it("bounds the gatekeeper no-mistakes status probe and continues stall handling when it fails", () => {
    const { record, runDir } = combo();
    const { deps } = fakeDeps({
      gatekeeper: "validating quietly...\n",
    });
    const timeouts: Array<number | undefined> = [];
    const noMistakesDeps: WorkerMonitorDeps = {
      ...deps,
      noMistakes: (_args, _cwd, options?: { timeoutMs?: number }) => {
        timeouts.push(options?.timeoutMs);
        return { status: 1, stdout: "", stderr: "spawnSync no-mistakes ETIMEDOUT" };
      },
    };

    expect(
      inspectWorkerPanes({
        deps: noMistakesDeps,
        combo: record,
        runDir,
        workerWindows: ["gatekeeper"],
        stallTicks: 2,
        gatekeeperStatusTimeoutMs: 5000,
      }).escalated,
    ).toBe(false);
    const result = inspectWorkerPanes({
      deps: noMistakesDeps,
      combo: record,
      runDir,
      workerWindows: ["gatekeeper"],
      stallTicks: 2,
      gatekeeperStatusTimeoutMs: 5000,
    });

    expect(result.escalated).toBe(true);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeGreaterThan(0);
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({ event: "needs_human", reason: "worker_stalled", worker: "gatekeeper" }),
    );
  });

  it("uses the configured gatekeeper status timeout for no-mistakes evidence", () => {
    const { record, runDir } = combo();
    const { deps } = fakeDeps({
      gatekeeper: "validating quietly...\n",
    });
    const timeouts: number[] = [];
    const noMistakesDeps: WorkerMonitorDeps = {
      ...deps,
      noMistakes: (_args, _cwd, options?: { timeoutMs?: number }) => {
        if (options?.timeoutMs !== undefined) timeouts.push(options.timeoutMs);
        return {
          status: 0,
          stdout: ["id: e2e-run", `branch: ${record.branch}`, "status: active", ""].join("\n"),
          stderr: "",
        };
      },
    };

    inspectWorkerPanes({
      deps: noMistakesDeps,
      combo: record,
      runDir,
      workerWindows: ["gatekeeper"],
      stallTicks: 2,
      gatekeeperStatusTimeoutMs: 1234,
    });
    const result = inspectWorkerPanes({
      deps: noMistakesDeps,
      combo: record,
      runDir,
      workerWindows: ["gatekeeper"],
      stallTicks: 2,
      gatekeeperStatusTimeoutMs: 1234,
    });

    expect(result.escalated).toBe(false);
    expect(timeouts).toEqual([1234]);
  });

  it("does not flag a stalled-looking reviewer after a recent reviewer artifact", () => {
    const { record, runDir } = combo();
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(runDir, "lgtm", { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
    const { deps, out } = fakeDeps({
      reviewer: "review complete; waiting for director...\n",
    });

    expect(
      inspectWorkerPanes({
        deps,
        combo: record,
        runDir,
        workerWindows: ["reviewer"],
        stallTicks: 2,
      }).escalated,
    ).toBe(false);
    const result = inspectWorkerPanes({
      deps,
      combo: record,
      runDir,
      workerWindows: ["reviewer"],
      stallTicks: 2,
    });

    expect(result.escalated).toBe(false);
    expect(result.summaries).toContain("worker reviewer: unchanged_ticks=2; reviewer artifact recent");
    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(false);
    expect(out).toContainEqual(expect.stringContaining("reviewer artifact recent"));
  });

  it("does not use stale reviewer artifacts as active reviewer evidence", () => {
    const { record, runDir } = combo();
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(runDir, "lgtm", { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    appendEvent(runDir, "lgtm_stale", {
      old_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      new_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    const { deps } = fakeDeps({
      reviewer: "reviewing new head...\n",
    });

    expect(
      inspectWorkerPanes({
        deps,
        combo: record,
        runDir,
        workerWindows: ["reviewer"],
        stallTicks: 2,
      }).escalated,
    ).toBe(false);
    const result = inspectWorkerPanes({
      deps,
      combo: record,
      runDir,
      workerWindows: ["reviewer"],
      stallTicks: 2,
    });

    expect(result.escalated).toBe(true);
    expect(result.summaries).toContain("worker reviewer: unchanged_ticks=2; no orchestrator evidence");
  });

  it("reports gnhf terminal failures as dead workers", () => {
    const { record, runDir } = combo();
    const { deps, out } = fakeDeps({
      coder: [
        "00:47:43  ·  21.8M in  ·  92K out  ·  7 commits",
        '{"success":false,"summary":"The branch already contains commits, and GitHub has no PR yet."}',
        "[ctrl+c to stop, gnhf again to resume]",
        "",
      ].join("\n"),
    });

    const result = inspectWorkerPanes({ deps, combo: record, runDir, workerWindows: ["coder"] });

    expect(result.escalated).toBe(true);
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "needs_human",
        reason: "worker_dead",
        worker: "coder",
        detail: "gnhf stopped without success",
      }),
    );
    expect(out).toContainEqual(expect.stringContaining("worker coder gnhf stopped without success"));
  });

  it("does not kill a live coder whose pane matches the terminal fingerprint", () => {
    const { record, runDir } = combo();
    // Healthy gnhf state: the TUI footer is always visible and codex streams
    // interim contract JSON ("not done yet") throughout an iteration.
    const gnhfRunDir = join(record.worktree, ".gnhf", "runs", "implement-github-iss-live");
    mkdirSync(gnhfRunDir, { recursive: true });
    writeFileSync(
      join(gnhfRunDir, "gnhf.log"),
      '{"event":"iteration:start","iteration":1}\n{"event":"agent:run:start","iteration":1}\n',
    );
    const { deps, out } = fakeDeps({
      coder: [
        '{"success":false,"summary":"Starting on the red test for issue 154."}',
        "[ctrl+c to stop, gnhf again to resume]",
        "",
      ].join("\n"),
    });

    const result = inspectWorkerPanes({ deps, combo: record, runDir, workerWindows: ["coder"] });

    expect(result.escalated).toBe(false);
    expect(readEvents(runDir)).toEqual([]);
    expect(out).toContainEqual(expect.stringContaining("gnhf run is still active"));
  });

  it("reports gnhf terminal failures when the orchestrator log recorded the end", () => {
    const { record, runDir } = combo();
    const gnhfRunDir = join(record.worktree, ".gnhf", "runs", "implement-github-iss-ended");
    mkdirSync(gnhfRunDir, { recursive: true });
    writeFileSync(
      join(gnhfRunDir, "gnhf.log"),
      '{"event":"iteration:start","iteration":2}\n{"event":"orchestrator:end","status":"stopped","successCount":0}\n',
    );
    const { deps } = fakeDeps({
      coder: [
        '{"success":false,"summary":"Could not finish."}',
        "[ctrl+c to stop, gnhf again to resume]",
        "",
      ].join("\n"),
    });

    const result = inspectWorkerPanes({ deps, combo: record, runDir, workerWindows: ["coder"] });

    expect(result.escalated).toBe(true);
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "needs_human",
        reason: "worker_dead",
        worker: "coder",
        detail: "gnhf stopped without success",
      }),
    );
  });

  it("trusts journaled coder completion over a dead-looking initial pane", () => {
    const { record, runDir } = combo();
    appendEvent(runDir, "coder_started", {});
    appendEvent(runDir, "coder_done", {});
    const { deps, calls } = fakeDeps({
      coder: undefined,
    });

    const result = inspectWorkerPanes({
      deps,
      combo: record,
      runDir,
      workerWindows: ["coder"],
      recoverableDeadWorkers: ["coder"],
    });

    expect(result.escalated).toBe(false);
    expect(result.findings).toEqual([]);
    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(false);
    expect(calls.some((call) => call[0] === "list-panes")).toBe(false);
  });

  it("trusts journaled coder completion when the tmux session is already gone", () => {
    const { record, runDir } = combo();
    appendEvent(runDir, "coder_started", {});
    appendEvent(runDir, "coder_done", {});
    const out: string[] = [];
    const deps: WorkerMonitorDeps = {
      out: (line) => out.push(line),
      tmux: (args) => {
        if (args[0] === "list-windows") return { status: 1, stdout: "", stderr: "no session" };
        if (args[0] === "has-session") return { status: 1, stdout: "", stderr: "no session" };
        return { status: 0, stdout: "", stderr: "" };
      },
    };

    const result = inspectWorkerPanes({
      deps,
      combo: record,
      runDir,
      workerWindows: ["coder"],
      recoverableDeadWorkers: ["coder"],
    });

    expect(result.escalated).toBe(false);
    expect(result.findings).toEqual([]);
    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(false);
    expect(out).toContain("director: worker coder: terminal_outcome=coder_done");
  });

  it("detects a dead pane for a coder_failed terminal outcome instead of skipping", () => {
    const { record, runDir } = combo();
    appendEvent(runDir, "coder_started", {});
    appendEvent(runDir, "coder_failed", { exit_code: 1, has_new_commits: false });
    const { deps } = fakeDeps({
      coder: undefined,
    });

    const result = inspectWorkerPanes({
      deps,
      combo: record,
      runDir,
      workerWindows: ["coder"],
      recoverableDeadWorkers: ["coder"],
    });

    expect(result.escalated).toBe(true);
    expect(result.findings).toEqual([
      {
        worker: "coder",
        reason: "worker_dead",
        detail: "dead pane",
        needsHumanRecorded: false,
      },
    ]);
    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(false);
  });

  it("detects a dead session for a coder_failed terminal outcome instead of skipping", () => {
    const { record, runDir } = combo();
    appendEvent(runDir, "coder_started", {});
    appendEvent(runDir, "coder_failed", { exit_code: 1, has_new_commits: false });
    const out: string[] = [];
    const deps: WorkerMonitorDeps = {
      out: (line) => out.push(line),
      tmux: (args) => {
        if (args[0] === "list-windows") return { status: 1, stdout: "", stderr: "no session" };
        if (args[0] === "has-session") return { status: 1, stdout: "", stderr: "no session" };
        return { status: 0, stdout: "", stderr: "" };
      },
    };

    const result = inspectWorkerPanes({
      deps,
      combo: record,
      runDir,
      workerWindows: ["coder"],
      recoverableDeadWorkers: ["coder"],
    });

    expect(result.escalated).toBe(true);
    expect(result.findings).toEqual([
      {
        worker: "coder",
        reason: "worker_dead",
        detail: "no session",
        needsHumanRecorded: false,
      },
    ]);
    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(false);
  });

  it("escalates a dead coder pane when review_comments remain unresolved after coder_done", () => {
    const { record, runDir } = combo();
    appendEvent(runDir, "coder_started", {});
    appendEvent(runDir, "coder_done", {});
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(runDir, "review_comment", {
      author: "bot",
      kind: "review",
      url: "https://github.com/o/r/pull/7#r1",
    });
    const { deps } = fakeDeps({
      coder: undefined,
    });

    const result = inspectWorkerPanes({
      deps,
      combo: record,
      runDir,
      workerWindows: ["coder"],
    });

    expect(result.escalated).toBe(true);
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "needs_human",
        reason: "worker_dead",
        worker: "coder",
      }),
    );
  });

  it("does not escalate a dead coder pane when review_comments are resolved by a subsequent LGTM", () => {
    const { record, runDir } = combo();
    appendEvent(runDir, "coder_started", {});
    appendEvent(runDir, "coder_done", {});
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(runDir, "review_comment", {
      author: "bot",
      kind: "review",
      url: "https://github.com/o/r/pull/7#r1",
    });
    appendEvent(runDir, "lgtm", { sha: "abc123" });
    const { deps } = fakeDeps({
      coder: undefined,
    });

    const result = inspectWorkerPanes({
      deps,
      combo: record,
      runDir,
      workerWindows: ["coder"],
    });

    expect(result.escalated).toBe(false);
    expect(result.findings).toEqual([]);
    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(false);
  });

  it("escalates a dead coder pane when a pr_conflict arrives after a resolving LGTM", () => {
    const { record, runDir } = combo();
    appendEvent(runDir, "coder_started", {});
    appendEvent(runDir, "coder_done", {});
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(runDir, "review_comment", {
      author: "bot",
      kind: "review",
      url: "https://github.com/o/r/pull/7#r1",
    });
    appendEvent(runDir, "lgtm", { sha: "abc123" });
    appendEvent(runDir, "pr_conflict", {
      sha: "abc123",
      merge_state: "DIRTY",
      pr_url: "https://github.com/o/r/pull/7",
      action: "rebase_required",
    });
    const { deps } = fakeDeps({
      coder: undefined,
    });

    const result = inspectWorkerPanes({
      deps,
      combo: record,
      runDir,
      workerWindows: ["coder"],
    });

    expect(result.escalated).toBe(true);
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "needs_human",
        reason: "worker_dead",
        worker: "coder",
      }),
    );
  });

  it("returns recoverable dead-worker findings without journaling needs_human", () => {
    const { record, runDir } = combo();
    const { deps } = fakeDeps({
      coder: undefined,
    });

    const result = inspectWorkerPanes({
      deps,
      combo: record,
      runDir,
      workerWindows: ["coder"],
      recoverableDeadWorkers: ["coder"],
    });

    expect(result.escalated).toBe(true);
    expect(result.findings).toEqual([
      {
        worker: "coder",
        reason: "worker_dead",
        detail: "dead pane",
        needsHumanRecorded: false,
      },
    ]);
    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(false);
  });

  it("does not count duplicate worker names twice in one tick", () => {
    const { record, runDir } = combo();
    const { deps } = fakeDeps({
      reviewer: "waiting for review...\n",
    });

    const result = inspectWorkerPanes({
      deps,
      combo: record,
      runDir,
      workerWindows: ["reviewer", "reviewer"],
      stallTicks: 2,
    });

    expect(result.escalated).toBe(false);
    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(false);
  });

  it("emits needs_human after the same pane is unchanged for three ticks", () => {
    const { record, runDir } = combo();
    const { deps } = fakeDeps({
      reviewer: "waiting for review...\n",
    });

    expect(inspectWorkerPanes({ deps, combo: record, runDir, workerWindows: ["reviewer"] }).escalated).toBe(
      false,
    );
    expect(inspectWorkerPanes({ deps, combo: record, runDir, workerWindows: ["reviewer"] }).escalated).toBe(
      false,
    );
    expect(inspectWorkerPanes({ deps, combo: record, runDir, workerWindows: ["reviewer"] }).escalated).toBe(
      true,
    );

    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({ event: "needs_human", reason: "worker_stalled", worker: "reviewer" }),
    );
  });

  it("does not stall a precreated idle role window", () => {
    const { record, runDir } = combo();
    const { deps } = fakeDeps({
      reviewer: idleRoleWindowCommand("reviewer"),
    });

    expect(
      inspectWorkerPanes({ deps, combo: record, runDir, workerWindows: ["reviewer"], stallTicks: 2 })
        .escalated,
    ).toBe(false);
    expect(
      inspectWorkerPanes({ deps, combo: record, runDir, workerWindows: ["reviewer"], stallTicks: 2 })
        .escalated,
    ).toBe(false);
    expect(
      inspectWorkerPanes({ deps, combo: record, runDir, workerWindows: ["reviewer"], stallTicks: 2 })
        .escalated,
    ).toBe(false);

    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(false);
  });

  it("returns recoverable stalled-worker findings without journaling needs_human", () => {
    const { record, runDir } = combo();
    const { deps } = fakeDeps({
      "coder-responding": "waiting for coder responding...\n",
    });

    expect(
      inspectWorkerPanes({
        deps,
        combo: record,
        runDir,
        workerWindows: ["coder-responding"],
        recoverableStalledWorkers: ["coder-responding"],
        stallTicks: 2,
      }).escalated,
    ).toBe(false);
    const result = inspectWorkerPanes({
      deps,
      combo: record,
      runDir,
      workerWindows: ["coder-responding"],
      recoverableStalledWorkers: ["coder-responding"],
      stallTicks: 2,
    });

    expect(result.escalated).toBe(true);
    expect(result.findings).toEqual([
      {
        worker: "coder-responding",
        reason: "worker_stalled",
        detail: "unchanged pane for 2 ticks",
        needsHumanRecorded: false,
      },
    ]);
    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(false);
  });

  it("emits needs_human when a worker window has no live pane pid", () => {
    const { record, runDir } = combo();
    const { deps } = fakeDeps({
      gatekeeper: undefined,
    });

    const result = inspectWorkerPanes({ deps, combo: record, runDir, workerWindows: ["gatekeeper"] });

    expect(result.escalated).toBe(true);
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({ event: "needs_human", reason: "worker_dead", worker: "gatekeeper" }),
    );
  });

  it("keeps the director loop alive when list-windows fails but the session still exists", () => {
    const { record, runDir } = combo();
    const out: string[] = [];
    const deps: WorkerMonitorDeps = {
      out: (line) => out.push(line),
      tmux: (args) => {
        if (args[0] === "list-windows") return { status: 1, stdout: "", stderr: "temporary tmux hiccup" };
        return { status: 0, stdout: "", stderr: "" };
      },
    };

    const result = inspectWorkerPanes({
      deps,
      combo: record,
      runDir,
      workerWindows: ["reviewer", "gatekeeper"],
    });

    expect(result.escalated).toBe(false);
    expect(result.summaries).toEqual(["workers unavailable: temporary tmux hiccup"]);
    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(false);
    expect(out).toContainEqual(expect.stringContaining("workers unavailable: temporary tmux hiccup"));
  });

  it("emits needs_human when tmux cannot list worker windows because the session is gone", () => {
    const { record, runDir } = combo();
    const out: string[] = [];
    const deps: WorkerMonitorDeps = {
      out: (line) => out.push(line),
      tmux: (args) => {
        if (args[0] === "list-windows" || args[0] === "has-session") {
          return { status: 1, stdout: "", stderr: "no such session" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    };

    const result = inspectWorkerPanes({
      deps,
      combo: record,
      runDir,
      workerWindows: ["reviewer", "reviewer", "gatekeeper"],
    });

    expect(result.escalated).toBe(true);
    expect(readEvents(runDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "needs_human", reason: "worker_dead", worker: "reviewer" }),
        expect.objectContaining({ event: "needs_human", reason: "worker_dead", worker: "gatekeeper" }),
      ]),
    );
    expect(
      readEvents(runDir).filter((event) => event.event === "needs_human" && event["worker"] === "reviewer"),
    ).toHaveLength(1);
    expect(out).toContainEqual(expect.stringContaining("worker reviewer no such session"));
  });

  it("does not flag the coder as stalled when gnhf is actively progressing", () => {
    const { record, runDir } = combo();
    // Create a fake gnhf.log with recent mtime so gnhf looks alive
    const gnhfRunsDir = join(record.worktree, ".gnhf", "runs", "implement-github-iss-test");
    mkdirSync(gnhfRunsDir, { recursive: true });
    writeFileSync(join(gnhfRunsDir, "gnhf.log"), '{"event":"iteration:start","iteration":3}\n');

    const out: string[] = [];
    const unchangedPane = "gnhf v0.1.41\niteration 3\nspinner...";
    const deps: WorkerMonitorDeps = {
      out: (line) => out.push(line),
      tmux: (args) => {
        if (args[0] === "list-windows") return { status: 0, stdout: "coder", stderr: "" };
        if (args[0] === "list-panes") return { status: 0, stdout: "12345", stderr: "" };
        if (args[0] === "capture-pane") return { status: 0, stdout: unchangedPane, stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    };

    // First tick: unchanged for 1 tick, under threshold
    const r1 = inspectWorkerPanes({ deps, combo: record, runDir, workerWindows: ["coder"] });
    expect(r1.escalated).toBe(false);
    expect(out).toContainEqual(expect.stringContaining("unchanged_ticks=1"));

    // Second tick: unchanged for 2 ticks
    const r2 = inspectWorkerPanes({ deps, combo: record, runDir, workerWindows: ["coder"] });
    expect(r2.escalated).toBe(false);

    // Third tick: unchanged for 3 ticks = stall threshold, BUT gnhf is alive
    const r3 = inspectWorkerPanes({ deps, combo: record, runDir, workerWindows: ["coder"] });
    expect(r3.escalated).toBe(false);
    expect(out).toContainEqual(expect.stringContaining("gnhf is actively progressing"));
    expect(out).not.toContainEqual(expect.stringContaining("worker_stalled"));
    const events = readEvents(runDir);
    expect(events.filter((e) => e.event === "needs_human" && e["reason"] === "worker_stalled")).toHaveLength(
      0,
    );
  });

  it("does not treat a fresh ended gnhf log as active coder stall evidence", () => {
    const { record, runDir } = combo();
    const gnhfRunsDir = join(record.worktree, ".gnhf", "runs", "implement-github-iss-ended");
    mkdirSync(gnhfRunsDir, { recursive: true });
    writeFileSync(
      join(gnhfRunsDir, "gnhf.log"),
      [
        '{"event":"iteration:start","iteration":3}',
        '{"event":"orchestrator:end","status":"stopped","successCount":0}',
        "",
      ].join("\n"),
    );

    const out: string[] = [];
    const unchangedPane = "gnhf v0.1.41\niteration 3\nspinner...";
    const deps: WorkerMonitorDeps = {
      out: (line) => out.push(line),
      tmux: (args) => {
        if (args[0] === "list-windows") return { status: 0, stdout: "coder", stderr: "" };
        if (args[0] === "list-panes") return { status: 0, stdout: "12345", stderr: "" };
        if (args[0] === "capture-pane") return { status: 0, stdout: unchangedPane, stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    };

    expect(
      inspectWorkerPanes({ deps, combo: record, runDir, workerWindows: ["coder"], stallTicks: 2 }).escalated,
    ).toBe(false);
    const result = inspectWorkerPanes({
      deps,
      combo: record,
      runDir,
      workerWindows: ["coder"],
      stallTicks: 2,
    });

    expect(result.escalated).toBe(true);
    expect(result.summaries).toContain("worker coder: unchanged_ticks=2; no orchestrator evidence");
    expect(out).toContainEqual(expect.stringContaining("no orchestrator evidence"));
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({ event: "needs_human", reason: "worker_stalled", worker: "coder" }),
    );
  });

  it("suppresses a stall escalation when an injected evidence source reports the role binary alive", () => {
    const { record, runDir } = combo();
    const { deps, out } = fakeDeps({ coder: "acp loop spinner\n" });
    const evidenceSources = {
      coder: { aliveEvidence: () => "acp run active; orchestrator log is progressing" },
    };

    for (let tick = 0; tick < 3; tick += 1) {
      const result = inspectWorkerPanes({
        deps,
        combo: record,
        runDir,
        workerWindows: ["coder"],
        evidenceSources,
      });
      expect(result.escalated).toBe(false);
    }

    expect(out).toContainEqual(expect.stringContaining("acp run active"));
    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(false);
  });

  it("reports a dead worker when an injected pane fingerprint confirms terminal failure", () => {
    const { record, runDir } = combo();
    const { deps } = fakeDeps({ coder: "FATAL: orchestrator crashed\n" });

    const result = inspectWorkerPanes({
      deps,
      combo: record,
      runDir,
      workerWindows: ["coder"],
      evidenceSources: {
        coder: {
          aliveEvidence: () => undefined,
          paneTerminalFailure: (pane) =>
            pane.includes("FATAL") ? { kind: "dead", detail: "acp orchestrator stopped" } : undefined,
        },
      },
    });

    expect(result.escalated).toBe(true);
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "needs_human",
        reason: "worker_dead",
        worker: "coder",
        detail: "acp orchestrator stopped",
      }),
    );
  });

  it("keeps a fingerprint-matched worker alive when the injected source reports the run active", () => {
    const { record, runDir } = combo();
    const { deps, out } = fakeDeps({ coder: "FATAL-looking footer\n" });

    const result = inspectWorkerPanes({
      deps,
      combo: record,
      runDir,
      workerWindows: ["coder"],
      evidenceSources: {
        coder: {
          aliveEvidence: () => undefined,
          paneTerminalFailure: () => ({ kind: "run_active", summary: "footer matched but run is live" }),
        },
      },
    });

    expect(result.escalated).toBe(false);
    expect(out).toContainEqual(expect.stringContaining("footer matched but run is live"));
    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(false);
  });
});
// -/ 1/1
