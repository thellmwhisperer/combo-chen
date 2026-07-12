/**
 * @overview Tests for findings-aware external review evidence (issue #295
 *   slice B): a CodeRabbit SUCCESS check is not proof of a clean review, so
 *   the READY leg reads review content — a fresh non-skipped agent review
 *   pinned to the current head plus zero unresolved actionable threads.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at describe("fetchExternalReviewEvidence") <- the evidence states.
 *   2. The #295 saga tests pin the regression scenarios verbatim.
 *
 *   MAIN FLOW
 *   ---------
 *   fake gh (REST reviews + GraphQL reviewThreads) -> evidence state
 *
 * @exports none
 * @deps vitest, ./review-evidence
 */
import { describe, expect, it } from "vitest";

import { externalReviewEvidenceClean, fetchExternalReviewEvidence } from "./review-evidence.js";

const PR_URL = "https://github.com/octo/widgets/pull/42";
const HEAD_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD_C = "cccccccccccccccccccccccccccccccccccccccc";
const AGENTS = ["coderabbitai"];

interface FakeGhCall {
  args: string[];
}

type ThreadNode = {
  isResolved: boolean;
  isOutdated: boolean;
  path?: string;
  line?: number | null;
  comments: { nodes: Array<{ author: { login: string } | null; body: string; url?: string }> };
};

function graphqlPage(nodes: ThreadNode[], endCursor?: string): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: endCursor !== undefined, endCursor: endCursor ?? null },
            nodes,
          },
        },
      },
    },
  });
}

function fakeGh(input: { reviews: unknown[]; threadPages?: string[]; graphqlStatus?: number }): {
  gh: (args: string[]) => { status: number; stdout: string; stderr: string };
  calls: FakeGhCall[];
} {
  const calls: FakeGhCall[] = [];
  let graphqlCall = 0;
  return {
    calls,
    gh: (args) => {
      calls.push({ args });
      if (args[0] === "api" && args[1] === "graphql") {
        if (input.graphqlStatus !== undefined && input.graphqlStatus !== 0) {
          return { status: input.graphqlStatus, stdout: "", stderr: "gh: GraphQL error" };
        }
        const page = (input.threadPages ?? [graphqlPage([])])[graphqlCall];
        graphqlCall += 1;
        if (page === undefined) throw new Error(`unexpected extra GraphQL page request #${graphqlCall}`);
        return { status: 0, stdout: page, stderr: "" };
      }
      if (args[0] === "api" && String(args[2]).includes("/pulls/42/reviews")) {
        return { status: 0, stdout: JSON.stringify(input.reviews), stderr: "" };
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    },
  };
}

function agentReview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user: { login: "coderabbitai[bot]" },
    body: "**Actionable comments posted: 0**",
    commit_id: HEAD_A,
    submitted_at: "2026-07-11T10:00:00Z",
    state: "COMMENTED",
    ...overrides,
  };
}

function thread(overrides: Partial<ThreadNode> = {}): ThreadNode {
  return {
    isResolved: false,
    isOutdated: false,
    path: "src/module/file.ts",
    line: 12,
    comments: {
      nodes: [
        {
          author: { login: "coderabbitai[bot]" },
          body: "_⚠️ Potential issue_ The lock is released before the write completes.",
          url: `${PR_URL}#discussion_r1`,
        },
      ],
    },
    ...overrides,
  };
}

// -- 1/2 CORE · evidence states <- START HERE --
describe("fetchExternalReviewEvidence", () => {
  it("is clean with a fresh non-skipped agent review at head and no unresolved threads", () => {
    const { gh } = fakeGh({ reviews: [agentReview()], threadPages: [graphqlPage([])] });

    const evidence = fetchExternalReviewEvidence(gh, PR_URL, HEAD_A, AGENTS);

    expect(evidence.state).toBe("clean");
    expect(evidence.agentReviewSha).toBe(HEAD_A);
    expect(externalReviewEvidenceClean(evidence)).toBe(true);
  });

  it("#295 saga: actionable unresolved findings at head are findings even when checks report SUCCESS", () => {
    // The journal in #285/#294 recorded actionable CodeRabbit review signals
    // immediately before ready_for_merge; the SUCCESS check leg passed. The
    // evidence leg must independently report findings.
    const { gh } = fakeGh({
      reviews: [agentReview({ body: "**Actionable comments posted: 2**" })],
      threadPages: [graphqlPage([thread(), thread({ path: "src/other.ts", line: 3 })])],
    });

    const evidence = fetchExternalReviewEvidence(gh, PR_URL, HEAD_A, AGENTS);

    expect(evidence.state).toBe("findings");
    expect(evidence.unresolvedFindings).toHaveLength(2);
    expect(evidence.unresolvedFindings[0]).toMatchObject({
      author: "coderabbitai[bot]",
      path: "src/module/file.ts",
      line: 12,
    });
    expect(externalReviewEvidenceClean(evidence)).toBe(false);
  });

  it("#295 saga: a review pinned to a superseded head is missing evidence for the current head", () => {
    // Steps 5-7 of the repro: coder committed B, no-mistakes published C; the
    // only CodeRabbit review still points at A. SUCCESS rollups notwithstanding,
    // there is no review artifact for the current head.
    const { gh } = fakeGh({ reviews: [agentReview({ commit_id: HEAD_A })], threadPages: [graphqlPage([])] });

    const evidence = fetchExternalReviewEvidence(gh, PR_URL, HEAD_C, AGENTS);

    expect(evidence.state).toBe("missing");
    expect(externalReviewEvidenceClean(evidence)).toBe(false);
  });

  it("resolved and outdated threads do not block", () => {
    const { gh } = fakeGh({
      reviews: [agentReview()],
      threadPages: [graphqlPage([thread({ isResolved: true }), thread({ isOutdated: true })])],
    });

    expect(fetchExternalReviewEvidence(gh, PR_URL, HEAD_A, AGENTS).state).toBe("clean");
  });

  it("ignores unresolved threads from non-configured authors", () => {
    const { gh } = fakeGh({
      reviews: [agentReview()],
      threadPages: [
        graphqlPage([thread({ comments: { nodes: [{ author: { login: "human-dev" }, body: "nit" }] } })]),
      ],
    });

    expect(fetchExternalReviewEvidence(gh, PR_URL, HEAD_A, AGENTS).state).toBe("clean");
  });

  it("a skip-marked agent review at head is skipped, not clean", () => {
    const { gh } = fakeGh({
      reviews: [agentReview({ body: "Review skipped: review limit reached." })],
      threadPages: [graphqlPage([])],
    });

    const evidence = fetchExternalReviewEvidence(gh, PR_URL, HEAD_A, AGENTS);

    expect(evidence.state).toBe("skipped");
    expect(externalReviewEvidenceClean(evidence)).toBe(false);
  });

  it("reports findings when the head review claims actionable comments but no agent thread is visible", () => {
    const { gh } = fakeGh({
      reviews: [agentReview({ body: "**Actionable comments posted: 3**" })],
      threadPages: [graphqlPage([])],
    });

    const evidence = fetchExternalReviewEvidence(gh, PR_URL, HEAD_A, AGENTS);

    expect(evidence.state).toBe("findings");
    expect(evidence.detail).toMatch(/actionable/i);
  });

  it("follows reviewThreads pagination across pages", () => {
    const { gh, calls } = fakeGh({
      reviews: [agentReview()],
      threadPages: [graphqlPage([thread({ isResolved: true })], "CURSOR-1"), graphqlPage([thread()])],
    });

    const evidence = fetchExternalReviewEvidence(gh, PR_URL, HEAD_A, AGENTS);

    expect(evidence.state).toBe("findings");
    expect(calls.filter((call) => call.args[1] === "graphql")).toHaveLength(2);
  });

  it("is unknown, never clean, when the thread query fails", () => {
    const { gh } = fakeGh({ reviews: [agentReview()], graphqlStatus: 1 });

    const evidence = fetchExternalReviewEvidence(gh, PR_URL, HEAD_A, AGENTS);

    expect(evidence.state).toBe("unknown");
    expect(externalReviewEvidenceClean(evidence)).toBe(false);
  });

  it("is unknown for an unparsable PR url", () => {
    const { gh } = fakeGh({ reviews: [] });

    expect(fetchExternalReviewEvidence(gh, "not-a-pr", HEAD_A, AGENTS).state).toBe("unknown");
  });

  it("is missing when no agents are configured to provide evidence", () => {
    const { gh } = fakeGh({ reviews: [agentReview()], threadPages: [graphqlPage([])] });

    expect(fetchExternalReviewEvidence(gh, PR_URL, HEAD_A, []).state).toBe("missing");
  });
});
// -/ 1/2

// -- 2/2 CORE · clean predicate --
describe("externalReviewEvidenceClean", () => {
  it("accepts only the clean state", () => {
    for (const state of ["findings", "missing", "skipped", "unknown"] as const) {
      expect(externalReviewEvidenceClean({ state })).toBe(false);
    }
    expect(externalReviewEvidenceClean({ state: "clean" })).toBe(true);
  });
});
// -/ 2/2
