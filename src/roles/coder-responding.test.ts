/**
 * @overview Unit tests for coder responding mode. ~433 lines, testing
 *   review nudge prompt rendering, activation/resume commands, thread
 *   artifact persistence, PR comment routing, URL parsing, gh array
 *   aggregation, and review comment/PR review signal extraction.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at describe("routeReviewComments")   ← core routing logic
 *   2. Then describe("readGhArray")               ← paginated gh output parsing
 *   3. Then describe("signalFromComment")         ← signal extraction contracts
 *
 *   ┌─ TEST AREAS ───────────────────────────────────────────────┐
 *   │ buildReviewNudgePrompt          Prompt template rendering  │
 *   │ coder responding activation commands  Resume commands        │
 *   │ readCoderThreadArtifact         Legacy + canonical path    │
 *   │ routeReviewComments             Idempotent nudge + journal │
 *   │ parsePullRequestUrl             URL parsing variants       │
 *   │ readGhArray                     gh api --paginate          │
 *   │ signalFromComment               Author/kind/url extraction │
 *   │ signalFromReview                PR review state → signal   │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * @exports none (test file)
 * @deps vitest, node:{fs,os,path}, ../core/events, ./coder,
 *   ./coder-responding
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readEvents } from "../core/events.js";
import { CODER_THREAD_ARTIFACT, LEGACY_ROWER_THREAD_ARTIFACT } from "./coder.js";
import {
  buildReviewNudgePrompt,
  buildCoderRespondingResumeCommand,
  parsePullRequestUrl,
  readGhArray,
  readCoderThreadArtifact,
  routeReviewComments,
  signalFromComment,
  signalFromReview,
  type ReviewCommentSignal,
} from "./coder-responding.js";

function runDir(): string {
  return mkdtempSync(join(tmpdir(), "combo-chen-coder-responding-"));
}

const comment: ReviewCommentSignal = {
  author: "coderabbitai",
  kind: "review_comment",
  url: "https://github.com/o/r/pull/7#discussion_r1",
};

// -- 1/3 HELPER · Nudge prompt + activation commands --

describe("buildReviewNudgePrompt", () => {
  const promptTemplate = [
    "New review comment for coder responding mode:",
    "{url}",
    "",
    "Use the two-bucket contract: handle mechanical fixes autonomously with TDD, code, and committed local changes; escalate intent-touching decisions with needs_human before changing code.",
    "Do not push to origin or the PR branch. Leave committed local changes for gatekeeper/no-mistakes to validate and publish.",
  ].join("\n");

  it("renders the configured prompt template with the comment URL and two-bucket contract", () => {
    const prompt = buildReviewNudgePrompt(comment, promptTemplate);

    expect(prompt).toContain(`'${comment.url}'`);
    expect(prompt).toContain("mechanical");
    expect(prompt).toContain("intent-touching");
    expect(prompt).toContain("needs_human");
  });

  it("lets config replace the whole nudge prompt while still rendering placeholders", () => {
    expect(buildReviewNudgePrompt(comment, "Handle {kind} at {url} from {author}")).toBe(
      "Handle 'review_comment' at 'https://github.com/o/r/pull/7#discussion_r1' from 'coderabbitai'",
    );
  });
});

describe("coder responding activation commands", () => {
  it("resumes the implementing thread with the configured command template", () => {
    expect(
      buildCoderRespondingResumeCommand(
        {
          agent: "codex",
          thread_id: "019eb3f5-c135-76d2-88c5-0aa8edfe4c84",
          source: ".gnhf/runs/implement-github-iss-e6510c/iteration-1.jsonl",
        },
        "codex resume {thread_id}",
      ),
    ).toBe("codex resume '019eb3f5-c135-76d2-88c5-0aa8edfe4c84'");

    expect(
      buildCoderRespondingResumeCommand(
        {
          agent: "codex",
          thread_id: "019eb3f5-c135-76d2-88c5-0aa8edfe4c84",
          source: ".gnhf/runs/implement-github-iss-e6510c/iteration-1.jsonl",
        },
        "hermes --resume {thread_id}",
      ),
    ).toBe("hermes --resume '019eb3f5-c135-76d2-88c5-0aa8edfe4c84'");
  });

});
// -/ 1/3

// -- 2/3 CORE · Thread artifact + review routing ← START HERE --
describe("readCoderThreadArtifact", () => {
  it("reads the canonical coder thread artifact", () => {
    const dir = runDir();
    writeFileSync(
      join(dir, CODER_THREAD_ARTIFACT),
      JSON.stringify({
        agent: "codex",
        thread_id: "019eb3f5-c135-76d2-88c5-0aa8edfe4c84",
        source: ".gnhf/runs/implement-github-iss-e6510c/iteration-1.jsonl",
      }),
    );

    expect(readCoderThreadArtifact(dir).thread_id).toBe("019eb3f5-c135-76d2-88c5-0aa8edfe4c84");
  });

  it("still reads the legacy rower artifact for already-created combos", () => {
    const dir = runDir();
    writeFileSync(
      join(dir, LEGACY_ROWER_THREAD_ARTIFACT),
      JSON.stringify({
        agent: "codex",
        thread_id: "legacy-thread",
        source: ".gnhf/runs/implement-github-iss-e6510c/iteration-1.jsonl",
      }),
    );

    expect(readCoderThreadArtifact(dir).thread_id).toBe("legacy-thread");
  });

  it("reports a missing coder thread artifact separately from invalid JSON", () => {
    const dir = runDir();

    expect(() => readCoderThreadArtifact(dir)).toThrow(/Missing coder thread artifact/);
  });

  it("reports invalid JSON for the artifact that exists", () => {
    const dir = runDir();
    writeFileSync(join(dir, CODER_THREAD_ARTIFACT), "{nope");

    expect(() => readCoderThreadArtifact(dir)).toThrow(`${CODER_THREAD_ARTIFACT} is not valid JSON`);
  });
});

describe("routeReviewComments", () => {
  it("sends exactly one nudge for a new comment and stays idempotent on re-read", () => {
    const dir = runDir();
    const tmuxCalls: string[][] = [];
    const reviewNudgePrompt = "Review {url}";
    const tmux = (args: string[]) => {
      tmuxCalls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    };

    expect(
      routeReviewComments({
        runDir: dir,
        tmuxSession: "combo-chen-o-r-7",
        comments: [comment],
        reviewNudgePrompt,
        tmux,
        windowName: "coder-responding",
      }),
    ).toEqual([comment]);
    expect(
      routeReviewComments({
        runDir: dir,
        tmuxSession: "combo-chen-o-r-7",
        comments: [comment],
        reviewNudgePrompt,
        tmux,
        windowName: "coder-responding",
      }),
    ).toEqual([]);

    expect(tmuxCalls).toHaveLength(3);
    expect(tmuxCalls[0]).toEqual([
      "set-buffer",
      "-b",
      "combo-chen-nudge-combo-chen-o-r-7-coder-responding",
      buildReviewNudgePrompt(comment, reviewNudgePrompt),
    ]);
    expect(tmuxCalls[1]).toEqual([
      "paste-buffer",
      "-d",
      "-b",
      "combo-chen-nudge-combo-chen-o-r-7-coder-responding",
      "-t",
      "combo-chen-o-r-7:coder-responding",
    ]);
    expect(tmuxCalls[2]).toEqual([
      "send-keys",
      "-t",
      "combo-chen-o-r-7:coder-responding",
      "C-m",
    ]);
    expect(readEvents(dir).map((event) => event.event)).toEqual(["review_comment"]);
    expect(readEvents(dir)[0]).toMatchObject(comment);
  });
});
// -/ 2/3

// -- 3/3 HELPER · URL parsing, gh array, signal extraction --
describe("parsePullRequestUrl", () => {
  it("parses a standard GitHub PR URL", () => {
    const pr = parsePullRequestUrl("https://github.com/o/r/pull/7");
    expect(pr).toEqual({ owner: "o", repo: "r", number: 7 });
  });

  it("parses a URL with trailing fragment", () => {
    const pr = parsePullRequestUrl("https://github.com/o/r/pull/7#discussion_r1");
    expect(pr.owner).toBe("o");
    expect(pr.number).toBe(7);
  });

  it("parses a URL with trailing slash and query", () => {
    const pr = parsePullRequestUrl("https://github.com/o/r/pull/7/?tab=commits");
    expect(pr).toEqual({ owner: "o", repo: "r", number: 7 });
  });

  it("throws for a non-GitHub URL", () => {
    expect(() => parsePullRequestUrl("https://gitlab.com/o/r/pull/7")).toThrow(
      "Not a GitHub pull request URL",
    );
  });

  it("throws for a non-PR GitHub URL", () => {
    expect(() =>
      parsePullRequestUrl("https://github.com/o/r/issues/7"),
    ).toThrow("Not a GitHub pull request URL");
  });

  it("throws for GitHub Enterprise URLs because the regex is scoped to github.com", () => {
    expect(() =>
      parsePullRequestUrl(
        "https://github.mycompany.com/org/repo/pull/42",
      ),
    ).toThrow("Not a GitHub pull request URL");
  });
});

describe("readGhArray", () => {
  it("returns parsed array on success", () => {
    const gh = () => ({ status: 0, stdout: '[{"a":1}]', stderr: "" });
    expect(readGhArray(gh, "repos/a")).toEqual([{ a: 1 }]);
  });

  it("throws when gh returns non-zero status", () => {
    const gh = () => ({ status: 1, stdout: "", stderr: "not found" });
    expect(() => readGhArray(gh, "repos/x")).toThrow("gh api failed");
  });

  it("classifies rate limit failures from gh api", () => {
    const gh = () => ({ status: 1, stdout: "", stderr: "API rate limit exceeded" });
    expect(() => readGhArray(gh, "repos/x")).toThrow("rate_limit transient");
  });

  it("throws when gh returns invalid JSON", () => {
    const gh = () => ({ status: 0, stdout: "not json", stderr: "" });
    expect(() => readGhArray(gh, "repos/x")).toThrow("invalid JSON");
  });

  it("accepts an object page by wrapping it into the aggregate result", () => {
    const gh = () => ({ status: 0, stdout: '{"x":1}', stderr: "" });
    expect(readGhArray(gh, "repos/x")).toEqual([{ x: 1 }]);
  });

  it("throws when gh returns scalar JSON", () => {
    const gh = () => ({ status: 0, stdout: "7", stderr: "" });
    expect(() => readGhArray(gh, "repos/x")).toThrow("non-array");
  });

  it("passes --paginate to gh api", () => {
    const calls: string[][] = [];
    const gh = (args: string[]) => {
      calls.push(args);
      return { status: 0, stdout: "[]", stderr: "" };
    };
    readGhArray(gh, "repos/o/r/pulls/1/comments");
    expect(calls[0]).toEqual(["api", "--paginate", "repos/o/r/pulls/1/comments"]);
  });

  it("aggregates multiple JSON payloads emitted by gh api --paginate", () => {
    const gh = () => ({
      status: 0,
      stdout: '[{"a":1}]\n[{"b":2}]\n{"c":3}\n',
      stderr: "",
    });

    expect(readGhArray(gh, "repos/o/r/pulls/1/comments")).toEqual([
      { a: 1 },
      { b: 2 },
      { c: 3 },
    ]);
  });
});

describe("signalFromComment", () => {
  it("extracts author, kind, and url from a valid comment", () => {
    const signal = signalFromComment(
      {
        body: "Looks good",
        html_url: "https://github.com/o/r/pull/7#discussion_r1",
        user: { login: "reviewer" },
      },
      "pr_comment",
    );
    expect(signal).toEqual({
      author: "reviewer",
      kind: "pr_comment",
      url: "https://github.com/o/r/pull/7#discussion_r1",
    });
  });

  it("returns undefined when body is missing", () => {
    expect(
      signalFromComment({ html_url: "a", user: { login: "x" } }, "pr_comment"),
    ).toBeUndefined();
  });

  it("returns undefined when body is empty string", () => {
    expect(
      signalFromComment(
        { body: "", html_url: "a", user: { login: "x" } },
        "pr_comment",
      ),
    ).toBeUndefined();
  });

  it("returns undefined when html_url is missing", () => {
    expect(
      signalFromComment({ body: "ok", user: { login: "x" } }, "pr_comment"),
    ).toBeUndefined();
  });

  it("returns undefined when user.login is missing", () => {
    expect(
      signalFromComment({ body: "ok", html_url: "a", user: {} }, "pr_comment"),
    ).toBeUndefined();
  });

  it("returns undefined for non-object input", () => {
    expect(signalFromComment(null, "pr_comment")).toBeUndefined();
    expect(signalFromComment(42, "pr_comment")).toBeUndefined();
  });

  it("ignores a pure ambient-reviewer retrigger bookkeeping PR comment", () => {
    expect(
      signalFromComment(
        {
          body: [
            "@coderabbitai review",
            "",
            "Codex -- Re-running CodeRabbit for current PR #82 head 73f80173 after the no-mistakes documentation commit.",
          ].join("\n"),
          html_url: "https://github.com/o/r/pull/7#issuecomment-1",
          user: { login: "teseo" },
        },
        "pr_comment",
        { ambientReviewerAgents: ["coderabbit"] },
      ),
    ).toBeUndefined();

    expect(
      signalFromComment(
        {
          body: [
            "@reviewdog review",
            "",
            "Codex -- Re-running ReviewDog for current PR #82 head 73f80173 after the no-mistakes documentation commit.",
          ].join("\n"),
          html_url: "https://github.com/o/r/pull/7#issuecomment-2",
          user: { login: "teseo" },
        },
        "pr_comment",
        { ambientReviewerAgents: ["reviewdog"] },
      ),
    ).toBeUndefined();
  });
});

describe("signalFromReview", () => {
  it("returns a signal for a CHANGES_REQUESTED review", () => {
    const signal = signalFromReview({
      state: "CHANGES_REQUESTED",
      body: "Needs work",
      html_url: "https://github.com/o/r/pull/7#pullrequestreview-1",
      user: { login: "reviewer" },
    });
    expect(signal).toMatchObject({ author: "reviewer", kind: "review" });
  });

  it("returns a signal for a PENDING review with body", () => {
    const signal = signalFromReview({
      state: "PENDING",
      body: "Looking",
      html_url: "https://github.com/o/r/pull/7#pullrequestreview-1",
      user: { login: "reviewer" },
    });
    expect(signal).toMatchObject({ author: "reviewer", kind: "review" });
  });

  it("returns undefined for an APPROVED review", () => {
    expect(
      signalFromReview({
        state: "APPROVED",
        body: "LGTM",
        html_url: "https://github.com/o/r/pull/7#pullrequestreview-1",
        user: { login: "reviewer" },
      }),
    ).toBeUndefined();
  });

  it("returns undefined for a COMMENTED review that is only a pinned LGTM", () => {
    expect(
      signalFromReview({
        state: "COMMENTED",
        body: [
          "lgtm @ 73f80173a96fc2d70af0972c6ee936cc59ad5f19",
          "",
          "Runtime review. No findings.",
        ].join("\n"),
        html_url: "https://github.com/o/r/pull/7#pullrequestreview-1",
        user: { login: "reviewer" },
      }),
    ).toBeUndefined();
  });

  it("returns undefined for a review with empty body", () => {
    expect(
      signalFromReview({
        state: "CHANGES_REQUESTED",
        body: "",
        html_url: "a",
        user: { login: "x" },
      }),
    ).toBeUndefined();
  });

  it("returns undefined for non-object input", () => {
    expect(signalFromReview(null)).toBeUndefined();
  });
});
// -/ 3/3
