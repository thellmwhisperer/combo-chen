/**
 * @overview Tombstone: "dive-in viewport stacking." Exercises the real
 *   runTuiHome direct-mode entry with a persisted combo registry, journal,
 *   verdict artifact, keyboard input, and an 80x24 Ink stream. Long mock-like
 *   labels and findings force physical wrapping. The contract is that the
 *   complete final frame fits 24 physical rows, with title and footer visible.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at the tombstone test      <- persists data, runs entry, presses Enter.
 *   2. Then the hoisted Ink harness     <- supplies the real 80x24 render stream.
 *   3. Everything else is fixture setup.
 *
 *   MAIN FLOW
 *   ---------
 *   persisted combo + journal -> runTuiHome(direct) -> Enter -> 80x24 final frame
 *
 *   PUBLIC API
 *   ----------
 *   None (test file).
 *
 * @exports none
 * @deps ink, node:events, node:fs, node:os, node:path, vitest, ../../core/events, ../../core/loop-state, ../../core/state, ../../core/verdict, ../deps, ./entry
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { appendEvent } from "../../core/events.js";
import { writeLoopState } from "../../core/loop-state.js";
import { runDirFor, writeCombo, type ComboRecord } from "../../core/state.js";
import { writeVerdictFile } from "../../core/verdict.js";
import type { AppDeps } from "../deps.js";
import { runTuiHome, TUI_DIRECT_ENV } from "./entry.js";

// -- 1/3 HELPER · real Ink 80x24 stream harness --
const inkHarness = vi.hoisted(() => ({ frames: [] as string[] }));

vi.mock("ink", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ink")>();
  const { EventEmitter } = await import("node:events");

  class TestStdout extends EventEmitter {
    readonly columns = 80;
    readonly rows = 24;
    readonly frames: string[] = [];

    write = (frame: string): boolean => {
      this.frames.push(frame);
      inkHarness.frames = this.frames;
      return true;
    };
  }

  class TestStdin extends EventEmitter {
    readonly isTTY = true;
    private data: string | null = null;

    write = (data: string): void => {
      this.data = data;
      this.emit("readable");
      this.emit("data", data);
    };
    setEncoding(): void {}
    setRawMode(): void {}
    resume(): void {}
    pause(): void {}
    ref(): void {}
    unref(): void {}
    read = (): string | null => {
      const value = this.data;
      this.data = null;
      return value;
    };
  }

  class TestStderr extends EventEmitter {
    write = (): boolean => true;
  }

  return {
    ...actual,
    render: (tree: React.ReactNode) => {
      const stdout = new TestStdout();
      const stdin = new TestStdin();
      const instance = actual.render(tree, {
        stdout: stdout as never,
        stdin: stdin as never,
        stderr: new TestStderr() as never,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      setTimeout(() => stdin.write("\r"), 0);
      setTimeout(() => instance.unmount(), 30);
      return instance;
    },
  };
});
// -/ 1/3

// -- 2/3 HELPER · persisted long-thread fixture --
const NOW = Date.parse("2026-07-12T12:00:00.000Z");
const T = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();

function seedLongCombo(home: string): ComboRecord {
  const combo: ComboRecord = {
    id: "owner-repo-99",
    schemaVersion: 1,
    issueUrl: "https://github.com/owner/repo/issues/99",
    workItemSourceType: "github_issue",
    workItemSourceReference: "#99",
    workItemTitle:
      "Provider extraction with a deliberately long captain-facing title that would wrap at eighty columns",
    repoDir: "/repo",
    worktree: "/repo/.worktrees/issue-99",
    branch: "combo/issue-99",
    tmuxSession: "combo-chen-owner-repo-99",
    createdAt: T(200),
  };
  const runDir = runDirFor(home, combo.id);
  writeCombo(runDir, combo);
  appendEvent(runDir, "combo_created", { issue_url: combo.issueUrl });
  appendEvent(runDir, "coder_started", {});
  appendEvent(runDir, "coder_done", {});
  appendEvent(runDir, "local_review_requested", { round: 1, sha: "abc" });
  writeVerdictFile(runDir, {
    schemaVersion: 1,
    round: 1,
    code: 1,
    reviewed: { sha: "abc" },
    identity: { model: "reviewer", runtime: "codex" },
    checklist: [{ id: "tdd-first", status: "pass" }],
    findings: [
      {
        id: "f1",
        severity: "major",
        file: "skills/direct-combos/SKILL.md",
        line: 84,
        title:
          "Polling-bridge example greps journal event names that status output never prints at this terminal width",
        body: "body",
      },
      {
        id: "f2",
        severity: "minor",
        file: "src/skills/direct-combos.test.ts",
        line: 1,
        title:
          "New test file lacks the Sherpa overview header every other source file carries in the repository",
        body: "body",
      },
      {
        id: "f3",
        severity: "note",
        file: "skills/direct-combos/SKILL.md",
        line: 128,
        title:
          "Cross-link wording reads as an instruction to the documentation author instead of the operator",
        body: "body",
      },
    ],
    followUps: [],
  });
  writeLoopState(runDir, {
    schemaVersion: 1,
    currentRound: 1,
    rounds: [
      { round: 1, sha: "abc", verdictPath: "verdict-1.json", code: 1, findingIds: ["f1", "f2", "f3"] },
    ],
    fingerprintSurvival: {},
    guard: { state: "iterating" },
  });
  appendEvent(runDir, "local_verdict", {
    round: 1,
    code: 1,
    verdict_path: "verdict-1.json",
    identity: { model: "reviewer", runtime: "codex" },
  });
  appendEvent(runDir, "needs_human", { reason: "review_fix_timeout" });
  return combo;
}

function depsFor(home: string): AppDeps {
  return {
    env: { COMBO_CHEN_HOME: home, [TUI_DIRECT_ENV]: "1" },
    out: () => {},
    tmux: () => ({ status: 1, stdout: "", stderr: "" }),
    git: () => ({ status: 0, stdout: "", stderr: "" }),
    treehouse: () => ({ status: 0, stdout: "", stderr: "" }),
    gh: () => ({ status: 0, stdout: "", stderr: "" }),
    noMistakes: () => ({ status: 0, stdout: "", stderr: "" }),
    runAgent: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    sleep: async () => {},
    issueExists: () => true,
  };
}
// -/ 2/3

// -- 3/3 CORE · direct-entry viewport tombstone <- START HERE --
const stdoutRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
const stdoutColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");

afterEach(() => {
  if (stdoutRows !== undefined) Object.defineProperty(process.stdout, "rows", stdoutRows);
  else Reflect.deleteProperty(process.stdout, "rows");
  if (stdoutColumns !== undefined) Object.defineProperty(process.stdout, "columns", stdoutColumns);
  else Reflect.deleteProperty(process.stdout, "columns");
  inkHarness.frames = [];
});

describe("Tombstone: dive-in dies on keypress with green suite", () => {
  it("keeps title and footer visible through runTuiHome direct mode at 80x24", async () => {
    const home = mkdtempSync(join(tmpdir(), "combo-chen-tui-entry-viewport-"));
    const combo = seedLongCombo(home);
    Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: 80 });

    await runTuiHome(depsFor(home), 'node "dist/cli.mjs"');

    const frame = inkHarness.frames.at(-1)!;
    const lines = frame.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(24);
    expect(lines[0]).toContain(combo.id);
    expect(lines.at(-1)).toContain(combo.id);
    expect(frame).toContain("Polling-bridge example");
  });
});
// -/ 3/3
