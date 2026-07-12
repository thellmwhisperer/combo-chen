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
import { classifyCapsulePhase, runCapsule, type CapsuleDeps } from "./capsule.js";
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
      env: { COMBO_CHEN_LOCAL_VERDICT_WAIT_MS: "50" },
      out: () => undefined,
      git: async (request) => {
        gitCalls.push(request.args.join(" "));
        if (request.args[0] === "rev-parse")
          return { exitCode: 0, stdout: `${heads.shift() ?? "coded"}\n`, stderr: "" };
        if (request.args[0] === "rev-list") return { exitCode: 0, stdout: "1\n", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      runAgent: async (request) => {
        agentCommands.push(request.command);
        agentCalls += 1;
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
      { event: "gate_started" },
      { event: "gate_status", state: "fix_inflight", head_sha: "coded" },
      { event: "gate_status", state: "idle", head_sha: "published" },
      { event: "pr_opened", url: "https://github.com/o/r/pull/7" },
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

  it("stops with needs_human on code 1 carrying the findings (W5b takes the fix loop)", async () => {
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
    const journal = events(f.runDir);
    expect(journal.at(-1)).toMatchObject({
      event: "needs_human",
      reason: "local_verdict_code_1",
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
    expect(classifyCapsulePhase(journal("coder_started", "coder_done", "coder_started", "coder_failed"))).toBe(
      "sequence",
    );
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
});
// -/ 2/2
