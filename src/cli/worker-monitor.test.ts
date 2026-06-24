/**
 * @overview Unit tests for worker pane monitoring. ~150 lines, permission
 *   prompt, unchanged-pane stall, and dead-pane escalation.
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

import { readEvents } from "../core/events.js";
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

function fakeDeps(panes: Record<string, string | undefined>): { deps: WorkerMonitorDeps; out: string[] } {
  const out: string[] = [];
  return {
    out,
    deps: {
      out: (line) => out.push(line),
      tmux: (args) => {
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

  it("escalates immediately when gnhf is held after an unsuccessful terminal result", () => {
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
        reason: "worker_stalled",
        worker: "coder",
        detail: "gnhf stopped without success",
      }),
    );
    expect(out).toContainEqual(expect.stringContaining("worker coder gnhf stopped without success"));
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
