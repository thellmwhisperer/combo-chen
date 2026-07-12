/**
 * @overview Unit tests for tmux session helpers. ~260 lines, attach selection, session recovery, and cleanup.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at resolveAttachCombo tests <- running combo selection.
 *   2. Then ensureJournalPane tests       <- event tail window creation.
 *   3. Then kill helper tests             <- session/window cleanup.
 *
 *   MAIN FLOW
 *   ---------
 *   fake combo state -> session helper -> tmux argv contract
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   combo
 *
 * @exports none
 * @deps ../../core/state, ./sessions, node:fs, node:os, node:path, vitest
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runDirFor, writeCombo, type ComboRecord } from "../../core/state.js";
import {
  ensureJournalPane,
  ensureComboSession,
  ensureWindowPresent,
  idleRoleWindowCommand,
  killComboSession,
  killWindowIfPresent,
  JOURNAL_WINDOW,
  REVIEWER_WINDOW,
  resolveAttachCombo,
  resolveRoleSeatTty,
  seatOccupancy,
} from "./sessions.js";

// -- 1/4 HELPER · combo fixture --
function combo(overrides: Partial<ComboRecord> = {}): ComboRecord {
  return {
    id: "o-r-7",
    issueUrl: "https://github.com/o/r/issues/7",
    repoDir: join(tmpdir(), "combo-chen-repo"),
    worktree: join(tmpdir(), "combo-chen-worktree"),
    branch: "combo/issue-7",
    tmuxSession: "combo-chen-o-r-7",
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}
// -/ 1/4

// -- 2/4 CORE · resolveAttachCombo tests <- START HERE --
describe("resolveAttachCombo", () => {
  it("selects the only running combo when no name is provided", () => {
    const home = mkdtempSync(join(tmpdir(), "combo-chen-sessions-"));
    const stale = combo({ id: "o-r-6", tmuxSession: "combo-chen-o-r-6" });
    const running = combo();
    writeCombo(runDirFor(home, stale.id), stale);
    writeCombo(runDirFor(home, running.id), running);

    expect(
      resolveAttachCombo(
        {
          tmux: (args) => ({
            status: args.at(-1) === running.tmuxSession ? 0 : 1,
            stdout: "",
            stderr: "",
          }),
        },
        home,
        undefined,
      ),
    ).toEqual({ ...running, schemaVersion: 1 });
  });
});
// -/ 2/4

// -- 3/4 CORE · ensureJournalPane tests --
describe("ensureJournalPane", () => {
  it("creates a journal window with the configured CLI invocation when missing", () => {
    const calls: string[][] = [];
    const record = combo();

    ensureJournalPane(
      {
        tmux: (args) => {
          calls.push(args);
          if (args[0] === "list-windows") return { status: 0, stdout: "coder\n", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      record,
      "node cli.mjs",
    );

    expect(calls).toEqual([
      ["list-windows", "-t", "combo-chen-o-r-7", "-F", "#{window_name}"],
      ["new-window", "-t", "combo-chen-o-r-7", "-n", "journal", "node cli.mjs events --follow -n 'o-r-7'"],
    ]);
  });
});

describe("ensureWindowPresent", () => {
  it("repairs duplicate idle placeholders by keeping the lowest-index role window", () => {
    const calls: string[][] = [];

    expect(
      ensureWindowPresent(
        {
          tmux: (args) => {
            calls.push(args);
            if (args[0] === "list-windows" && args.at(-1) === "#{window_name}") {
              return { status: 0, stdout: "coder\ncoder\n", stderr: "" };
            }
            if (args[0] === "list-windows") {
              return { status: 0, stdout: "@7|4|coder\n@9|3|coder\n", stderr: "" };
            }
            if (args[0] === "list-panes") {
              return { status: 0, stdout: "0|tail\n", stderr: "" };
            }
            return { status: 0, stdout: "", stderr: "" };
          },
        },
        combo(),
        "coder",
        idleRoleWindowCommand("coder"),
      ),
    ).toBe(false);

    expect(calls).toContainEqual(["kill-window", "-t", "@7"]);
    expect(calls.some((call) => call[0] === "new-window")).toBe(false);
  });
});
// -/ 3/4

// -- 4/4 CORE · session recovery + kill helper tests --
describe("ensureComboSession", () => {
  it("recreates a missing combo room with a journal window instead of mislabeling it as coder", () => {
    const calls: string[][] = [];
    const record = combo();

    expect(
      ensureComboSession({
        deps: {
          tmux: (args) => {
            calls.push(args);
            if (args[0] === "has-session") return { status: 1, stdout: "", stderr: "can't find session" };
            return { status: 0, stdout: "", stderr: "" };
          },
        },
        combo: record,
        home: "/combo-home",
        cli: "node cli.mjs",
      }),
    ).toBe(true);

    expect(calls).toEqual([
      ["has-session", "-t", "combo-chen-o-r-7"],
      [
        "new-session",
        "-d",
        "-s",
        "combo-chen-o-r-7",
        "-n",
        JOURNAL_WINDOW,
        "COMBO_CHEN_HOME='/combo-home' node cli.mjs events --follow -n 'o-r-7'",
      ],
    ]);
  });

  it("restores the journal role when the session exists but the window is missing", () => {
    const calls: string[][] = [];
    const record = combo();

    expect(
      ensureComboSession({
        deps: {
          tmux: (args) => {
            calls.push(args);
            if (args[0] === "has-session") return { status: 0, stdout: "", stderr: "" };
            if (args[0] === "list-windows") return { status: 0, stdout: "coder\n", stderr: "" };
            return { status: 0, stdout: "", stderr: "" };
          },
        },
        combo: record,
        home: "/combo-home",
        cli: "node cli.mjs",
      }),
    ).toBe(false);

    expect(calls).toEqual([
      ["has-session", "-t", "combo-chen-o-r-7"],
      ["list-windows", "-t", "combo-chen-o-r-7", "-F", "#{window_name}"],
      [
        "new-window",
        "-t",
        "combo-chen-o-r-7",
        "-n",
        JOURNAL_WINDOW,
        "COMBO_CHEN_HOME='/combo-home' node cli.mjs events --follow -n 'o-r-7'",
      ],
    ]);
  });

  it("creates a journal window when attach finds only a recreated room without coder UI", () => {
    const calls: string[][] = [];
    const record = combo();

    ensureJournalPane(
      {
        tmux: (args) => {
          calls.push(args);
          if (args[0] === "list-windows") {
            return { status: 0, stdout: "", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      record,
      "node cli.mjs",
    );

    expect(calls).toEqual([
      ["list-windows", "-t", "combo-chen-o-r-7", "-F", "#{window_name}"],
      [
        "new-window",
        "-t",
        "combo-chen-o-r-7",
        "-n",
        JOURNAL_WINDOW,
        "node cli.mjs events --follow -n 'o-r-7'",
      ],
    ]);
  });
});

describe("killComboSession", () => {
  it("treats an already-gone tmux session as success", () => {
    const calls: string[][] = [];
    const record = combo();

    expect(() =>
      killComboSession(
        {
          tmux: (args) => {
            calls.push(args);
            return { status: 1, stdout: "", stderr: `can't find session: ${record.tmuxSession}` };
          },
        },
        record,
      ),
    ).not.toThrow();

    expect(calls).toEqual([["kill-session", "-t", "combo-chen-o-r-7"]]);
  });
});

describe("resolveRoleSeatTty", () => {
  it("returns the live pane tty of an existing role window", () => {
    const calls: string[][] = [];
    const record = combo();

    const tty = resolveRoleSeatTty(
      {
        tmux: (args) => {
          calls.push(args);
          if (args[0] === "list-windows") return { status: 0, stdout: "capsule\nreviewer\n", stderr: "" };
          if (args[0] === "list-panes") return { status: 0, stdout: "0 /dev/ttys011\n", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      record,
      REVIEWER_WINDOW,
    );

    expect(tty).toBe("/dev/ttys011");
    expect(calls).toContainEqual([
      "list-panes",
      "-t",
      "combo-chen-o-r-7:reviewer",
      "-F",
      "#{pane_dead} #{pane_tty}",
    ]);
  });

  it("resolves a duplicate role name deterministically by window id without creating another seat", () => {
    const calls: string[][] = [];
    const record = combo();

    const tty = resolveRoleSeatTty(
      {
        tmux: (args) => {
          calls.push(args);
          if (args[0] === "list-windows") {
            return {
              status: 0,
              stdout: "@7|4|coder\n@9|3|coder\n@2|0|capsule\n",
              stderr: "",
            };
          }
          if (args[0] === "list-panes" && args[2] === "@9") {
            return { status: 0, stdout: "0 /dev/ttys019\n", stderr: "" };
          }
          return { status: 1, stdout: "", stderr: "ambiguous window name" };
        },
      },
      record,
      "coder",
    );

    expect(tty).toBe("/dev/ttys019");
    expect(calls).toContainEqual([
      "list-windows",
      "-t",
      "combo-chen-o-r-7",
      "-F",
      "#{window_id}|#{window_index}|#{window_name}",
    ]);
    expect(calls).toContainEqual(["list-panes", "-t", "@9", "-F", "#{pane_dead} #{pane_tty}"]);
    expect(calls.some((call) => call[0] === "new-window")).toBe(false);
  });

  it("leaves a missing role window for topology setup instead of creating a competing seat", () => {
    const calls: string[][] = [];
    const record = combo();

    const tty = resolveRoleSeatTty(
      {
        tmux: (args) => {
          calls.push(args);
          if (args[0] === "list-windows") return { status: 0, stdout: "capsule\n", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      record,
      REVIEWER_WINDOW,
    );

    expect(tty).toBeUndefined();
    expect(calls.some((call) => call[0] === "new-window")).toBe(false);
  });

  it("skips dead panes when picking the seat", () => {
    const record = combo();

    const tty = resolveRoleSeatTty(
      {
        tmux: (args) => {
          if (args[0] === "list-windows") return { status: 0, stdout: "reviewer\n", stderr: "" };
          if (args[0] === "list-panes") {
            return { status: 0, stdout: "1 /dev/ttys011\n0 /dev/ttys012\n", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      record,
      REVIEWER_WINDOW,
    );

    expect(tty).toBe("/dev/ttys012");
  });

  it("returns undefined instead of throwing when tmux is unavailable", () => {
    const record = combo();

    const tty = resolveRoleSeatTty(
      {
        tmux: () => ({ status: 1, stdout: "", stderr: "no server running" }),
      },
      record,
      REVIEWER_WINDOW,
    );

    expect(tty).toBeUndefined();
  });
});

describe("seatOccupancy", () => {
  function seatDeps(listPanesStdout: string, status = 0) {
    return {
      tmux: (args: string[]) => {
        if (args[0] === "list-windows") {
          return { status: 0, stdout: "@3|2|reviewer\n", stderr: "" };
        }
        if (args[0] === "list-panes") return { status, stdout: listPanesStdout, stderr: "no such window" };
        return { status: 0, stdout: "", stderr: "" };
      },
    };
  }

  /** A real pid whose process has already exited (spawnSync reaps it). */
  function deadPid(): number {
    const finished = spawnSync("true");
    if (finished.pid === undefined || finished.pid === 0) throw new Error("no pid for finished process");
    return finished.pid;
  }

  it("confirms occupancy when the live pane's seat tty hosts an active role child", () => {
    const result = seatOccupancy(seatDeps("0 /dev/ttys011\n"), combo(), REVIEWER_WINDOW, {
      seatTty: "/dev/ttys011",
      childPid: process.pid,
    });

    expect(result.occupied).toBe(true);
    expect(result.detail).toContain("/dev/ttys011");
    expect(result.detail).toContain(`active role child ${process.pid}`);
  });

  it("checks occupancy through the deterministic lowest-index window id when role names duplicate", () => {
    const calls: string[][] = [];
    const result = seatOccupancy(
      {
        tmux: (args) => {
          calls.push(args);
          if (args[0] === "list-windows") {
            return { status: 0, stdout: "@7|4|coder\n@9|3|coder\n", stderr: "" };
          }
          if (args[0] === "list-panes" && args[2] === "@9") {
            return { status: 0, stdout: "0 /dev/ttys019\n", stderr: "" };
          }
          return { status: 1, stdout: "", stderr: "ambiguous window name" };
        },
      },
      combo(),
      "coder",
      { seatTty: "/dev/ttys019", childPid: process.pid },
    );

    expect(result.occupied).toBe(true);
    expect(calls).toContainEqual(["list-panes", "-t", "@9", "-F", "#{pane_dead} #{pane_tty}"]);
  });

  it("rejects a placeholder-only seat: live pane and matching tty but no running role child", () => {
    const exited = deadPid();

    const result = seatOccupancy(seatDeps("0 /dev/ttys011\n"), combo(), REVIEWER_WINDOW, {
      seatTty: "/dev/ttys011",
      childPid: exited,
    });

    expect(result.occupied).toBe(false);
    expect(result.detail).toContain(`role child ${exited} is not running`);
    expect(result.detail).toContain("placeholder");
  });

  it("rejects occupancy when the pane hosting the seat tty is dead", () => {
    const result = seatOccupancy(seatDeps("1 /dev/ttys011\n"), combo(), REVIEWER_WINDOW, {
      seatTty: "/dev/ttys011",
      childPid: process.pid,
    });

    expect(result.occupied).toBe(false);
    expect(result.detail).toContain("dead");
  });

  it("rejects occupancy when the window's panes host a different tty", () => {
    const result = seatOccupancy(seatDeps("0 /dev/ttys044\n"), combo(), REVIEWER_WINDOW, {
      seatTty: "/dev/ttys011",
      childPid: process.pid,
    });

    expect(result.occupied).toBe(false);
    expect(result.detail).toContain("/dev/ttys044");
  });

  it("rejects occupancy when the window has no panes to host the seat", () => {
    const result = seatOccupancy(seatDeps("", 1), combo(), REVIEWER_WINDOW, {
      seatTty: "/dev/ttys011",
      childPid: process.pid,
    });

    expect(result.occupied).toBe(false);
    expect(result.detail).toContain("no such window");
  });
});

describe("killWindowIfPresent", () => {
  it("kills an existing named window after listing windows", () => {
    const calls: string[][] = [];
    const record = combo();

    killWindowIfPresent(
      {
        tmux: (args) => {
          calls.push(args);
          if (args[0] === "list-windows") return { status: 0, stdout: "coder\nreviewer\n", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      record,
      REVIEWER_WINDOW,
    );

    expect(calls).toEqual([
      ["list-windows", "-t", "combo-chen-o-r-7", "-F", "#{window_name}"],
      ["kill-window", "-t", "combo-chen-o-r-7:reviewer"],
    ]);
  });
});
// -/ 4/4
