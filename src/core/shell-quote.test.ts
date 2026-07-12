/**
 * @overview Unit tests for POSIX shell quoting. ~30 lines, pinning the
 *   single-quoting contract command builders rely on.
 *
 *   READING GUIDE
 *   -------------
 *   1. describe("shellQuote") is the whole file.
 *
 * @exports none (test file)
 * @deps vitest, ./shell-quote
 */
import { describe, expect, it } from "vitest";

import { shellQuote } from "./shell-quote.js";

// -- 1/1 CORE · shellQuote contract <- START HERE --
describe("shellQuote", () => {
  it("wraps values in single quotes", () => {
    expect(shellQuote("combo/issue-7")).toBe("'combo/issue-7'");
    expect(shellQuote("/repos/r/.worktrees/issue 7")).toBe("'/repos/r/.worktrees/issue 7'");
  });

  it("keeps shell metacharacters inert", () => {
    expect(shellQuote("$(rm -rf /); `boom`; $HOME")).toBe("'$(rm -rf /); `boom`; $HOME'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("quotes the empty string", () => {
    expect(shellQuote("")).toBe("''");
  });
});
// -/ 1/1
