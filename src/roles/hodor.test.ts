import { describe, expect, it } from "vitest";

import { buildHodorInvocation, parseAxiOutcome } from "./hodor.js";

describe("buildHodorInvocation", () => {
  it("uses the configured gate command", () => {
    expect(buildHodorInvocation({ hodorCommand: "no-mistakes axi run" })).toBe(
      "no-mistakes axi run",
    );
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
