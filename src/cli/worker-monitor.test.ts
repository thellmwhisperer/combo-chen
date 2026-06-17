/**
 * @overview Unit tests for worker pane monitoring. ~120 lines, permission
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
});
// -/ 1/1
