/**
 * @overview Unit tests for director prompt delivery. Pins the deterministic
 *   prompt text, prompt target, tmux paste-buffer calls, and journal event.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at prompt rendering       <- exact director contract text.
 *   2. Then tmux delivery              <- window presence + paste-buffer argv.
 *   3. Then promptDirector             <- run-dir integration and journaling.
 *
 *   MAIN FLOW
 *   ---------
 *   combo record -> director prompt target -> tmux paste-buffer -> director_prompted event
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   tempHome, combo, okTmux
 *
 * @exports none
 * @deps ../../core/events, ../../core/runtime-ledger, ../../core/state, ./prompt, node:fs, node:os, node:path, vitest
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readEvents } from "../../core/events.js";
import { buildRuntimeLedger, writeRuntimeLedger } from "../../core/runtime-ledger.js";
import { runDirFor, writeCombo, type ComboRecord } from "../../core/state.js";
import { buildDirectorPrompt, directorPromptTarget, promptDirector, sendPromptToTarget } from "./prompt.js";

// -- 1/3 HELPER · Fixtures --
function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "combo-chen-director-prompt-"));
}

function combo(overrides: Partial<ComboRecord> = {}): ComboRecord {
  return {
    id: "o-r-7",
    issueUrl: "https://github.com/o/r/issues/7",
    repoDir: "/repo/r",
    worktree: "/repo/r/.worktrees/issue-7",
    branch: "combo/issue-7",
    tmuxSession: "combo-chen-o-r-7",
    createdAt: "2026-06-21T17:00:00.000Z",
    ...overrides,
  };
}

function okTmux(calls: string[][], windows: string[] = ["director"]) {
  return (args: string[]) => {
    calls.push(["tmux", ...args]);
    if (args[0] === "list-windows") {
      return { status: 0, stdout: `${windows.join("\n")}\n`, stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
}
// -/ 1/3

// -- 2/3 CORE · Prompt rendering and tmux delivery <- START HERE --
describe("buildDirectorPrompt", () => {
  it("renders a deterministic director intervention prompt", () => {
    expect(
      buildDirectorPrompt({
        combo: combo({ workItemTitle: "Fix launch" }),
        phase: "GATING",
        reason: "ambiguous_signal",
        message: "Decide whether this is a malformed gate signal.",
      }),
    ).toBe(
      [
        "Combo director intervention request",
        "",
        "Combo: o-r-7",
        "Branch: combo/issue-7",
        "Worktree: /repo/r/.worktrees/issue-7",
        "Work item: Fix launch (github_issue:https://github.com/o/r/issues/7)",
        "Current phase: GATING",
        "Reason: ambiguous_signal",
        "",
        "Request:",
        "Decide whether this is a malformed gate signal.",
        "",
        "Reply with the next concrete action. If this touches user intent, answer needs_human with the decision needed.",
      ].join("\n"),
    );
  });
});

describe("sendPromptToTarget", () => {
  it("checks the director window and sends the prompt through tmux paste-buffer", () => {
    const calls: string[][] = [];
    const target = directorPromptTarget(combo(), "director");

    sendPromptToTarget({
      target,
      prompt: "Director, inspect the malformed signal.",
      tmux: okTmux(calls),
    });

    expect(target).toEqual({
      name: "director",
      tmuxSession: "combo-chen-o-r-7",
      windowName: "director",
      tmuxTarget: "combo-chen-o-r-7:director",
    });
    expect(calls).toEqual([
      ["tmux", "list-windows", "-t", "combo-chen-o-r-7", "-F", "#{window_name}"],
      [
        "tmux",
        "set-buffer",
        "-b",
        "combo-chen-nudge-combo-chen-o-r-7-director",
        "Director, inspect the malformed signal.",
      ],
      [
        "tmux",
        "paste-buffer",
        "-d",
        "-b",
        "combo-chen-nudge-combo-chen-o-r-7-director",
        "-t",
        "combo-chen-o-r-7:director",
      ],
      ["tmux", "send-keys", "-t", "combo-chen-o-r-7:director", "C-m"],
    ]);
  });

  it("fails before pasting when the director window is missing", () => {
    const calls: string[][] = [];

    expect(() =>
      sendPromptToTarget({
        target: directorPromptTarget(combo(), "director"),
        prompt: "Are you there?",
        tmux: okTmux(calls, ["coder", "gatekeeper", "director-watch"]),
      }),
    ).toThrow('director prompt target "combo-chen-o-r-7:director" is not present');

    expect(calls).toEqual([["tmux", "list-windows", "-t", "combo-chen-o-r-7", "-F", "#{window_name}"]]);
  });
});
// -/ 2/3

// -- 3/3 CORE · promptDirector journals event --
describe("promptDirector", () => {
  it("uses the runtime-ledger director window and journals prompt facts", () => {
    const home = tempHome();
    const record = combo();
    const runDir = runDirFor(home, record.id);
    const calls: string[][] = [];
    const out: string[] = [];
    writeCombo(runDir, record);
    writeRuntimeLedger(
      runDir,
      buildRuntimeLedger({
        combo: record,
        runDir,
        cli: "combo-chen",
        roleWindows: { director: "capsule-director" },
      }),
    );

    promptDirector({
      deps: {
        out: (line) => out.push(line),
        tmux: okTmux(calls, ["coder", "capsule-director"]),
      },
      home,
      comboId: record.id,
      reason: "malformed_signal",
      message: "Gate output was not parseable.",
    });

    expect(
      calls.some((call) => call[1] === "paste-buffer" && call.includes("combo-chen-o-r-7:capsule-director")),
    ).toBe(true);
    expect(out).toEqual([
      "director-prompt: prompted combo-chen-o-r-7:capsule-director for o-r-7 (malformed_signal)",
    ]);
    expect(readEvents(runDir).at(-1)).toMatchObject({
      event: "director_prompted",
      reason: "malformed_signal",
      target: "combo-chen-o-r-7:capsule-director",
      window: "capsule-director",
      phase: "SETUP",
      prompt_preview: expect.stringContaining("Gate output was not parseable."),
    });
    expect(readEvents(runDir).at(-1)?.["prompt_sha"]).toMatch(/^[0-9a-f]{64}$/);
  });
});
// -/ 3/3
