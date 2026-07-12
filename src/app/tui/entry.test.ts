/**
 * @overview TUI home entry point contract tests.
 *   Pure session-management and TTY detection logic.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at session helpers       <- insideTmux, isTtyStdout, command.
 *   2. Then homeSessionActions         <- the 4 ensure/switch/attach cases.
 *
 *   MAIN FLOW
 *   ---------
 *   env + exists + cli -> homeSessionActions -> tmux arg arrays
 *
 *   PUBLIC API
 *   ----------
 *   None (test file).
 *
 * @exports none
 * @deps ./entry, vitest
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { writeLoopState } from "../../core/loop-state.js";
import { writeVerdictFile } from "../../core/verdict.js";
import {
  HOME_SESSION_NAME,
  TUI_DIRECT_ENV,
  decideOptions,
  homeSessionActions,
  homeSessionCommand,
  insideTmux,
  isTtyStdout,
  loadVerdictsForCombo,
  resolveJumpActions,
} from "./entry.js";

// -- 1/2 CORE · pure helpers <-
describe("session helpers", () => {
  it("detects inside-tmux from TMUX env", () => {
    expect(insideTmux({ TMUX: "/tmp/tmux-1000/default,123,0" })).toBe(true);
    expect(insideTmux({ TMUX: "" })).toBe(false);
    expect(insideTmux({})).toBe(false);
  });

  it("detects TTY stdout", () => {
    expect(isTtyStdout({ isTTY: true })).toBe(true);
    expect(isTtyStdout({ isTTY: false })).toBe(false);
    expect(isTtyStdout({})).toBe(false);
  });

  it("builds the session command with the direct-render env marker", () => {
    const cmd = homeSessionCommand('"node" "/path/to/cli.mjs"');
    expect(cmd).toContain(`${TUI_DIRECT_ENV}=1`);
    expect(cmd).toContain("node");
    expect(cmd).toContain("cli.mjs");
  });
});
// -/ 1/2

// -- 2/2 CORE · homeSessionActions <-
describe("homeSessionActions", () => {
  it("switches client when session exists and inside tmux", () => {
    const actions = homeSessionActions(true, true, '"node" cli.mjs');
    expect(actions).toEqual([["switch-client", "-t", HOME_SESSION_NAME]]);
  });

  it("attaches when session exists and outside tmux", () => {
    const actions = homeSessionActions(true, false, '"node" cli.mjs');
    expect(actions).toEqual([["attach", "-t", HOME_SESSION_NAME]]);
  });

  it("creates then switches when session missing and inside tmux", () => {
    const actions = homeSessionActions(false, true, '"node" cli.mjs');
    expect(actions).toHaveLength(2);
    expect(actions[0]).toEqual([
      "new-session",
      "-d",
      "-s",
      HOME_SESSION_NAME,
      "-n",
      "fleet",
      homeSessionCommand('"node" cli.mjs'),
    ]);
    expect(actions[1]).toEqual(["switch-client", "-t", HOME_SESSION_NAME]);
  });

  it("creates then attaches when session missing and outside tmux", () => {
    const actions = homeSessionActions(false, false, '"node" cli.mjs');
    expect(actions).toHaveLength(2);
    expect(actions[0]?.[0]).toBe("new-session");
    expect(actions[1]).toEqual(["attach", "-t", HOME_SESSION_NAME]);
  });

  it("embeds the direct-render env marker in the created session command", () => {
    const actions = homeSessionActions(false, true, '"node" /x/cli.mjs');
    const createCmd = actions[0]?.[6];
    expect(createCmd).toContain(TUI_DIRECT_ENV);
  });
});
// -/ 2/2

// -- 3/5 CORE · loadVerdictsForCombo (verdict files keyed by round) <-
describe("loadVerdictsForCombo", () => {
  function freshRunDir(): string {
    return mkdtempSync(join(tmpdir(), "combo-chen-tui-entry-"));
  }

  it("returns an empty map when loop-state is absent (v0 journal)", () => {
    const runDir = freshRunDir();
    expect(loadVerdictsForCombo(runDir, undefined).size).toBe(0);
  });

  it("reads each round verdict recorded in loop-state", () => {
    const runDir = freshRunDir();
    writeVerdictFile(runDir, {
      schemaVersion: 1,
      round: 1,
      code: 1,
      reviewed: { sha: "a" },
      identity: { model: "m", runtime: "r" },
      checklist: [{ id: "tdd-first", status: "pass" }],
      findings: [{ id: "f1", severity: "major", file: "x.ts", line: 9, title: "t", body: "b" }],
      followUps: [],
    });
    writeLoopState(runDir, {
      schemaVersion: 1,
      currentRound: 1,
      rounds: [{ round: 1, sha: "a", verdictPath: "verdict-1.json", code: 1, findingIds: ["f1"] }],
      fingerprintSurvival: {},
      guard: { state: "iterating" },
    });
    const verdicts = loadVerdictsForCombo(runDir, undefined);
    expect(verdicts.get(1)?.round).toBe(1);
    expect(verdicts.get(1)?.findings).toHaveLength(1);
  });

  it("uses the passed loop-state when provided", () => {
    const runDir = freshRunDir();
    writeVerdictFile(runDir, {
      schemaVersion: 1,
      round: 2,
      code: 0,
      reviewed: { sha: "b" },
      identity: { model: "m", runtime: "r" },
      checklist: [{ id: "tdd-first", status: "pass" }],
      findings: [],
      followUps: [],
    });
    const loopState = {
      schemaVersion: 1 as const,
      currentRound: 2,
      rounds: [{ round: 2, sha: "b", verdictPath: "verdict-2.json", code: 0 as const, findingIds: [] }],
      fingerprintSurvival: {},
      guard: { state: "cleared" as const, round: 2 },
    };
    const verdicts = loadVerdictsForCombo(runDir, loopState);
    expect(verdicts.get(2)?.code).toBe(0);
  });

  it("skips a missing verdict file without throwing", () => {
    const runDir = freshRunDir();
    const loopState = {
      schemaVersion: 1 as const,
      currentRound: 1,
      rounds: [{ round: 1, sha: "a", verdictPath: "verdict-1.json", code: 1 as const, findingIds: [] }],
      fingerprintSurvival: {},
      guard: { state: "iterating" as const },
    };
    expect(loadVerdictsForCombo(runDir, loopState).size).toBe(0);
  });
});
// -/ 3/5

// -- 4/5 CORE · resolveJumpActions (TUI moves the client only) <-
describe("resolveJumpActions", () => {
  it("returns null when no live actor is present", () => {
    expect(
      resolveJumpActions({
        insideTmux: true,
        comboSession: "combo-chen-o-r-7",
        homeSession: HOME_SESSION_NAME,
      }),
    ).toBeNull();
  });

  it("returns null when the combo session is empty", () => {
    expect(
      resolveJumpActions({
        insideTmux: true,
        comboSession: "",
        liveActor: { actor: "coder" },
        homeSession: HOME_SESSION_NAME,
      }),
    ).toBeNull();
  });

  it("returns the jump actions for the live actor window", () => {
    const actions = resolveJumpActions({
      insideTmux: true,
      comboSession: "combo-chen-o-r-7",
      liveActor: { actor: "reviewer" },
      homeSession: HOME_SESSION_NAME,
    });
    expect(actions).not.toBeNull();
    expect(actions![0]).toEqual(["bind-key", "B", "switch-client", "-t", HOME_SESSION_NAME]);
    expect(actions![1]).toEqual(["select-window", "-t", "combo-chen-o-r-7:reviewer"]);
  });
});
// -/ 4/5

// -- 5/5 CORE · decideOptions (one write path: feeds decideComboEscalation) <-
describe("decideOptions", () => {
  it("builds the options for the decide handler with the pending ref", () => {
    expect(decideOptions("o-r-7", "retry", "2026-07-12T09:00:00.000Z")).toEqual({
      name: "o-r-7",
      verb: "retry",
      ref: "2026-07-12T09:00:00.000Z",
      by: "human",
    });
  });

  it("omits ref when not provided (handler resolves the latest pending)", () => {
    const opts = decideOptions("o-r-7", "skip");
    expect(opts).toEqual({ name: "o-r-7", verb: "skip", by: "human" });
    expect("ref" in opts).toBe(false);
  });

  it("normalizes take-over to take_over for the handler", () => {
    expect(decideOptions("o-r-7", "take-over").verb).toBe("take_over");
  });
});
// -/ 5/5
