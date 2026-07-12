/**
 * @overview Telemetry readers tests: pure parsers for gnhf.log iterations,
 *   JSONL token usage, and no-mistakes gate steps; plus best-effort I/O
 *   wrappers that read worktree/run-dir observables. The readers NEVER read
 *   panes — only files (gnhf.log, iteration-*.jsonl, overture.json) and git
 *   rev-list / no-mistakes status command output.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at gnhf.log parsing        <- iteration number + max iterations.
 *   2. Then JSONL token parsing         <- response.completed usage sums.
 *   3. Then gate step parsing           <- no-mistakes axi status steps table.
 *   4. Then git commit observables      <- rev-list count + last subject.
 *   5. Then I/O wrappers                <- readCoderTelemetry / readGateTelemetry.
 *
 *   MAIN FLOW
 *   ---------
 *   files/git -> readCoderTelemetry / readGateTelemetry -> LiveTelemetryFacts
 *
 *   PUBLIC API
 *   ----------
 *   None (test file).
 *
 * @exports none
 * @deps ./telemetry-readers, ../../core/state, vitest
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ComboRecord } from "../../core/state.js";
import {
  parseGateStepsFromAxiStatus,
  parseGnhfLogIterations,
  parseJsonlTokenUsage,
  readCoderTelemetry,
  readGateTelemetry,
} from "./telemetry-readers.js";

// -- 1/5 HELPER · fixtures --
function combo(overrides: Partial<ComboRecord> = {}): ComboRecord {
  return {
    id: "o-r-7",
    issueUrl: "https://github.com/o/r/issues/7",
    repoDir: "/repos/r",
    worktree: "/repos/r/.worktrees/7",
    branch: "combo/7",
    tmuxSession: "combo-chen-o-r-7",
    createdAt: "2026-07-12T08:00:00.000Z",
    ...overrides,
  };
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function seedOverture(runDir: string, base = "origin/main"): void {
  writeFileSync(join(runDir, "overture.json"), `${JSON.stringify({ resources: { base } })}\n`);
}
// -/ 1/5

// -- 2/5 CORE · gnhf.log iteration parsing (pure) --
describe("parseGnhfLogIterations", () => {
  it("returns the highest iteration from iteration:start events", () => {
    const log = [
      '{"event":"iteration:start","iteration":1}',
      '{"event":"agent:run:start","iteration":1}',
      '{"event":"iteration:start","iteration":2}',
      '{"event":"agent:run:start","iteration":2}',
      '{"event":"iteration:start","iteration":3}',
    ].join("\n");
    expect(parseGnhfLogIterations(log)?.iteration).toBe(3);
  });

  it("returns undefined when no iteration:start events exist", () => {
    expect(parseGnhfLogIterations('{"event":"orchestrator:end"}')).toBeUndefined();
  });

  it("returns undefined for empty content", () => {
    expect(parseGnhfLogIterations("")).toBeUndefined();
  });

  it("skips malformed JSON lines", () => {
    const log = 'not json\n{"event":"iteration:start","iteration":5}\nbroken';
    expect(parseGnhfLogIterations(log)?.iteration).toBe(5);
  });
});
// -/ 2/5

// -- 3/5 CORE · JSONL token usage parsing (pure) --
describe("parseJsonlTokenUsage", () => {
  it("sums input/output tokens from response.completed events", () => {
    const jsonl = [
      '{"type":"thread.started","thread_id":"abc"}',
      '{"type":"response.completed","response":{"usage":{"input_tokens":1000000,"output_tokens":5000}}}',
      '{"type":"response.completed","response":{"usage":{"input_tokens":2000000,"output_tokens":8000}}}',
    ].join("\n");
    const usage = parseJsonlTokenUsage(jsonl);
    expect(usage?.inputTokens).toBe(3_000_000);
    expect(usage?.outputTokens).toBe(13_000);
  });

  it("handles a single response.completed event", () => {
    const jsonl =
      '{"type":"response.completed","response":{"usage":{"input_tokens":500,"output_tokens":100}}}';
    const usage = parseJsonlTokenUsage(jsonl);
    expect(usage?.inputTokens).toBe(500);
    expect(usage?.outputTokens).toBe(100);
  });

  it("returns undefined when no response.completed events exist", () => {
    expect(parseJsonlTokenUsage('{"type":"thread.started","thread_id":"abc"}')).toBeUndefined();
  });

  it("returns undefined for empty content", () => {
    expect(parseJsonlTokenUsage("")).toBeUndefined();
  });

  it("skips malformed JSON lines", () => {
    const jsonl =
      'not json\n{"type":"response.completed","response":{"usage":{"input_tokens":500,"output_tokens":100}}}';
    expect(parseJsonlTokenUsage(jsonl)?.inputTokens).toBe(500);
  });

  it("handles flat usage objects without a response wrapper", () => {
    const jsonl = '{"type":"response.completed","usage":{"input_tokens":300,"output_tokens":50}}';
    expect(parseJsonlTokenUsage(jsonl)?.inputTokens).toBe(300);
  });
});
// -/ 3/5

// -- 4/5 CORE · gate step parsing from no-mistakes axi status (pure) --
describe("parseGateStepsFromAxiStatus", () => {
  it("maps completed steps to done, running to live, and others to pending", () => {
    const raw = [
      "branch: combo/7",
      "status: running",
      "steps[0]{",
      "  review, completed",
      "  test, running",
      "  lint, pending",
      "}",
    ].join("\n");
    const fact = parseGateStepsFromAxiStatus(raw);
    expect(fact?.steps).toEqual([
      { name: "review", state: "done" },
      { name: "test", state: "live" },
      { name: "lint", state: "pending" },
    ]);
  });

  it("returns undefined when no steps table is present", () => {
    expect(parseGateStepsFromAxiStatus("branch: combo/7\nstatus: idle")).toBeUndefined();
  });

  it("treats passed/succeeded as done", () => {
    const raw = ["steps[0]{", "  review, passed", "  test, succeeded", "}"].join("\n");
    const fact = parseGateStepsFromAxiStatus(raw);
    expect(fact?.steps.every((s) => s.state === "done")).toBe(true);
  });

  it("treats active/in_progress as live", () => {
    const raw = ["steps[0]{", "  review, active", "}"].join("\n");
    const fact = parseGateStepsFromAxiStatus(raw);
    expect(fact?.steps[0]?.state).toBe("live");
  });
});
// -/ 4/5

// -- 5/5 CORE · I/O wrappers (best-effort, file/git observables) --
describe("readCoderTelemetry", () => {
  it("reads iteration, tokens, commits, and last commit subject from observables", () => {
    const worktree = tempDir("tel-wt-");
    const runDir = tempDir("tel-run-");
    const gnhfRun = join(worktree, ".gnhf", "runs", "impl-7");
    mkdirSync(gnhfRun, { recursive: true });
    writeFileSync(
      join(gnhfRun, "gnhf.log"),
      '{"event":"iteration:start","iteration":3}\n{"event":"agent:run:start","iteration":3}\n',
    );
    writeFileSync(
      join(gnhfRun, "iteration-3.jsonl"),
      [
        '{"type":"thread.started","thread_id":"t1"}',
        '{"type":"response.completed","response":{"usage":{"input_tokens":6200000,"output_tokens":40000}}}',
      ].join("\n"),
    );
    seedOverture(runDir);

    const deps = {
      git: (args: string[]): { status: number; stdout: string; stderr: string } => {
        if (args[0] === "merge-base") return { status: 0, stdout: "base123\n", stderr: "" };
        if (args[0] === "rev-list" && args.includes("--count"))
          return { status: 0, stdout: "8\n", stderr: "" };
        if (args[0] === "log")
          return { status: 0, stdout: "docs(direct-combos): journal-first supervision\n", stderr: "" };
        return { status: 1, stdout: "", stderr: "unknown" };
      },
    };
    const fact = readCoderTelemetry(worktree, runDir, deps);
    expect(fact.iteration).toBe(3);
    expect(fact.inputTokens).toBe(6_200_000);
    expect(fact.outputTokens).toBe(40_000);
    expect(fact.commitCount).toBe(8);
    expect(fact.lastCommitSubject).toBe("docs(direct-combos): journal-first supervision");
  });

  it("degrades gracefully when gnhf files are absent", () => {
    const worktree = tempDir("tel-empty-");
    const runDir = tempDir("tel-run-");
    seedOverture(runDir);
    const deps = {
      git: (): { status: number; stdout: string; stderr: string } => ({
        status: 1,
        stdout: "",
        stderr: "fail",
      }),
    };
    const fact = readCoderTelemetry(worktree, runDir, deps);
    expect(fact.iteration).toBeUndefined();
    expect(fact.commitCount).toBeUndefined();
  });

  it("degrades gracefully when overture.json is absent", () => {
    const worktree = tempDir("tel-no-ov-");
    const runDir = tempDir("tel-run-");
    const deps = {
      git: (): { status: number; stdout: string; stderr: string } => ({
        status: 0,
        stdout: "5\n",
        stderr: "",
      }),
    };
    const fact = readCoderTelemetry(worktree, runDir, deps);
    expect(fact.commitCount).toBeUndefined();
  });
});

describe("readGateTelemetry", () => {
  it("parses gate steps from no-mistakes axi status output", () => {
    const deps = {
      noMistakes: (): { status: number; stdout: string; stderr: string } => ({
        status: 0,
        stdout: [
          "branch: combo/7",
          "status: running",
          "steps[0]{",
          "  review, completed",
          "  test, running",
          "  lint, pending",
          "}",
        ].join("\n"),
        stderr: "",
      }),
    };
    const fact = readGateTelemetry(combo(), deps);
    expect(fact?.steps).toHaveLength(3);
    expect(fact?.steps[0]?.state).toBe("done");
    expect(fact?.steps[1]?.state).toBe("live");
  });

  it("returns undefined when no-mistakes status fails", () => {
    const deps = {
      noMistakes: (): { status: number; stdout: string; stderr: string } => ({
        status: 1,
        stdout: "",
        stderr: "no daemon",
      }),
    };
    expect(readGateTelemetry(combo(), deps)).toBeUndefined();
  });

  it("returns undefined when noMistakes dep is absent", () => {
    expect(readGateTelemetry(combo(), {})).toBeUndefined();
  });
});
// -/ 5/5
