import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readEvents } from "../core/events.js";
import {
  buildReviewNudgePrompt,
  buildReviewWatchCommand,
  buildThreadSitterResumeCommand,
  parsePullRequestUrl,
  readGhArray,
  routeReviewComments,
  signalFromComment,
  signalFromReview,
  type ReviewCommentSignal,
} from "./thread-sitter.js";

function runDir(): string {
  return mkdtempSync(join(tmpdir(), "combo-chen-thread-sitter-"));
}

const comment: ReviewCommentSignal = {
  author: "coderabbitai",
  kind: "review_comment",
  url: "https://github.com/o/r/pull/7#discussion_r1",
};

describe("buildReviewNudgePrompt", () => {
  const promptTemplate = [
    "New review comment for the thread-sitter:",
    "{url}",
    "",
    "Use the two-bucket contract: handle mechanical fixes autonomously with TDD, code, push, and PR replies; escalate intent-touching decisions with needs_human before changing code.",
    "Before pushing, check the hodor push semaphore.",
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

describe("thread-sitter activation commands", () => {
  it("resumes the implementing thread with the configured command template", () => {
    expect(
      buildThreadSitterResumeCommand(
        {
          agent: "codex",
          thread_id: "019eb3f5-c135-76d2-88c5-0aa8edfe4c84",
          source: ".gnhf/runs/implement-github-iss-e6510c/iteration-1.jsonl",
        },
        "codex resume {thread_id}",
      ),
    ).toBe("codex resume '019eb3f5-c135-76d2-88c5-0aa8edfe4c84'");

    expect(
      buildThreadSitterResumeCommand(
        {
          agent: "codex",
          thread_id: "019eb3f5-c135-76d2-88c5-0aa8edfe4c84",
          source: ".gnhf/runs/implement-github-iss-e6510c/iteration-1.jsonl",
        },
        "hermes --resume {thread_id}",
      ),
    ).toBe("hermes --resume '019eb3f5-c135-76d2-88c5-0aa8edfe4c84'");
  });

  it("builds a small polling watcher around the nudge helper", () => {
    expect(
      buildReviewWatchCommand({
        cli: '"node" "/opt/combo/dist/cli.mjs"',
        comboId: "o-r-7",
        pollSeconds: 7,
      }),
    ).toBe(
      'while :; do "node" "/opt/combo/dist/cli.mjs" nudge-review-comments -n \'o-r-7\'; sleep 7; done',
    );
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
        windowName: "thread-sitter",
      }),
    ).toEqual([comment]);
    expect(
      routeReviewComments({
        runDir: dir,
        tmuxSession: "combo-chen-o-r-7",
        comments: [comment],
        reviewNudgePrompt,
        tmux,
        windowName: "thread-sitter",
      }),
    ).toEqual([]);

    expect(tmuxCalls).toHaveLength(3);
    expect(tmuxCalls[0]).toEqual([
      "set-buffer",
      "-b",
      "combo-chen-nudge-combo-chen-o-r-7-thread-sitter",
      buildReviewNudgePrompt(comment, reviewNudgePrompt),
    ]);
    expect(tmuxCalls[1]).toEqual([
      "paste-buffer",
      "-d",
      "-b",
      "combo-chen-nudge-combo-chen-o-r-7-thread-sitter",
      "-t",
      "combo-chen-o-r-7:thread-sitter",
    ]);
    expect(tmuxCalls[2]).toEqual([
      "send-keys",
      "-t",
      "combo-chen-o-r-7:thread-sitter",
      "C-m",
    ]);
    expect(readEvents(dir).map((event) => event.event)).toEqual(["review_comment"]);
    expect(readEvents(dir)[0]).toMatchObject(comment);
  });
});

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
