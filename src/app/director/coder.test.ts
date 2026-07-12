/**
 * @overview Unit tests for coder-response CLI helpers. ~890 lines, activate, nudge, and recovery flows.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at activateCoder tests        <- resumed coder worker.
 *   2. Then nudgeReviewComments tests      <- mirror sync and comment routing.
 *   3. Then nudgePrConflict tests           <- conflict prompt delivery.
 *   4. Then recoverStuckWorker tests        <- stale worker recreation.
 *   5. Then recoverDeadCoder tests          <- capsule-owned capsule pane relaunch.
 *   6. Test harness helpers                 <- combo and thread artifact setup.
 *
 *   MAIN FLOW
 *   ---------
 *   fake combo state -> activate/nudge helper -> tmux/git/gh calls + journal events
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   combo, writeThreadArtifact
 *
 * @exports none
 * @deps ../../core/events, ../../core/state, ../../infra/config, ../../infra/config-snapshot, ../../roles/coder-invocation, ./coder, node:fs, node:os, node:path, vitest
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appendEvent, readEvents } from "../../core/events.js";
import { runDirFor, writeCombo, type ComboRecord } from "../../core/state.js";
import { loadConfig } from "../../infra/config.js";
import { writeConfigSnapshot } from "../../infra/config-snapshot.js";
import { CODER_THREAD_ARTIFACT } from "../../roles/coder-invocation.js";
import { CODER_WINDOW } from "../runtime/sessions.js";
import {
  activateCoder,
  nudgePrConflict,
  nudgeReviewComments,
  recoverDeadCoder,
  recoverStuckWorker,
} from "./coder.js";

// -- 1/3 HELPER · Test harness --
const CODEX_THREAD_ID = "019eb3f5-c135-76d2-88c5-0aa8edfe4c84";

function combo(overrides: Partial<ComboRecord> = {}): ComboRecord {
  const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
  return {
    id: "o-r-7",
    issueUrl: "https://github.com/o/r/issues/7",
    repoDir,
    worktree: join(repoDir, ".worktrees", "issue-7"),
    branch: "combo/issue-7",
    tmuxSession: "combo-chen-o-r-7",
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function writeThreadArtifact(runDir: string): void {
  writeFileSync(
    join(runDir, CODER_THREAD_ARTIFACT),
    `${JSON.stringify({
      agent: "codex",
      thread_id: CODEX_THREAD_ID,
      source: ".gnhf/runs/implement-github-iss-e6510c/iteration-1.jsonl",
    })}\n`,
  );
}
// -/ 1/3

// -- 2/3 CORE · activateCoder tests <- START HERE --
describe("activateCoder", () => {
  it("starts resumed coder worker from the unified role config", () => {
    const calls: string[][] = [];
    const out: string[] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(home, record.id);

    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      '[limits]\nbabysit_poll_seconds = 7\n\n[roles.coder]\nrespond_command = "codex --profile sitter --no-alt-screen resume {thread_id}"\n',
    );
    writeCombo(runDir, record);
    writeThreadArtifact(runDir);

    activateCoder({
      deps: {
        env: { COMBO_CHEN_HOME: home },
        out: (line) => out.push(line),
        tmux: (args) => {
          calls.push(args);
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      home,
      comboId: record.id,
      cli: "node /repo/dist/cli.mjs",
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(["list-windows", "-t", "combo-chen-o-r-7", "-F", "#{window_name}"]);
    expect(calls[1]).toEqual([
      "new-window",
      "-t",
      "combo-chen-o-r-7",
      "-n",
      CODER_WINDOW,
      `codex --profile sitter --no-alt-screen resume '${CODEX_THREAD_ID}'`,
    ]);
    expect(out).toEqual(["coder responding active for o-r-7"]);
  });

  it("uses the launch config snapshot after repo TOML changes", () => {
    const calls: string[][] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(home, record.id);

    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      '[roles.coder]\nrespond_command = "codex --profile launch resume {thread_id}"\n',
    );
    writeCombo(runDir, record);
    writeConfigSnapshot(runDir, loadConfig({ repoDir: record.repoDir, env: {} }));
    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      '[roles.coder]\nrespond_command = "codex --profile drifted resume {thread_id}"\n',
    );
    writeThreadArtifact(runDir);

    activateCoder({
      deps: {
        env: { COMBO_CHEN_HOME: home },
        out: () => undefined,
        tmux: (args) => {
          calls.push(args);
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      home,
      comboId: record.id,
      cli: "node /repo/dist/cli.mjs",
    });

    expect(calls[0]).toEqual(["list-windows", "-t", "combo-chen-o-r-7", "-F", "#{window_name}"]);
    expect(calls[1]).toEqual([
      "new-window",
      "-t",
      "combo-chen-o-r-7",
      "-n",
      CODER_WINDOW,
      `codex --profile launch resume '${CODEX_THREAD_ID}'`,
    ]);
  });

  it("reports resumed coder startup failures", () => {
    const calls: string[][] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(home, record.id);

    writeCombo(runDir, record);
    writeThreadArtifact(runDir);

    expect(() =>
      activateCoder({
        deps: {
          env: { COMBO_CHEN_HOME: home },
          out: () => undefined,
          tmux: (args) => {
            calls.push(args);
            if (args[0] === "new-window" && args.includes(CODER_WINDOW)) {
              return { status: 1, stdout: "", stderr: "duplicate window" };
            }
            return { status: 0, stdout: "", stderr: "" };
          },
        },
        home,
        comboId: record.id,
        cli: "node /repo/dist/cli.mjs",
      }),
    ).toThrow(`tmux failed to start ${CODER_WINDOW}: duplicate window`);

    expect(calls).not.toContainEqual(["kill-window", "-t", `combo-chen-o-r-7:${CODER_WINDOW}`]);
  });
});
// -/ 2/3

// -- 3/3 CORE · nudgeReviewComments tests --
describe("nudgeReviewComments", () => {
  it("routes default review nudges through the persistent coder window", () => {
    const calls: string[][] = [];
    const out: string[] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo({ tmuxSession: "combo-chen-owned-session" });
    const runDir = runDirFor(home, record.id);

    writeCombo(runDir, record);
    writeThreadArtifact(runDir);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    nudgeReviewComments({
      deps: {
        env: { COMBO_CHEN_HOME: home },
        out: (line) => out.push(line),
        tmux: (args) => {
          calls.push(["tmux", ...args]);
          return { status: 0, stdout: "", stderr: "" };
        },
        git: (args, cwd) => {
          calls.push(["git", `cwd=${cwd}`, ...args]);
          if (args[0] === "remote" && args[1] === "get-url" && args[2] === "no-mistakes") {
            return { status: 2, stdout: "", stderr: "No such remote 'no-mistakes'" };
          }
          if (args[0] === "rev-parse" && args[1] === "HEAD") {
            return { status: 0, stdout: "abc123\n", stderr: "" };
          }
          return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
        },
        gh: (args) => {
          const endpoint = args.at(-1);
          if (endpoint === "repos/o/r/issues/7/comments") {
            return {
              status: 0,
              stdout: JSON.stringify([
                {
                  html_url: "https://github.com/o/r/pull/7#issuecomment-1",
                  user: { login: "external-reviewer" },
                  body: "Please handle this.",
                },
              ]),
              stderr: "",
            };
          }
          return { status: 0, stdout: "[]", stderr: "" };
        },
      },
      home,
      comboId: record.id,
    });

    const tmuxCalls = calls.filter((call) => call[0] === "tmux");
    expect(tmuxCalls).toHaveLength(2);
    expect(tmuxCalls[0]).toEqual([
      "tmux",
      "list-windows",
      "-t",
      "combo-chen-owned-session",
      "-F",
      "#{window_name}",
    ]);
    expect(out).toEqual(["nudged https://github.com/o/r/pull/7#issuecomment-1"]);
    const reviewWindow = calls.find((call) => call[0] === "tmux" && call[1] === "new-window");
    expect(reviewWindow?.at(-1)).toContain("New review comment for coder responding mode:");
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "set-buffer")).toBe(false);
  });

  it("routes fetched PR comments and reports routed nudges", () => {
    const calls: string[][] = [];
    const out: string[] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo({ tmuxSession: "combo-chen-owned-session" });
    const runDir = runDirFor(home, record.id);

    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      ["[external_comments]", 'agents = ["external-reviewer"]', ""].join("\n"),
    );
    writeCombo(runDir, record);
    writeThreadArtifact(runDir);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    nudgeReviewComments({
      deps: {
        env: { COMBO_CHEN_HOME: home },
        out: (line) => out.push(line),
        tmux: (args) => {
          calls.push(["tmux", ...args]);
          return { status: 0, stdout: "", stderr: "" };
        },
        git: (args, cwd) => {
          calls.push(["git", `cwd=${cwd}`, ...args]);
          if (args[0] === "remote" && args[1] === "get-url" && args[2] === "no-mistakes") {
            return { status: 2, stdout: "", stderr: "No such remote 'no-mistakes'" };
          }
          if (args[0] === "rev-parse" && args[1] === "HEAD") {
            return { status: 0, stdout: "abc123\n", stderr: "" };
          }
          return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
        },
        gh: (args) => {
          calls.push(["gh", ...args]);
          const endpoint = args.at(-1);
          if (endpoint === "repos/o/r/issues/7/comments") {
            return {
              status: 0,
              stdout: JSON.stringify([
                {
                  html_url: "https://github.com/o/r/pull/7#issuecomment-1",
                  user: { login: "external-reviewer" },
                  body: "Please handle this.",
                },
              ]),
              stderr: "",
            };
          }
          return { status: 0, stdout: "[]", stderr: "" };
        },
      },
      home,
      comboId: record.id,
    });

    const events = readEvents(runDir).filter((event) => event.event === "review_comment");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      author: "external-reviewer",
      kind: "pr_comment",
      url: "https://github.com/o/r/pull/7#issuecomment-1",
      head_sha: "abc123",
    });
    expect(calls.filter((call) => call[0] === "git")).toEqual([
      ["git", `cwd=${record.worktree}`, "rev-parse", "HEAD"],
    ]);
    const tmuxCalls = calls.filter((call) => call[0] === "tmux");
    expect(tmuxCalls).toHaveLength(2);
    expect(tmuxCalls[1]?.at(-1)).toContain(
      `codex --ask-for-approval never --sandbox workspace-write exec resume '${CODEX_THREAD_ID}'`,
    );
    expect(tmuxCalls[1]?.at(-1)).toContain("New review comment for coder responding mode:");
    expect(out).toEqual(["nudged https://github.com/o/r/pull/7#issuecomment-1"]);
  });

  it("pins routed review comments to the latest published gate SHA instead of local HEAD", () => {
    const calls: string[][] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo({ tmuxSession: "combo-chen-owned-session" });
    const runDir = runDirFor(home, record.id);
    const publishedSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const localSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      ["[external_comments]", 'agents = ["external-reviewer"]', ""].join("\n"),
    );
    writeCombo(runDir, record);
    writeThreadArtifact(runDir);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(runDir, "gate_validated", { sha: publishedSha });

    nudgeReviewComments({
      deps: {
        env: { COMBO_CHEN_HOME: home },
        out: () => undefined,
        tmux: (args) => {
          calls.push(["tmux", ...args]);
          return { status: 0, stdout: "", stderr: "" };
        },
        git: (args, cwd) => {
          calls.push(["git", `cwd=${cwd}`, ...args]);
          if (args[0] === "remote" && args[1] === "get-url" && args[2] === "no-mistakes") {
            return { status: 2, stdout: "", stderr: "No such remote 'no-mistakes'" };
          }
          if (args[0] === "rev-parse" && args[1] === "HEAD") {
            return { status: 0, stdout: `${localSha}\n`, stderr: "" };
          }
          return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
        },
        gh: (args) => {
          const endpoint = args.at(-1);
          if (endpoint === "repos/o/r/issues/7/comments") {
            return {
              status: 0,
              stdout: JSON.stringify([
                {
                  html_url: "https://github.com/o/r/pull/7#issuecomment-1",
                  user: { login: "external-reviewer" },
                  body: "Please handle this.",
                },
              ]),
              stderr: "",
            };
          }
          return { status: 0, stdout: "[]", stderr: "" };
        },
      },
      home,
      comboId: record.id,
    });

    const events = readEvents(runDir).filter((event) => event.event === "review_comment");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      author: "external-reviewer",
      kind: "pr_comment",
      url: "https://github.com/o/r/pull/7#issuecomment-1",
      head_sha: publishedSha,
    });
    expect(calls).not.toContainEqual(["git", `cwd=${record.worktree}`, "rev-parse", "HEAD"]);
  });

  it("uses the launch config snapshot for routed review nudges after repo TOML changes", () => {
    const calls: string[][] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo({ tmuxSession: "combo-chen-owned-session" });
    const runDir = runDirFor(home, record.id);

    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      '[roles.coder]\nrespond_command = "codex --profile launch resume {thread_id}"\n',
    );
    writeCombo(runDir, record);
    writeConfigSnapshot(runDir, loadConfig({ repoDir: record.repoDir, env: {} }));
    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      '[roles.coder]\nrespond_command = "codex --profile drifted resume {thread_id}"\n',
    );
    writeThreadArtifact(runDir);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    nudgeReviewComments({
      deps: {
        env: { COMBO_CHEN_HOME: home },
        out: () => undefined,
        tmux: (args) => {
          calls.push(["tmux", ...args]);
          return { status: 0, stdout: "", stderr: "" };
        },
        git: (args, cwd) => {
          calls.push(["git", `cwd=${cwd}`, ...args]);
          if (args[0] === "remote" && args[1] === "get-url" && args[2] === "no-mistakes") {
            return { status: 2, stdout: "", stderr: "No such remote 'no-mistakes'" };
          }
          if (args[0] === "rev-parse" && args[1] === "HEAD") {
            return { status: 0, stdout: "abc123\n", stderr: "" };
          }
          return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
        },
        gh: (args) => {
          const endpoint = args.at(-1);
          if (endpoint === "repos/o/r/issues/7/comments") {
            return {
              status: 0,
              stdout: JSON.stringify([
                {
                  html_url: "https://github.com/o/r/pull/7#issuecomment-1",
                  user: { login: "external-reviewer" },
                  body: "Please handle this.",
                },
              ]),
              stderr: "",
            };
          }
          return { status: 0, stdout: "[]", stderr: "" };
        },
      },
      home,
      comboId: record.id,
    });

    const tmuxCalls = calls.filter((call) => call[0] === "tmux");
    expect(tmuxCalls).toHaveLength(2);
    expect(tmuxCalls[1]?.at(-1)).toContain(`codex --profile launch resume '${CODEX_THREAD_ID}'`);
    expect(tmuxCalls[1]?.at(-1)).toContain("New review comment for coder responding mode:");
  });

  it("uses configured external comment agents when filtering review noise", () => {
    const calls: string[][] = [];
    const out: string[] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo({ tmuxSession: "combo-chen-owned-session" });
    const runDir = runDirFor(home, record.id);

    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      ["[external_comments]", 'agents = ["external-reviewer"]', ""].join("\n"),
    );
    writeCombo(runDir, record);
    writeThreadArtifact(runDir);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    nudgeReviewComments({
      deps: {
        env: { COMBO_CHEN_HOME: home },
        out: (line) => out.push(line),
        tmux: (args) => {
          calls.push(["tmux", ...args]);
          return { status: 0, stdout: "", stderr: "" };
        },
        git: (args, cwd) => {
          calls.push(["git", `cwd=${cwd}`, ...args]);
          if (args[0] === "remote" && args[1] === "get-url" && args[2] === "no-mistakes") {
            return { status: 2, stdout: "", stderr: "No such remote 'no-mistakes'" };
          }
          if (args[0] === "rev-parse" && args[1] === "HEAD") {
            return { status: 0, stdout: "abc123\n", stderr: "" };
          }
          return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
        },
        gh: (args) => {
          calls.push(["gh", ...args]);
          const endpoint = args.at(-1);
          if (endpoint === "repos/o/r/issues/7/comments") {
            return {
              status: 0,
              stdout: JSON.stringify([
                {
                  html_url: "https://github.com/o/r/pull/7#issuecomment-1",
                  user: { login: "external-reviewer" },
                  body: "Review skipped: rate limited for this account.",
                },
                {
                  html_url: "https://github.com/o/r/pull/7#issuecomment-2",
                  user: { login: "maintainer" },
                  body: "Please handle this.",
                },
              ]),
              stderr: "",
            };
          }
          return { status: 0, stdout: "[]", stderr: "" };
        },
      },
      home,
      comboId: record.id,
    });

    const events = readEvents(runDir).filter((event) => event.event === "review_comment");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      author: "maintainer",
      kind: "pr_comment",
      url: "https://github.com/o/r/pull/7#issuecomment-2",
      head_sha: "abc123",
    });
    expect(out).toEqual(["nudged https://github.com/o/r/pull/7#issuecomment-2"]);
    expect(calls.some((call) => call.includes("https://github.com/o/r/pull/7#issuecomment-1"))).toBe(false);
  });
});

describe("nudgePrConflict", () => {
  it("starts non-interactive resume with the conflict prompt inline", () => {
    const calls: string[][] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo({ tmuxSession: "combo-chen-owned-session" });
    const runDir = runDirFor(home, record.id);
    writeCombo(runDir, record);
    writeThreadArtifact(runDir);

    nudgePrConflict({
      deps: {
        env: { COMBO_CHEN_HOME: home },
        out: () => undefined,
        tmux: (args) => {
          calls.push(["tmux", ...args]);
          return args[0] === "list-windows"
            ? { status: 0, stdout: "reviewer\n", stderr: "" }
            : { status: 0, stdout: "", stderr: "" };
        },
      },
      home,
      comboId: record.id,
      conflict: {
        prUrl: "https://github.com/o/r/pull/7",
        headSha: "abc123",
        mergeState: "DIRTY",
      },
    });

    const conflictWindow = calls.find((call) => call[0] === "tmux" && call[1] === "new-window");
    expect(conflictWindow?.at(-1)).toContain("PR conflict recovery for coder responding mode:");
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "set-buffer")).toBe(false);
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "paste-buffer")).toBe(false);
  });
});

describe("recoverStuckWorker", () => {
  it("recreates coder responding and replays the latest routed review prompt", () => {
    const calls: string[][] = [];
    const out: string[] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo({ tmuxSession: "combo-chen-owned-session" });
    const runDir = runDirFor(home, record.id);

    writeCombo(runDir, record);
    writeThreadArtifact(runDir);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(runDir, "review_comment", {
      author: "external-reviewer",
      kind: "review_comment",
      url: "https://github.com/o/r/pull/7#discussion_r1",
    });

    const recovered = recoverStuckWorker({
      deps: {
        env: { COMBO_CHEN_HOME: home },
        out: (line) => out.push(line),
        tmux: (args) => {
          calls.push(["tmux", ...args]);
          if (args[0] === "list-windows") {
            return { status: 0, stdout: "reviewer\n", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      home,
      comboId: record.id,
      recovery: {
        worker: CODER_WINDOW,
        reason: "worker_stalled",
        detail: "unchanged pane for 2 ticks",
        attempt: 1,
        maxAttempts: 2,
      },
    });

    expect(recovered).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual(["tmux", "kill-window", "-t", "combo-chen-owned-session:coder"]);
    expect(calls[1]).toEqual([
      "tmux",
      "list-windows",
      "-t",
      "combo-chen-owned-session",
      "-F",
      "#{window_name}",
    ]);
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "worker_recovered",
        worker: CODER_WINDOW,
        reason: "worker_stalled",
        attempt: 1,
        max_attempts: 2,
      }),
    );
    expect(out).toEqual([`director: recovered stalled ${CODER_WINDOW} attempt 1/2`]);
    const recoveryWindow = calls.find((call) => call[0] === "tmux" && call[1] === "new-window");
    expect(recoveryWindow?.at(-1)).toContain("New review comment for coder responding mode:");
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "set-buffer")).toBe(false);
  });

  it("quotes hostile review prompt text inside the one window command argument", () => {
    const calls: string[][] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo({ tmuxSession: "combo-chen-owned-session" });
    const runDir = runDirFor(home, record.id);
    const hostileUrl = "-leading'`whoami`$(touch nope)\nsecond line";

    writeCombo(runDir, record);
    writeThreadArtifact(runDir);
    appendEvent(runDir, "review_comment", {
      author: "external-reviewer",
      kind: "review_comment",
      url: hostileUrl,
    });
    appendEvent(runDir, "review_comment", {
      author: "",
      kind: "review_comment",
      url: "",
    });

    recoverStuckWorker({
      deps: {
        env: { COMBO_CHEN_HOME: home },
        out: () => undefined,
        tmux: (args) => {
          calls.push(["tmux", ...args]);
          if (args[0] === "list-windows") {
            return { status: 0, stdout: "reviewer\n", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      home,
      comboId: record.id,
      recovery: {
        worker: CODER_WINDOW,
        reason: "worker_stalled",
        detail: "unchanged pane for 2 ticks",
        attempt: 1,
        maxAttempts: 2,
      },
    });

    const newWindowCalls = calls.filter((call) => call[0] === "tmux" && call[1] === "new-window");
    expect(newWindowCalls).toHaveLength(1);
    expect(newWindowCalls[0]).toHaveLength(7);
    expect(newWindowCalls[0]?.at(-1)).toContain("-leading");
    expect(newWindowCalls[0]?.at(-1)).toContain("`whoami`");
    expect(newWindowCalls[0]?.at(-1)).toContain("$(touch nope)");
    expect(newWindowCalls[0]?.at(-1)).toContain("second line");
    expect(calls.some((call) => call[1] === "set-buffer" || call[1] === "paste-buffer")).toBe(false);
  });

  it("does not touch tmux when asked to recover a different worker", () => {
    const calls: string[][] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo({ tmuxSession: "combo-chen-owned-session" });
    const runDir = runDirFor(home, record.id);

    writeCombo(runDir, record);
    writeThreadArtifact(runDir);
    appendEvent(runDir, "review_comment", {
      author: "external-reviewer",
      kind: "review_comment",
      url: "https://github.com/o/r/pull/7#discussion_r1",
    });

    const recovered = recoverStuckWorker({
      deps: {
        env: { COMBO_CHEN_HOME: home },
        out: () => undefined,
        tmux: (args) => {
          calls.push(["tmux", ...args]);
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      home,
      comboId: record.id,
      recovery: {
        worker: "reviewer",
        reason: "worker_stalled",
        detail: "unchanged pane for 2 ticks",
        attempt: 1,
        maxAttempts: 2,
      },
    });

    expect(recovered).toBe(false);
    expect(calls).toEqual([]);
    expect(readEvents(runDir).some((event) => event.event === "worker_recovered")).toBe(false);
  });
});

describe("recoverDeadCoder", () => {
  /** Stateful tmux fake: tracks windows per session so kill/new/list agree. */
  function fakeTmux(initial: { session: string; windows: string[] } | undefined) {
    const calls: string[][] = [];
    let state = initial === undefined ? undefined : { ...initial, windows: new Set(initial.windows) };
    const tmux = (args: string[]): { status: number; stdout: string; stderr: string } => {
      calls.push(["tmux", ...args]);
      const target = args[args.indexOf("-t") + 1] ?? "";
      const [session, window] = target.includes(":") ? target.split(":", 2) : [target, undefined];
      if (args[0] === "has-session") {
        return { status: state !== undefined && state.session === session ? 0 : 1, stdout: "", stderr: "" };
      }
      if (state === undefined || state.session !== session) {
        if (args[0] === "new-session") {
          const name = args[args.indexOf("-n") + 1] ?? "0";
          state = { session: args[args.indexOf("-s") + 1] ?? "", windows: new Set([name]) };
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "can't find session" };
      }
      if (args[0] === "list-windows") {
        return { status: 0, stdout: `${[...state.windows].join("\n")}\n`, stderr: "" };
      }
      if (args[0] === "kill-window" && window !== undefined) {
        state.windows.delete(window);
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "new-window") {
        state.windows.add(args[args.indexOf("-n") + 1] ?? "window");
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    return { calls, tmux, windows: () => (state === undefined ? [] : [...state.windows]) };
  }

  it("relaunches the capsule sequencer for a dead initial coder (capsule-owned recovery)", () => {
    const out: string[] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo({ tmuxSession: "combo-chen-owned-session" });
    const runDir = runDirFor(home, record.id);
    mkdirSync(home, { recursive: true });
    writeCombo(runDir, record);
    const shim = fakeTmux({
      session: record.tmuxSession,
      windows: ["capsule", "journal", "director", "coder", "gatekeeper", "reviewer"],
    });

    const recovered = recoverDeadCoder({
      deps: {
        env: { COMBO_CHEN_HOME: home },
        out: (line) => out.push(line),
        tmux: shim.tmux,
      },
      home,
      comboId: record.id,
      cli: "node /repo/dist/cli.mjs",
      recovery: {
        worker: "coder",
        reason: "worker_dead",
        detail: "dead pane",
        attempt: 1,
        maxAttempts: 2,
      },
    });

    expect(recovered).toBe(true);
    expect(shim.calls).toContainEqual(["tmux", "kill-window", "-t", `${record.tmuxSession}:capsule`]);
    const created = shim.calls.find((call) => call[1] === "new-window" && call.includes("capsule"));
    expect(created).toBeDefined();
    expect(created?.at(-1)).toContain(" capsule ");
    expect(created?.at(-1)).toContain(runDir);
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "worker_recovered",
        worker: "coder",
        reason: "worker_dead",
        detail: "dead pane",
        attempt: 1,
        max_attempts: 2,
      }),
    );
    expect(readEvents(runDir).some((event) => event.event === "needs_human")).toBe(false);
    expect(out).toEqual(["director: coder dead (worker_dead); relaunched capsule sequencer attempt 1/2"]);
  });

  it("recreates the capsule session when the tmux session is gone", () => {
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo({ tmuxSession: "combo-chen-owned-session" });
    const runDir = runDirFor(home, record.id);
    mkdirSync(home, { recursive: true });
    writeCombo(runDir, record);
    const shim = fakeTmux(undefined);

    const recovered = recoverDeadCoder({
      deps: {
        env: { COMBO_CHEN_HOME: home },
        out: () => undefined,
        tmux: shim.tmux,
      },
      home,
      comboId: record.id,
      cli: "node /repo/dist/cli.mjs",
      recovery: {
        worker: "coder",
        reason: "worker_dead",
        detail: "can't find session",
        attempt: 2,
        maxAttempts: 3,
      },
    });

    expect(recovered).toBe(true);
    const createdSession = shim.calls.find((call) => call[1] === "new-session");
    expect(createdSession).toBeDefined();
    expect(createdSession?.[createdSession.indexOf("-n") + 1]).toBe("capsule");
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({ event: "worker_recovered", worker: "coder", reason: "worker_dead" }),
    );
  });

  it("returns false for a non-coder worker without touching tmux or the journal", () => {
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo({ tmuxSession: "combo-chen-owned-session" });
    const runDir = runDirFor(home, record.id);
    mkdirSync(home, { recursive: true });
    writeCombo(runDir, record);
    const shim = fakeTmux({ session: record.tmuxSession, windows: ["capsule"] });

    const recovered = recoverDeadCoder({
      deps: { env: { COMBO_CHEN_HOME: home }, out: () => undefined, tmux: shim.tmux },
      home,
      comboId: record.id,
      cli: "node /repo/dist/cli.mjs",
      recovery: {
        worker: "reviewer",
        reason: "worker_dead",
        detail: "dead pane",
        attempt: 1,
        maxAttempts: 2,
      },
    });

    expect(recovered).toBe(false);
    expect(shim.calls).toEqual([]);
    expect(readEvents(runDir)).toEqual([]);
  });
});
// -/ 3/3
