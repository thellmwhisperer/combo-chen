/**
 * @overview Shared narrowing guards. Canonical home for the small unknown →
 *   typed helpers that were previously copy-pasted per module; the
 *   no-duplicate-helpers slop rule pins redefinitions elsewhere to red.
 *
 * @exports errorMessage, isRecord, isErrnoException
 * @deps none
 */

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
