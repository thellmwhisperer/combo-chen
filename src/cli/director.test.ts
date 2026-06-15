/**
 * @overview Unit tests for director CLI helpers. ~350 lines, READY and post-address orchestration.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at tickDirector tests    <- current-head READY and gate routing.
 *   2. Test harness helpers           <- combo fixture and fake deps.
 *
 *   MAIN FLOW
 *   ---------
 *   fake journal/gh/git/tmux -> tickDirector -> journal events and gate scripts
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   combo, fakeDeps, seedReadyCandidate
 *
 * @exports none
 * @deps vitest, node:{fs,os,path}, ../core/{events,state}, ./director
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appendEvent, readEvents } from "../core/events.js";
import { runDirFor, writeCombo, type ComboRecord } from "../core/state.js";
import { tickDirector, type DirectorDeps } from "./director.js";

// -- 1/2 HELPER · Fixtures --
const ISSUE = "https://github.com/o/r/issues/7";

function combo(overrides: Partial<ComboRecord> = {}): ComboRecord {
  const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
  return {
    id: "o-r-7",
    issueUrl: ISSUE,
    repoDir,
    worktree: join(repoDir, ".worktrees", "issue-7"),
    branch: "combo/issue-7",
    tmuxSession: "combo-chen-o-r-7",
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function successfulRollup(): unknown[] {
  return [
    { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "CodeRabbit", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "StatusContext", context: "coverage", state: "SUCCESS" },
  ];
}

function seedReadyCandidate(input: {
  homeDir: string;
  headSha: string;
  gateSha?: string;
  lgtmSha?: string;
}): { record: ComboRecord; runDir: string } {
  const record = combo();
  const runDir = runDirFor(input.homeDir, record.id);
  writeCombo(runDir, record);
  appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
  appendEvent(runDir, "gate_validated", { sha: input.gateSha ?? input.headSha });
  appendEvent(runDir, "lgtm", { sha: input.lgtmSha ?? input.headSha });
  return { record, runDir };
}

function fakeDeps(input: {
  homeDir: string;
  record: ComboRecord;
  prHeadSha: string;
  worktreeHeadSha?: string;
  rollup?: unknown[];
  codeRabbitComments?: Array<{ body: string; commitSha?: string; submittedAt?: string }>;
  issueComments?: unknown[];
  git?: DirectorDeps["git"];
}): { deps: DirectorDeps; calls: string[][]; out: string[] } {
  const calls: string[][] = [];
  const out: string[] = [];
  const deps: DirectorDeps = {
    env: { COMBO_CHEN_HOME: input.homeDir },
    out: (line) => out.push(line),
    tmux: (args) => {
      calls.push(["tmux", ...args]);
      return { status: 0, stdout: "", stderr: "" };
    },
    gh: (args) => {
      calls.push(["gh", ...args]);
      if (args[0] === "issue" && args[1] === "view") {
        return {
          status: 0,
          stdout: JSON.stringify({ title: "Issue title", body: "Issue body" }),
          stderr: "",
        };
      }
      if (args[0] === "pr" && args[1] === "view") {
        const fields = args.at(-1) ?? "";
        const base = { headRefOid: input.prHeadSha, state: "OPEN" };
        return {
          status: 0,
          stdout: JSON.stringify(
            fields.includes("statusCheckRollup")
              ? { ...base, statusCheckRollup: input.rollup ?? successfulRollup() }
              : base,
          ),
          stderr: "",
        };
      }
      const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
      if (endpoint.endsWith("/issues/7/comments")) {
        return { status: 0, stdout: JSON.stringify(input.issueComments ?? []), stderr: "" };
      }
      if (endpoint.endsWith("/pulls/7/comments")) {
        return { status: 0, stdout: "[]", stderr: "" };
      }
      if (endpoint.endsWith("/pulls/7/reviews")) {
        const comments = input.codeRabbitComments ?? [
          {
            body: "CodeRabbit review complete. No issues found.",
            commitSha: input.prHeadSha,
            submittedAt: "2026-06-15T00:00:00Z",
          },
        ];
        return {
          status: 0,
          stdout: JSON.stringify(
            comments.map((comment, index) => ({
              body: comment.body,
              commit_id: comment.commitSha ?? input.prHeadSha,
              html_url: `https://github.com/o/r/pull/7#pullrequestreview-${index + 1}`,
              state: "COMMENTED",
              submitted_at: comment.submittedAt ?? `2026-06-15T00:00:0${index}Z`,
              user: { login: "coderabbitai" },
            })),
          ),
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
    },
    git:
      input.git ??
      ((args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "remote" && args[1] === "get-url" && args[2] === "no-mistakes") {
          return { status: 2, stdout: "", stderr: "No such remote 'no-mistakes'" };
        }
        if (cwd === input.record.worktree && args[0] === "rev-parse" && args[1] === "HEAD") {
          return { status: 0, stdout: `${input.worktreeHeadSha ?? input.prHeadSha}\n`, stderr: "" };
        }
        if (args[0] === "status" && args[1] === "--porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
      }),
    sleep: () => Promise.resolve(),
  };
  return { deps, calls, out };
}
// -/ 1/2

// -- 2/2 CORE · tickDirector tests <- START HERE --
describe("tickDirector", () => {
  it("emits READY when gate, reviewer, CodeRabbit, and checks all agree on the current head", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { record, runDir } = seedReadyCandidate({ homeDir: h, headSha });
    const { deps } = fakeDeps({ homeDir: h, record, prHeadSha: headSha });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "ready_for_merge",
        sha: headSha,
        pr_url: "https://github.com/o/r/pull/7",
      }),
    );
  });

  it("does not emit READY when CodeRabbit only reports a rate-limited review skip", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { record, runDir } = seedReadyCandidate({ homeDir: h, headSha });
    const { deps } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
      codeRabbitComments: [
        {
          body: "CodeRabbit review complete. No issues found.",
          submittedAt: "2026-06-15T00:00:00Z",
        },
        {
          body: "Review skipped: rate limited for this account.",
          submittedAt: "2026-06-15T00:01:00Z",
        },
      ],
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir).some((event) => event.event === "ready_for_merge")).toBe(false);
  });

  it("does not emit READY when the current head has a failing check rollup", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { record, runDir } = seedReadyCandidate({ homeDir: h, headSha });
    const { deps } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: headSha,
      rollup: [
        { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" },
        { __typename: "CheckRun", name: "CodeRabbit", status: "COMPLETED", conclusion: "SUCCESS" },
      ],
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir).some((event) => event.event === "ready_for_merge")).toBe(false);
  });

  it("does not emit READY when the journaled gate and LGTM belong to a stale SHA", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const oldSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const newSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { record, runDir } = seedReadyCandidate({
      homeDir: h,
      headSha: newSha,
      gateSha: oldSha,
      lgtmSha: oldSha,
    });
    const { deps } = fakeDeps({ homeDir: h, record, prHeadSha: newSha, worktreeHeadSha: oldSha });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir).some((event) => event.event === "ready_for_merge")).toBe(false);
  });

  it("starts a post-address gate only when an actionable nudge is followed by a new committed HEAD", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(repoDir, ".no-mistakes.yaml"), "commands:\n  test: pnpm test\n");
    const record = combo({ repoDir, worktree });
    const runDir = runDirFor(h, record.id);
    const oldSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const newSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    writeCombo(runDir, record);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(runDir, "gate_status", { state: "idle", head_sha: oldSha });
    let revParseCalls = 0;
    const gitCalls: string[][] = [];
    const { deps, calls, out } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: oldSha,
      codeRabbitComments: [],
      issueComments: [
        {
          html_url: "https://github.com/o/r/pull/7#issuecomment-1",
          user: { login: "reviewer" },
          body: "Please handle this.",
        },
      ],
      git: (args, cwd) => {
        gitCalls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "remote" && args[1] === "get-url" && args[2] === "no-mistakes") {
          return { status: 2, stdout: "", stderr: "No such remote 'no-mistakes'" };
        }
        if (cwd === worktree && args[0] === "rev-parse" && args[1] === "HEAD") {
          revParseCalls += 1;
          return { status: 0, stdout: `${revParseCalls === 1 ? oldSha : newSha}\n`, stderr: "" };
        }
        if (args[0] === "status" && args[1] === "--porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
      },
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir)).toContainEqual(expect.objectContaining({ event: "address_done", head_sha: newSha }));
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({ event: "gate_stale", old_sha: oldSha, new_sha: newSha }),
    );
    const gatekeeperWindow = calls.find(
      (call) => call[0] === "tmux" && call[1] === "new-window" && call.includes("gatekeeper"),
    );
    const scriptPath = join(runDir, `gatekeeper-post-${newSha.slice(0, 12)}.sh`);
    expect(gatekeeperWindow?.at(-1)).toBe(`sh '${scriptPath}'`);
    expect(readFileSync(scriptPath, "utf8")).toContain("post-address gate");
    expect(readFileSync(join(worktree, ".no-mistakes.yaml"), "utf8")).toBe("commands:\n  test: pnpm test\n");
    expect(out).toContain(`no-mistakes: copied local config to ${worktree}/.no-mistakes.yaml`);
  });

  it("does not start a post-address gate for LGTM/bookkeeping artifacts without a coder HEAD change", async () => {
    const h = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const previousGateSha = "8ad6cca0d0d0b5d33be0e4e529b397aa7a33c0f4";
    const currentHead = "73f80173a96fc2d70af0972c6ee936cc59ad5f19";
    const { record, runDir } = seedReadyCandidate({
      homeDir: h,
      headSha: currentHead,
      gateSha: previousGateSha,
      lgtmSha: currentHead,
    });
    const { deps, calls } = fakeDeps({
      homeDir: h,
      record,
      prHeadSha: currentHead,
      worktreeHeadSha: currentHead,
      issueComments: [
        {
          body: [
            "@coderabbitai review",
            "",
            "Codex -- Re-running CodeRabbit for current PR #82 head 73f80173.",
          ].join("\n"),
          html_url: "https://github.com/o/r/pull/7#issuecomment-1",
          user: { login: "teseo" },
          created_at: "2026-06-15T02:51:55Z",
        },
      ],
      codeRabbitComments: [
        {
          body: `lgtm @ ${currentHead}\n\nRuntime review. No findings.`,
          commitSha: currentHead,
          submittedAt: "2026-06-15T02:54:18Z",
        },
      ],
    });

    await tickDirector({ deps, home: h, comboId: record.id, cli: "node /repo/dist/cli.mjs" });

    expect(readEvents(runDir).filter((event) => event.event === "review_comment")).toEqual([]);
    expect(readEvents(runDir).some((event) => event.event === "address_done")).toBe(false);
    expect(readEvents(runDir).some((event) => event.event === "gate_stale")).toBe(false);
    expect(calls.some((call) => call[0] === "tmux" && call.includes("gatekeeper"))).toBe(false);
  });
});
// -/ 2/2
