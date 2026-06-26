/**
 * @overview Unit tests for GitHub check-rollup readiness helpers.
 *   ~90 lines, configured READY checks and normal CI separation.
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

import {
  checkRollupSucceeded,
  externalReviewSkippedByConfiguredAgent,
  requiredChecksSucceeded,
} from "./checks.js";

// -- 1/1 CORE · READY check helper tests <- START HERE --
function checkRun(name: string, conclusion: string): unknown {
  return { __typename: "CheckRun", name, status: "COMPLETED", conclusion };
}

function statusContext(context: string, state: string, description?: string): unknown {
  return { __typename: "StatusContext", context, state, description };
}

describe("GitHub check readiness helpers", () => {
  it("keeps configured required READY checks out of the normal CI rollup", () => {
    expect(
      checkRollupSucceeded(
        [checkRun("unit", "SUCCESS"), checkRun("ExternalReview", "FAILURE")],
        { requiredCheckNames: ["ExternalReview"] },
      ),
    ).toBe(true);
    expect(
      checkRollupSucceeded(
        [checkRun("unit", "FAILURE"), checkRun("ExternalReview", "SUCCESS")],
        { requiredCheckNames: ["ExternalReview"] },
      ),
    ).toBe(false);
    expect(
      checkRollupSucceeded(
        [checkRun("ExternalReview", "SUCCESS")],
        { requiredCheckNames: ["ExternalReview"] },
      ),
    ).toBe(true);
  });

  it("does not let external-comment checks stand in for normal CI", () => {
    expect(
      checkRollupSucceeded(
        [checkRun("ExternalReview", "SUCCESS")],
        { ambientCheckNames: ["ExternalReview"] },
      ),
    ).toBe(false);
  });

  it("requires every configured READY check to be present with SUCCESS", () => {
    const rollup = [
      checkRun("unit", "SUCCESS"),
      checkRun("ExternalReview", "SUCCESS"),
      checkRun("ReviewDog", "SUCCESS"),
    ];

    expect(requiredChecksSucceeded(rollup, ["ExternalReview", "ReviewDog"])).toBe(true);
    expect(requiredChecksSucceeded(rollup, ["ExternalReview", "Copilot"])).toBe(false);
    expect(
      requiredChecksSucceeded(
        [checkRun("unit", "SUCCESS"), checkRun("ExternalReview", "SUCCESS"), checkRun("ReviewDog", "SKIPPED")],
        ["ExternalReview", "ReviewDog"],
      ),
    ).toBe(false);
    expect(requiredChecksSucceeded([checkRun("ReviewDog Extended", "SUCCESS")], ["ReviewDog"])).toBe(false);
  });

  it("does not treat a skipped CodeRabbit check as a required READY success", () => {
    expect(requiredChecksSucceeded([checkRun("CodeRabbit", "SKIPPED")], ["CodeRabbit"])).toBe(false);
  });

  it("does not accept skipped review statuses as required READY checks", () => {
    const skippedReview = statusContext("CodeRabbit", "SUCCESS", "Review skipped");

    expect(requiredChecksSucceeded([checkRun("unit", "SUCCESS"), skippedReview], ["CodeRabbit"])).toBe(false);
    expect(checkRollupSucceeded([skippedReview], { requiredCheckNames: ["CodeRabbit"] })).toBe(false);
  });

  it("detects skipped external reviews only from configured comment agents", () => {
    expect(
      externalReviewSkippedByConfiguredAgent(
        [
          {
            author: { login: "coderabbitai[bot]" },
            body: "## Review skipped\nAuto reviews are disabled. Use @coderabbitai review.",
          },
        ],
        ["coderabbitai"],
      ),
    ).toBe(true);
    expect(
      externalReviewSkippedByConfiguredAgent(
        [
          {
            user: { login: "random-user" },
            body: "Review skipped: rate limited.",
          },
        ],
        ["coderabbitai"],
      ),
    ).toBe(false);
    expect(
      externalReviewSkippedByConfiguredAgent(
        [
          {
            author: { login: "coderabbitai[bot]" },
            body: "Review complete. No issues found.",
          },
        ],
        ["coderabbitai"],
      ),
    ).toBe(false);
  });
});
// -/ 1/1
