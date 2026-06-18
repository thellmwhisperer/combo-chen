/**
 * @overview Unit tests for GitHub CLI parsing helpers. ~225 lines, gh JSON and URL parsing.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at cli GitHub helpers tests <- remote slugs, issue JSON, PR JSON, LGTM pins.
 *
 *   MAIN FLOW
 *   ---------
 *   fake gh stdout -> helper parser -> normalized values
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
 * @deps vitest, ./github
 */
import { describe, expect, it } from "vitest";

import {
  fetchForensicsGithubFacts,
  fetchIssueDetails,
  latestGitHubLgtmSha,
  parsePrView,
  remoteSlug,
} from "./github.js";

// -- 1/1 CORE · cli GitHub helpers tests <- START HERE --
describe("cli GitHub helpers", () => {
  it("extracts owner/repo slugs from common origin remote URL shapes", () => {
    expect(remoteSlug("git@github.com:owner/repo.git")).toBe("owner/repo");
    expect(remoteSlug("https://github.com/owner/repo.git")).toBe("owner/repo");
    expect(remoteSlug("https://github.com/owner/repo")).toBe("owner/repo");
  });

  it("parses PR view JSON with optional merge metadata", () => {
    expect(
      parsePrView(
        JSON.stringify({
          headRefOid: "def456",
          state: "MERGED",
          mergedBy: { login: "maintainer" },
          baseRefName: "main",
          mergeCommit: { oid: "abc123" },
        }),
      ),
    ).toEqual({
      headSha: "def456",
      state: "MERGED",
      mergedBy: "maintainer",
      baseRefName: "main",
      mergeSha: "abc123",
    });
  });

  it("fetches issue title and normalizes null bodies from gh JSON", () => {
    const calls: string[][] = [];
    const gh = (args: string[]) => {
      calls.push(args);
      return {
        status: 0,
        stdout: JSON.stringify({ title: "Split CLI helpers", body: null }),
        stderr: "",
      };
    };

    expect(fetchIssueDetails(gh, "https://github.com/o/r/issues/84")).toEqual({
      title: "Split CLI helpers",
      body: "",
    });
    expect(calls).toEqual([
      ["issue", "view", "https://github.com/o/r/issues/84", "--json", "title,body"],
    ]);
  });

  it("separates configured required READY checks from CI for forensics", () => {
    const gh = (args: string[]) => {
      if (args[0] === "pr") {
        return {
          status: 0,
          stdout: JSON.stringify({
            headRefOid: "def456",
            state: "OPEN",
            statusCheckRollup: [
              { __typename: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
              { __typename: "CheckRun", name: "ReviewDog", status: "COMPLETED", conclusion: "FAILURE" },
            ],
          }),
          stderr: "",
        };
      }
      if (args[0] === "issue") {
        return { status: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
      }
      if (args[0] === "api") {
        return { status: 0, stdout: "[]", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
    };

    const facts = fetchForensicsGithubFacts(
      gh,
      "https://github.com/o/r/issues/84",
      "https://github.com/o/r/pull/84",
      undefined,
      { requiredCheckNames: ["reviewdog"] },
    );

    expect(facts?.pr?.ci).toBe("success");
    expect(facts?.pr?.readyRequiredChecks).toBe("failure");
    expect(facts?.pr).not.toHaveProperty("codeRabbit");
  });

  it("finds the latest non-negated LGTM pin across comments and reviews", () => {
    const calls: string[][] = [];
    const gh = (args: string[]) => {
      calls.push(args);
      if (args.join(" ").includes("issues/7/comments")) {
        return {
          status: 0,
          stdout: JSON.stringify([
            { body: "no lgtm @ aa11bb0", created_at: "2026-06-11T00:00:00Z" },
            { body: "lgtm @ cc33dd0", created_at: "2026-06-11T00:01:00Z" },
          ]),
          stderr: "",
        };
      }
      if (args.join(" ").includes("pulls/7/reviews")) {
        return {
          status: 0,
          stdout: JSON.stringify([
            { body: "lgtm @ ee55ff0", submitted_at: "2026-06-11T00:02:00Z" },
          ]),
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
    };

    expect(latestGitHubLgtmSha(gh, "https://github.com/o/r/pull/7")).toBe("ee55ff0");
    expect(calls).toEqual([
      ["api", "--paginate", "repos/o/r/issues/7/comments"],
      ["api", "--paginate", "repos/o/r/pulls/7/reviews"],
    ]);
  });

  it("ignores fixture pins inside code spans, fenced code blocks, and quoted prose", () => {
    const fixtureSha = "73f80173a96fc2d70af0972c6ee936cc59ad5f19";
    const gh = (args: string[]) => {
      if (args.join(" ").includes("issues/7/comments")) {
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              body: `Regression fixture: \`lgtm @ ${fixtureSha}\``,
              created_at: "2026-06-11T00:00:00Z",
            },
            {
              body: ["```ts", `const fixture = "lgtm @ ${fixtureSha}";`, "```"].join("\n"),
              created_at: "2026-06-11T00:01:00Z",
            },
            {
              body: [`> Fixture review body: lgtm @ ${fixtureSha}`, `> no lgtm @ ${fixtureSha}`].join(
                "\n",
              ),
              created_at: "2026-06-11T00:02:00Z",
            },
            {
              body: `          lgtm @ ${fixtureSha}`,
              created_at: "2026-06-11T00:03:00Z",
            },
          ]),
          stderr: "",
        };
      }
      if (args.join(" ").includes("pulls/7/reviews")) {
        return { status: 0, stdout: "[]", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
    };

    expect(latestGitHubLgtmSha(gh, "https://github.com/o/r/pull/7")).toBeUndefined();
  });

  it("requires LGTM pins to be own-line verdicts with at least seven hex characters", () => {
    const validSha = "73f80173a96fc2d70af0972c6ee936cc59ad5f19";
    const inlineSha = "9af80173a96fc2d70af0972c6ee936cc59ad5f19";
    const gh = (args: string[]) => {
      if (args.join(" ").includes("issues/7/comments")) {
        return {
          status: 0,
          stdout: JSON.stringify([
            { body: "lgtm @ def456", created_at: "2026-06-11T00:00:00Z" },
            {
              body: `Inline mention lgtm @ ${inlineSha} is just prose.`,
              created_at: "2026-06-11T00:03:00Z",
            },
          ]),
          stderr: "",
        };
      }
      if (args.join(" ").includes("pulls/7/reviews")) {
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              body: ["Runtime review complete.", "", `lgtm @ ${validSha}`].join("\n"),
              submitted_at: "2026-06-11T00:02:00Z",
            },
          ]),
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
    };

    expect(latestGitHubLgtmSha(gh, "https://github.com/o/r/pull/7")).toBe(validSha);
  });
});
// -/ 1/1
