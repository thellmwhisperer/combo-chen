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
  killComboSession,
  killWindowIfPresent,
  JOURNAL_WINDOW,
  REVIEWER_WINDOW,
  resolveAttachCombo,
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
    ).toEqual(running);
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
