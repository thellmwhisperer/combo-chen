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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runDirFor, writeCombo, type ComboRecord } from "../../core/state.js";
import {
  ensureJournalPane,
  ensureComboSession,
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

  it("recreates a missing role window as the idle seat before resolving its tty", () => {
    const calls: string[][] = [];
    const record = combo();

    const tty = resolveRoleSeatTty(
      {
        tmux: (args) => {
          calls.push(args);
          if (args[0] === "list-windows") return { status: 0, stdout: "capsule\n", stderr: "" };
          if (args[0] === "list-panes") return { status: 0, stdout: "0 /dev/ttys012\n", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      record,
      REVIEWER_WINDOW,
    );

    expect(tty).toBe("/dev/ttys012");
    expect(calls).toContainEqual([
      "new-window",
      "-t",
      "combo-chen-o-r-7",
      "-n",
      REVIEWER_WINDOW,
      idleRoleWindowCommand(REVIEWER_WINDOW),
    ]);
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
        if (args[0] === "list-panes") return { status, stdout: listPanesStdout, stderr: "no such window" };
        return { status: 0, stdout: "", stderr: "" };
      },
    };
  }

  it("confirms occupancy when the window's live pane hosts the seat tty", () => {
    const result = seatOccupancy(seatDeps("0 /dev/ttys011\n"), combo(), REVIEWER_WINDOW, "/dev/ttys011");

    expect(result.occupied).toBe(true);
    expect(result.detail).toContain("/dev/ttys011");
  });

  it("rejects occupancy when the pane hosting the seat tty is dead", () => {
    const result = seatOccupancy(seatDeps("1 /dev/ttys011\n"), combo(), REVIEWER_WINDOW, "/dev/ttys011");

    expect(result.occupied).toBe(false);
    expect(result.detail).toContain("dead");
  });

  it("rejects occupancy when the window's panes host a different tty", () => {
    const result = seatOccupancy(seatDeps("0 /dev/ttys044\n"), combo(), REVIEWER_WINDOW, "/dev/ttys011");

    expect(result.occupied).toBe(false);
    expect(result.detail).toContain("/dev/ttys044");
  });

  it("rejects occupancy when the window has no panes to host the seat", () => {
    const result = seatOccupancy(seatDeps("", 1), combo(), REVIEWER_WINDOW, "/dev/ttys011");

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
