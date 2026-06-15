import { describe, expect, it } from "vitest";

import { fetchIssueDetails, latestGitHubLgtmSha, parsePrView, remoteSlug } from "./github.js";

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
          mergedBy: { login: "javi" },
          baseRefName: "main",
          mergeCommit: { oid: "abc123" },
        }),
      ),
    ).toEqual({
      headSha: "def456",
      state: "MERGED",
      mergedBy: "javi",
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

  it("finds the latest non-negated LGTM pin across comments and reviews", () => {
    const calls: string[][] = [];
    const gh = (args: string[]) => {
      calls.push(args);
      if (args.join(" ").includes("issues/7/comments")) {
        return {
          status: 0,
          stdout: JSON.stringify([
            { body: "no lgtm @ aa11bb", created_at: "2026-06-11T00:00:00Z" },
            { body: "lgtm @ cc33dd", created_at: "2026-06-11T00:01:00Z" },
          ]),
          stderr: "",
        };
      }
      if (args.join(" ").includes("pulls/7/reviews")) {
        return {
          status: 0,
          stdout: JSON.stringify([
            { body: "lgtm @ ee55ff", submitted_at: "2026-06-11T00:02:00Z" },
          ]),
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
    };

    expect(latestGitHubLgtmSha(gh, "https://github.com/o/r/pull/7")).toBe("ee55ff");
    expect(calls).toEqual([
      ["api", "repos/o/r/issues/7/comments", "--paginate"],
      ["api", "repos/o/r/pulls/7/reviews", "--paginate"],
    ]);
  });
});
