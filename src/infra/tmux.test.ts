import { describe, expect, it } from "vitest";

import {
  attachSessionArgs,
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
  splitWindowArgs,
} from "./tmux.js";

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
    expect(listPanesArgs("s", "rower")).toEqual([
      "list-panes",
      "-t",
      "s:rower",
      "-F",
      "#{pane_index}",
    ]);
    expect(captureWindowArgs("s", "rower")).toEqual(["capture-pane", "-p", "-t", "s:rower"]);
    expect(renameWindowArgs("s", "rower", "rower:RUNNING")).toEqual([
      "rename-window",
      "-t",
      "s:rower",
      "rower:RUNNING",
    ]);
  });

  it("nudges an interactive sitter with literal text and a separate bare Enter", () => {
    expect(nudgeWindowArgs("combo-chen-o-r-7", "thread-sitter", "Review https://x/y#z")).toEqual([
      ["send-keys", "-l", "-t", "combo-chen-o-r-7:thread-sitter", "Review https://x/y#z"],
      ["send-keys", "-t", "combo-chen-o-r-7:thread-sitter", "Enter"],
    ]);
  });
});
