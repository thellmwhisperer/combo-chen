/**
 * @overview Unit tests for worker pane monitoring. ~500 lines, permission
 *   prompt recovery/escalation, unchanged-pane stall, and dead-pane escalation.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at inspectWorkerPanes tests <- one tick of worker inspection.
 *   2. Use fixture helpers              <- fake combo/run dir + tmux outputs.
 *
 *   MAIN FLOW
 *   ---------
 *   fake tmux panes -> inspectWorkerPanes -> needs_human events + snapshot file
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
 * @deps vitest, node:{fs,os,path}, ../core/{events,state}, ./worker-monitor
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appendEvent, readEvents } from "../core/events.js";
import { runDirFor, writeCombo, type ComboRecord } from "../core/state.js";
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

function fakeDeps(panes: Record<string, string | undefined>): { deps: WorkerMonitorDeps; out: string[]; calls: string[][] } {
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
      expect.objectContaining({ event: "needs_human", reason: "worker_permission_prompt", worker: "reviewer" }),
    );
    expect(out).toContainEqual(expect.stringContaining("worker reviewer permission prompt"));
  });

  it("auto-approves a known-safe permission prompt without escalating", () => {
    const { record, runDir } = combo();
    const { deps, out, calls } = fakeDeps({
      reviewer: "Do you want to proceed? [y/N]\n",
    });

    const result = inspectWorkerPanes({
      deps,
      combo: record,
      runDir,
      workerWindows: ["reviewer"],
      permissionPromptPolicy: "auto-approve-known-safe",
    });

    expect(result.escalated).toBe(false);
    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(false);
    expect(calls).toContainEqual(["send-keys", "-t", "combo-chen-o-r-7:reviewer", "y", "C-m"]);
    expect(out).toContainEqual(expect.stringContaining("worker reviewer permission prompt auto-approved"));
  });

  it("keeps auto-approval target in argv when the tmux session contains shell metacharacters", () => {
    const { record, runDir } = combo();
    record.tmuxSession = "--combo-chen-'\"`$(printf pwn)\n";
    const { deps, calls } = fakeDeps({
      reviewer: "Do you want to proceed? [y/N]\n",
    });

    const result = inspectWorkerPanes({
      deps,
      combo: record,
      runDir,
      workerWindows: ["reviewer"],
      permissionPromptPolicy: "auto-approve-known-safe",
    });

    expect(result.escalated).toBe(false);
    expect(calls).toContainEqual(["send-keys", "-t", `${record.tmuxSession}:reviewer`, "y", "C-m"]);
  });

  it("escalates a persistent auto-approved prompt after the recovery budget is exhausted", () => {
    const { record, runDir } = combo();
    const { deps, calls } = fakeDeps({
      reviewer: "Do you want to proceed? [y/N]\n",
    });
    const input = {
      deps,
      combo: record,
      runDir,
      workerWindows: ["reviewer"],
      permissionPromptPolicy: "auto-approve-known-safe" as const,
      autoApprovePermissionPromptMaxAttempts: 1,
    };

    expect(inspectWorkerPanes(input).escalated).toBe(false);
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "worker_recovered",
        reason: "worker_permission_prompt",
        worker: "reviewer",
        detail: "permission prompt auto-approved",
        attempt: 1,
        max_attempts: 1,
      }),
    );

    const result = inspectWorkerPanes(input);

    expect(result.escalated).toBe(true);
    expect(calls.filter((call) => call[0] === "send-keys")).toHaveLength(1);
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "needs_human",
        reason: "worker_permission_prompt",
        worker: "reviewer",
        detail: "recovery attempts exhausted after 1; permission prompt",
      }),
    );
  });

  it("escalates a permission prompt when auto-approval fails", () => {
    const { record, runDir } = combo();
    const out: string[] = [];
    const deps: WorkerMonitorDeps = {
      out: (line) => out.push(line),
      tmux: (args) => {
        if (args[0] === "list-windows") return { status: 0, stdout: "reviewer\n", stderr: "" };
        if (args[0] === "list-panes") return { status: 0, stdout: "12345\n", stderr: "" };
        if (args[0] === "capture-pane") return { status: 0, stdout: "Do you want to proceed? [y/N]\n", stderr: "" };
        if (args[0] === "send-keys") return { status: 1, stdout: "", stderr: "blocked target" };
        return { status: 0, stdout: "", stderr: "" };
      },
    };

    const result = inspectWorkerPanes({
      deps,
      combo: record,
      runDir,
      workerWindows: ["reviewer"],
      permissionPromptPolicy: "auto-approve-known-safe",
    });

    expect(result.escalated).toBe(true);
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "needs_human",
        reason: "worker_permission_prompt",
        worker: "reviewer",
        detail: "permission prompt auto-approve failed: blocked target",
      }),
    );
    expect(out).toContainEqual(expect.stringContaining("permission prompt auto-approve failed"));
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
      expect.objectContaining({ event: "needs_human", reason: "worker_permission_prompt", worker: "reviewer" }),
    );
  });

  it("returns recoverable permission-prompt findings without journaling needs_human", () => {
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
        detail: "permission prompt",
        needsHumanRecorded: false,
      },
    ]);
    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(false);
  });

  it("uses the configured unchanged-pane threshold", () => {
    const { record, runDir } = combo();
    const { deps } = fakeDeps({
      reviewer: "waiting for review...\n",
    });

    expect(
      inspectWorkerPanes({ deps, combo: record, runDir, workerWindows: ["reviewer"], stallTicks: 2 }).escalated,
    ).toBe(false);
    expect(
      inspectWorkerPanes({ deps, combo: record, runDir, workerWindows: ["reviewer"], stallTicks: 2 }).escalated,
    ).toBe(true);
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

    expect(inspectWorkerPanes({ deps, combo: record, runDir, workerWindows: ["reviewer"] }).escalated).toBe(false);
    expect(inspectWorkerPanes({ deps, combo: record, runDir, workerWindows: ["reviewer"] }).escalated).toBe(false);
    expect(inspectWorkerPanes({ deps, combo: record, runDir, workerWindows: ["reviewer"] }).escalated).toBe(true);

    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({ event: "needs_human", reason: "worker_stalled", worker: "reviewer" }),
    );
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
      tmux: (args) =>
        args[0] === "list-windows"
          ? { status: 1, stdout: "", stderr: "temporary tmux hiccup" }
          : args[0] === "has-session"
            ? { status: 0, stdout: "", stderr: "" }
            : { status: 0, stdout: "", stderr: "" },
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
      tmux: (args) =>
        args[0] === "list-windows"
          ? { status: 1, stdout: "", stderr: "no such session" }
          : args[0] === "has-session"
            ? { status: 1, stdout: "", stderr: "no such session" }
          : { status: 0, stdout: "", stderr: "" },
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
    expect(readEvents(runDir).filter((event) => event.event === "needs_human" && event["worker"] === "reviewer"))
      .toHaveLength(1);
    expect(out).toContainEqual(expect.stringContaining("worker reviewer no such session"));
  });
});
// -/ 1/1
