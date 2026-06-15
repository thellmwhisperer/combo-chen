/**
 * @overview Unit tests for CLI argument helpers. ~55 lines, parseEventFields coverage.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at parseEventFields tests <- coercion and validation contract.
 *
 *   MAIN FLOW
 *   ---------
 *   string fields -> parseEventFields -> typed payload or error
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   none
 *
 * @exports none
 * @deps vitest, ./args
 */
import { describe, expect, it } from "vitest";

import { parseEventFields } from "./args.js";

// -- 1/1 CORE · parseEventFields tests <- START HERE --
describe("parseEventFields", () => {
  it("coerces booleans and integers while preserving string values", () => {
    expect(
      parseEventFields([
        "state=fix_inflight",
        "exit_code=3",
        "has_new_commits=true",
        "dry_run=false",
        "url=https://github.com/o/r/pull/7?anchor=a=b",
      ]),
    ).toEqual({
      state: "fix_inflight",
      exit_code: 3,
      has_new_commits: true,
      dry_run: false,
      url: "https://github.com/o/r/pull/7?anchor=a=b",
    });
  });

  it("rejects fields without a key/value separator", () => {
    expect(() => parseEventFields(["state"])).toThrow('--field expects key=value, got "state"');
  });
});
// -/ 1/1
