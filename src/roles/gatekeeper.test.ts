/**
 * @overview Unit tests for the gatekeeper role. ~240 lines, testing
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
 * @deps node:child_process, vitest, ./gatekeeper
 */
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  buildGatekeeperInvocation,
  buildIssuePrIntent,
  buildNoMistakesPushIntent,
  buildWorkPlanPrIntent,
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

  it("does not match --skip inside single-quoted arguments", () => {
    expect(
      buildGatekeeperInvocation({
        gatekeeperCommand: "no-mistakes axi run --intent 'use --skip=lint to skip'",
      }),
    ).toBe("no-mistakes axi run --intent 'use --skip=lint to skip' --skip=ci");
  });

  it("does not match --skip inside double-quoted arguments", () => {
    expect(
      buildGatekeeperInvocation({
        gatekeeperCommand: 'no-mistakes axi run --intent "use --skip=lint to skip"',
      }),
    ).toBe('no-mistakes axi run --intent "use --skip=lint to skip" --skip=ci');
  });

  it("does not let escaped quotes expose --skip text inside quoted arguments", () => {
    expect(
      buildGatekeeperInvocation({
        gatekeeperCommand: 'no-mistakes axi run --intent "literal \\" --skip=lint stays data"',
      }),
    ).toBe('no-mistakes axi run --intent "literal \\" --skip=lint stays data" --skip=ci');
  });

  it("modifies real --skip outside quotes while ignoring --skip inside quotes", () => {
    expect(
      buildGatekeeperInvocation({
        gatekeeperCommand: "no-mistakes axi run --skip=lint --intent 'use --skip=test'",
      }),
    ).toBe("no-mistakes axi run --skip=lint,ci --intent 'use --skip=test'");
  });

  it("handles --skip with quoted value outside of intent quotes", () => {
    expect(
      buildGatekeeperInvocation({
        gatekeeperCommand: "no-mistakes axi run --skip='lint,test' --intent 'some value'",
      }),
    ).toBe("no-mistakes axi run --skip='lint,test,ci' --intent 'some value'");
  });

  it("scopes publish-only skip rewrites to the no-mistakes command segment", () => {
    expect(
      buildGatekeeperInvocation({
        gatekeeperCommand: "preflight --skip=lint && no-mistakes axi run --intent ok",
      }),
    ).toBe("preflight --skip=lint && no-mistakes axi run --intent ok --skip=ci");

    expect(
      buildGatekeeperInvocation({
        gatekeeperCommand: "preflight --skip=lint && no-mistakes axi run --skip=test",
      }),
    ).toBe("preflight --skip=lint && no-mistakes axi run --skip=test,ci");
  });

  it("does not treat quoted no-mistakes text as a runnable gate command", () => {
    expect(buildGatekeeperInvocation({ gatekeeperCommand: "echo 'no-mistakes axi run --skip=lint'" })).toBe(
      "echo 'no-mistakes axi run --skip=lint'",
    );
  });

  it("expands double-quoted issue PR intent without executing markdown backticks", () => {
    const command = buildGatekeeperInvocation({
      gatekeeperCommand: 'printf "%s" "{issue_pr_intent}"',
      combo: {
        branch: "combo/issue-7",
        issueUrl: "https://github.com/o/r/issues/7",
      },
      workPlan: {
        title: "Gatekeeper quoting",
        source: { type: "local_file", reference: "plans/gatekeeper-quoting.md" },
        problem: "The plan mentions `status --deep` and `pr_labels_updated` as literal markdown.",
        scope: "",
        acceptanceCriteria: "- Keep markdown literals inert.",
        validation: "",
        outOfScope: "",
        intentDecisions: "",
        rawMarkdown: "# Gatekeeper quoting\n\nThe plan mentions `status --deep` as literal markdown.",
      },
    });

    expect(command).toContain('printf "%s" "$(');
    expect(command).not.toContain('""$(');

    const result = spawnSync("sh", ["-c", command], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("`status --deep`");
    expect(result.stdout).toContain("`pr_labels_updated`");
  });

  it("builds an issue-derived PR intent with an autoclose keyword", () => {
    const intent = buildIssuePrIntent({
      combo: { issueUrl: "https://github.com/o/r/issues/53" },
      issueTitle: "Include GitHub autoclose keywords",
      issueBody: "This mentions issue #53 but not as a close directive.",
    });

    expect(intent).toContain("Implement GitHub issue https://github.com/o/r/issues/53.");
    expect(intent).toContain("Title: Include GitHub autoclose keywords");
    expect(intent).toContain("Pull request body requirement:");
    expect(intent).toContain("visible line verbatim in the PR body");
    expect(intent).toContain("This mentions issue #53 but not as a close directive.");
    expect(intent).toMatch(/\nFixes #53\n/);
  });

  it("forbids autoclose keywords in plan-backed PR intent even when the plan asks", () => {
    const intent = buildWorkPlanPrIntent({
      title: "Plan-driven work",
      source: { type: "local_file", reference: "plans/work.md" },
      problem: "The plan mentions Fixes #53 as a desired PR body line.",
      scope: "",
      acceptanceCriteria: "- Complete the work.",
      validation: "",
      outOfScope: "",
      intentDecisions: "",
      rawMarkdown: "# Plan-driven work\n\n## Acceptance Criteria\n- Complete the work.",
    });

    expect(intent).toContain("never include GitHub autoclose keywords");
    expect(intent).toContain("If the plan asks to close an issue, call that out for a human instead.");
    expect(intent).not.toContain("unless the plan explicitly asks");
  });

  it("keeps the required autoclose line before issue body truncation can drop it", () => {
    const intent = buildIssuePrIntent({
      combo: { issueUrl: "https://github.com/o/r/issues/53" },
      issueTitle: "Include GitHub autoclose keywords",
      issueBody: "x".repeat(9000),
    });

    const decoded = Buffer.from(buildNoMistakesPushIntent(intent), "base64").toString("utf8");

    expect(decoded).toContain("Pull request body requirement:");
    expect(decoded).toContain("Fixes #53");
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

  it("truncates intent before base64 encoding when it exceeds the push limit", () => {
    const longIntent = "x".repeat(5000);
    const encoded = buildNoMistakesPushIntent(longIntent);
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    expect(decoded.length).toBe(4000);
    expect(decoded.endsWith("x...")).toBe(true);
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
