import { describe, expect, it } from "vitest";

import { buildHodorInvocation, buildIssuePrIntent, parseAxiOutcome } from "./hodor.js";

describe("buildHodorInvocation", () => {
  it("uses the configured gate command", () => {
    expect(buildHodorInvocation({ hodorCommand: "no-mistakes axi run" })).toBe(
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
