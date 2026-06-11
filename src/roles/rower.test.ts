import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ROWER_THREAD_ARTIFACT,
  buildRowerInvocation,
  defaultPrompt,
  persistRowerThreadArtifact,
} from "./rower.js";

const combo = {
  id: "o-r-7",
  issueUrl: "https://github.com/o/r/issues/7",
  repoDir: "/repos/r",
  worktree: "/repos/r/.worktrees/issue-7",
  branch: "combo/issue-7",
  tmuxSession: "combo-chen-o-r-7",
  createdAt: "2026-06-10T00:00:00.000Z",
};

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const codexJsonlFixture = join(fixtureDir, "codex-iteration-1.jsonl");

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function seedGnhfRun(worktree: string): void {
  const runDir = join(worktree, ".gnhf", "runs", "implement-github-iss-e6510c");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "iteration-1.jsonl"), readFileSync(codexJsonlFixture, "utf8"));
}

describe("defaultPrompt", () => {
  it("tells the rower which issue to row and to work test-first", () => {
    const prompt = defaultPrompt(combo.issueUrl);
    expect(prompt).toContain(combo.issueUrl);
    expect(prompt).toContain("gh issue view");
    expect(prompt.toLowerCase()).toContain("test");
  });
});

describe("buildRowerInvocation", () => {
  it("renders the configured template with the combo's facts as quoted tokens", () => {
    const command = buildRowerInvocation({
      rowerCommand: "gnhf --x {issue_url} --wt {worktree} {prompt}",
      combo,
    });
    expect(command).toContain("--x 'https://github.com/o/r/issues/7'");
    expect(command).toContain("--wt '/repos/r/.worktrees/issue-7'");
    expect(command).toContain("Implement GitHub issue");
  });

  it("lets a custom prompt replace the default", () => {
    const command = buildRowerInvocation({
      rowerCommand: "gnhf {prompt}",
      combo,
      prompt: "fix the flaky test only",
    });
    expect(command).toBe("gnhf 'fix the flaky test only'");
  });
});

describe("rower thread artifact", () => {
  it("persists the codex thread id from a gnhf iteration JSONL fixture", () => {
    const runDir = tempDir("combo-chen-run-");
    const worktree = tempDir("combo-chen-worktree-");
    seedGnhfRun(worktree);

    const artifact = persistRowerThreadArtifact({ runDir, worktree });

    expect(artifact).toEqual({
      agent: "codex",
      thread_id: "019eb3f5-c135-76d2-88c5-0aa8edfe4c84",
      source: ".gnhf/runs/implement-github-iss-e6510c/iteration-1.jsonl",
    });
    expect(JSON.parse(readFileSync(join(runDir, ROWER_THREAD_ARTIFACT), "utf8"))).toEqual(
      artifact,
    );
  });
});
