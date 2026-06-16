/**
 * @overview Unit tests for the gatekeeper role. ~155 lines, testing
 *   gatekeeper invocation building, issue→PR intent generation (with
 *   autoclose keywords, truncation, and push-safe base64 encoding), axi
 *   TOON outcome parsing, and the PR body issue autoclose contract.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at describe("PR body issue autoclose contract")   ← autoclose detection
 *   2. Then describe("buildGatekeeperInvocation")               ← intent + invocation
 *
 *   ┌─ TEST AREAS ────────────────────────────────────────┐
 *   │ buildGatekeeperInvocation     Invocation + intent    │
 *   │ buildNoMistakesPushIntent    Base64 push-option intent │
 *   │ parseAxiOutcome              TOON outcome extraction │
 *   │ PR body issue autoclose contract  Keyword detection  │
 *   └──────────────────────────────────────────────────────┘
 *
 * @exports none (test file)
 * @deps vitest, ./gatekeeper
 */
import { describe, expect, it } from "vitest";

import {
  buildGatekeeperInvocation,
  buildIssuePrIntent,
  buildNoMistakesPushIntent,
  ensureIssueAutocloseInPrBody,
  hasIssueAutocloseInPrBody,
  parseAxiOutcome,
} from "./gatekeeper.js";

// -- 1/2 CORE · Gatekeeper invocation + parseAxiOutcome ← START HERE --
describe("buildGatekeeperInvocation", () => {
  it("forces no-mistakes publish-only mode", () => {
    expect(buildGatekeeperInvocation({ gatekeeperCommand: "no-mistakes axi run" })).toBe(
      "no-mistakes axi run --skip=ci",
    );
  });

  it("adds ci to existing no-mistakes skip flags", () => {
    expect(buildGatekeeperInvocation({ gatekeeperCommand: "no-mistakes axi run --skip=lint" })).toBe(
      "no-mistakes axi run --skip=lint,ci",
    );
    expect(buildGatekeeperInvocation({ gatekeeperCommand: "no-mistakes axi run --skip test,ci" })).toBe(
      "no-mistakes axi run --skip test,ci",
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

  it("base64-encodes multiline intent for git push options", () => {
    const intent = "Implement issue\n\nTitle: Fix\tbug\nFixes #53";
    expect(Buffer.from(buildNoMistakesPushIntent(intent), "base64").toString("utf8")).toBe(intent);
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

// -/ 1/2

// -- 2/2 HELPER · PR body issue autoclose contract --
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
// -/ 2/2
