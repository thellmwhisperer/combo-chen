import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runDirFor, writeCombo, type ComboRecord } from "../core/state.js";
import { CODER_THREAD_ARTIFACT } from "../roles/coder.js";
import { activateCoder } from "./coder.js";

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
