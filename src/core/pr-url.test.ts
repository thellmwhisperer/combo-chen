/**
 * @overview Unit tests for shared GitHub pull request URL parsing. ~35 lines,
 *   checking the canonical parser used by CLI and role helpers.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at describe("parseGitHubPullRequestUrl") <- full parser contract.
 *
 *   MAIN FLOW
 *   ---------
 *   URL string -> parseGitHubPullRequestUrl -> typed PR reference or undefined
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   none
 *
 * @exports none
 * @deps vitest, ./pr-url
 */
import { describe, expect, it } from "vitest";

import { parseGitHubPullRequestUrl } from "./pr-url.js";

// -- 1/1 CORE · parseGitHubPullRequestUrl <- START HERE --
describe("parseGitHubPullRequestUrl", () => {
  it("parses GitHub PR URLs with optional trailing URL detail", () => {
    expect(parseGitHubPullRequestUrl("https://github.com/o/r/pull/7")).toEqual({
      owner: "o",
      repo: "r",
      number: 7,
    });
    expect(parseGitHubPullRequestUrl("https://github.com/o/r/pull/7#discussion_r1")).toEqual({
      owner: "o",
      repo: "r",
      number: 7,
    });
    expect(parseGitHubPullRequestUrl("https://github.com/o/r/pull/7/?tab=commits")).toEqual({
      owner: "o",
      repo: "r",
      number: 7,
    });
  });

  it("rejects non-GitHub or non-pull-request URLs", () => {
    expect(parseGitHubPullRequestUrl("https://gitlab.com/o/r/pull/7")).toBeUndefined();
    expect(parseGitHubPullRequestUrl("https://github.com/o/r/issues/7")).toBeUndefined();
    expect(parseGitHubPullRequestUrl("https://github.mycompany.com/o/r/pull/7")).toBeUndefined();
  });
});
// -/ 1/1
