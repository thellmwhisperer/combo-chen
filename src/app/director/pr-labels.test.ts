/**
 * @overview Contract tests for monotonic combo PR label projection and mutation.
 * @exports none
 * @deps vitest, ../../core/events, ./pr-labels
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEvents } from "../../core/events.js";
import { diffComboPrLabels, projectComboPrLabels, syncComboPrLabels } from "./pr-labels.js";

// -- 1/2 CORE · projection <- START HERE --
describe("projectComboPrLabels", () => {
  it("projects the monotonic working, ready, and merged lifecycle", () => {
    const base = { pr: { state: "OPEN", headSha: "abc" } };
    expect(projectComboPrLabels({ ...base, events: [] }).labels).toEqual(["combo:working"]);
    expect(
      projectComboPrLabels({ ...base, events: [{ t: "now", event: "ready_for_merge", sha: "abc" }] }).labels,
    ).toEqual(["combo:ready"]);
    expect(
      projectComboPrLabels({ ...base, events: [{ t: "now", event: "merged", sha: "def" }] }).labels,
    ).toEqual(["combo:merged"]);
  });

  it("projects conflict as the sole non-monotonic exception", () => {
    expect(
      projectComboPrLabels({ events: [], pr: { state: "OPEN", headSha: "abc", mergeStateStatus: "DIRTY" } }),
    ).toMatchObject({ labels: ["combo:conflict"], reason: "conflict" });
  });

  it("diffs only labels owned by combo-chen", () => {
    expect(diffComboPrLabels(["bug", "combo:working"], ["combo:ready"])).toEqual({
      add: ["combo:ready"],
      remove: ["combo:working"],
    });
  });
});
// -/ 1/2

// -- 2/2 CORE · mutation audit --
describe("syncComboPrLabels", () => {
  it("removes the old lifecycle label, adds the new one, and journals both mutations", () => {
    const runDir = mkdtempSync(join(tmpdir(), "combo-labels-"));
    let labels = ["combo:working"];
    const gh = (args: string[]) => {
      if (args[0] === "pr" && args[1] === "view")
        return {
          status: 0,
          stdout: JSON.stringify({
            headRefOid: "abc",
            state: "OPEN",
            labels: labels.map((name) => ({ name })),
          }),
          stderr: "",
        };
      if (args.includes("--remove-label")) labels = [];
      if (args.includes("--add-label")) labels = ["combo:ready"];
      return { status: 0, stdout: "", stderr: "" };
    };
    const result = syncComboPrLabels({
      gh,
      runDir,
      prUrl: "https://github.com/o/r/pull/1",
      events: [{ t: "now", event: "ready_for_merge", sha: "abc" }],
    });
    expect(result.diff).toEqual({ add: ["combo:ready"], remove: ["combo:working"] });
    expect(readEvents(runDir).filter((event) => event.event === "pr_labels_updated")).toHaveLength(2);
  });
});
// -/ 2/2
