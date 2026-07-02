/**
 * @overview Shared narrowing guards and error formatting helpers.
 *   Canonical home for small unknown-to-typed helpers that were previously
 *   copy-pasted per module; no-duplicate-helpers pins redefinitions to red.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at errorMessage       <- shared unknown-error formatting.
 *   2. Then isRecord               <- JSON/object narrowing.
 *   3. Then isErrnoException       <- filesystem errno narrowing.
 *
 *   MAIN FLOW
 *   ---------
 *   callers catch unknown -> errorMessage/isRecord/isErrnoException -> typed branch
 *
 *   PUBLIC API
 *   ----------
 *   errorMessage       Convert unknown errors into display-safe strings.
 *   isRecord           Narrow unknown values to object records.
 *   isErrnoException   Narrow unknown errors to NodeJS errno errors.
 *
 *   INTERNALS
 *   ---------
 *   none
 *
 * @exports errorMessage, isRecord, isErrnoException
 * @deps none
 */

// -- 1/1 CORE · Shared guards ← START HERE --
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
// -/ 1/1
