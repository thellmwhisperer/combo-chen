/**
 * @overview GitHub check-rollup helpers for CI and configured READY checks.
 *   ~120 lines, 6 exports, provider-name matching without provider-specific logic.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at checkRollupSucceeded       <- CI success excluding required READY checks.
 *   2. Then requiredChecksSucceeded        <- every configured READY check succeeds.
 *   3. Read checkName/checkSignal*         <- low-level parsing helpers.
 *
 *   MAIN FLOW
 *   ---------
 *   GitHub statusCheckRollup -> name matching -> success/failure predicate
 *
 *   PUBLIC API
 *   ----------
 *   checkName                 Concatenate useful rollup labels.
 *   checkNameMatchesAny       Exact match against any useful rollup label.
 *   checkSignalSucceeded      Broad success predicate for CI rollup.
 *   checkSignalIsSuccess      Exact SUCCESS predicate for required READY checks.
 *   checkRollupSucceeded      True when normal CI checks pass or only required checks remain.
 *   requiredChecksSucceeded   True when every configured READY check succeeds.
 *
 *   INTERNALS
 *   ---------
 *   isRecord, upperString, checkSignalIsReviewSkipped, checkLabels
 *
 * @exports checkName, checkNameMatchesAny, checkSignalSucceeded, checkSignalIsSuccess, checkRollupSucceeded, requiredChecksSucceeded
 * @deps none
 */

// -- 1/2 HELPER · Scalar readers and status predicates --
const SUCCESSFUL_CHECK_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const SUCCESSFUL_STATUS_STATES = new Set(["SUCCESS", "COMPLETED"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function upperString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim().toUpperCase() : undefined;
}

function lowerString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim().toLowerCase() : undefined;
}

function checkSignalIsReviewSkipped(item: Record<string, unknown>): boolean {
  return [item["description"], item["summary"], item["title"], item["text"]].some((value) =>
    lowerString(value)?.includes("review skipped"),
  );
}

function checkLabels(item: unknown): string[] {
  if (!isRecord(item)) return [];
  const parts = [item["name"], item["context"], item["workflowName"]];
  const app = item["app"];
  if (isRecord(app)) parts.push(app["name"], app["slug"]);
  return parts.filter((part): part is string => typeof part === "string");
}

export function checkName(item: unknown): string {
  return checkLabels(item).join(" ");
}

export function checkSignalSucceeded(item: unknown): boolean {
  if (!isRecord(item)) return false;
  if (checkSignalIsReviewSkipped(item)) return false;
  const conclusion = upperString(item["conclusion"]);
  if (conclusion !== undefined) return SUCCESSFUL_CHECK_CONCLUSIONS.has(conclusion);
  const state = upperString(item["state"] ?? item["status"]);
  if (state !== undefined) return SUCCESSFUL_STATUS_STATES.has(state);
  return false;
}

export function checkSignalIsSuccess(item: unknown): boolean {
  if (!isRecord(item)) return false;
  if (checkSignalIsReviewSkipped(item)) return false;
  const conclusion = upperString(item["conclusion"]);
  if (conclusion !== undefined) return conclusion === "SUCCESS";
  const state = upperString(item["state"] ?? item["status"]);
  if (state !== undefined) return state === "SUCCESS";
  return false;
}
// -/ 1/2

// -- 2/2 CORE · checkRollupSucceeded + requiredChecksSucceeded <- START HERE --
export function checkNameMatchesAny(item: unknown, names: string[]): boolean {
  const labels = checkLabels(item).map((label) => label.trim().toLowerCase());
  return names.some((name) => {
    const needle = name.trim().toLowerCase();
    return needle.length > 0 && labels.includes(needle);
  });
}

export function checkRollupSucceeded(
  rollup: unknown[] | undefined,
  options: { requiredCheckNames?: string[]; ambientCheckNames?: string[] } = {},
): boolean {
  if (rollup === undefined || rollup.length === 0) return false;
  const requiredCheckNames = options.requiredCheckNames ?? [];
  const ignoredCheckNames = requiredCheckNames.concat(options.ambientCheckNames ?? []);
  const checks = rollup.filter((item) => !checkNameMatchesAny(item, ignoredCheckNames));
  if (checks.length > 0) return checks.every(checkSignalSucceeded);
  return requiredCheckNames.length > 0 && requiredChecksSucceeded(rollup, requiredCheckNames);
}

export function requiredChecksSucceeded(rollup: unknown[] | undefined, requiredCheckNames: string[]): boolean {
  const required = requiredCheckNames.map((name) => name.trim()).filter((name) => name.length > 0);
  if (required.length === 0) return true;
  if (rollup === undefined) return false;
  return required.every((name) =>
    rollup.some((item) => checkNameMatchesAny(item, [name]) && checkSignalIsSuccess(item)),
  );
}
// -/ 2/2
