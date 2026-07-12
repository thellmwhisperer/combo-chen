/**
 * @overview GitHub check-rollup helpers for CI and configured READY checks.
 *   ~165 lines, 5 exports, provider-name matching without provider-specific logic.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at checkRollupSucceeded       <- CI success excluding required READY checks.
 *   2. Then requiredChecksSucceeded        <- every configured READY check succeeds.
 *   3. Read checkSignal*                   <- low-level parsing helpers.
 *
 *   MAIN FLOW
 *   ---------
 *   GitHub statusCheckRollup -> name matching -> success/failure predicate
 *
 *   PUBLIC API
 *   ----------
 *   checkNameMatchesAny       Exact match against any useful rollup label.
 *   checkSignalIsSuccess      Exact SUCCESS predicate for required READY checks.
 *   checkRollupSucceeded      True when normal CI checks pass or only required checks remain.
 *   requiredChecksSucceeded   True when every configured READY check succeeds.
 *   externalReviewSkippedByConfiguredAgent
 *                             True when a configured external reviewer says review skipped.
 *   textLooksReviewSkipped    Raw "review skipped" marker predicate for review bodies.
 *   configuredAgents          Normalized configured external-agent logins.
 *   authorMatchesConfiguredAgent  Login-vs-agents match accepting the [bot] suffix.
 *
 *   INTERNALS
 *   ---------
 *   upperString, checkSignalSucceeded, checkSignalIsReviewSkipped, checkLabels, comment helpers
 *
 * @exports checkNameMatchesAny, checkSignalIsSuccess, checkRollupSucceeded, requiredChecksSucceeded, externalReviewSkippedByConfiguredAgent, textLooksReviewSkipped, configuredAgents, authorMatchesConfiguredAgent
 * @deps ../../core/guards
 */
import { isRecord } from "../../core/guards.js";

// -- 1/2 HELPER · Scalar readers and status predicates --
const SUCCESSFUL_CHECK_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const SUCCESSFUL_STATUS_STATES = new Set(["SUCCESS", "COMPLETED"]);
const EXTERNAL_REVIEW_SKIPPED_PATTERN =
  /\b(review\s+limit\s+reached|review\s+skipped|couldn'?t start this review|rate[-\s]?limit(?:ed)?)\b/i;

function upperString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim().toUpperCase() : undefined;
}

function lowerString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim().toLowerCase() : undefined;
}

/** True when text carries a provider's "review skipped / rate limited" marker. */
export function textLooksReviewSkipped(text: string): boolean {
  return EXTERNAL_REVIEW_SKIPPED_PATTERN.test(text);
}

function checkSignalIsReviewSkipped(item: Record<string, unknown>): boolean {
  return [item["description"], item["summary"], item["title"], item["text"]].some((value) =>
    textLooksReviewSkipped(lowerString(value) ?? ""),
  );
}

function checkLabels(item: unknown): string[] {
  if (!isRecord(item)) return [];
  const parts = [item["name"], item["context"], item["workflowName"]];
  const app = item["app"];
  if (isRecord(app)) parts.push(app["name"], app["slug"]);
  return parts.filter((part): part is string => typeof part === "string");
}

/** Normalizes configured external-agent logins: trimmed, lowercased, non-empty. */
export function configuredAgents(agents: string[]): string[] {
  return agents.map((agent) => agent.trim().toLowerCase()).filter((agent) => agent.length > 0);
}

function commentAuthorLogin(comment: Record<string, unknown>): string | undefined {
  for (const key of ["author", "user"]) {
    const author = comment[key];
    if (!isRecord(author)) continue;
    const login = author["login"];
    if (typeof login === "string" && login.trim() !== "") return login.trim().toLowerCase();
  }
  return undefined;
}

function commentBody(comment: Record<string, unknown>): string | undefined {
  const body = comment["body"];
  return typeof body === "string" && body.trim() !== "" ? body : undefined;
}

/** Matches a lowercased login against normalized agents, accepting the [bot] suffix. */
export function authorMatchesConfiguredAgent(login: string, agents: string[]): boolean {
  return agents.some((agent) => login === agent || login === `${agent}[bot]`);
}

function checkSignalSucceeded(item: unknown): boolean {
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

export function requiredChecksSucceeded(
  rollup: unknown[] | undefined,
  requiredCheckNames: string[],
): boolean {
  const required = requiredCheckNames.map((name) => name.trim()).filter((name) => name.length > 0);
  if (required.length === 0) return true;
  if (rollup === undefined) return false;
  return required.every((name) =>
    rollup.some((item) => checkNameMatchesAny(item, [name]) && checkSignalIsSuccess(item)),
  );
}

export function externalReviewSkippedByConfiguredAgent(
  comments: unknown[] | undefined,
  externalCommentAgents: string[],
): boolean {
  const agents = configuredAgents(externalCommentAgents);
  if (comments === undefined || comments.length === 0 || agents.length === 0) return false;
  return comments.some((comment) => {
    if (!isRecord(comment)) return false;
    const login = commentAuthorLogin(comment);
    const body = commentBody(comment);
    return (
      login !== undefined &&
      body !== undefined &&
      authorMatchesConfiguredAgent(login, agents) &&
      EXTERNAL_REVIEW_SKIPPED_PATTERN.test(body)
    );
  });
}
// -/ 2/2
