/**
 * @overview Unit tests for status downstream summaries. ~95 lines, focused on
 *   GitHub PR recovery hints used by status --deep.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at describe("deepComboStatus") <- CLI-facing downstream phrases.
 *
 * @exports none
 * @deps vitest, ./status
 */
import { describe, expect, it } from "vitest";

import { deepComboStatus } from "./status.js";

// -- 1/1 CORE · deepComboStatus --
describe("deepComboStatus", () => {
  it("surfaces dirty or conflicting GitHub mergeability before stale READY can hide it", () => {
    const combo = {
      branch: "combo/issue-7",
      worktree: "/repo/.worktrees/issue-7",
    };
    const prUrl = "https://github.com/o/r/pull/7";
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const downstream = deepComboStatus(
      combo,
      [
        { t: new Date(0).toISOString(), event: "pr_opened", url: prUrl },
        { t: new Date(0).toISOString(), event: "ready_for_merge", sha: headSha, pr_url: prUrl },
      ],
      () => ({ status: 1, stdout: "", stderr: "no daemon" }),
      (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: headSha,
              state: "OPEN",
              mergeStateStatus: "DIRTY",
              mergeable: "CONFLICTING",
              statusCheckRollup: [
                { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
              ],
            }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    );

    expect(downstream).toBe("PR conflict: rebase required (DIRTY)");
  });

  it("surfaces PR head drift with an explicit sync or fetch action", () => {
    const combo = {
      branch: "combo/issue-7",
      worktree: "/repo/.worktrees/issue-7",
    };
    const prUrl = "https://github.com/o/r/pull/7";
    const localHeadSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const prHeadSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const downstream = deepComboStatus(
      combo,
      [{ t: new Date(0).toISOString(), event: "pr_opened", url: prUrl }],
      () => ({ status: 1, stdout: "", stderr: "no daemon" }),
      (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: prHeadSha,
              state: "OPEN",
              mergeStateStatus: "CLEAN",
              mergeable: "MERGEABLE",
              statusCheckRollup: [
                { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
              ],
            }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
      { localHeadSha },
    );

    expect(downstream).toBe(
      "PR head drift: local aaaaaaa differs from PR bbbbbbb; fetch PR head for review or sync combo worktree",
    );
  });
});
// -/ 1/1
