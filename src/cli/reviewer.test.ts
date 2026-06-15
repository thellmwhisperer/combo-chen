/**
 * @overview Unit tests for reviewer CLI helpers. ~220 lines, journal predicates and reviewer flows.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at reviewer journal helpers <- pure LGTM/terminal predicates.
 *   2. Then activateReviewer             <- reviewer + watcher tmux windows.
 *   3. Then tickReviewer                 <- PR state handling.
 *
 *   MAIN FLOW
 *   ---------
 *   fake journal/gh/tmux -> reviewer helper -> events, tmux calls, output
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
 * @deps vitest, node:{fs,os,path}, ../core/{events,state}, ./reviewer
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appendEvent, readEvents, type ComboEvent } from "../core/events.js";
import { runDirFor, writeCombo, type ComboRecord } from "../core/state.js";
import {
  activateReviewer,
  canonicalLgtmShaForHead,
  hasJournaledLgtm,
  hasMergedEvent,
  latestOpenedPrUrl,
  livePinnedLgtmSha,
  terminalReviewerEvent,
  tickReviewer,
} from "./reviewer.js";

// -- 1/4 HELPER · combo fixture --
function combo(overrides: Partial<ComboRecord> = {}): ComboRecord {
  return {
    id: "o-r-7",
    issueUrl: "https://github.com/o/r/issues/7",
    repoDir: mkdtempSync(join(tmpdir(), "combo-chen-repo-")),
    worktree: join(tmpdir(), "combo-chen-worktree"),
    branch: "combo/issue-7",
    tmuxSession: "combo-chen-o-r-7",
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}
// -/ 1/4

// -- 2/4 HELPER · reviewer journal helpers --
describe("cli reviewer journal helpers", () => {
  it("tracks the currently live LGTM pin through stale events", () => {
    const events = [
      { t: "2026-06-11T00:00:00.000Z", event: "lgtm", sha: "abc123" },
      {
        t: "2026-06-11T00:01:00.000Z",
        event: "review_comment",
        url: "https://github.com/o/r/pull/7#issuecomment-1",
      },
      { t: "2026-06-11T00:02:00.000Z", event: "lgtm_stale", old_sha: "abc123", new_sha: "def456" },
      { t: "2026-06-11T00:03:00.000Z", event: "lgtm", sha: "def456" },
    ] satisfies ComboEvent[];

    expect(livePinnedLgtmSha(events)).toBe("def456");
    expect(hasJournaledLgtm(events, "abc123")).toBe(true);
    expect(hasJournaledLgtm(events, "fff999")).toBe(false);
  });

  it("canonicalizes short LGTM pins to the full PR head SHA", () => {
    const head = "e4e7dd43c6cc0d5f1234567890abcdef12345678";

    expect(canonicalLgtmShaForHead("e4e7dd4", head)).toBe(head);
    expect(canonicalLgtmShaForHead("abc123", head)).toBe("abc123");
  });

  it("finds terminal reviewer and merge events from the journal", () => {
    const events = [
      { t: "2026-06-11T00:00:00.000Z", event: "pr_opened", url: "https://github.com/o/r/pull/7" },
      { t: "2026-06-11T00:01:00.000Z", event: "merged", sha: "head456", by: "javi" },
      { t: "2026-06-11T00:02:00.000Z", event: "combo_closed" },
    ] satisfies ComboEvent[];

    expect(terminalReviewerEvent(events)).toMatchObject({ event: "combo_closed" });
    expect(hasMergedEvent(events, ["squash789", "head456"])).toBe(true);
    expect(hasMergedEvent(events, ["squash789"])).toBe(false);
  });

  it("returns the latest opened PR URL from the journal", () => {
    const runDir = mkdtempSync(join(tmpdir(), "combo-chen-reviewer-"));

    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(runDir, "lgtm", { sha: "abc123" });
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/8" });

    expect(latestOpenedPrUrl(runDir)).toBe("https://github.com/o/r/pull/8");
  });
});
// -/ 2/4

// -- 3/4 CORE · activateReviewer tests <- START HERE --
describe("activateReviewer", () => {
  it("starts the reviewer and watcher windows for the latest opened PR", () => {
    const calls: string[][] = [];
    const out: string[] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(home, record.id);

    writeCombo(runDir, record);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    activateReviewer({
      deps: {
        env: { COMBO_CHEN_HOME: home },
        out: (line) => out.push(line),
        tmux: (args) => {
          calls.push(args);
          return { status: 0, stdout: "coder\ngatekeeper\n", stderr: "" };
        },
      },
      home,
      comboId: record.id,
      cli: "node /repo/dist/cli.mjs",
    });

    expect(calls[0]).toEqual(["list-windows", "-t", "combo-chen-o-r-7", "-F", "#{window_name}"]);
    expect(calls[1]).toEqual(["list-windows", "-t", "combo-chen-o-r-7", "-F", "#{window_name}"]);
    expect(calls[2]?.slice(0, 5)).toEqual(["new-window", "-t", "combo-chen-o-r-7", "-n", "reviewer"]);
    expect(calls[2]?.at(-1)).toContain("https://github.com/o/r/pull/7");
    expect(calls[3]?.slice(0, 5)).toEqual([
      "new-window",
      "-t",
      "combo-chen-o-r-7",
      "-n",
      "reviewer-watch",
    ]);
    expect(calls[3]?.at(-1)).toContain(
      `COMBO_CHEN_HOME='${home}' node /repo/dist/cli.mjs reviewer-tick -n 'o-r-7'`,
    );
    expect(out).toEqual([
      "reviewer: claude reviewing https://github.com/o/r/pull/7 in combo-chen-o-r-7:reviewer",
      "reviewer-watch: polling reviewer hard signals every 120s",
    ]);
  });

  it("rejects activation before a PR has opened", () => {
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(home, record.id);

    writeCombo(runDir, record);

    expect(() =>
      activateReviewer({
        deps: {
          env: { COMBO_CHEN_HOME: home },
          out: () => undefined,
          tmux: () => ({ status: 0, stdout: "", stderr: "" }),
        },
        home,
        comboId: record.id,
        cli: "node /repo/dist/cli.mjs",
      }),
    ).toThrow("Cannot activate reviewer for o-r-7: no pr_opened event in the journal");
  });
});
// -/ 3/4

// -- 4/4 CORE · tickReviewer tests --
describe("tickReviewer", () => {
  it("journals a closed PR and stops the combo without local git cleanup", async () => {
    const calls: string[][] = [];
    const out: string[] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(home, record.id);

    writeCombo(runDir, record);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    await tickReviewer({
      deps: {
        env: { COMBO_CHEN_HOME: home },
        out: (line) => out.push(line),
        tmux: (args) => {
          calls.push(["tmux", ...args]);
          return { status: 0, stdout: "", stderr: "" };
        },
        git: (args, cwd) => {
          calls.push(["git", `cwd=${cwd}`, ...args]);
          return { status: 0, stdout: "", stderr: "" };
        },
        gh: (args) => {
          calls.push(["gh", ...args]);
          return {
            status: 0,
            stdout: '{"headRefOid":"def456","state":"CLOSED","mergedBy":null}',
            stderr: "",
          };
        },
        sleep: () => Promise.resolve(),
      },
      home,
      comboId: record.id,
    });

    expect(readEvents(runDir).slice(-2)).toMatchObject([
      { event: "needs_human", reason: "pr_closed" },
      { event: "combo_closed" },
    ]);
    expect(calls).toContainEqual(["tmux", "kill-session", "-t", "combo-chen-o-r-7"]);
    expect(calls.some((call) => call[0] === "git")).toBe(false);
    expect(out).toEqual(["reviewer: closed"]);
  });
});
// -/ 4/4
