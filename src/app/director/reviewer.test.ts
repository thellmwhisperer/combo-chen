/**
 * @overview Unit tests for reviewer lifecycle observation after local verdict cutover.
 * @exports none
 * @deps vitest, node:fs, ../../core/events, ../../core/state, ./reviewer
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendEvent, readEvents } from "../../core/events.js";
import { writeCombo } from "../../core/state.js";
import { livePinnedLgtmSha, tickReviewer } from "./reviewer.js";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "reviewer-local-"));
  const id = "o-r-7";
  const runDir = join(home, "runs", id);
  writeCombo(runDir, {
    schemaVersion: 1,
    id,
    issueUrl: "https://github.com/o/r/issues/7",
    repoDir: home,
    worktree: home,
    branch: "feat/x",
    tmuxSession: "combo-x",
    createdAt: new Date().toISOString(),
  });
  appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
  return { home, id, runDir };
}

// -- 1/2 CORE · local review state <- START HERE --
describe("local reviewer state", () => {
  it("derives the live LGTM only from journal artifacts", () => {
    expect(livePinnedLgtmSha([{ t: "now", event: "lgtm", sha: "abc" }])).toBe("abc");
    expect(
      livePinnedLgtmSha([
        { t: "now", event: "lgtm", sha: "abc" },
        { t: "later", event: "lgtm_stale", old_sha: "abc", new_sha: "def" },
      ]),
    ).toBeUndefined();
  });

  it("does not query GitHub comments or reviews", async () => {
    const { home, id } = fixture();
    const calls: string[][] = [];
    const out: string[] = [];
    await tickReviewer({
      home,
      comboId: id,
      deps: {
        env: { COMBO_CHEN_HOME: home },
        out: (line) => out.push(line),
        sleep: async () => {},
        tmux: () => ({ status: 0, stdout: "", stderr: "" }),
        git: () => ({ status: 0, stdout: "", stderr: "" }),
        gh: (args) => {
          calls.push(args);
          return { status: 0, stdout: JSON.stringify({ headRefOid: "abc", state: "OPEN" }), stderr: "" };
        },
      },
    });
    expect(calls).toEqual([
      [
        "pr",
        "view",
        "https://github.com/o/r/pull/7",
        "--json",
        "headRefOid,state,mergedAt,mergedBy,mergeCommit",
      ],
    ]);
    expect(out).toEqual(["reviewer: awaiting local verdict for o-r-7"]);
  });
});
// -/ 1/2

// -- 2/2 CORE · terminal lifecycle --
describe("terminal reviewer observation", () => {
  it("journals a GitHub merge without reviewer comment ingestion", async () => {
    const { home, id, runDir } = fixture();
    await tickReviewer({
      home,
      comboId: id,
      deps: {
        env: { COMBO_CHEN_HOME: home },
        out: () => {},
        sleep: async () => {},
        tmux: () => ({ status: 0, stdout: "", stderr: "" }),
        git: () => ({ status: 0, stdout: "", stderr: "" }),
        gh: () => ({
          status: 0,
          stdout: JSON.stringify({
            headRefOid: "abc",
            state: "MERGED",
            mergedBy: { login: "javi" },
            mergeCommit: { oid: "def" },
          }),
          stderr: "",
        }),
      },
    });
    expect(readEvents(runDir)).toContainEqual(
      expect.objectContaining({ event: "merged", sha: "def", by: "javi" }),
    );
  });
});
// -/ 2/2
