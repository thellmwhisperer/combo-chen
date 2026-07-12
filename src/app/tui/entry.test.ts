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
import { describe, expect, it } from "vitest";

import {
  HOME_SESSION_NAME,
  TUI_DIRECT_ENV,
  homeSessionActions,
  homeSessionCommand,
  insideTmux,
  isTtyStdout,
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
