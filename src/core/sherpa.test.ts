import { describe, expect, it } from "vitest";
import { auditSherpa, buildSherpaPrompt } from "./sherpa.js";

describe("buildSherpaPrompt", () => {
  it("includes the file path in the prompt", () => {
    const prompt = buildSherpaPrompt("const x = 1;", "src/foo.ts");
    expect(prompt).toContain("src/foo.ts");
  });

  it("includes the Sherpa spec", () => {
    const prompt = buildSherpaPrompt("code", "file.ts");
    expect(prompt).toContain("Sherpa");
    expect(prompt).toContain("READING GUIDE");
    expect(prompt).toContain("Layer 1");
    expect(prompt).toContain("Layer 2");
  });

  it("includes the file content", () => {
    const prompt = buildSherpaPrompt("export function hello() {}", "lib.ts");
    expect(prompt).toContain("export function hello() {}");
  });

  it("asks for the complete annotated file", () => {
    const prompt = buildSherpaPrompt("code", "file.ts");
    expect(prompt).toContain("Return ONLY the annotated file content");
  });
});

describe("auditSherpa", () => {
  it("reports missing header", () => {
    const result = auditSherpa("export const x = 1;");
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.kind === "missing_header")).toBe(true);
  });

  it("passes a valid file with header and markers", () => {
    const valid = `/**
 * @overview Test file.
 *
 *   READING GUIDE
 *   1. Start at mainFunc ← CORE
 *
 * @exports mainFunc, helperFunc
 */
// -- 1/2 CORE · Main logic ← START HERE --
export function mainFunc() {}
// -/ 1/2
// -- 2/2 HELPER · Helpers --
export function helperFunc() {}
// -/ 2/2`;
    const result = auditSherpa(valid);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("detects missing exports", () => {
    const code = `/**
 * @overview Test.
 * @exports mainFunc
 */
// -- 1/2 CORE · Main ← START HERE --
export function mainFunc() {}
export function missing() {}
// -/ 1/2
// -- 2/2 HELPER · Helpers --
// -/ 2/2`;
    const result = auditSherpa(code);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.kind === "broken_exports")).toBe(true);
  });

  it("detects misnumbered markers", () => {
    const code = `/**
 * @overview Test.
 * @exports mainFunc
 */
// -- 1/2 CORE · Main ← START HERE --
export function mainFunc() {}
// -/ 1/2
// -- 1/2 HELPER · Helpers --
// -/ 1/2`;
    const result = auditSherpa(code);
    expect(result.issues.some((i) => i.kind === "misnumbered")).toBe(true);
  });

  it("detects missing CORE marker", () => {
    const code = `/**
 * @overview Test.
 * @exports mainFunc
 */
// -- 1/1 HELPER · Helpers --
export function mainFunc() {}
// -/ 1/1`;
    const result = auditSherpa(code);
    expect(result.issues.some((i) => i.kind === "missing_core_marker")).toBe(true);
  });

  it("detects missing START HERE", () => {
    const code = `/**
 * @overview Test.
 * @exports mainFunc
 */
// -- 1/1 CORE · Main --
export function mainFunc() {}
// -/ 1/1`;
    const result = auditSherpa(code);
    expect(result.issues.some((i) => i.kind === "missing_start_here")).toBe(true);
  });
});
