/**
 * @overview GitHub check-rollup helpers for CI and configured ambient reviewers.
 *   ~90 lines, 5 exports, provider-name matching without provider-specific logic.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at checkRollupSucceeded       <- CI success excluding ambient review checks.
 *   2. Then ambientCheckSucceeded          <- configured ambient reviewer gate.
 *   3. Read checkName/checkSignal*         <- low-level parsing helpers.
 *
 *   MAIN FLOW
 *   ---------
 *   GitHub statusCheckRollup -> name matching -> success/failure predicate
 *
 *   PUBLIC API
 *   ----------
 *   checkName                 Concatenate useful rollup labels.
 *   checkSignalSucceeded      Broad success predicate for CI rollup.
 *   checkSignalIsSuccess      Exact SUCCESS predicate for ambient reviewer gates.
 *   checkRollupSucceeded      True when non-ambient CI checks all pass.
 *   ambientCheckSucceeded     True when configured ambient reviewer check passes.
 *
 *   INTERNALS
 *   ---------
 *   isRecord, upperString, checkMatchesAny
 *
 * @exports checkName, checkSignalSucceeded, checkSignalIsSuccess, checkRollupSucceeded, ambientCheckSucceeded
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

export function checkName(item: unknown): string {
  if (!isRecord(item)) return "";
  const parts = [item["name"], item["context"], item["workflowName"]];
  const app = item["app"];
  if (isRecord(app)) parts.push(app["name"], app["slug"]);
  return parts.filter((part): part is string => typeof part === "string").join(" ");
}

export function checkSignalSucceeded(item: unknown): boolean {
  if (!isRecord(item)) return false;
  const conclusion = upperString(item["conclusion"]);
  if (conclusion !== undefined) return SUCCESSFUL_CHECK_CONCLUSIONS.has(conclusion);
  const state = upperString(item["state"] ?? item["status"]);
  if (state !== undefined) return SUCCESSFUL_STATUS_STATES.has(state);
  return false;
}

export function checkSignalIsSuccess(item: unknown): boolean {
  if (!isRecord(item)) return false;
  const conclusion = upperString(item["conclusion"]);
  if (conclusion !== undefined) return conclusion === "SUCCESS";
  const state = upperString(item["state"] ?? item["status"]);
  if (state !== undefined) return state === "SUCCESS";
  return false;
}
// -/ 1/2

// -- 2/2 CORE · checkRollupSucceeded + ambientCheckSucceeded <- START HERE --
function checkMatchesAny(item: unknown, names: string[]): boolean {
  const label = checkName(item).toLowerCase();
  return names.some((name) => {
    const needle = name.trim().toLowerCase();
    return needle.length > 0 && label.includes(needle);
  });
}

export function checkRollupSucceeded(
  rollup: unknown[] | undefined,
  options: { ambientCheckNames?: string[] } = {},
): boolean {
  if (rollup === undefined) return false;
  const ambientCheckNames = options.ambientCheckNames ?? [];
  const checks = rollup.filter((item) => !checkMatchesAny(item, ambientCheckNames));
  return checks.length > 0 && checks.every(checkSignalSucceeded);
}

export function ambientCheckSucceeded(rollup: unknown[] | undefined, ambientCheckNames: string[]): boolean {
  if (ambientCheckNames.length === 0) return true;
  return rollup !== undefined && rollup.some((item) => checkMatchesAny(item, ambientCheckNames) && checkSignalIsSuccess(item));
}
// -/ 2/2
