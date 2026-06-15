import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appendEvent, readEvents } from "../core/events.js";
import { runDirFor, writeCombo, type ComboRecord } from "../core/state.js";
import { CODER_THREAD_ARTIFACT } from "../roles/coder.js";
import { activateCoder, nudgeReviewComments } from "./coder.js";

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

describe("activateCoder", () => {
  it("starts resumed coder and review-comment watcher windows from config", () => {
    const calls: string[][] = [];
    const out: string[] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(home, record.id);

    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      "[limits]\nbabysit_poll_seconds = 7\n\n[rower.codex]\nresume_command = \"codex --profile sitter resume {thread_id}\"\n\n[thread_sitter]\nwindow_name = \"sitter\"\nwatch_window_name = \"sitter-watch\"\n",
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
    expect(calls[0]).toEqual([
      "new-window",
      "-t",
      "combo-chen-o-r-7",
      "-n",
      "sitter",
      `codex --profile sitter resume '${CODEX_THREAD_ID}'`,
    ]);
    expect(calls[1]?.slice(0, 5)).toEqual([
      "new-window",
      "-t",
      "combo-chen-o-r-7",
      "-n",
      "sitter-watch",
    ]);
    expect(calls[1]?.at(-1)).toBe(
      "while :; do node /repo/dist/cli.mjs nudge-review-comments -n 'o-r-7'; sleep 7; done",
    );
    expect(out).toEqual(["coder responding active for o-r-7"]);
  });

  it("cleans up the resumed coder window when watcher startup fails", () => {
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
            if (args[0] === "new-window" && args.includes("sitter-watch")) {
              return { status: 1, stdout: "", stderr: "duplicate window" };
            }
            return { status: 0, stdout: "", stderr: "" };
          },
        },
        home,
        comboId: record.id,
        cli: "node /repo/dist/cli.mjs",
      }),
    ).toThrow("tmux failed to start sitter-watch: duplicate window");

    expect(calls).toContainEqual(["kill-window", "-t", "combo-chen-o-r-7:sitter"]);
  });
});

describe("nudgeReviewComments", () => {
  it("syncs the mirror, routes fetched PR comments, and reports routed nudges", () => {
    const calls: string[][] = [];
    const out: string[] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo({ tmuxSession: "combo-chen-owned-session" });
    const runDir = runDirFor(home, record.id);

    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      '[thread_sitter]\nreview_nudge_prompt = "Please address {url}"\nwindow_name = "sitter"\n',
    );
    writeCombo(runDir, record);
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
                  user: { login: "coderabbitai" },
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
      author: "coderabbitai",
      kind: "pr_comment",
      url: "https://github.com/o/r/pull/7#issuecomment-1",
    });
    expect(calls.filter((call) => call[0] === "git")).toEqual([
      ["git", `cwd=${record.worktree}`, "remote", "get-url", "no-mistakes"],
    ]);
    expect(calls.filter((call) => call[0] === "tmux")).toEqual([
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
});
