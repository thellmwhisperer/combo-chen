/**
 * @overview Unit tests for operator-facing display sanitization and boolean formatting.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at sanitizeToken tests  <- hostile terminal input contract.
 *   2. Read yesNo tests              <- compact boolean rendering.
 *
 *   MAIN FLOW
 *   ---------
 *   hostile or ordinary input -> display helper -> safe operator text
 *
 *   PUBLIC API
 *   ----------
 *   None (test file).
 *
 *   INTERNALS
 *   ---------
 *   sanitizeToken and yesNo fixtures.
 *
 * @exports none
 * @deps ./display, vitest
 */
import { describe, expect, it } from "vitest";

import { sanitizeToken, yesNo } from "./display.js";

//    Hostile inputs are written as \u escapes on purpose: raw Cc/Cf bytes in
//    the source would make this file binary-ish for git diff and review tools.
// -- 1/2 CORE · sanitizeToken contract <- START HERE --
describe("sanitizeToken", () => {
  it("collapses control characters into single spaces", () => {
    expect(sanitizeToken("abc\u0007def")).toBe("abc def");
  });

  it("strips bidirectional override and isolate marks", () => {
    expect(sanitizeToken("a\u202egnihsihp\u202cb")).toBe("a gnihsihp b");
    expect(sanitizeToken("x\u2066hidden\u2069y")).toBe("x hidden y");
  });

  it("strips invisible format characters like zero-width space and word joiner", () => {
    expect(sanitizeToken("com\u200bbo")).toBe("com bo");
    expect(sanitizeToken("wo\u2060rd")).toBe("wo rd");
  });

  it("falls back to unknown when nothing printable remains", () => {
    expect(sanitizeToken("\u0000 \u200e\u202a")).toBe("unknown");
    expect(sanitizeToken("   ")).toBe("unknown");
  });

  it("passes ordinary tokens through trimmed", () => {
    expect(sanitizeToken("  combo/issue-7  ")).toBe("combo/issue-7");
  });
});
// -/ 1/2

// -- 2/2 HELPER · yesNo contract --
describe("yesNo", () => {
  it("formats booleans for operator-facing lines", () => {
    expect(yesNo(true)).toBe("yes");
    expect(yesNo(false)).toBe("no");
  });
});
// -/ 2/2
