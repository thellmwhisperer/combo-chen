import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runDirFor, writeCombo, type ComboRecord } from "../core/state.js";
import {
  ensureJournalPane,
  killWindowIfPresent,
  REVIEWER_WINDOW,
  resolveAttachCombo,
} from "./sessions.js";

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

describe("ensureJournalPane", () => {
  it("splits a journal pane with the configured CLI invocation when only one pane exists", () => {
    const calls: string[][] = [];
    const record = combo();

    ensureJournalPane(
      {
        tmux: (args) => {
          calls.push(args);
          if (args[0] === "list-panes") return { status: 0, stdout: "0\n", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      record,
      "node cli.mjs",
    );

    expect(calls).toEqual([
      ["list-panes", "-t", "combo-chen-o-r-7:coder", "-F", "#{pane_index}"],
      [
        "split-window",
        "-d",
        "-v",
        "-l",
        "12",
        "-t",
        "combo-chen-o-r-7:coder",
        "node cli.mjs events --follow -n o-r-7",
      ],
    ]);
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
