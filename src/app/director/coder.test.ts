/**
 * @overview Unit tests for coder-response CLI helpers. ~890 lines, activate, nudge, and recovery flows.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at activateCoder tests        <- resumed coder worker.
 *   2. Then nudgeReviewComments tests      <- mirror sync and comment routing.
 *   3. Then recoverStuckWorker tests        <- stale worker recreation.
 *   4. Then recoverDeadCoder tests         <- initial coder runner restart.
 *   5. Test harness helpers                <- combo and thread artifact setup.
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
import { activateCoder, nudgeReviewComments, recoverDeadCoder, recoverStuckWorker } from "./coder.js";

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
  it("starts resumed coder worker from config", () => {
    const calls: string[][] = [];
    const out: string[] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(home, record.id);

    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      '[limits]\nbabysit_poll_seconds = 7\n\n[rower.codex]\nresume_command = "codex --profile sitter --no-alt-screen resume {thread_id}"\n\n[thread_sitter]\nwindow_name = "sitter"\nwatch_window_name = "sitter-watch"\n',
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
      "sitter",
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
      '[coder.codex]\nresume_command = "codex --profile launch resume {thread_id}"\n\n[coder_responding]\nwindow_name = "launch-sitter"\n',
    );
    writeCombo(runDir, record);
    writeConfigSnapshot(runDir, loadConfig({ repoDir: record.repoDir, env: {} }));
    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      '[coder.codex]\nresume_command = "codex --profile drifted resume {thread_id}"\n\n[coder_responding]\nwindow_name = "drifted-sitter"\n',
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
      "launch-sitter",
      `codex --profile launch resume '${CODEX_THREAD_ID}'`,
    ]);
  });

  it("reports resumed coder startup failures", () => {
    const calls: string[][] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(home, record.id);

    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      '[thread_sitter]\nwindow_name = "sitter"\nwatch_window_name = "sitter-watch"\n',
    );
    writeCombo(runDir, record);
    writeThreadArtifact(runDir);

    expect(() =>
      activateCoder({
        deps: {
          env: { COMBO_CHEN_HOME: home },
          out: () => undefined,
          tmux: (args) => {
            calls.push(args);
            if (args[0] === "new-window" && args.includes("sitter")) {
              return { status: 1, stdout: "", stderr: "duplicate window" };
            }
            return { status: 0, stdout: "", stderr: "" };
          },
        },
        home,
        comboId: record.id,
        cli: "node /repo/dist/cli.mjs",
      }),
    ).toThrow("tmux failed to start sitter: duplicate window");

    expect(calls).not.toContainEqual(["kill-window", "-t", "combo-chen-o-r-7:sitter"]);
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

    expect(calls.filter((call) => call[0] === "tmux")).toEqual([
      ["tmux", "list-windows", "-t", "combo-chen-owned-session", "-F", "#{window_name}"],
      [
        "tmux",
        "new-window",
        "-t",
        "combo-chen-owned-session",
        "-n",
        "coder",
        `codex resume '${CODEX_THREAD_ID}'`,
      ],
      [
        "tmux",
        "set-buffer",
        "-b",
        "combo-chen-nudge-combo-chen-owned-session-coder",
        "New review comment for coder responding mode:\n'https://github.com/o/r/pull/7#issuecomment-1'\n\nUse the two-bucket contract: handle mechanical fixes autonomously with TDD, code, and committed local changes; escalate intent-touching decisions with needs_human before changing code.\nDo not push to origin or the PR branch. Leave committed local changes for gatekeeper/no-mistakes to validate and publish.",
      ],
      [
        "tmux",
        "paste-buffer",
        "-d",
        "-b",
        "combo-chen-nudge-combo-chen-owned-session-coder",
        "-t",
        "combo-chen-owned-session:coder",
      ],
      ["tmux", "send-keys", "-t", "combo-chen-owned-session:coder", "C-m"],
    ]);
    expect(out).toEqual(["nudged https://github.com/o/r/pull/7#issuecomment-1"]);
  });

  it("syncs the mirror, routes fetched PR comments, and reports routed nudges", () => {
    const calls: string[][] = [];
    const out: string[] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo({ tmuxSession: "combo-chen-owned-session" });
    const runDir = runDirFor(home, record.id);

    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      [
        "[thread_sitter]",
        'review_nudge_prompt = "Please address {url}"',
        'window_name = "sitter"',
        "",
        "[external_comments]",
        'agents = ["external-reviewer"]',
        "",
      ].join("\n"),
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
      ["git", `cwd=${record.worktree}`, "remote", "get-url", "no-mistakes"],
      ["git", `cwd=${record.worktree}`, "rev-parse", "HEAD"],
    ]);
    expect(calls.filter((call) => call[0] === "tmux")).toEqual([
      ["tmux", "list-windows", "-t", "combo-chen-owned-session", "-F", "#{window_name}"],
      [
        "tmux",
        "new-window",
        "-t",
        "combo-chen-owned-session",
        "-n",
        "sitter",
        `codex resume '${CODEX_THREAD_ID}'`,
      ],
      [
        "tmux",
        "set-buffer",
        "-b",
        "combo-chen-nudge-combo-chen-owned-session-sitter",
        "Please address 'https://github.com/o/r/pull/7#issuecomment-1'",
      ],
      [
        "tmux",
        "paste-buffer",
        "-d",
        "-b",
        "combo-chen-nudge-combo-chen-owned-session-sitter",
        "-t",
        "combo-chen-owned-session:sitter",
      ],
      ["tmux", "send-keys", "-t", "combo-chen-owned-session:sitter", "C-m"],
    ]);
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
      [
        "[thread_sitter]",
        'review_nudge_prompt = "Please address {url}"',
        'window_name = "sitter"',
        "",
        "[external_comments]",
        'agents = ["external-reviewer"]',
        "",
      ].join("\n"),
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
      '[coder_responding]\nreview_nudge_prompt = "Launch prompt {url}"\nwindow_name = "launch-sitter"\n',
    );
    writeCombo(runDir, record);
    writeConfigSnapshot(runDir, loadConfig({ repoDir: record.repoDir, env: {} }));
    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      '[coder_responding]\nreview_nudge_prompt = "Drifted prompt {url}"\nwindow_name = "drifted-sitter"\n',
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

    expect(calls.filter((call) => call[0] === "tmux")).toEqual([
      ["tmux", "list-windows", "-t", "combo-chen-owned-session", "-F", "#{window_name}"],
      [
        "tmux",
        "new-window",
        "-t",
        "combo-chen-owned-session",
        "-n",
        "launch-sitter",
        `codex resume '${CODEX_THREAD_ID}'`,
      ],
      [
        "tmux",
        "set-buffer",
        "-b",
        "combo-chen-nudge-combo-chen-owned-session-launch-sitter",
        "Launch prompt 'https://github.com/o/r/pull/7#issuecomment-1'",
      ],
      [
        "tmux",
        "paste-buffer",
        "-d",
        "-b",
        "combo-chen-nudge-combo-chen-owned-session-launch-sitter",
        "-t",
        "combo-chen-owned-session:launch-sitter",
      ],
      ["tmux", "send-keys", "-t", "combo-chen-owned-session:launch-sitter", "C-m"],
    ]);
  });

  it("uses configured external comment agents when filtering review noise", () => {
    const calls: string[][] = [];
    const out: string[] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo({ tmuxSession: "combo-chen-owned-session" });
    const runDir = runDirFor(home, record.id);

    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      [
        "[external_comments]",
        'agents = ["external-reviewer"]',
        "",
        "[coder_responding]",
        'review_nudge_prompt = "Please address {author} {url}"',
        'window_name = "sitter"',
      ].join("\n"),
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

describe("recoverStuckWorker", () => {
  it("recreates coder responding and replays the latest routed review prompt", () => {
    const calls: string[][] = [];
    const out: string[] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo({ tmuxSession: "combo-chen-owned-session" });
    const runDir = runDirFor(home, record.id);

    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      [
        "[coder_responding]",
        'review_nudge_prompt = "Please address {url}"',
        'window_name = "sitter"',
        "",
      ].join("\n"),
    );
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
        worker: "sitter",
        reason: "worker_stalled",
        detail: "unchanged pane for 2 ticks",
        attempt: 1,
        maxAttempts: 2,
      },
    });

    expect(recovered).toBe(true);
    expect(calls).toEqual([
      ["tmux", "kill-window", "-t", "combo-chen-owned-session:sitter"],
      ["tmux", "list-windows", "-t", "combo-chen-owned-session", "-F", "#{window_name}"],
      [
        "tmux",
        "new-window",
        "-t",
        "combo-chen-owned-session",
        "-n",
        "sitter",
        `codex resume '${CODEX_THREAD_ID}'`,
      ],
      [
        "tmux",
        "set-buffer",
        "-b",
        "combo-chen-nudge-combo-chen-owned-session-sitter",
        "Please address 'https://github.com/o/r/pull/7#discussion_r1'",
      ],
      [
        "tmux",
        "paste-buffer",
        "-d",
        "-b",
        "combo-chen-nudge-combo-chen-owned-session-sitter",
        "-t",
        "combo-chen-owned-session:sitter",
      ],
      ["tmux", "send-keys", "-t", "combo-chen-owned-session:sitter", "C-m"],
    ]);
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({
        event: "worker_recovered",
        worker: "sitter",
        reason: "worker_stalled",
        attempt: 1,
        max_attempts: 2,
      }),
    );
    expect(out).toEqual(["director: recovered stalled sitter attempt 1/2"]);
  });

  it("replays hostile review prompt text as one tmux buffer argument", () => {
    const calls: string[][] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo({ tmuxSession: "combo-chen-owned-session" });
    const runDir = runDirFor(home, record.id);
    const hostileUrl = "-leading'`whoami`$(touch nope)\nsecond line";

    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      [
        "[coder_responding]",
        'review_nudge_prompt = "Please address {url}"',
        'window_name = "sitter"',
        "",
      ].join("\n"),
    );
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
        worker: "sitter",
        reason: "worker_stalled",
        detail: "unchanged pane for 2 ticks",
        attempt: 1,
        maxAttempts: 2,
      },
    });

    const setBufferCalls = calls.filter((call) => call[0] === "tmux" && call[1] === "set-buffer");
    expect(setBufferCalls).toHaveLength(1);
    expect(setBufferCalls[0]).toHaveLength(5);
    expect(setBufferCalls[0]?.[4]).toContain("-leading");
    expect(setBufferCalls[0]?.[4]).toContain("`whoami`");
    expect(setBufferCalls[0]?.[4]).toContain("$(touch nope)");
    expect(setBufferCalls[0]?.[4]).toContain("second line");
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
  it("quotes hostile runner paths as one tmux command", () => {
    const calls: string[][] = [];
    const root = mkdtempSync(join(tmpdir(), "combo-chen-home-root-"));
    const home = join(root, "home ' `whoami` $(touch nope)\nsecond");
    const record = combo({ tmuxSession: "combo-chen-owned-session" });
    const runDir = runDirFor(home, record.id);
    mkdirSync(home, { recursive: true });
    writeCombo(runDir, record);
    writeFileSync(join(runDir, "runner.sh"), "#!/bin/sh\nexit 0\n");

    recoverDeadCoder({
      deps: {
        env: { COMBO_CHEN_HOME: home },
        out: () => undefined,
        tmux: (args) => {
          calls.push(["tmux", ...args]);
          if (args[0] === "has-session") return { status: 0, stdout: "", stderr: "" };
          if (args[0] === "list-windows") return { status: 0, stdout: "\n", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      home,
      comboId: record.id,
      recovery: {
        worker: "coder",
        reason: "worker_dead",
        detail: "dead pane",
        attempt: 1,
        maxAttempts: 2,
      },
    });

    const newWindow = calls.find((call) => call[0] === "tmux" && call[1] === "new-window");
    expect(newWindow).toHaveLength(7);
    const command = newWindow?.at(-1) ?? "";
    expect(command).toContain("'\\''");
    expect(command).toContain("`whoami`");
    expect(command).toContain("$(touch nope)");
    expect(command).toContain("\nsecond");
  });
});
// -/ 3/3
