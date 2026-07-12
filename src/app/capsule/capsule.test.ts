/**
 * @overview Contract tests for the v1 capsule sequencer.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at capsule happy path        <- rebase, coder, gate, and PR order.
 *   2. Then coder completion              <- commits-first and optional JSONL bridge.
 *   3. Finish at terminal gate outcomes   <- attach, lease, and missing PR behavior.
 *
 *   MAIN FLOW
 *   ---------
 *   persisted run fixture -> runCapsule -> injected processes -> journal assertions
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   fixture, events, successfulGate
 *
 * @exports none
 * @deps node:{fs,os,path}, vitest, ../../core/{events,state,work-plan}, ../../infra/{config,config-snapshot}, ./capsule
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { readEvents } from "../../core/events.js";
import { writeCombo, type ComboRecord } from "../../core/state.js";
import { normalizeGitHubIssueWorkPlan, renderWorkPlanMarkdown } from "../../core/work-plan.js";
import { loadConfig } from "../../infra/config.js";
import { writeConfigSnapshot } from "../../infra/config-snapshot.js";
import { runCapsule, type CapsuleDeps } from "./capsule.js";
import type { GateProcessRequest, GateProcessResult } from "../gate/in-process-gate.js";

// -- 1/2 HELPER · persisted fixture and event projection --
function fixture(): { root: string; runDir: string; combo: ComboRecord } {
  const root = mkdtempSync(join(tmpdir(), "combo-chen-capsule-"));
  const runDir = join(root, "run");
  const worktree = join(root, "worktree");
  mkdirSync(runDir);
  mkdirSync(worktree);
  const combo: ComboRecord = {
    id: "o-r-7",
    issueUrl: "https://github.com/o/r/issues/7",
    workItemSourceType: "github_issue",
    workItemSourceReference: "https://github.com/o/r/issues/7",
    repoDir: root,
    worktree,
    branch: "combo/issue-7",
    tmuxSession: "combo-chen-o-r-7",
    createdAt: new Date(0).toISOString(),
  };
  writeCombo(runDir, combo);
  writeConfigSnapshot(runDir, loadConfig({ repoDir: root, env: {} }));
  writeFileSync(
    join(runDir, "work-plan.md"),
    renderWorkPlanMarkdown(
      normalizeGitHubIssueWorkPlan({ issueUrl: combo.issueUrl, title: "Issue title", body: "Issue body" }),
    ),
  );
  writeFileSync(join(runDir, "overture.json"), `${JSON.stringify({ resources: { base: "origin/main" } })}\n`);
  return { root, runDir, combo };
}

function events(runDir: string): Array<Record<string, unknown>> {
  return readEvents(runDir).map(({ t: _timestamp, ...event }) => event);
}

function gateProcess(
  gate: GateProcessResult,
  finalStatus = "status: done\n",
): (request: GateProcessRequest) => Promise<GateProcessResult> {
  return async (request) => {
    const call = `${request.command} ${request.args.join(" ")}`;
    if (call === "git rev-parse HEAD") return { exitCode: 0, stdout: "coded\n", stderr: "" };
    if (call === "git remote get-url no-mistakes") return { exitCode: 2, stdout: "", stderr: "" };
    if (call === "no-mistakes axi status") return { exitCode: 0, stdout: finalStatus, stderr: "" };
    if (call === "no-mistakes daemon start") return { exitCode: 0, stdout: "", stderr: "" };
    if (call.startsWith("sh -c ")) return gate;
    throw new Error(`unexpected gate process: ${call}`);
  };
}

function deps(
  input: {
    heads?: string[];
    coderExitCode?: number;
    gateResult?: Awaited<ReturnType<NonNullable<CapsuleDeps["runGate"]>>>;
  } = {},
): { deps: CapsuleDeps; gitCalls: string[]; activateReviewer: ReturnType<typeof vi.fn> } {
  const heads = [...(input.heads ?? ["base", "coded"])];
  const gitCalls: string[] = [];
  const activateReviewer = vi.fn();
  return {
    gitCalls,
    activateReviewer,
    deps: {
      env: {},
      out: () => undefined,
      git: async (request) => {
        gitCalls.push(request.args.join(" "));
        if (request.args[0] === "rev-parse")
          return { exitCode: 0, stdout: `${heads.shift() ?? "coded"}\n`, stderr: "" };
        if (request.args[0] === "rev-list") return { exitCode: 0, stdout: "1\n", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      runAgent: async () => ({ exitCode: input.coderExitCode ?? 0, stdout: "", stderr: "" }),
      runGate: async (gateInput) => {
        if (input.gateResult !== undefined) return input.gateResult;
        if (gateInput.activateReviewer !== undefined) await gateInput.activateReviewer();
        return { status: "validated", exitCode: 0, headSha: "published" };
      },
      findPrUrl: async () => "https://github.com/o/r/pull/7",
      resolvePrHead: async () => "published",
      ensurePrAutoclose: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      activateReviewer,
    },
  };
}
// -/ 1/2

// -- 2/2 CORE · runCapsule contracts <- START HERE --
describe("capsule sequencer", () => {
  it("sequences rebase, commits-first coder completion, initial gate, and reviewer activation", async () => {
    const f = fixture();
    const h = deps();

    await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({ status: "validated", exitCode: 0 });
    expect(h.gitCalls.slice(0, 5)).toEqual([
      "fetch origin main",
      "rebase origin/main",
      "rev-parse HEAD",
      "rev-parse HEAD",
      "rev-list --count base..coded",
    ]);
    expect(events(f.runDir)).toEqual([{ event: "coder_started" }, { event: "coder_done" }]);
    expect(h.activateReviewer).toHaveBeenCalledOnce();
  });

  it("treats a nonzero coder exit with new commits as coder_done", async () => {
    const f = fixture();
    const h = deps({ coderExitCode: 17 });

    await expect(runCapsule(f.runDir, h.deps)).resolves.toMatchObject({ status: "validated" });
    expect(events(f.runDir).map((event) => event.event)).toEqual(["coder_started", "coder_done"]);
  });

  it("harvests the optional gnhf thread bridge without writing lifecycle markers", async () => {
    const f = fixture();
    const h = deps({ coderExitCode: 17 });
    h.deps.runAgent = async () => {
      const run = join(f.combo.worktree, ".gnhf", "runs", "fresh");
      mkdirSync(run, { recursive: true });
      writeFileSync(
        join(run, "iteration-1.jsonl"),
        [
          JSON.stringify({ type: "thread.started", thread_id: "thread-7" }),
          JSON.stringify({
            type: "item.completed",
            item: {
              type: "agent_message",
              text: JSON.stringify({ success: true, should_fully_stop: true }),
            },
          }),
        ].join("\n"),
      );
      return { exitCode: 17, stdout: "", stderr: "" };
    };

    await expect(runCapsule(f.runDir, h.deps)).resolves.toMatchObject({ status: "validated" });
    expect(events(f.runDir)[1]).toEqual({
      event: "coder_done",
      gnhf_iteration_jsonl: ".gnhf/runs/fresh/iteration-1.jsonl",
    });
    expect(JSON.parse(readFileSync(join(f.runDir, "coder-thread.json"), "utf8"))).toMatchObject({
      agent: "codex",
      thread_id: "thread-7",
    });
    expect(readdirSync(f.runDir)).not.toEqual(
      expect.arrayContaining(["coder.exit", "gatekeeper.log", "window.log", ".done"]),
    );
  });

  it("revalidates the frozen coder safety pin before spawning an agent", async () => {
    const f = fixture();
    const snapshotPath = join(f.runDir, "config.snapshot.json");
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
    snapshot["coderCommand"] = "npx gnhf --agent codex {prompt}";
    writeFileSync(snapshotPath, `${JSON.stringify(snapshot)}\n`);
    const h = deps();
    const runAgent = vi.fn(h.deps.runAgent);
    h.deps.runAgent = runAgent;

    await expect(runCapsule(f.runDir, h.deps)).rejects.toThrow(/unsafe coder invocation/i);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("journals rebase_conflict and never starts the coder", async () => {
    const f = fixture();
    const h = deps();
    h.deps.git = async (request) => {
      if (request.args[0] === "rebase") return { exitCode: 42, stdout: "", stderr: "conflict" };
      if (request.args[0] === "merge-base") return { exitCode: 0, stdout: "merge-base\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({ status: "rebase_conflict", exitCode: 42 });
    expect(events(f.runDir)).toEqual([{ event: "rebase_conflict", base: "merge-base" }]);
  });

  it("consumes the in-process initial gate and preserves the PR-opened event sequence", async () => {
    const f = fixture();
    const h = deps();
    h.deps.runGate = undefined;
    h.deps.gateProcess = gateProcess({ exitCode: 0, stdout: "outcome: checks-passed\n", stderr: "" });

    await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({ status: "validated", exitCode: 0 });
    expect(events(f.runDir)).toEqual([
      { event: "coder_started" },
      { event: "coder_done" },
      { event: "gate_started" },
      { event: "gate_status", state: "fix_inflight", head_sha: "coded" },
      { event: "gate_status", state: "idle", head_sha: "published" },
      { event: "pr_opened", url: "https://github.com/o/r/pull/7" },
    ]);
    expect(h.activateReviewer).toHaveBeenCalledOnce();
  });

  it("journals needs_human pr_missing when the initial gate opens no PR", async () => {
    const f = fixture();
    const h = deps();
    h.deps.runGate = undefined;
    h.deps.gateProcess = gateProcess({ exitCode: 0, stdout: "outcome: checks-passed\n", stderr: "" });
    h.deps.findPrUrl = async () => undefined;

    await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({ status: "no_pr", exitCode: 0 });
    expect(events(f.runDir).slice(-2)).toEqual([
      { event: "gate_status", state: "idle", head_sha: "coded" },
      { event: "needs_human", reason: "pr_missing" },
    ]);
  });

  it("preserves autoclose failure ordering before stopping the capsule", async () => {
    const f = fixture();
    const h = deps();
    h.deps.runGate = undefined;
    h.deps.gateProcess = gateProcess({ exitCode: 0, stdout: "outcome: checks-passed\n", stderr: "" });
    h.deps.ensurePrAutoclose = async () => ({ exitCode: 7, stdout: "", stderr: "edit failed" });

    await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({ status: "failed", exitCode: 7 });
    expect(events(f.runDir).slice(-3)).toEqual([
      { event: "gate_status", state: "failed", head_sha: "published" },
      { event: "gate_failed", exit_code: 7 },
      { event: "pr_autoclose_failed", exit_code: 7, url: "https://github.com/o/r/pull/7" },
    ]);
  });

  for (const gateResult of [
    { status: "already_running", exitCode: 0, headSha: "head", runId: "01LIVE" } as const,
    { status: "lease_unavailable", exitCode: 0, headSha: "head" } as const,
    { status: "no_pr", exitCode: 0, headSha: "head" } as const,
  ]) {
    it(`preserves the ${gateResult.status} terminal path`, async () => {
      const f = fixture();
      const h = deps({ gateResult });
      const attachGate = vi.fn();
      h.deps.attachGate = attachGate;

      await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({
        status: gateResult.status,
        exitCode: gateResult.exitCode,
      });
      if (gateResult.status === "already_running") expect(attachGate).toHaveBeenCalledWith("01LIVE");
      else expect(attachGate).not.toHaveBeenCalled();
    });
  }
});
// -/ 2/2
