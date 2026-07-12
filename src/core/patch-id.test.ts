/**
 * @overview Unit and real-git tests for the whole-range patch-id primitive.
 *   Pins captain decision D3: equivalence is `git patch-id --stable` over the
 *   whole base..head diff, so a pure rebase preserves it and gate-added
 *   autofix commits break it.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at describe("computeChangesetPatchId") <- resolution rules with a fake runner.
 *   2. describe("patchIdEquals")                    <- equivalence semantics incl. empty diffs.
 *   3. describe("real git")                         <- rebase-survives / autofix-breaks proof.
 *
 *   MAIN FLOW
 *   ---------
 *   fake or real git runner -> computeChangesetPatchId -> {base, head, patchId}
 *
 * @exports none
 * @deps vitest, node:{child_process,fs,os,path}, ./patch-id
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  computeChangesetPatchId,
  patchIdEquals,
  PatchIdError,
  type PatchIdProcessRequest,
  type PatchIdProcessResult,
} from "./patch-id.js";

const BASE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PATCH_ID = "3c8d6e7f3c8d6e7f3c8d6e7f3c8d6e7f3c8d6e7f";

function ok(stdout: string): PatchIdProcessResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function failed(stderr: string): PatchIdProcessResult {
  return { exitCode: 128, stdout: "", stderr };
}

function fakeRunner(responses: Array<(request: PatchIdProcessRequest) => PatchIdProcessResult>): {
  run: (request: PatchIdProcessRequest) => Promise<PatchIdProcessResult>;
  seen: PatchIdProcessRequest[];
} {
  const seen: PatchIdProcessRequest[] = [];
  return {
    seen,
    run: (request) => {
      seen.push(request);
      const respond = responses[seen.length - 1];
      if (respond === undefined) throw new Error(`unexpected process call #${seen.length}`);
      return Promise.resolve(respond(request));
    },
  };
}

// -- 1/3 CORE · resolution rules over a fake runner <- START HERE --
describe("computeChangesetPatchId", () => {
  it("resolves head, merge-base, and the whole-range stable patch-id", async () => {
    const runner = fakeRunner([
      () => ok(`${HEAD_SHA}\n`),
      () => ok(`${BASE_SHA}\n`),
      () => ok(`${PATCH_ID} 0000000000000000000000000000000000000000\n`),
    ]);

    const result = await computeChangesetPatchId({
      run: runner.run,
      cwd: "/work/tree",
      baseRef: "origin/main",
      head: "HEAD",
    });

    expect(result).toEqual({ base: BASE_SHA, head: HEAD_SHA, patchId: PATCH_ID });
    expect(runner.seen[0]).toMatchObject({
      command: "git",
      args: ["rev-parse", "--verify", "HEAD^{commit}"],
      cwd: "/work/tree",
    });
    expect(runner.seen[1]).toMatchObject({
      command: "git",
      args: ["merge-base", "origin/main", HEAD_SHA],
      cwd: "/work/tree",
    });
    expect(runner.seen[2]).toMatchObject({ command: "sh", cwd: "/work/tree" });
    expect(runner.seen[2]!.args[0]).toBe("-c");
    expect(runner.seen[2]!.args[1]).toContain(`git diff '${BASE_SHA}' '${HEAD_SHA}'`);
    expect(runner.seen[2]!.args[1]).toContain("git patch-id --stable");
  });

  it("returns an undefined patch-id for an empty base..head diff", async () => {
    const runner = fakeRunner([() => ok(`${HEAD_SHA}\n`), () => ok(`${HEAD_SHA}\n`), () => ok("")]);

    const result = await computeChangesetPatchId({
      run: runner.run,
      cwd: "/work/tree",
      baseRef: "origin/main",
      head: HEAD_SHA,
    });

    expect(result).toEqual({ base: HEAD_SHA, head: HEAD_SHA, patchId: undefined });
  });

  it("throws a named PatchIdError when the head does not resolve to a commit", async () => {
    const runner = fakeRunner([() => failed("fatal: Needed a single revision")]);

    await expect(
      computeChangesetPatchId({
        run: runner.run,
        cwd: "/work/tree",
        baseRef: "origin/main",
        head: "deadbeef",
      }),
    ).rejects.toThrow(/unresolvable head "deadbeef"/);
  });

  it("throws a named PatchIdError when base and head share no merge base", async () => {
    const runner = fakeRunner([() => ok(`${HEAD_SHA}\n`), () => failed("")]);

    await expect(
      computeChangesetPatchId({
        run: runner.run,
        cwd: "/work/tree",
        baseRef: "origin/main",
        head: HEAD_SHA,
      }),
    ).rejects.toThrow(/no merge base between "origin\/main" and/);
  });

  it("throws PatchIdError when the diff pipe itself fails", async () => {
    const runner = fakeRunner([
      () => ok(`${HEAD_SHA}\n`),
      () => ok(`${BASE_SHA}\n`),
      () => failed("fatal: bad object"),
    ]);

    await expect(
      computeChangesetPatchId({
        run: runner.run,
        cwd: "/work/tree",
        baseRef: "origin/main",
        head: HEAD_SHA,
      }),
    ).rejects.toThrow(PatchIdError);
  });
});
// -/ 1/3

// -- 2/3 CORE · equivalence semantics --
describe("patchIdEquals", () => {
  it("treats equal defined ids as equivalent and different ids as not", () => {
    expect(patchIdEquals({ patchId: PATCH_ID }, { patchId: PATCH_ID })).toBe(true);
    expect(patchIdEquals({ patchId: PATCH_ID }, { patchId: PATCH_ID.replace("3", "4") })).toBe(false);
  });

  it("treats two empty changesets as equivalent and empty-vs-defined as not", () => {
    expect(patchIdEquals({ patchId: undefined }, { patchId: undefined })).toBe(true);
    expect(patchIdEquals({ patchId: undefined }, { patchId: PATCH_ID })).toBe(false);
    expect(patchIdEquals({ patchId: PATCH_ID }, { patchId: undefined })).toBe(false);
  });
});
// -/ 2/3

// -- 3/3 CORE · real-git proof of the D3 carry-over contract --
function realGitRunner(): (request: PatchIdProcessRequest) => Promise<PatchIdProcessResult> {
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

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "combo-chen-patch-id-"));
  git(dir, "init", "--initial-branch", "main");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "user.name", "patch-id test");
  writeFileSync(join(dir, "base.txt"), "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "base");
  return dir;
}

describe("computeChangesetPatchId against real git", () => {
  it("survives a pure rebase and breaks on a gate autofix commit", { timeout: 30_000 }, async () => {
    const dir = initRepo();
    const run = realGitRunner();

    git(dir, "checkout", "-b", "combo/topic");
    writeFileSync(join(dir, "feature.txt"), "feature change\n");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "feat: change");
    const reviewed = await computeChangesetPatchId({ run, cwd: dir, baseRef: "main", head: "HEAD" });
    expect(reviewed.patchId).toMatch(/^[0-9a-f]{40}$/);

    // The base advances with an unrelated change; a pure rebase replays the
    // same changeset onto it. New shas, same whole-range patch-id.
    git(dir, "checkout", "main");
    writeFileSync(join(dir, "unrelated.txt"), "base moved\n");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "chore: advance base");
    git(dir, "checkout", "combo/topic");
    git(dir, "rebase", "main");
    const rebased = await computeChangesetPatchId({ run, cwd: dir, baseRef: "main", head: "HEAD" });
    expect(rebased.head).not.toBe(reviewed.head);
    expect(patchIdEquals(reviewed, rebased)).toBe(true);

    // A gate autofix commit changes the changeset content: not equivalent.
    writeFileSync(join(dir, "feature.txt"), "feature change\nautofix\n");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "fix: gate autofix");
    const autofixed = await computeChangesetPatchId({ run, cwd: dir, baseRef: "main", head: "HEAD" });
    expect(patchIdEquals(reviewed, autofixed)).toBe(false);
  });

  it("reports an empty changeset when head equals the merge base", { timeout: 30_000 }, async () => {
    const dir = initRepo();
    const run = realGitRunner();

    const result = await computeChangesetPatchId({ run, cwd: dir, baseRef: "main", head: "HEAD" });

    expect(result.patchId).toBeUndefined();
    expect(result.base).toBe(result.head);
  });
});
// -/ 3/3
