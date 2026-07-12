/**
 * @overview Tests for the v1 capsule READY contract: patch-id lgtm carry-over
 *   across gate rebases (captain decision D3) and the four-leg deterministic
 *   READY agreement with findings-aware external evidence. Pins the #295
 *   regression sagas: autofix commits route a re-review round (never
 *   needs_human), and actionable findings block READY under a SUCCESS check.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at describe("livePinnedLocalLgtm")  <- the patch-id-aware pin fold.
 *   2. describe("applyLgtmCarryOver")            <- real-git rebase/autofix sagas.
 *   3. describe("capsuleReadyAgreement")         <- the four READY legs.
 *
 *   MAIN FLOW
 *   ---------
 *   journal events (+ real git repos for carry-over) -> fold -> decision
 *
 * @exports none
 * @deps vitest, node:{child_process,fs,os,path}, ../../core/events, ./ready
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appendEvent, readEvents, type ComboEvent } from "../../core/events.js";
import type { PatchIdProcessRequest, PatchIdProcessResult } from "../../core/patch-id.js";
import {
  applyLgtmCarryOver,
  capsuleReadyAgreement,
  livePinnedLocalLgtm,
  nextLocalReviewRound,
  pinLocalLgtm,
} from "./ready.js";

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PATCH_ID = "1111111111111111111111111111111111111111";

function event(name: ComboEvent["event"], payload: Record<string, unknown>): ComboEvent {
  return { t: "2026-07-12T10:00:00.000Z", event: name, ...payload };
}

function runDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "combo-chen-ready-")), "run");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function gitRunner(): (request: PatchIdProcessRequest) => Promise<PatchIdProcessResult> {
  return (request) => {
    const result = spawnSync(request.command, request.args, {
      cwd: request.cwd,
      encoding: "utf8",
      env: { ...process.env, ...request.env },
    });
    return Promise.resolve({
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    });
  };
}

/** A repo with a reviewed topic commit on combo/topic branched off main. */
function reviewedRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "combo-chen-carry-"));
  git(dir, "init", "--initial-branch", "main");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "user.name", "carry-over test");
  writeFileSync(join(dir, "base.txt"), "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "base");
  git(dir, "checkout", "-b", "combo/topic");
  writeFileSync(join(dir, "feature.txt"), "feature change\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "feat: change");
  return dir;
}

/** Advance main with an unrelated commit and rebase combo/topic onto it. */
function gateRebase(dir: string): void {
  git(dir, "checkout", "main");
  writeFileSync(join(dir, "unrelated.txt"), "base moved\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "chore: advance base");
  git(dir, "checkout", "combo/topic");
  git(dir, "rebase", "main");
}

// -- 1/4 CORE · patch-id-aware pin fold <- START HERE --
describe("livePinnedLocalLgtm", () => {
  it("folds the latest lgtm with its patch-id and honors lgtm_stale invalidation", () => {
    const events = [
      event("lgtm", { sha: SHA_A, patch_id: PATCH_ID }),
      event("lgtm_stale", { old_sha: SHA_A, new_sha: SHA_B }),
      event("lgtm", { sha: SHA_B, patch_id: PATCH_ID }),
    ];

    expect(livePinnedLocalLgtm(events)).toEqual({ sha: SHA_B, patchId: PATCH_ID });
    expect(livePinnedLocalLgtm(events.slice(0, 2))).toBeUndefined();
    expect(livePinnedLocalLgtm([])).toBeUndefined();
  });

  it("keeps a pin without patch-id readable (sha only)", () => {
    expect(livePinnedLocalLgtm([event("lgtm", { sha: SHA_A })])).toEqual({ sha: SHA_A });
  });
});

describe("nextLocalReviewRound", () => {
  it("is one past the highest requested round, starting at 1", () => {
    expect(nextLocalReviewRound([])).toBe(1);
    expect(
      nextLocalReviewRound([
        event("local_review_requested", { round: 1, sha: SHA_A }),
        event("local_verdict", { round: 1, code: 0, verdict_path: "verdict-1.json", identity: {} }),
        event("local_review_requested", { round: 2, sha: SHA_B }),
      ]),
    ).toBe(3);
  });
});
// -/ 1/4

// -- 2/4 CORE · pinLocalLgtm --
describe("pinLocalLgtm", () => {
  it("journals lgtm pinned to the reviewed sha and its whole-range patch-id", async () => {
    const repo = reviewedRepo();
    const dir = runDir();
    const sha = git(repo, "rev-parse", "HEAD");

    const pin = await pinLocalLgtm({
      git: gitRunner(),
      cwd: repo,
      runDir: dir,
      baseRef: "main",
      sha,
      round: 1,
    });

    expect(pin.sha).toBe(sha);
    expect(pin.patchId).toMatch(/^[0-9a-f]{40}$/);
    const journaled = readEvents(dir);
    expect(journaled).toHaveLength(1);
    expect(journaled[0]).toMatchObject({
      event: "lgtm",
      sha,
      patch_id: pin.patchId,
      round: 1,
      source: "local_verdict",
    });
    expect(livePinnedLocalLgtm(journaled)).toEqual({ sha, patchId: pin.patchId });
  });
});
// -/ 2/4

// -- 3/4 CORE · carry-over sagas --
describe("applyLgtmCarryOver", () => {
  it("carries the lgtm across a pure gate rebase (same whole-range patch-id)", async () => {
    const repo = reviewedRepo();
    const dir = runDir();
    const reviewedSha = git(repo, "rev-parse", "HEAD");
    await pinLocalLgtm({ git: gitRunner(), cwd: repo, runDir: dir, baseRef: "main", sha: reviewedSha, round: 1 });
    gateRebase(repo);
    const publishedSha = git(repo, "rev-parse", "HEAD");
    expect(publishedSha).not.toBe(reviewedSha);

    const result = await applyLgtmCarryOver({
      git: gitRunner(),
      cwd: repo,
      runDir: dir,
      baseRef: "main",
      publishedSha,
    });

    expect(result).toMatchObject({ outcome: "carried", pin: { sha: publishedSha } });
    const events = readEvents(dir);
    expect(livePinnedLocalLgtm(events)).toMatchObject({ sha: publishedSha });
    const carried = events.at(-1)!;
    expect(carried).toMatchObject({ event: "lgtm", sha: publishedSha, carried_from: reviewedSha });
    expect(events.some((entry) => entry.event === "lgtm_stale")).toBe(false);
  });

  it("#295 saga: a gate autofix commit invalidates the lgtm and requests a re-review round, not needs_human", async () => {
    // Repro steps 5-7: reviewed changeset at B, no-mistakes adds an autofix
    // commit and publishes C. The changed changeset must route back to a local
    // re-review round without pre-seeding LGTM at C.
    const repo = reviewedRepo();
    const dir = runDir();
    const reviewedSha = git(repo, "rev-parse", "HEAD");
    appendEvent(dir, "local_review_requested", { round: 1, sha: reviewedSha });
    await pinLocalLgtm({ git: gitRunner(), cwd: repo, runDir: dir, baseRef: "main", sha: reviewedSha, round: 1 });
    gateRebase(repo);
    writeFileSync(join(repo, "feature.txt"), "feature change\nautofix\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "fix: gate autofix");
    const publishedSha = git(repo, "rev-parse", "HEAD");

    const result = await applyLgtmCarryOver({
      git: gitRunner(),
      cwd: repo,
      runDir: dir,
      baseRef: "main",
      publishedSha,
    });

    expect(result).toMatchObject({ outcome: "re_review_requested", round: 2, reason: "patch_id_mismatch" });
    const events = readEvents(dir);
    expect(livePinnedLocalLgtm(events)).toBeUndefined();
    expect(events.at(-2)).toMatchObject({
      event: "lgtm_stale",
      old_sha: reviewedSha,
      new_sha: publishedSha,
      reason: "patch_id_mismatch",
    });
    expect(events.at(-1)).toMatchObject({
      event: "local_review_requested",
      round: 2,
      sha: publishedSha,
      reason: "lgtm_carry_over",
    });
    expect(events.some((entry) => entry.event === "needs_human")).toBe(false);
  });

  it("returns already_current without journaling when the gate published the reviewed head", async () => {
    const repo = reviewedRepo();
    const dir = runDir();
    const reviewedSha = git(repo, "rev-parse", "HEAD");
    await pinLocalLgtm({ git: gitRunner(), cwd: repo, runDir: dir, baseRef: "main", sha: reviewedSha, round: 1 });
    const before = readEvents(dir);

    const result = await applyLgtmCarryOver({
      git: gitRunner(),
      cwd: repo,
      runDir: dir,
      baseRef: "main",
      publishedSha: reviewedSha,
    });

    expect(result).toMatchObject({ outcome: "already_current", pin: { sha: reviewedSha } });
    expect(readEvents(dir)).toEqual(before);
  });

  it("is a no-op when no local lgtm pin is live", async () => {
    const repo = reviewedRepo();
    const dir = runDir();

    const result = await applyLgtmCarryOver({
      git: gitRunner(),
      cwd: repo,
      runDir: dir,
      baseRef: "main",
      publishedSha: git(repo, "rev-parse", "HEAD"),
    });

    expect(result).toEqual({ outcome: "no_pin" });
    expect(readEvents(dir)).toEqual([]);
  });

  it("routes a re-review round when the published head cannot be resolved locally", async () => {
    // Conservative leg: if equivalence cannot be verified the lgtm must not
    // be assumed to hold. Still a re-review request, never needs_human.
    const repo = reviewedRepo();
    const dir = runDir();
    const reviewedSha = git(repo, "rev-parse", "HEAD");
    await pinLocalLgtm({ git: gitRunner(), cwd: repo, runDir: dir, baseRef: "main", sha: reviewedSha, round: 1 });

    const result = await applyLgtmCarryOver({
      git: gitRunner(),
      cwd: repo,
      runDir: dir,
      baseRef: "main",
      publishedSha: SHA_B,
    });

    expect(result).toMatchObject({ outcome: "re_review_requested", reason: "patch_id_unavailable" });
    const events = readEvents(dir);
    expect(events.at(-2)).toMatchObject({ event: "lgtm_stale", old_sha: reviewedSha, new_sha: SHA_B });
    expect(events.at(-1)).toMatchObject({ event: "local_review_requested", sha: SHA_B });
    expect(events.some((entry) => entry.event === "needs_human")).toBe(false);
  });
});
// -/ 3/4

// -- 4/4 CORE · capsuleReadyAgreement --
const GREEN_ROLLUP = [
  { name: "ci", conclusion: "SUCCESS" },
  { name: "CodeRabbit", conclusion: "SUCCESS" },
];

function readyInput(overrides: Partial<Parameters<typeof capsuleReadyAgreement>[0]> = {}) {
  return {
    events: [
      event("gate_status", { state: "idle", head_sha: SHA_A }),
      event("gate_validated", { sha: SHA_A }),
      event("lgtm", { sha: SHA_A, patch_id: PATCH_ID }),
    ],
    headSha: SHA_A,
    statusCheckRollup: GREEN_ROLLUP,
    requiredCheckNames: ["CodeRabbit"],
    ambientCheckNames: [],
    externalEvidence: { state: "clean" as const },
    ...overrides,
  };
}

describe("capsuleReadyAgreement", () => {
  it("is ready when all four legs agree on the current head", () => {
    const decision = capsuleReadyAgreement(readyInput());

    expect(decision).toEqual({ ready: true, blockers: [] });
  });

  it("#295 saga: actionable external findings block READY even when every check reports SUCCESS", () => {
    // Steps 2-3 of the repro: internal lgtm at A, CodeRabbit SUCCESS in the
    // rollup, actionable findings at A. v0 emitted ready_for_merge(A); the
    // capsule agreement must not.
    const decision = capsuleReadyAgreement(readyInput({ externalEvidence: { state: "findings" } }));

    expect(decision.ready).toBe(false);
    expect(decision.blockers).toEqual([expect.stringMatching(/external review evidence.*findings/i)]);
  });

  it("accepts a patch-id-equivalent lgtm pinned to a superseded sha", () => {
    const decision = capsuleReadyAgreement(
      readyInput({
        events: [
          event("gate_status", { state: "idle", head_sha: SHA_B }),
          event("gate_validated", { sha: SHA_B }),
          event("lgtm", { sha: SHA_A, patch_id: PATCH_ID }),
        ],
        headSha: SHA_B,
        headPatchId: PATCH_ID,
      }),
    );

    expect(decision).toEqual({ ready: true, blockers: [] });
  });

  it("blocks when the pinned patch-id does not match the head patch-id", () => {
    const decision = capsuleReadyAgreement(
      readyInput({
        events: [
          event("gate_status", { state: "idle", head_sha: SHA_B }),
          event("gate_validated", { sha: SHA_B }),
          event("lgtm", { sha: SHA_A, patch_id: PATCH_ID }),
        ],
        headSha: SHA_B,
        headPatchId: PATCH_ID.replace("1", "2"),
      }),
    );

    expect(decision.ready).toBe(false);
    expect(decision.blockers).toEqual([expect.stringMatching(/lgtm/i)]);
  });

  it("blocks without gate validation at the current head or with a blocking gate state", () => {
    const staleGate = capsuleReadyAgreement(
      readyInput({
        events: [
          event("gate_validated", { sha: SHA_B }),
          event("lgtm", { sha: SHA_A, patch_id: PATCH_ID }),
        ],
      }),
    );
    expect(staleGate.ready).toBe(false);
    expect(staleGate.blockers).toEqual([expect.stringMatching(/gate/i)]);

    const inflightGate = capsuleReadyAgreement(
      readyInput({
        events: [
          event("gate_validated", { sha: SHA_A }),
          event("gate_status", { state: "fix_inflight", head_sha: SHA_A }),
          event("lgtm", { sha: SHA_A, patch_id: PATCH_ID }),
        ],
      }),
    );
    expect(inflightGate.ready).toBe(false);
    expect(inflightGate.blockers).toEqual([expect.stringMatching(/gate/i)]);
  });

  it("blocks on failing rollup or missing required checks", () => {
    const redRollup = capsuleReadyAgreement(
      readyInput({ statusCheckRollup: [{ name: "ci", conclusion: "FAILURE" }] }),
    );
    expect(redRollup.ready).toBe(false);
    expect(redRollup.blockers.join(" ")).toMatch(/check/i);

    const missingRequired = capsuleReadyAgreement(
      readyInput({ statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }] }),
    );
    expect(missingRequired.ready).toBe(false);
    expect(missingRequired.blockers.join(" ")).toMatch(/required/i);
  });

  it("blocks on stale, missing, or unknown external evidence", () => {
    for (const state of ["missing", "skipped", "unknown"] as const) {
      const decision = capsuleReadyAgreement(readyInput({ externalEvidence: { state } }));
      expect(decision.ready).toBe(false);
    }
  });

  it("reports every failing leg so the journal records one precise picture", () => {
    const decision = capsuleReadyAgreement(
      readyInput({
        events: [],
        statusCheckRollup: [],
        externalEvidence: { state: "missing" },
      }),
    );

    expect(decision.ready).toBe(false);
    expect(decision.blockers.length).toBeGreaterThanOrEqual(4);
  });
});
// -/ 4/4
