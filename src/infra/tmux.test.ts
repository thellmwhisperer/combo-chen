import { describe, expect, it } from "vitest";

import {
  captureWindowArgs,
  hasSessionArgs,
  killSessionArgs,
  newSessionArgs,
  newWindowArgs,
  renameWindowArgs,
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

  it("checks, kills, captures, and renames by session target", () => {
    expect(hasSessionArgs("s")).toEqual(["has-session", "-t", "s"]);
    expect(killSessionArgs("s")).toEqual(["kill-session", "-t", "s"]);
    expect(captureWindowArgs("s", "rower")).toEqual(["capture-pane", "-p", "-t", "s:rower"]);
    expect(renameWindowArgs("s", "rower", "rower:RUNNING")).toEqual([
      "rename-window",
      "-t",
      "s:rower",
      "rower:RUNNING",
    ]);
  });
});
