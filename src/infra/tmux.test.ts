/**
 * @overview Unit tests for tmux argument builders. ~99 lines, testing
 *   the pure argument-vector contracts for session management, window
 *   splitting, pane capture, and the nudge/paste-buffer mechanism.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at describe("tmux argument builders")   ← single describe block
 *
 *   ┌─ TEST AREAS ───────────────────────────────────────┐
 *   │ tmux argument builders  All tmux argv contracts    │
 *   └─────────────────────────────────────────────────────┘
 *
 * @exports none (test file)
 * @deps vitest, ./tmux
 */
import { describe, expect, it } from "vitest";

import {
  attachSessionArgs,
  bindKeyArgs,
  captureWindowArgs,
  hasSessionArgs,
  JOURNAL_PANE_HEIGHT,
  killSessionArgs,
  killWindowArgs,
  listPanesArgs,
  listWindowsArgs,
  newSessionArgs,
  newWindowArgs,
  nudgeWindowArgs,
  renameWindowArgs,
  selectWindowArgs,
  splitWindowArgs,
  switchClientArgs,
  unbindKeyArgs,
} from "./tmux.js";

// -- 1/1 CORE · tmux argument builders: argv contracts ← START HERE --
describe("tmux argument builders (pure: what we ask tmux to do is contract)", () => {
  it("creates detached sessions with a first named window", () => {
    expect(newSessionArgs("combo-chen-o-r-7", "rower", "sh runner.sh")).toEqual([
      "new-session",
      "-d",
      "-s",
      "combo-chen-o-r-7",
      "-n",
      "rower",
      "sh runner.sh",
    ]);
  });

  it("adds named windows running a command", () => {
    expect(newWindowArgs("combo-chen-o-r-7", "watch", "combo-chen events --follow")).toEqual([
      "new-window",
      "-t",
      "combo-chen-o-r-7",
      "-n",
      "watch",
      "combo-chen events --follow",
    ]);
  });

  it("splits a detached short journal pane below the rower window", () => {
    expect(JOURNAL_PANE_HEIGHT).toBe(12);
    expect(splitWindowArgs("combo-chen-o-r-7", "rower", "combo-chen events --follow")).toEqual([
      "split-window",
      "-d",
      "-v",
      "-l",
      "12",
      "-t",
      "combo-chen-o-r-7:rower",
      "combo-chen events --follow",
    ]);
  });

  it("checks, kills, captures, and renames by session target", () => {
    expect(attachSessionArgs("s")).toEqual(["attach", "-t", "s"]);
    expect(hasSessionArgs("s")).toEqual(["has-session", "-t", "s"]);
    expect(killSessionArgs("s")).toEqual(["kill-session", "-t", "s"]);
    expect(killWindowArgs("s", "thread-sitter")).toEqual(["kill-window", "-t", "s:thread-sitter"]);
    expect(killWindowArgs("s", "gordon")).toEqual(["kill-window", "-t", "s:gordon"]);
    expect(listWindowsArgs("s")).toEqual(["list-windows", "-t", "s", "-F", "#{window_name}"]);
    expect(listPanesArgs("s", "rower")).toEqual(["list-panes", "-t", "s:rower", "-F", "#{pane_index}"]);
    expect(listPanesArgs("s", "rower", "#{pane_dead}")).toEqual([
      "list-panes",
      "-t",
      "s:rower",
      "-F",
      "#{pane_dead}",
    ]);
    expect(captureWindowArgs("s", "rower")).toEqual(["capture-pane", "-p", "-t", "s:rower"]);
    expect(renameWindowArgs("s", "rower", "rower:RUNNING")).toEqual([
      "rename-window",
      "-t",
      "s:rower",
      "rower:RUNNING",
    ]);
  });

  it("switches the current client to a session (inside-tmux navigation)", () => {
    expect(switchClientArgs("combo-chen-home")).toEqual(["switch-client", "-t", "combo-chen-home"]);
  });

  it("selects a window within a session (sets the session active window)", () => {
    expect(selectWindowArgs("combo-chen-o-r-7", "reviewer")).toEqual([
      "select-window",
      "-t",
      "combo-chen-o-r-7:reviewer",
    ]);
  });

  it("binds a prefix key to a tmux command for the TUI return binding", () => {
    expect(bindKeyArgs("B", "switch-client -t combo-chen-home")).toEqual([
      "bind-key",
      "B",
      "switch-client",
      "-t",
      "combo-chen-home",
    ]);
  });

  it("binds a key in a named table when given a keyTable option", () => {
    expect(bindKeyArgs("B", "switch-client -t combo-chen-home", { keyTable: "combo-chen" })).toEqual([
      "bind-key",
      "-T",
      "combo-chen",
      "B",
      "switch-client",
      "-t",
      "combo-chen-home",
    ]);
  });

  it("unbinds a prefix key", () => {
    expect(unbindKeyArgs("B")).toEqual(["unbind-key", "B"]);
  });

  it("nudges an interactive sitter with pasted text and a separate raw Enter", () => {
    expect(nudgeWindowArgs("combo-chen-o-r-7", "thread-sitter", "Review https://x/y#z")).toEqual([
      ["set-buffer", "-b", "combo-chen-nudge-combo-chen-o-r-7-thread-sitter", "Review https://x/y#z"],
      [
        "paste-buffer",
        "-d",
        "-b",
        "combo-chen-nudge-combo-chen-o-r-7-thread-sitter",
        "-t",
        "combo-chen-o-r-7:thread-sitter",
      ],
      ["send-keys", "-t", "combo-chen-o-r-7:thread-sitter", "C-m"],
    ]);
  });
});
// -/ 1/1
