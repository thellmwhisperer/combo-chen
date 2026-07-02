/**
 * @overview Unit tests for shared narrowing guards: errorMessage, isRecord,
 *   isErrnoException. Single canonical home for helpers that were previously
 *   duplicated across core/, cli/, and roles/.
 *
 * @exports none (test file)
 * @deps vitest, ./guards
 */
import { describe, expect, it } from "vitest";

import { errorMessage, isErrnoException, isRecord } from "./guards.js";

describe("errorMessage", () => {
  it("returns the message of an Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-Error values", () => {
    expect(errorMessage("raw")).toBe("raw");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});

describe("isRecord", () => {
  it("accepts plain objects and arrays", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(true);
  });

  it("rejects null and primitives", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord("s")).toBe(false);
    expect(isRecord(7)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

describe("isErrnoException", () => {
  it("accepts errors carrying a code", () => {
    const error = new Error("gone") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    expect(isErrnoException(error)).toBe(true);
  });

  it("rejects plain errors and non-errors", () => {
    expect(isErrnoException(new Error("plain"))).toBe(false);
    expect(isErrnoException({ code: "ENOENT" })).toBe(false);
  });
});
