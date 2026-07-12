/**
 * @overview Integration contract for the capsule's READY seams: after a
 *   code-0 verdict the capsule pins the local lgtm with its patch-id, and
 *   after the initial gate publishes it applies the patch-id carry-over
 *   (D3). Kept out of capsule.test.ts so the W5b loop work and this READY
 *   work do not edit the same test file.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at "pins the local lgtm"     <- the code-0 -> lgtm seam.
 *   2. Then the carry-over contracts      <- published head vs reviewed pin.
 *
 *   MAIN FLOW
 *   ---------
 *   persisted run fixture -> runCapsule -> journal lgtm / lgtm_stale contracts
 *
 * @exports none
 * @deps node:{fs,os,path}, vitest, ../../core/{events,state,verdict,work-plan}, ../../infra/{config,config-snapshot}, ./capsule, ./ready
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readEvents } from "../../core/events.js";
import { writeCombo, type ComboRecord } from "../../core/state.js";
import { LOCAL_REVIEW_CHECKLIST, VERDICT_SCHEMA_VERSION, writeVerdictFile } from "../../core/verdict.js";
import { normalizeGitHubIssueWorkPlan, renderWorkPlanMarkdown } from "../../core/work-plan.js";
import { loadConfig } from "../../infra/config.js";
import { writeConfigSnapshot } from "../../infra/config-snapshot.js";
import { runCapsule, type CapsuleDeps } from "./capsule.js";
import { livePinnedLocalLgtm } from "./ready.js";
import type { GateProcessRequest, GateProcessResult } from "../gate/in-process-gate.js";

const REVIEWED_PATCH_ID = "1111111111111111111111111111111111111111";

function fixture(): { runDir: string; combo: ComboRecord } {
  const root = mkdtempSync(join(tmpdir(), "combo-chen-ready-seam-"));
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
  return { runDir, combo };
}

/**
 * A scriptable git fake speaking the three patch-id verbs: rev-parse resolves
 * from `commits`, merge-base returns `base`, and the diff|patch-id pipe
 * returns `patchIds` keyed by resolved head.
 */
function readyDeps(input: {
  runDir: string;
  commits: Record<string, string>;
  patchIds: Record<string, string>;
  publishedSha: string;
}): { deps: CapsuleDeps; agentCommands: string[] } {
  const agentCommands: string[] = [];
  const coderHeads = ["base", "reviewed"];
  let lastResolved = "";
  const git = async (request: GateProcessRequest): Promise<GateProcessResult> => {
    const call = request.args.join(" ");
    if (request.command === "git" && request.args[0] === "rev-parse" && request.args[1] === "--verify") {
      const ref = String(request.args[2]).replace(/\^\{commit\}$/, "");
      const resolved = input.commits[ref];
      if (resolved === undefined) return { exitCode: 128, stdout: "", stderr: `unknown ref ${ref}` };
      lastResolved = resolved;
      return { exitCode: 0, stdout: `${resolved}\n`, stderr: "" };
    }
    if (request.command === "git" && request.args[0] === "rev-parse") {
      return { exitCode: 0, stdout: `${coderHeads.shift() ?? "reviewed"}\n`, stderr: "" };
    }
    if (request.command === "git" && request.args[0] === "merge-base") {
      return { exitCode: 0, stdout: "base\n", stderr: "" };
    }
    if (request.command === "sh" && call.includes("git patch-id --stable")) {
      const patchId = input.patchIds[lastResolved];
      return { exitCode: 0, stdout: patchId === undefined ? "" : `${patchId} 0\n`, stderr: "" };
    }
    if (request.command === "git" && request.args[0] === "rev-list") {
      return { exitCode: 0, stdout: "1\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  let agentCalls = 0;
  return {
    agentCommands,
    deps: {
      env: { COMBO_CHEN_LOCAL_VERDICT_WAIT_MS: "50" },
      out: () => undefined,
      git,
      runAgent: async (request) => {
        agentCommands.push(request.command);
        agentCalls += 1;
        // Call 1 is the coder; call 2 is the reviewer writing the verdict.
        if (agentCalls > 2) throw new Error("unexpected third agent run");
        if (agentCalls === 1) return { exitCode: 0, stdout: "", stderr: "" };
        writeVerdictFile(input.runDir, {
          schemaVersion: VERDICT_SCHEMA_VERSION,
          round: 1,
          code: 0,
          reviewed: { sha: "reviewed" },
          identity: { model: "claude-fable-5", runtime: "claude" },
          checklist: LOCAL_REVIEW_CHECKLIST.map((item) => ({ id: item.id, status: "pass" as const })),
          findings: [],
          followUps: [],
        });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      runGate: async () => ({ status: "validated", exitCode: 0, headSha: input.publishedSha }),
      findPrUrl: async () => "https://github.com/o/r/pull/7",
      resolvePrHead: async () => input.publishedSha,
      activateReviewer: () => undefined,
    },
  };
}

// -- 1/1 CORE · READY seams through runCapsule <- START HERE --
describe("capsule READY seams", () => {
  it("pins the local lgtm with the reviewed patch-id after a code-0 verdict", async () => {
    const f = fixture();
    const h = readyDeps({
      runDir: f.runDir,
      commits: { HEAD: "reviewed", reviewed: "reviewed" },
      patchIds: { reviewed: REVIEWED_PATCH_ID },
      publishedSha: "reviewed",
    });

    await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({ status: "validated", exitCode: 0 });

    const events = readEvents(f.runDir);
    const lgtm = events.find((event) => event.event === "lgtm");
    expect(lgtm).toMatchObject({
      sha: "reviewed",
      patch_id: REVIEWED_PATCH_ID,
      round: 1,
      source: "local_verdict",
    });
    // Published head equals the reviewed sha: no carry-over entry is added.
    expect(events.filter((event) => event.event === "lgtm")).toHaveLength(1);
    expect(livePinnedLocalLgtm(events)).toEqual({ sha: "reviewed", patchId: REVIEWED_PATCH_ID });
  });

  it("carries the lgtm to a rebased published head with the same patch-id", async () => {
    const f = fixture();
    const h = readyDeps({
      runDir: f.runDir,
      commits: { HEAD: "reviewed", reviewed: "reviewed", rebased: "rebased" },
      patchIds: { reviewed: REVIEWED_PATCH_ID, rebased: REVIEWED_PATCH_ID },
      publishedSha: "rebased",
    });

    await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({ status: "validated", exitCode: 0 });

    const events = readEvents(f.runDir);
    expect(livePinnedLocalLgtm(events)).toEqual({ sha: "rebased", patchId: REVIEWED_PATCH_ID });
    expect(events.at(-1)).toMatchObject({
      event: "lgtm",
      sha: "rebased",
      carried_from: "reviewed",
      source: "patch_id_carry_over",
    });
  });

  it("invalidates the lgtm and requests a re-review round when the gate changed the changeset", async () => {
    const f = fixture();
    const h = readyDeps({
      runDir: f.runDir,
      commits: { HEAD: "reviewed", reviewed: "reviewed", autofixed: "autofixed" },
      patchIds: {
        reviewed: REVIEWED_PATCH_ID,
        autofixed: REVIEWED_PATCH_ID.replace("1", "2"),
      },
      publishedSha: "autofixed",
    });

    await expect(runCapsule(f.runDir, h.deps)).resolves.toEqual({ status: "validated", exitCode: 0 });

    const events = readEvents(f.runDir);
    expect(livePinnedLocalLgtm(events)).toBeUndefined();
    expect(events.at(-2)).toMatchObject({
      event: "lgtm_stale",
      old_sha: "reviewed",
      new_sha: "autofixed",
      reason: "patch_id_mismatch",
    });
    expect(events.at(-1)).toMatchObject({
      event: "local_review_requested",
      round: 2,
      sha: "autofixed",
      reason: "lgtm_carry_over",
    });
    expect(events.some((event) => event.event === "needs_human")).toBe(false);
  });
});
// -/ 1/1
