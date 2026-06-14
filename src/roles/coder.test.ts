/**
 * @overview Unit tests for the coder role. ~152 lines, testing
 *   default prompt generation, coder invocation rendering, codex thread-id
 *   extraction from JSONL, and thread artifact persistence.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at describe("extractCodexThreadIdFromJsonl")   ← thread-id parsing
 *   2. Then describe("coder thread artifact")               ← persistence
 *   3. Then describe("buildCoderInvocation")                 ← command rendering
 *
 *   ┌─ TEST AREAS ───────────────────────────────────────┐
 *   │ defaultPrompt              Issue-aware prompt text  │
 *   │ buildCoderInvocation       Command template render  │
 *   │ extractCodexThreadIdFromJsonl  JSONL thread-id scan │
 *   │ coder thread artifact      Persist + artifact path  │
 *   └─────────────────────────────────────────────────────┘
 *
 * @exports none (test file)
 * @deps vitest, node:{fs,os,path,url}, ./coder
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CODER_THREAD_ARTIFACT,
  buildCoderInvocation,
  defaultPrompt,
  extractCodexThreadIdFromJsonl,
  persistCoderThreadArtifact,
} from "./coder.js";

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

// -- 1/3 CORE · Prompt generation + invocation ← START HERE --
describe("defaultPrompt", () => {
  it("tells the coder which issue to implement and to work test-first", () => {
    const prompt = defaultPrompt(combo.issueUrl);
    expect(prompt).toContain(combo.issueUrl);
    expect(prompt).toContain("gh issue view");
    expect(prompt.toLowerCase()).toContain("test");
  });
});

describe("buildCoderInvocation", () => {
  it("renders the configured template with the combo's facts as quoted tokens", () => {
    const command = buildCoderInvocation({
      coderCommand: "gnhf --x {issue_url} --wt {worktree} {prompt}",
      combo,
    });
    expect(command).toContain("--x 'https://github.com/o/r/issues/7'");
    expect(command).toContain("--wt '/repos/r/.worktrees/issue-7'");
    expect(command).toContain("Implement GitHub issue");
  });

  it("lets a custom prompt replace the default", () => {
    const command = buildCoderInvocation({
      coderCommand: "gnhf {prompt}",
      combo,
      prompt: "fix the flaky test only",
    });
    expect(command).toBe("gnhf 'fix the flaky test only'");
  });
});

// -/ 1/3

// -- 2/3 HELPER · Thread ID extraction --
describe("extractCodexThreadIdFromJsonl", () => {
  it("returns the thread_id from a thread.started event", () => {
    const dir = tempDir("coder-extract-");
    const jsonlPath = join(dir, "test.jsonl");
    writeFileSync(
      jsonlPath,
      `{"type":"thread.started","thread_id":"abc-123"}\n`,
    );
    expect(extractCodexThreadIdFromJsonl(jsonlPath)).toBe("abc-123");
  });

  it("returns undefined for an empty file", () => {
    const dir = tempDir("coder-extract-");
    const jsonlPath = join(dir, "empty.jsonl");
    writeFileSync(jsonlPath, "");
    expect(extractCodexThreadIdFromJsonl(jsonlPath)).toBeUndefined();
  });

  it("returns undefined when no thread.started event is present", () => {
    const dir = tempDir("coder-extract-");
    const jsonlPath = join(dir, "no-thread.jsonl");
    writeFileSync(
      jsonlPath,
      `{"type":"tool.call","foo":"bar"}\n{"type":"tool.result","baz":1}\n`,
    );
    expect(extractCodexThreadIdFromJsonl(jsonlPath)).toBeUndefined();
  });

  it("returns undefined when thread.started has an empty thread_id", () => {
    const dir = tempDir("coder-extract-");
    const jsonlPath = join(dir, "empty-thread.jsonl");
    writeFileSync(
      jsonlPath,
      `{"type":"thread.started","thread_id":""}\n`,
    );
    expect(extractCodexThreadIdFromJsonl(jsonlPath)).toBeUndefined();
  });

  it("skips lines with invalid JSON", () => {
    const dir = tempDir("coder-extract-");
    const jsonlPath = join(dir, "bad.jsonl");
    writeFileSync(
      jsonlPath,
      `not valid json\n{"type":"thread.started","thread_id":"abc-123"}\n`,
    );
    expect(extractCodexThreadIdFromJsonl(jsonlPath)).toBe("abc-123");
  });

  it("returns the most recent thread.started thread_id", () => {
    const dir = tempDir("coder-extract-");
    const jsonlPath = join(dir, "multiple.jsonl");
    writeFileSync(
      jsonlPath,
      [
        JSON.stringify({ type: "thread.started", thread_id: "old-thread" }),
        JSON.stringify({ type: "other", thread_id: "ignored-thread" }),
        JSON.stringify({ type: "thread.started", thread_id: "new-thread" }),
      ].join("\n"),
    );
    expect(extractCodexThreadIdFromJsonl(jsonlPath)).toBe("new-thread");
  });
});

// -/ 2/3

// -- 3/3 HELPER · Coder thread artifact --
describe("coder thread artifact", () => {
  it("uses a coder-named artifact file", () => {
    expect(CODER_THREAD_ARTIFACT).toBe("coder-thread.json");
  });

  it("persists the codex thread id from a gnhf iteration JSONL fixture", () => {
    const runDir = tempDir("combo-chen-run-");
    const worktree = tempDir("combo-chen-worktree-");
    seedGnhfRun(worktree);

    const artifact = persistCoderThreadArtifact({ runDir, worktree });

    expect(artifact).toEqual({
      agent: "codex",
      thread_id: "019eb3f5-c135-76d2-88c5-0aa8edfe4c84",
      source: ".gnhf/runs/implement-github-iss-e6510c/iteration-1.jsonl",
    });
    expect(JSON.parse(readFileSync(join(runDir, CODER_THREAD_ARTIFACT), "utf8"))).toEqual(
      artifact,
    );
  });
});
// -/ 3/3
