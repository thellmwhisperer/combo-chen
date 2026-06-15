import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { remoteShaForRef, syncNoMistakesMirror } from "./gate.js";
import type { ComboRecord } from "../core/state.js";

describe("remoteShaForRef", () => {
  it("returns only the SHA for the exact ref", () => {
    expect(
      remoteShaForRef(
        [
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/aaa/combo/issue-7",
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/heads/combo/issue-7",
        ].join("\n"),
        "refs/heads/combo/issue-7",
      ),
    ).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });
});

describe("syncNoMistakesMirror", () => {
  it("treats a missing no-mistakes remote as a no-op", () => {
    const calls: string[][] = [];
    const out: string[] = [];
    const worktree = join(tmpdir(), "combo-chen-worktree");
    const combo: ComboRecord = {
      id: "o-r-7",
      issueUrl: "https://github.com/o/r/issues/7",
      repoDir: join(tmpdir(), "combo-chen-repo"),
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date(0).toISOString(),
    };

    expect(
      syncNoMistakesMirror(
        {
          out: (line) => out.push(line),
          git: (args, cwd) => {
            calls.push([cwd, ...args]);
            return { status: 2, stdout: "", stderr: "No such remote 'no-mistakes'" };
          },
        },
        combo,
        mkdtempSync(join(tmpdir(), "combo-chen-run-")),
      ),
    ).toBe(false);

    expect(out).toEqual([]);
    expect(calls).toEqual([[worktree, "remote", "get-url", "no-mistakes"]]);
  });
});
