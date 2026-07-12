/**
 * @overview Unit tests for park with live seated children. Session teardown
 *   must reap the capsule's seated role child, never wedge on it.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at parkCombo reaping test <- live seated child through park.
 *   2. Fixture helpers                 <- homed combo + tmux-emulating deps.
 *
 *   MAIN FLOW
 *   ---------
 *   live seated child -> parkCombo -> kill-session (pane-group HUP) -> child reaped + parked journal
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   parkFixture
 *
 * @exports none
 * @deps node:{fs,os,path}, vitest, ../../core/{events,state}, ../../testing/cli-harness, ../capsule/capsule, ./park
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readEvents } from "../../core/events.js";
import { runDirFor, writeCombo, type ComboRecord } from "../../core/state.js";
import { findSeatedChild, processGroupOf, waitForSeatedChild } from "../../testing/cli-harness.js";
import { runAgentProcess } from "../capsule/capsule.js";
import { parkCombo, type ParkDeps } from "./park.js";

// -- 1/1 CORE · parkCombo reaping tests <- START HERE --
function parkFixture(): { home: string; combo: ComboRecord; runDir: string } {
  const home = mkdtempSync(join(tmpdir(), "combo-chen-park-home-"));
  const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-park-repo-"));
  const combo: ComboRecord = {
    id: "o-r-7",
    issueUrl: "https://github.com/o/r/issues/7",
    repoDir,
    worktree: join(repoDir, ".worktrees", "issue-7"),
    branch: "combo/issue-7",
    tmuxSession: "combo-chen-o-r-7",
    createdAt: new Date(0).toISOString(),
  };
  const runDir = runDirFor(home, combo.id);
  writeCombo(runDir, combo);
  return { home, combo, runDir };
}

describe("parkCombo with a live seated child", () => {
  it("kills the session, reaping the seated child, and still writes the handoff", async () => {
    const { home, combo, runDir } = parkFixture();
    const seat = join(runDir, "seat-tty");
    writeFileSync(seat, "");
    const marker = "sleep 41.113";

    // A real capsule-owned child holding its role seat while the human parks.
    const turn = runAgentProcess({ command: marker, cwd: runDir, seatTty: seat });
    const child = await waitForSeatedChild(marker, process.pid);
    // Reaping precondition: the seated child lives in the capsule pane's
    // process group, exactly what tmux kill-session HUPs.
    expect(child.pgid).toBe(processGroupOf(process.pid));

    const out: string[] = [];
    const calls: string[][] = [];
    const deps: ParkDeps = {
      env: {},
      out: (line) => out.push(line),
      tmux: (args) => {
        calls.push(args);
        if (args[0] === "kill-session") {
          // Emulate tmux at the fake boundary: kill-session HUPs the pane's
          // process group, which contains the seated child.
          process.kill(child.pid, "SIGHUP");
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "has-session") return { status: 1, stdout: "", stderr: "can't find session" };
        return { status: 0, stdout: "", stderr: "" };
      },
      gh: () => ({ status: 1, stdout: "", stderr: "no pr" }),
      noMistakes: () => ({ status: 1, stdout: "", stderr: "No active run." }),
    };

    parkCombo({ deps, home, comboId: combo.id, cli: "combo-chen", by: "human" });

    expect(calls).toContainEqual(["kill-session", "-t", combo.tmuxSession]);
    await expect(turn).resolves.toMatchObject({ exitCode: 128 });
    expect(findSeatedChild(marker, process.pid)).toBeUndefined();
    expect(readEvents(runDir)).toContainEqual(expect.objectContaining({ event: "parked", by: "human" }));
    expect(existsSync(join(runDir, "park-handoff.md"))).toBe(true);
    expect(out).toContainEqual(expect.stringContaining(`parked ${combo.id}`));
  });
});
// -/ 1/1
