import { describe, expect, it } from "vitest";

import {
  buildGatekeeperInvocation,
  buildIssuePrIntent,
  ensureIssueAutocloseInPrBody,
  hasIssueAutocloseInPrBody,
  parseAxiOutcome,
} from "./gatekeeper.js";

describe("buildGatekeeperInvocation", () => {
  it("uses the configured gate command", () => {
    expect(buildGatekeeperInvocation({ gatekeeperCommand: "no-mistakes axi run" })).toBe(
      "no-mistakes axi run",
    );
  });

  it("builds an issue-derived PR intent with an autoclose keyword", () => {
    const intent = buildIssuePrIntent({
      combo: { issueUrl: "https://github.com/o/r/issues/53" },
      issueTitle: "Include GitHub autoclose keywords",
      issueBody: "This mentions issue #53 but not as a close directive.",
    });

    expect(intent).toContain("Implement GitHub issue https://github.com/o/r/issues/53.");
    expect(intent).toContain("Title: Include GitHub autoclose keywords");
    expect(intent).toContain("This mentions issue #53 but not as a close directive.");
    expect(intent).toContain("Fixes #53");
  });

  it("produces a valid intent with an empty issue body", () => {
    const intent = buildIssuePrIntent({
      combo: { issueUrl: "https://github.com/o/r/issues/53" },
      issueTitle: "Include GitHub autoclose keywords",
      issueBody: "",
    });

    expect(intent).toContain("Implement GitHub issue https://github.com/o/r/issues/53.");
    expect(intent).toContain("Title: Include GitHub autoclose keywords");
    expect(intent).not.toContain("Issue body:");
    expect(intent).toContain("Fixes #53");
  });

  it("truncates issue body when it exceeds the max length", () => {
    const body = "x".repeat(9000);
    const intent = buildIssuePrIntent({
      combo: { issueUrl: "https://github.com/o/r/issues/53" },
      issueTitle: "Title",
      issueBody: body,
    });

    expect(intent).toContain("Issue body:");
    expect(intent).toContain("...");
    expect(intent).toContain("Fixes #53");
    expect(intent.length).toBeLessThan(body.length + 200);
  });
});

describe("parseAxiOutcome", () => {
  it("extracts the outcome line from TOON output", () => {
    const raw = "run:\n  step: ci\noutcome: checks-passed\nnext_step: stop and ask the user";
    expect(parseAxiOutcome(raw)).toBe("checks-passed");
  });

  it("returns undefined when no outcome is present (tolerant by design)", () => {
    expect(parseAxiOutcome("run:\n  step: review")).toBeUndefined();
  });
});

describe("PR body issue autoclose contract", () => {
  const combo = { issueUrl: "https://github.com/o/r/issues/53" };

  it("accepts a concrete visible GitHub autoclose keyword for the source issue", () => {
    expect(hasIssueAutocloseInPrBody("Summary\n\nFixes #53\n", combo)).toBe(true);
    expect(hasIssueAutocloseInPrBody("Summary\n\nCloses o/r#53\n", combo)).toBe(true);
  });

  it("rejects free-form mentions, generic placeholders, and hidden-only autoclose lines", () => {
    const body = [
      "## What Changed",
      "This addresses issue #53.",
      "Closes #N",
      "Fixes other/repo#53",
      "The literal code span `Fixes #53` should not count.",
      "<!-- Fixes #53 -->",
      "",
      "```text",
      "Fixes #53",
      "```",
      "",
      "<details>",
      "<summary>Evidence</summary>",
      "Resolves #53",
      "</details>",
    ].join("\n");

    expect(hasIssueAutocloseInPrBody(body, combo)).toBe(false);
  });

  it("prefixes a missing visible autoclose line derived from the source issue URL", () => {
    const body = "## What Changed\n\nThis addresses issue #53.\n\n```text\nFixes #53\n```";

    expect(ensureIssueAutocloseInPrBody(body, combo)).toBe(
      "Fixes #53\n\n## What Changed\n\nThis addresses issue #53.\n\n```text\nFixes #53\n```",
    );
  });

  it("leaves an existing visible concrete autoclose line unchanged", () => {
    const body = "## Intent\n\nResolves #53\n\n## Testing\n\npassed";

    expect(ensureIssueAutocloseInPrBody(body, combo)).toBe(body);
  });
});
