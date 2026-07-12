/**
 * @overview Contract tests for the v1 capsule sequencer.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at capsule happy path        <- rebase, coder, review, gate, PR order.
 *   2. Then coder completion              <- commits-first and optional JSONL bridge.
 *   3. Then the local review round        <- verdict routing and escalations.
 *   4. Finish at terminal gate outcomes   <- attach, lease, and missing PR behavior.
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
 *   fixture, events, deps, verdict, gateProcess
 *
 * @exports none
 * @deps node:{fs,os,path}, vitest, ../../core/{combo,events,state,verdict,work-plan}, ../../infra/{config,config-snapshot}, ./capsule
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { deriveStatus } from "../../core/combo.js";
import { appendEvent, readEvents, type ComboEvent } from "../../core/events.js";
import {
  initialLoopState,
  readLoopState,
  recordLoopRound,
  withLoopGuard,
  writeLoopState,
} from "../../core/loop-state.js";
import { writeCombo, type ComboRecord } from "../../core/state.js";
import {
  LOCAL_REVIEW_CHECKLIST,
  VERDICT_SCHEMA_VERSION,
  writeVerdictFile,
  type VerdictFile,
} from "../../core/verdict.js";
import { normalizeGitHubIssueWorkPlan, renderWorkPlanMarkdown } from "../../core/work-plan.js";
import { loadConfig } from "../../infra/config.js";
import { writeConfigSnapshot } from "../../infra/config-snapshot.js";
import { writeCoderThreadArtifact } from "../../testing/cli-harness.js";
import { classifyCapsulePhase, runAgentProcess, runCapsule, type CapsuleDeps } from "./capsule.js";
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
  // The verdict wait is frozen config now; keep it short for the tests that
  // exercise the missing-verdict escalation path.
  writeConfigSnapshot(
    runDir,
    loadConfig({ repoDir: root, env: { COMBO_CHEN_REVIEW_VERDICT_WAIT_MS: "50" } }),
  );
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

function verdict(runDir: string, overrides: Partial<VerdictFile> = {}): VerdictFile {
  const artifact: VerdictFile = {
    schemaVersion: VERDICT_SCHEMA_VERSION,
    round: 1,
    code: 0,
    reviewed: { sha: "coded" },
    identity: { model: "claude-fable-5", runtime: "claude" },
    checklist: LOCAL_REVIEW_CHECKLIST.map((item) => ({ id: item.id, status: "pass" as const })),
    findings: [],
    followUps: [],
    ...overrides,
  };
  writeVerdictFile(runDir, artifact);
  return artifact;
}

function deps(
  f: { runDir: string },
  input: {
    heads?: string[];
    coderExitCode?: number;
    gateResult?: Awaited<ReturnType<NonNullable<CapsuleDeps["runGate"]>>>;
    agents?: Array<CapsuleDeps["runAgent"]>;
    revListCounts?: number[];
  } = {},
): {
  deps: CapsuleDeps;
  gitCalls: string[];
  agentCommands: string[];
  activateReviewer: ReturnType<typeof vi.fn>;
  setCoder: (fn: CapsuleDeps["runAgent"]) => void;
  setReviewer: (fn: CapsuleDeps["runAgent"]) => void;
} {
  const heads = [...(input.heads ?? ["base", "coded"])];
  const revListCounts = [...(input.revListCounts ?? [])];
  const gitCalls: string[] = [];
  const agentCommands: string[] = [];
  const activateReviewer = vi.fn();
  let coder: CapsuleDeps["runAgent"] = async () => ({
    exitCode: input.coderExitCode ?? 0,
    stdout: "",
    stderr: "",
  });
  let reviewer: CapsuleDeps["runAgent"] = async () => {
    verdict(f.runDir);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  let agentCalls = 0;
  return {
    gitCalls,
    agentCommands,
    activateReviewer,
    setCoder: (fn) => {
      coder = fn;
    },
    setReviewer: (fn) => {
      reviewer = fn;
    },
    deps: {
      env: {},
      out: () => undefined,
      git: async (request) => {
        gitCalls.push(request.args.join(" "));
        if (request.args[0] === "rev-parse")
          return { exitCode: 0, stdout: `${heads.shift() ?? "coded"}\n`, stderr: "" };
        if (request.args[0] === "rev-list")
          return { exitCode: 0, stdout: `${revListCounts.shift() ?? 1}\n`, stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      runAgent: async (request) => {
        agentCommands.push(request.command);
        agentCalls += 1;
        if (input.agents !== undefined) {
          const scripted = input.agents[agentCalls - 1];
          if (scripted === undefined) throw new Error(`unexpected agent call ${agentCalls}`);
          return scripted(request);
        }
        return agentCalls === 1 ? coder(request) : reviewer(request);
      },
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
  it("sequences rebase, commits-first coder completion, local review, initial gate, and reviewer activation", async () => {
    const f = fixture();
    const h = deps(f);

    await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({ status: "validated", exitCode: 0 });
    expect(h.gitCalls.slice(0, 5)).toEqual([
      "fetch origin main",
      "rebase origin/main",
      "rev-parse HEAD",
      "rev-parse HEAD",
      "rev-list --count base..coded",
    ]);
    expect(events(f.runDir).map((event) => event.event)).toEqual([
      "coder_started",
      "coder_done",
      "local_review_requested",
      "local_verdict",
      // W6a: the code-0 verdict pins the local lgtm, and the validated gate
      // carries it to the published head by patch-id equivalence.
      "lgtm",
      "lgtm",
    ]);
    expect(h.activateReviewer).toHaveBeenCalledOnce();
  });

  it("treats a nonzero coder exit with new commits as coder_done", async () => {
    const f = fixture();
    const h = deps(f, { coderExitCode: 17 });

    await expect(runCapsule(f.runDir, h.deps)).resolves.toMatchObject({ status: "validated" });
    expect(events(f.runDir).map((event) => event.event)).toEqual([
      "coder_started",
      "coder_done",
      "local_review_requested",
      "local_verdict",
      "lgtm",
      "lgtm",
    ]);
  });

  it("harvests the optional gnhf thread bridge without writing lifecycle markers", async () => {
    const f = fixture();
    const h = deps(f, { coderExitCode: 17 });
    h.setCoder(async () => {
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
    });

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
    const h = deps(f);
    const runAgent = vi.fn(h.deps.runAgent);
    h.deps.runAgent = runAgent;

    await expect(runCapsule(f.runDir, h.deps)).rejects.toThrow(/unsafe coder invocation/i);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("journals rebase_conflict and never starts the coder", async () => {
    const f = fixture();
    const h = deps(f);
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
    const h = deps(f);
    h.deps.runGate = undefined;
    h.deps.gateProcess = gateProcess({ exitCode: 0, stdout: "outcome: checks-passed\n", stderr: "" });

    await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({ status: "validated", exitCode: 0 });
    expect(events(f.runDir)).toEqual([
      { event: "coder_started" },
      { event: "coder_done" },
      { event: "local_review_requested", round: 1, sha: "coded" },
      {
        event: "local_verdict",
        round: 1,
        code: 0,
        verdict_path: "verdict-1.json",
        identity: { model: "claude-fable-5", runtime: "claude" },
        sha: "coded",
        findings: [],
      },
      // W6a: the code-0 verdict pins the local lgtm before the gate runs.
      { event: "lgtm", sha: "coded", round: 1, source: "local_verdict" },
      { event: "gate_started" },
      { event: "gate_status", state: "fix_inflight", head_sha: "coded" },
      { event: "gate_status", state: "idle", head_sha: "published" },
      { event: "pr_opened", url: "https://github.com/o/r/pull/7" },
      // W6a: the published head carries the lgtm by patch-id equivalence.
      { event: "lgtm", sha: "published", carried_from: "coded", source: "patch_id_carry_over" },
    ]);
    expect(h.activateReviewer).toHaveBeenCalledOnce();
  });

  it("journals needs_human pr_missing when the initial gate opens no PR", async () => {
    const f = fixture();
    const h = deps(f);
    h.deps.runGate = undefined;
    h.deps.gateProcess = gateProcess({ exitCode: 0, stdout: "outcome: checks-passed\n", stderr: "" });
    h.deps.findPrUrl = async () => undefined;

    await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({ status: "no_pr", exitCode: 0 });
    expect(events(f.runDir).slice(-2)).toEqual([
      { event: "gate_status", state: "idle", head_sha: "coded" },
      { event: "needs_human", reason: "pr_missing" },
    ]);
  });

  it("preserves autoclose failure ordering before the capsule escalates", async () => {
    const f = fixture();
    writeConfigSnapshot(
      f.runDir,
      loadConfig({ repoDir: f.root, env: { COMBO_CHEN_GATEKEEPER_INITIAL_GATE_RETRY_ATTEMPTS: "0" } }),
    );
    const h = deps(f);
    h.deps.runGate = undefined;
    h.deps.gateProcess = gateProcess({ exitCode: 0, stdout: "outcome: checks-passed\n", stderr: "" });
    h.deps.ensurePrAutoclose = async () => ({ exitCode: 7, stdout: "", stderr: "edit failed" });

    await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({ status: "failed", exitCode: 7 });
    expect(events(f.runDir).slice(-4)).toEqual([
      { event: "gate_status", state: "failed", head_sha: "published" },
      { event: "gate_failed", exit_code: 7 },
      { event: "pr_autoclose_failed", exit_code: 7, url: "https://github.com/o/r/pull/7" },
      { event: "needs_human", reason: "gate_failed" },
    ]);
  });

  it("skips rebase and coder phases when resuming at the post-coder handoff", async () => {
    const f = fixture();
    appendEvent(f.runDir, "coder_started", {});
    appendEvent(f.runDir, "coder_done", {});
    const h = deps(f, { heads: ["coded"] });
    const agentCommands: string[] = [];
    h.deps.runAgent = async (request) => {
      agentCommands.push(request.command);
      verdict(f.runDir);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await expect(runCapsule(f.runDir, h.deps, { startAtGate: true })).resolves.toEqual({
      status: "validated",
      exitCode: 0,
    });
    expect(agentCommands).toHaveLength(1);
    expect(agentCommands[0]).toContain("verdict-1.json");
    expect(h.gitCalls.some((call) => call.startsWith("rebase") || call.startsWith("fetch"))).toBe(false);
    expect(events(f.runDir).map((event) => event.event)).toEqual([
      "coder_started",
      "coder_done",
      "local_review_requested",
      "local_verdict",
      // W6a: the resumed run still pins the lgtm and carries it to the
      // published head by patch-id equivalence.
      "lgtm",
      "lgtm",
    ]);
  });

  it("retries a failed initial gate within the configured budget", async () => {
    const f = fixture();
    const gateResults = [
      { status: "failed", exitCode: 1, headSha: "coded" } as const,
      { status: "failed", exitCode: 1, headSha: "coded" } as const,
      { status: "validated", exitCode: 0, headSha: "published" } as const,
    ];
    const h = deps(f);
    h.deps.runGate = async () => {
      const next = gateResults.shift();
      if (next === undefined) throw new Error("gate invoked past its scripted results");
      return next;
    };
    const sleeps: number[] = [];
    h.deps.sleep = async (ms) => {
      sleeps.push(ms);
    };

    await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({ status: "validated", exitCode: 0 });
    expect(sleeps).toEqual([10_000, 10_000]);
    expect(events(f.runDir).some((event) => event.event === "needs_human")).toBe(false);
  });

  it("journals needs_human gate_failed after exhausting initial gate retries", async () => {
    const f = fixture();
    const h = deps(f, { gateResult: { status: "failed", exitCode: 3, headSha: "coded" } });
    h.deps.sleep = async () => {};

    await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({ status: "failed", exitCode: 3 });
    expect(events(f.runDir).at(-1)).toEqual({ event: "needs_human", reason: "gate_failed" });
  });

  for (const gateResult of [
    { status: "already_running", exitCode: 0, headSha: "head", runId: "01LIVE" } as const,
    { status: "lease_unavailable", exitCode: 0, headSha: "head" } as const,
    { status: "no_pr", exitCode: 0, headSha: "head" } as const,
  ]) {
    it(`preserves the ${gateResult.status} terminal path`, async () => {
      const f = fixture();
      const h = deps(f, { gateResult });
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

describe("capsule local review round", () => {
  it("runs the reviewer as an owned child with the verdict-file invocation", async () => {
    const f = fixture();
    const h = deps(f);

    await runCapsule(f.runDir, h.deps);

    expect(h.agentCommands).toHaveLength(2);
    expect(h.agentCommands[1]).toContain("verdict-1.json");
    expect(h.agentCommands[1]).toContain("Local pre-publish review");
    expect(h.agentCommands[1]).not.toContain("gh pr review");
  });

  it("lights the LOCAL_REVIEW phase during the round and returns to GATING on code 0", async () => {
    const f = fixture();
    const h = deps(f);

    await runCapsule(f.runDir, h.deps);

    const journal = readEvents(f.runDir);
    const requestedAt = journal.findIndex((event) => event.event === "local_review_requested");
    const verdictAt = journal.findIndex((event) => event.event === "local_verdict");
    expect(deriveStatus(journal.slice(0, requestedAt + 1)).phase).toBe("LOCAL_REVIEW");
    expect(deriveStatus(journal.slice(0, verdictAt + 1)).phase).toBe("GATING");
  });

  it("renders the tier-2 dossier from the verdict artifact", async () => {
    const f = fixture();
    const h = deps(f);
    h.setReviewer(async () => {
      verdict(f.runDir, {
        code: 0,
        findings: [
          {
            id: "note-only",
            severity: "note",
            file: "src/x.ts",
            title: "Nit worth recording",
            body: "Cosmetic only.",
          },
        ],
      });
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await runCapsule(f.runDir, h.deps);

    const dossier = readFileSync(join(f.runDir, "review-1-coded.md"), "utf8");
    expect(dossier).toContain("Review round 1 @ coded");
    expect(dossier).toContain("note-only");
  });

  it("escalates a code-1 verdict when no coder thread artifact exists to resume", async () => {
    const f = fixture();
    const h = deps(f);
    const runGate = vi.fn(h.deps.runGate!);
    h.deps.runGate = runGate;
    h.setReviewer(async () => {
      verdict(f.runDir, {
        code: 1,
        findings: [
          {
            id: "hardcoded-timeout",
            severity: "blocker",
            file: "src/app/x.ts",
            line: 12,
            title: "New timeout constant without env path",
            body: "Wire env/TOML.",
            criticalSurface: "publishing",
          },
        ],
      });
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({
      status: "local_review_escalated",
      exitCode: 0,
    });
    expect(runGate).not.toHaveBeenCalled();
    expect(h.agentCommands).toHaveLength(2);
    const journal = events(f.runDir);
    expect(journal.at(-1)).toMatchObject({
      event: "needs_human",
      reason: "review_fix_thread_unavailable",
      round: 1,
      findings: [
        {
          id: "hardcoded-timeout",
          severity: "blocker",
          file: "src/app/x.ts",
          line: 12,
          title: "New timeout constant without env path",
          fingerprints: ["id:hardcoded-timeout", "loc:src/app/x.ts#new-timeout-constant-without-env-path"],
        },
      ],
    });
    expect(deriveStatus(readEvents(f.runDir)).needsHuman).toBe(true);
    expect(readLoopState(f.runDir)?.guard).toEqual({
      state: "escalated",
      round: 1,
      reason: "review_fix_thread_unavailable",
    });
  });

  for (const code of [2, 3] as const) {
    it(`stops with needs_human on code ${code}`, async () => {
      const f = fixture();
      const h = deps(f);
      h.setReviewer(async () => {
        verdict(f.runDir, { code });
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({
        status: "local_review_escalated",
        exitCode: 0,
      });
      expect(events(f.runDir).at(-1)).toMatchObject({
        event: "needs_human",
        reason: `local_verdict_code_${code}`,
      });
    });
  }

  it("harvests the machine-readable follow-ups block into the journal", async () => {
    const f = fixture();
    const h = deps(f);
    h.setReviewer(async () => {
      verdict(f.runDir, {
        followUps: [{ title: "Consider fs.watch", findingId: "note-only" }],
      });
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await runCapsule(f.runDir, h.deps);

    expect(events(f.runDir)).toContainEqual({
      event: "follow_ups",
      round: 1,
      items: [{ title: "Consider fs.watch", findingId: "note-only" }],
    });
  });

  it("escalates when the reviewer exits without producing a verdict", async () => {
    const f = fixture();
    const h = deps(f);
    h.setReviewer(async () => ({ exitCode: 3, stdout: "", stderr: "" }));

    await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({
      status: "local_review_escalated",
      exitCode: 0,
    });
    expect(events(f.runDir).at(-1)).toMatchObject({
      event: "needs_human",
      reason: "local_verdict_missing",
      round: 1,
      reviewer_exit_code: 3,
    });
  });

  it("escalates a verdict pinned to the wrong sha as malformed round attribution", async () => {
    const f = fixture();
    const h = deps(f);
    h.setReviewer(async () => {
      verdict(f.runDir, { reviewed: { sha: "someone-elses-changeset" } });
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({
      status: "local_review_escalated",
      exitCode: 0,
    });
    expect(events(f.runDir).at(-1)).toMatchObject({
      event: "needs_human",
      reason: "local_verdict_malformed",
    });
  });

  it("escalates a verdict missing required checklist ids (issue #276 contract)", async () => {
    const f = fixture();
    const h = deps(f);
    h.setReviewer(async () => {
      verdict(f.runDir, { checklist: [{ id: "tdd-first", status: "pass" }] });
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({
      status: "local_review_escalated",
      exitCode: 0,
    });
    const escalation = events(f.runDir).at(-1);
    expect(escalation).toMatchObject({ event: "needs_human", reason: "local_verdict_malformed" });
    expect(String(escalation?.["detail"])).toContain("checklist");
  });
});

describe("classifyCapsulePhase", () => {
  function journal(...names: Array<ComboEvent["event"]>): ComboEvent[] {
    return names.map((event) => ({ t: new Date(0).toISOString(), event }));
  }

  it("classifies a fresh or coder-active journal as the full sequence", () => {
    expect(classifyCapsulePhase([])).toBe("sequence");
    expect(classifyCapsulePhase(journal("combo_created", "coder_started"))).toBe("sequence");
  });

  it("classifies a failed coder as the full sequence again", () => {
    expect(
      classifyCapsulePhase(journal("coder_started", "coder_done", "coder_started", "coder_failed")),
    ).toBe("sequence");
  });

  it("classifies a completed coder without a PR as the gate phase", () => {
    expect(classifyCapsulePhase(journal("coder_started", "coder_done"))).toBe("gate");
    expect(
      classifyCapsulePhase(journal("coder_started", "coder_done", "local_review_requested", "local_verdict")),
    ).toBe("gate");
    expect(classifyCapsulePhase(journal("coder_started", "coder_done", "gate_started", "gate_failed"))).toBe(
      "gate",
    );
  });

  it("classifies an opened PR as supervision, including closure-pending merges", () => {
    expect(classifyCapsulePhase(journal("coder_done", "pr_opened"))).toBe("supervise");
    expect(classifyCapsulePhase(journal("coder_done", "pr_opened", "merged"))).toBe("supervise");
  });

  it("classifies combo_closed as terminal", () => {
    expect(classifyCapsulePhase(journal("coder_done", "pr_opened", "merged", "combo_closed"))).toBe("closed");
  });

  it("keeps review-fix coder events out of phase classification", () => {
    const reviewFix = (event: ComboEvent["event"]): ComboEvent => ({
      t: new Date(0).toISOString(),
      event,
      mode: "review_fix",
    });
    // An interrupted or failed fix turn is review-loop-internal state: the
    // capsule entry point stays "gate" and the loop resume fold owns it.
    expect(
      classifyCapsulePhase([...journal("coder_started", "coder_done"), reviewFix("coder_started")]),
    ).toBe("gate");
    expect(
      classifyCapsulePhase([
        ...journal("coder_started", "coder_done"),
        reviewFix("coder_started"),
        reviewFix("coder_failed"),
      ]),
    ).toBe("gate");
    expect(classifyCapsulePhase([...journal("coder_started", "coder_done"), reviewFix("coder_done")])).toBe(
      "gate",
    );
  });
});

describe("capsule review loop (W5b)", () => {
  const ok = { exitCode: 0, stdout: "", stderr: "" };
  const findingA = {
    id: "hardcoded-timeout",
    severity: "blocker" as const,
    file: "src/app/x.ts",
    line: 12,
    title: "New timeout constant without env path",
    body: "Wire env/TOML.",
  };
  const findingB = {
    id: "missing-test",
    severity: "major" as const,
    file: "src/app/y.ts",
    title: "Behavior change without failing-first test",
    body: "Add the red test.",
  };

  it("iterates code 1 through a coder fix turn and closes the loop with a verdict on the fix commit", async () => {
    const f = fixture();
    writeCoderThreadArtifact(f.runDir);
    const h = deps(f, {
      // coder base+head, round-1 request, fix-turn base, fix-turn head, round-2 request:
      // round 2 must review the NEW fix commit, not the round-1 sha.
      heads: ["base", "coded", "coded", "coded", "fixed", "fixed"],
      agents: [
        async () => ok,
        async () => {
          verdict(f.runDir, { round: 1, code: 1, findings: [findingA] });
          return ok;
        },
        async () => ok, // the fix turn: exits, leaving one new commit
        async () => {
          verdict(f.runDir, { round: 2, code: 0, reviewed: { sha: "fixed" } });
          return ok;
        },
      ],
    });

    await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({ status: "validated", exitCode: 0 });
    // W6a's lgtm pin and patch-id carry-over journal after the loop clears;
    // this test pins the loop's own event sequence.
    expect(events(f.runDir).slice(0, 8)).toEqual([
      { event: "coder_started" },
      { event: "coder_done" },
      { event: "local_review_requested", round: 1, sha: "coded" },
      expect.objectContaining({ event: "local_verdict", round: 1, code: 1 }),
      { event: "coder_started", round: 1, mode: "review_fix" },
      { event: "coder_done", round: 1, mode: "review_fix", new_commit_count: 1 },
      { event: "local_review_requested", round: 2, sha: "fixed" },
      expect.objectContaining({ event: "local_verdict", round: 2, code: 0, sha: "fixed" }),
    ]);
    const fixCommand = h.agentCommands[2]!;
    expect(fixCommand).toContain("codex resume");
    expect(fixCommand).toContain("hardcoded-timeout");
    expect(fixCommand).toContain("review-1-coded.md");
    expect(fixCommand).not.toContain("gnhf");
    expect(h.activateReviewer).toHaveBeenCalledOnce();
    expect(readFileSync(join(f.runDir, "review-2-fixed.md"), "utf8")).toContain("Review round 2 @ fixed");
    const state = readLoopState(f.runDir);
    expect(state?.currentRound).toBe(2);
    expect(state?.rounds.map((round) => round.code)).toEqual([1, 0]);
    expect(state?.rounds.map((round) => round.verdictPath)).toEqual(["verdict-1.json", "verdict-2.json"]);
    expect(state?.rounds.at(-1)?.sha).toBe("fixed");
    expect(state?.guard).toEqual({ state: "cleared", round: 2 });
    expect(state?.fingerprintSurvival["id:hardcoded-timeout"]).toEqual([1]);
  });

  it("escalates when the same finding fingerprint survives two consecutive rounds", async () => {
    const f = fixture();
    writeCoderThreadArtifact(f.runDir);
    const h = deps(f, {
      agents: [
        async () => ok,
        async () => {
          verdict(f.runDir, { round: 1, code: 1, findings: [findingA] });
          return ok;
        },
        async () => ok,
        async () => {
          // Line drifted, id survived: the fix did not land.
          verdict(f.runDir, { round: 2, code: 1, findings: [{ ...findingA, line: 40 }, findingB] });
          return ok;
        },
      ],
    });
    const runGate = vi.fn(h.deps.runGate!);
    h.deps.runGate = runGate;

    await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({
      status: "local_review_escalated",
      exitCode: 0,
    });
    expect(runGate).not.toHaveBeenCalled();
    expect(h.agentCommands).toHaveLength(4);
    const escalation = events(f.runDir).at(-1);
    expect(escalation).toMatchObject({
      event: "needs_human",
      reason: "review_no_progress",
      round: 2,
      findings: [expect.objectContaining({ id: "hardcoded-timeout" })],
    });
    const state = readLoopState(f.runDir);
    expect(state?.guard).toEqual({ state: "escalated", round: 2, reason: "review_no_progress" });
    expect(state?.fingerprintSurvival["id:hardcoded-timeout"]).toEqual([1, 2]);
  });

  it("escalates a no-op coder fix turn instead of re-reviewing", async () => {
    const f = fixture();
    writeCoderThreadArtifact(f.runDir);
    const h = deps(f, {
      revListCounts: [1, 0], // coder phase commits; the fix turn does not
      agents: [
        async () => ok,
        async () => {
          verdict(f.runDir, { round: 1, code: 1, findings: [findingA] });
          return ok;
        },
        async () => ({ exitCode: 5, stdout: "", stderr: "" }), // no-op fix turn
      ],
    });

    await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({
      status: "local_review_escalated",
      exitCode: 0,
    });
    expect(h.agentCommands).toHaveLength(3);
    expect(events(f.runDir).at(-1)).toMatchObject({
      event: "needs_human",
      reason: "review_fix_noop",
      round: 1,
      coder_exit_code: 5,
      findings: [expect.objectContaining({ id: "hardcoded-timeout" })],
    });
    // The no-op turn journals no coder_done: the last coder event is the fix start.
    expect(events(f.runDir).filter((event) => event.event === "coder_done")).toHaveLength(1);
    expect(readLoopState(f.runDir)?.guard).toEqual({
      state: "escalated",
      round: 1,
      reason: "review_fix_noop",
    });
  });

  it("escalates at the configured round cap when every round finds fresh defects", async () => {
    const f = fixture();
    writeCoderThreadArtifact(f.runDir);
    const snapshotPath = join(f.runDir, "config.snapshot.json");
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
    snapshot["reviewMaxRounds"] = 2;
    writeFileSync(snapshotPath, `${JSON.stringify(snapshot)}\n`);
    const h = deps(f, {
      agents: [
        async () => ok,
        async () => {
          verdict(f.runDir, { round: 1, code: 1, findings: [findingA] });
          return ok;
        },
        async () => ok,
        async () => {
          verdict(f.runDir, { round: 2, code: 1, findings: [findingB] });
          return ok;
        },
      ],
    });

    await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({
      status: "local_review_escalated",
      exitCode: 0,
    });
    expect(h.agentCommands).toHaveLength(4);
    expect(events(f.runDir).at(-1)).toMatchObject({
      event: "needs_human",
      reason: "review_max_rounds",
      round: 2,
      max_rounds: 2,
      findings: [expect.objectContaining({ id: "missing-test" })],
    });
    expect(readLoopState(f.runDir)?.guard).toEqual({
      state: "escalated",
      round: 2,
      reason: "review_max_rounds",
    });
  });

  it("enforces the default round cap for a pre-W5b snapshot missing the review fields", async () => {
    const f = fixture();
    writeCoderThreadArtifact(f.runDir);
    const snapshotPath = join(f.runDir, "config.snapshot.json");
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
    // A run frozen before W5b has none of the [review] fields; the loop must
    // still be bounded by the documented default cap, never by undefined.
    delete snapshot["reviewMaxRounds"];
    delete snapshot["reviewerTurnTimeoutMinutes"];
    delete snapshot["fixTurnTimeoutMinutes"];
    delete snapshot["reviewVerdictWaitMs"];
    writeFileSync(snapshotPath, `${JSON.stringify(snapshot)}\n`);
    const freshFinding = (round: number) => ({
      ...findingA,
      id: `fresh-${round}`,
      file: `src/app/fresh-${round}.ts`,
      title: `Fresh defect ${round}`,
    });
    const h = deps(f, {
      agents: [
        async () => ok,
        ...[1, 2, 3].flatMap((round) => [
          async () => {
            verdict(f.runDir, { round, code: 1 as const, findings: [freshFinding(round)] });
            return ok;
          },
          async () => ok, // fix turn after rounds 1 and 2; never reached after round 3
        ]),
      ],
    });

    await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({
      status: "local_review_escalated",
      exitCode: 0,
    });
    // coder + three reviews + two fix turns: the cap stops round 3 before a third fix.
    expect(h.agentCommands).toHaveLength(6);
    expect(events(f.runDir).at(-1)).toMatchObject({
      event: "needs_human",
      reason: "review_max_rounds",
      round: 3,
      max_rounds: 3,
    });
  });

  it("records the loop position while iterating and clears it on a code-0 close", async () => {
    const f = fixture();
    const h = deps(f);

    await runCapsule(f.runDir, h.deps);

    const state = readLoopState(f.runDir);
    expect(state?.currentRound).toBe(1);
    expect(state?.rounds).toEqual([
      { round: 1, sha: "coded", verdictPath: "verdict-1.json", code: 0, findingIds: [] },
    ]);
    expect(state?.guard).toEqual({ state: "cleared", round: 1 });
  });
});

describe("capsule review loop resume (W5b fix round 1)", () => {
  const ok = { exitCode: 0, stdout: "", stderr: "" };
  const findingA = {
    id: "hardcoded-timeout",
    severity: "blocker" as const,
    file: "src/app/x.ts",
    line: 12,
    title: "New timeout constant without env path",
    body: "Wire env/TOML.",
  };

  /** Journal + artifacts as they exist right after a round-1 code-1 verdict. */
  function seedRoundOne(f: { runDir: string }): VerdictFile {
    appendEvent(f.runDir, "coder_started", {});
    appendEvent(f.runDir, "coder_done", {});
    const seeded = verdict(f.runDir, { round: 1, code: 1, findings: [findingA] });
    appendEvent(f.runDir, "local_review_requested", { round: 1, sha: "coded" });
    appendEvent(f.runDir, "local_verdict", {
      round: 1,
      code: 1,
      verdict_path: "verdict-1.json",
      identity: seeded.identity,
      sha: "coded",
    });
    writeLoopState(f.runDir, recordLoopRound(initialLoopState(), seeded));
    return seeded;
  }

  function seedFixDone(f: { runDir: string }): void {
    appendEvent(f.runDir, "coder_started", { round: 1, mode: "review_fix" });
    appendEvent(f.runDir, "coder_done", { round: 1, mode: "review_fix", new_commit_count: 1 });
  }

  it("resumes the pending fix turn after a crash on the code-1 verdict, never redoing round 1", async () => {
    const f = fixture();
    writeCoderThreadArtifact(f.runDir);
    seedRoundOne(f);
    const h = deps(f, {
      heads: ["coded", "fixed", "fixed"],
      agents: [
        async () => ok, // the resumed fix turn
        async () => {
          verdict(f.runDir, { round: 2, code: 0, reviewed: { sha: "fixed" } });
          return ok;
        },
      ],
    });

    await expect(runCapsule(f.runDir, h.deps, { startAtGate: true })).resolves.toEqual({
      status: "validated",
      exitCode: 0,
    });
    expect(h.agentCommands[0]).toContain("codex resume");
    const journal = events(f.runDir);
    expect(
      journal.filter((event) => event.event === "local_review_requested" && event.round === 1),
    ).toHaveLength(1);
    expect(journal).toContainEqual({ event: "coder_started", round: 1, mode: "review_fix" });
    expect(journal).toContainEqual({ event: "local_review_requested", round: 2, sha: "fixed" });
    // Round 1's artifact is history, never overwritten.
    const roundOne = JSON.parse(readFileSync(join(f.runDir, "verdict-1.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(roundOne["round"]).toBe(1);
    expect(roundOne["code"]).toBe(1);
    const state = readLoopState(f.runDir);
    expect(state?.rounds.map((round) => round.round)).toEqual([1, 2]);
    expect(state?.guard).toEqual({ state: "cleared", round: 2 });
    expect(state?.fingerprintSurvival["id:hardcoded-timeout"]).toEqual([1]);
  });

  it("trusts commit observables for a fix turn interrupted before coder_done", async () => {
    const f = fixture();
    writeCoderThreadArtifact(f.runDir);
    seedRoundOne(f);
    appendEvent(f.runDir, "coder_started", { round: 1, mode: "review_fix" });
    const h = deps(f, {
      heads: ["fixed", "fixed"],
      agents: [
        async () => {
          verdict(f.runDir, { round: 2, code: 0, reviewed: { sha: "fixed" } });
          return ok;
        },
      ],
    });

    await expect(runCapsule(f.runDir, h.deps, { startAtGate: true })).resolves.toEqual({
      status: "validated",
      exitCode: 0,
    });
    // No second fix turn ran: the dead turn's commit is the completion evidence.
    expect(h.agentCommands).toHaveLength(1);
    expect(events(f.runDir)).toContainEqual({
      event: "coder_done",
      round: 1,
      mode: "review_fix",
      new_commit_count: 1,
      recovered: true,
    });
  });

  it("re-runs an interrupted fix turn that left no commits", async () => {
    const f = fixture();
    writeCoderThreadArtifact(f.runDir);
    seedRoundOne(f);
    appendEvent(f.runDir, "coder_started", { round: 1, mode: "review_fix" });
    const h = deps(f, {
      heads: ["coded", "coded", "fixed", "fixed"],
      revListCounts: [0, 1], // resume observes no commits; the re-run commits
      agents: [
        async () => ok, // re-run fix turn
        async () => {
          verdict(f.runDir, { round: 2, code: 0, reviewed: { sha: "fixed" } });
          return ok;
        },
      ],
    });

    await expect(runCapsule(f.runDir, h.deps, { startAtGate: true })).resolves.toEqual({
      status: "validated",
      exitCode: 0,
    });
    expect(h.agentCommands[0]).toContain("codex resume");
    expect(
      events(f.runDir).filter((event) => event.event === "coder_started" && event["mode"] === "review_fix"),
    ).toHaveLength(2);
  });

  it("resumes at the re-review after a completed fix turn", async () => {
    const f = fixture();
    writeCoderThreadArtifact(f.runDir);
    seedRoundOne(f);
    seedFixDone(f);
    const h = deps(f, {
      heads: ["fixed"],
      agents: [
        async () => {
          verdict(f.runDir, { round: 2, code: 0, reviewed: { sha: "fixed" } });
          return ok;
        },
      ],
    });

    await expect(runCapsule(f.runDir, h.deps, { startAtGate: true })).resolves.toEqual({
      status: "validated",
      exitCode: 0,
    });
    expect(h.agentCommands).toHaveLength(1);
    expect(
      events(f.runDir).filter((event) => event.event === "coder_done" && event["mode"] === "review_fix"),
    ).toHaveLength(1);
  });

  it("re-requests a review that crashed before the verdict artifact appeared", async () => {
    const f = fixture();
    writeCoderThreadArtifact(f.runDir);
    seedRoundOne(f);
    seedFixDone(f);
    appendEvent(f.runDir, "local_review_requested", { round: 2, sha: "fixed" });
    const h = deps(f, {
      heads: ["fixed"],
      agents: [
        async () => {
          verdict(f.runDir, { round: 2, code: 0, reviewed: { sha: "fixed" } });
          return ok;
        },
      ],
    });

    await expect(runCapsule(f.runDir, h.deps, { startAtGate: true })).resolves.toEqual({
      status: "validated",
      exitCode: 0,
    });
    const journal = events(f.runDir);
    // The round is re-requested under its own number; round 1 stays history.
    expect(
      journal.filter((event) => event.event === "local_review_requested" && event.round === 2),
    ).toHaveLength(2);
    expect(
      journal.filter((event) => event.event === "local_review_requested" && event.round === 1),
    ).toHaveLength(1);
  });

  it("consumes an orphan verdict artifact without re-spawning the reviewer", async () => {
    const f = fixture();
    writeCoderThreadArtifact(f.runDir);
    seedRoundOne(f);
    seedFixDone(f);
    appendEvent(f.runDir, "local_review_requested", { round: 2, sha: "fixed" });
    verdict(f.runDir, { round: 2, code: 0, reviewed: { sha: "fixed" } });
    const h = deps(f, { heads: ["fixed"], agents: [] });

    await expect(runCapsule(f.runDir, h.deps, { startAtGate: true })).resolves.toEqual({
      status: "validated",
      exitCode: 0,
    });
    expect(h.agentCommands).toHaveLength(0);
    expect(events(f.runDir)).toContainEqual(
      expect.objectContaining({ event: "local_verdict", round: 2, code: 0, sha: "fixed" }),
    );
    expect(readLoopState(f.runDir)?.guard).toEqual({ state: "cleared", round: 2 });
  });

  it("keeps a pending loop escalation idempotent across resumes", async () => {
    const f = fixture();
    writeCoderThreadArtifact(f.runDir);
    const seeded = seedRoundOne(f);
    appendEvent(f.runDir, "needs_human", {
      reason: "review_fix_noop",
      round: 1,
      findings: [{ id: "hardcoded-timeout" }],
    });
    writeLoopState(
      f.runDir,
      withLoopGuard(recordLoopRound(initialLoopState(), seeded), {
        state: "escalated",
        round: 1,
        reason: "review_fix_noop",
      }),
    );
    const h = deps(f, { agents: [] });
    const before = events(f.runDir).length;

    await expect(runCapsule(f.runDir, h.deps, { startAtGate: true })).resolves.toEqual({
      status: "local_review_escalated",
      exitCode: 0,
    });
    expect(h.agentCommands).toHaveLength(0);
    expect(events(f.runDir)).toHaveLength(before);
  });

  it("converges a lost escalated guard write from the journal on resume", async () => {
    const f = fixture();
    writeCoderThreadArtifact(f.runDir);
    seedRoundOne(f);
    // The needs_human landed but the capsule died before the guard write.
    appendEvent(f.runDir, "needs_human", { reason: "review_fix_noop", round: 1 });
    const h = deps(f, { agents: [] });

    await expect(runCapsule(f.runDir, h.deps, { startAtGate: true })).resolves.toEqual({
      status: "local_review_escalated",
      exitCode: 0,
    });
    expect(readLoopState(f.runDir)?.guard).toEqual({
      state: "escalated",
      round: 1,
      reason: "review_fix_noop",
    });
  });

  it("appends the missing escalation for a code-2 verdict that crashed pre-needs_human", async () => {
    const f = fixture();
    const seeded = verdict(f.runDir, { round: 1, code: 2 });
    appendEvent(f.runDir, "coder_started", {});
    appendEvent(f.runDir, "coder_done", {});
    appendEvent(f.runDir, "local_review_requested", { round: 1, sha: "coded" });
    appendEvent(f.runDir, "local_verdict", {
      round: 1,
      code: 2,
      verdict_path: "verdict-1.json",
      identity: seeded.identity,
      sha: "coded",
    });
    const h = deps(f, { agents: [] });

    await expect(runCapsule(f.runDir, h.deps, { startAtGate: true })).resolves.toEqual({
      status: "local_review_escalated",
      exitCode: 0,
    });
    expect(events(f.runDir).at(-1)).toMatchObject({
      event: "needs_human",
      reason: "local_verdict_code_2",
      round: 1,
    });
    expect(readLoopState(f.runDir)?.guard).toEqual({
      state: "escalated",
      round: 1,
      reason: "local_verdict_code_2",
    });
  });

  it("a retry decision re-enters the loop at the next round with history intact", async () => {
    const f = fixture();
    writeCoderThreadArtifact(f.runDir);
    const seeded = seedRoundOne(f);
    const escalation = appendEvent(f.runDir, "needs_human", { reason: "review_fix_noop", round: 1 });
    writeLoopState(
      f.runDir,
      withLoopGuard(recordLoopRound(initialLoopState(), seeded), {
        state: "escalated",
        round: 1,
        reason: "review_fix_noop",
      }),
    );
    appendEvent(f.runDir, "decision", { needs_human_ref: escalation.t, verb: "retry" });
    const h = deps(f, {
      heads: ["fixed2"],
      agents: [
        async () => {
          verdict(f.runDir, { round: 2, code: 0, reviewed: { sha: "fixed2" } });
          return ok;
        },
      ],
    });

    await expect(runCapsule(f.runDir, h.deps, { startAtGate: true })).resolves.toEqual({
      status: "validated",
      exitCode: 0,
    });
    expect(events(f.runDir)).toContainEqual({ event: "local_review_requested", round: 2, sha: "fixed2" });
    const state = readLoopState(f.runDir);
    expect(state?.rounds.map((round) => round.round)).toEqual([1, 2]);
    expect(state?.guard).toEqual({ state: "cleared", round: 2 });
  });

  it("keeps a non-retry decision parked instead of iterating or gating", async () => {
    const f = fixture();
    writeCoderThreadArtifact(f.runDir);
    const seeded = seedRoundOne(f);
    const escalation = appendEvent(f.runDir, "needs_human", { reason: "review_fix_noop", round: 1 });
    writeLoopState(
      f.runDir,
      withLoopGuard(recordLoopRound(initialLoopState(), seeded), {
        state: "escalated",
        round: 1,
        reason: "review_fix_noop",
      }),
    );
    appendEvent(f.runDir, "decision", { needs_human_ref: escalation.t, verb: "take_over" });
    const h = deps(f, { agents: [] });
    const runGate = vi.fn(h.deps.runGate!);
    h.deps.runGate = runGate;

    await expect(runCapsule(f.runDir, h.deps, { startAtGate: true })).resolves.toEqual({
      status: "local_review_escalated",
      exitCode: 0,
    });
    expect(h.agentCommands).toHaveLength(0);
    expect(runGate).not.toHaveBeenCalled();
  });

  it("proceeds straight to the gate when the loop already cleared", async () => {
    const f = fixture();
    appendEvent(f.runDir, "coder_started", {});
    appendEvent(f.runDir, "coder_done", {});
    const seeded = verdict(f.runDir, { round: 1, code: 0 });
    appendEvent(f.runDir, "local_review_requested", { round: 1, sha: "coded" });
    appendEvent(f.runDir, "local_verdict", {
      round: 1,
      code: 0,
      verdict_path: "verdict-1.json",
      identity: seeded.identity,
      sha: "coded",
    });
    writeLoopState(
      f.runDir,
      withLoopGuard(recordLoopRound(initialLoopState(), seeded), { state: "cleared", round: 1 }),
    );
    const h = deps(f, { agents: [] });

    await expect(runCapsule(f.runDir, h.deps, { startAtGate: true })).resolves.toEqual({
      status: "validated",
      exitCode: 0,
    });
    expect(h.agentCommands).toHaveLength(0);
    expect(events(f.runDir).filter((event) => event.event === "local_review_requested")).toHaveLength(1);
  });
});

describe("capsule agent custody (W5b fix round 1)", () => {
  const ok = { exitCode: 0, stdout: "", stderr: "" };
  const finding = {
    id: "hardcoded-timeout",
    severity: "blocker" as const,
    file: "src/app/x.ts",
    title: "New timeout constant without env path",
    body: "Wire env/TOML.",
  };
  const never = (): Promise<GateProcessResult> => new Promise<GateProcessResult>(() => undefined);

  it("terminates a timed-out owned child in production custody", async () => {
    const started = Date.now();

    const result = await runAgentProcess({ command: "sleep 30", cwd: tmpdir(), timeoutMs: 200 });

    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("escalates a reviewer child that never exits at the frozen turn timeout", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const h = deps(f, { agents: [async () => ok, never] });

      const done = runCapsule(f.runDir, h.deps);
      await vi.advanceTimersByTimeAsync(60 * 60_000 + 1);

      await expect(done).resolves.toEqual({ status: "local_review_escalated", exitCode: 0 });
      expect(events(f.runDir).at(-1)).toMatchObject({
        event: "needs_human",
        reason: "local_review_timeout",
        round: 1,
        timeout_minutes: 60,
      });
      expect(readLoopState(f.runDir)?.guard).toEqual({
        state: "escalated",
        round: 1,
        reason: "local_review_timeout",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("escalates a coder fix child that never exits at the frozen turn timeout", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      writeCoderThreadArtifact(f.runDir);
      const h = deps(f, {
        agents: [
          async () => ok,
          async () => {
            verdict(f.runDir, { round: 1, code: 1, findings: [finding] });
            return ok;
          },
          never,
        ],
      });

      const done = runCapsule(f.runDir, h.deps);
      await vi.advanceTimersByTimeAsync(120 * 60_000 + 1);

      await expect(done).resolves.toEqual({ status: "local_review_escalated", exitCode: 0 });
      expect(events(f.runDir).at(-1)).toMatchObject({
        event: "needs_human",
        reason: "review_fix_timeout",
        round: 1,
        timeout_minutes: 120,
        findings: [expect.objectContaining({ id: "hardcoded-timeout" })],
      });
      expect(readLoopState(f.runDir)?.guard).toEqual({
        state: "escalated",
        round: 1,
        reason: "review_fix_timeout",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("escalates a reviewer spawn rejection instead of crashing the capsule", async () => {
    const f = fixture();
    const h = deps(f, {
      agents: [async () => ok, () => Promise.reject(new Error("spawn claude ENOENT"))],
    });

    await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({
      status: "local_review_escalated",
      exitCode: 0,
    });
    const escalation = events(f.runDir).at(-1);
    expect(escalation).toMatchObject({ event: "needs_human", reason: "local_review_spawn_failed", round: 1 });
    expect(String(escalation?.["detail"])).toContain("ENOENT");
  });

  it("escalates a coder fix spawn rejection carrying the findings", async () => {
    const f = fixture();
    writeCoderThreadArtifact(f.runDir);
    const h = deps(f, {
      agents: [
        async () => ok,
        async () => {
          verdict(f.runDir, { round: 1, code: 1, findings: [finding] });
          return ok;
        },
        () => Promise.reject(new Error("spawn codex ENOENT")),
      ],
    });

    await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({
      status: "local_review_escalated",
      exitCode: 0,
    });
    expect(events(f.runDir).at(-1)).toMatchObject({
      event: "needs_human",
      reason: "review_fix_spawn_failed",
      round: 1,
      findings: [expect.objectContaining({ id: "hardcoded-timeout" })],
    });
  });

  it("reports a failed commit count as an operational failure, not a no-op turn", async () => {
    const f = fixture();
    writeCoderThreadArtifact(f.runDir);
    const h = deps(f, {
      agents: [
        async () => ok,
        async () => {
          verdict(f.runDir, { round: 1, code: 1, findings: [finding] });
          return ok;
        },
        async () => ok,
      ],
    });
    const baseGit = h.deps.git;
    let revListCalls = 0;
    h.deps.git = async (request) => {
      if (request.args[0] === "rev-list") {
        revListCalls += 1;
        // The coder phase count succeeds; the fix turn's count fails.
        if (revListCalls === 2) return { exitCode: 129, stdout: "", stderr: "fatal: bad revision" };
      }
      return baseGit(request);
    };

    await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({
      status: "local_review_escalated",
      exitCode: 0,
    });
    const escalation = events(f.runDir).at(-1);
    expect(escalation).toMatchObject({ event: "needs_human", reason: "review_fix_commit_count_failed" });
    expect(String(escalation?.["detail"])).toContain("bad revision");
    expect(events(f.runDir).some((event) => event["reason"] === "review_fix_noop")).toBe(false);
  });

  it("treats a nonzero fix exit that committed as a completed turn and re-reviews", async () => {
    const f = fixture();
    writeCoderThreadArtifact(f.runDir);
    const h = deps(f, {
      agents: [
        async () => ok,
        async () => {
          verdict(f.runDir, { round: 1, code: 1, findings: [finding] });
          return ok;
        },
        async () => ({ exitCode: 7, stdout: "", stderr: "" }),
        async () => {
          verdict(f.runDir, { round: 2, code: 0 });
          return ok;
        },
      ],
    });

    await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({ status: "validated", exitCode: 0 });
    expect(events(f.runDir)).toContainEqual(
      expect.objectContaining({ event: "coder_done", round: 1, mode: "review_fix", new_commit_count: 1 }),
    );
  });
});
// -/ 2/2
