/**
 * @overview Unit tests for the surviving GitHub issue, PR, and check-fact helpers.
 * @exports none
 * @deps vitest, ./github
 */
import { describe, expect, it } from "vitest";
import { blockingReadyMergeState, fetchIssueDetails, parsePrView, remoteSlug } from "./github.js";

// -- 1/1 CORE · provider fact parsing <- START HERE --
describe("GitHub facts", () => {
  it("parses supported remote URLs", () => {
    expect(remoteSlug("git@github.com:owner/repo.git")).toBe("owner/repo");
    expect(remoteSlug("https://github.com/owner/repo.git")).toBe("owner/repo");
  });

  it("fetches issue title and body", () => {
    const facts = fetchIssueDetails(
      () => ({ status: 0, stdout: JSON.stringify({ title: "T", body: "B" }), stderr: "" }),
      "https://github.com/o/r/issues/1",
    );
    expect(facts).toEqual({ title: "T", body: "B" });
  });

  it("normalizes PR lifecycle and check facts", () => {
    expect(
      parsePrView(
        JSON.stringify({
          headRefOid: "abc",
          state: "OPEN",
          mergeStateStatus: "CLEAN",
          statusCheckRollup: [],
        }),
      ),
    ).toEqual({ headSha: "abc", state: "OPEN", mergeStateStatus: "CLEAN", statusCheckRollup: [] });
  });

  it("blocks READY for dirty or conflicting merge state", () => {
    expect(blockingReadyMergeState({ mergeStateStatus: "DIRTY" })).toBe("DIRTY");
    expect(blockingReadyMergeState({ mergeable: "CONFLICTING" })).toBe("CONFLICTING");
    expect(blockingReadyMergeState({ mergeStateStatus: "CLEAN" })).toBeUndefined();
  });
});
// -/ 1/1
