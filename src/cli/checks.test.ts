/**
 * @overview Unit tests for GitHub check-rollup readiness helpers.
 *   ~70 lines, configured READY checks and normal CI separation.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at requiredChecksSucceeded tests <- every configured check must pass.
 *   2. Then checkRollupSucceeded tests        <- required checks are not normal CI.
 *
 *   MAIN FLOW
 *   ---------
 *   GitHub statusCheckRollup fixture -> check helpers -> boolean readiness signal
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   checkRun
 *
 * @exports none
 * @deps vitest, ./checks
 */
import { describe, expect, it } from "vitest";

import { checkRollupSucceeded, requiredChecksSucceeded } from "./checks.js";

// -- 1/1 CORE · READY check helper tests <- START HERE --
function checkRun(name: string, conclusion: string): unknown {
  return { __typename: "CheckRun", name, status: "COMPLETED", conclusion };
}

describe("GitHub check readiness helpers", () => {
  it("keeps configured required READY checks out of the normal CI rollup", () => {
    expect(
      checkRollupSucceeded(
        [checkRun("unit", "SUCCESS"), checkRun("CodeRabbit", "FAILURE")],
        { requiredCheckNames: ["CodeRabbit"] },
      ),
    ).toBe(true);
    expect(
      checkRollupSucceeded(
        [checkRun("unit", "FAILURE"), checkRun("CodeRabbit", "SUCCESS")],
        { requiredCheckNames: ["CodeRabbit"] },
      ),
    ).toBe(false);
  });

  it("requires every configured READY check to be present with SUCCESS", () => {
    const rollup = [
      checkRun("unit", "SUCCESS"),
      checkRun("CodeRabbit", "SUCCESS"),
      checkRun("ReviewDog", "SUCCESS"),
    ];

    expect(requiredChecksSucceeded(rollup, ["CodeRabbit", "ReviewDog"])).toBe(true);
    expect(requiredChecksSucceeded(rollup, ["CodeRabbit", "Copilot"])).toBe(false);
    expect(
      requiredChecksSucceeded(
        [checkRun("unit", "SUCCESS"), checkRun("CodeRabbit", "SUCCESS"), checkRun("ReviewDog", "SKIPPED")],
        ["CodeRabbit", "ReviewDog"],
      ),
    ).toBe(false);
  });
});
// -/ 1/1
