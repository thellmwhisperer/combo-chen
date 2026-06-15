/**
 * @overview Shared GitHub CLI API reader. Owns paginated `gh api` parsing,
 *   short-lived endpoint caches, and failure classification for callers that
 *   poll the same PR from multiple orchestration phases. ~125 lines, 8 exports.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at readGhArray       <- cached paginated endpoint reader.
 *   2. Then classifyGhFailure     <- maps gh stderr to stable failure kinds.
 *
 *   MAIN FLOW
 *   ---------
 *   gh api --paginate -> classify nonzero status -> parse JSON pages -> cache
 *
 *   PUBLIC API
 *   ----------
 *   GhApiCache, GhCommandResult, GhCommandRunner, GhFailureKind,
 *   GhFailureClassification, createGhApiCache, classifyGhFailure, readGhArray
 *
 *   INTERNALS
 *   ---------
 *   formatGhFailure
 *
 * @exports GhApiCache, GhCommandResult, GhCommandRunner, GhFailureKind, GhFailureClassification, createGhApiCache, classifyGhFailure, readGhArray
 * @deps none
 */

// -- 1/2 HELPER · Types + failure classification --
export interface GhCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type GhCommandRunner = (args: string[]) => GhCommandResult;
export type GhApiCache = Map<string, unknown[]>;

export type GhFailureKind = "rate_limit" | "network" | "auth" | "not_found" | "unknown";

export interface GhFailureClassification {
  kind: GhFailureKind;
  transient: boolean;
  status: number;
  detail: string;
}

export function createGhApiCache(): GhApiCache {
  return new Map();
}

export function classifyGhFailure(result: GhCommandResult): GhFailureClassification {
  const detail = result.stderr.trim() || "unknown error";
  const text = detail.toLowerCase();
  if (/\brate[-\s]?limit(?:ed)?\b|secondary rate limit|api rate limit/.test(text)) {
    return { kind: "rate_limit", transient: true, status: result.status, detail };
  }
  if (
    /timed?\s*out|timeout|could not resolve host|failed to connect|connection reset|network/.test(
      text,
    )
  ) {
    return { kind: "network", transient: true, status: result.status, detail };
  }
  if (/bad credentials|requires authentication|not authenticated|unauthorized|oauth|token/.test(text)) {
    return { kind: "auth", transient: false, status: result.status, detail };
  }
  if (result.status === 404 || /\bnot found\b/.test(text)) {
    return { kind: "not_found", transient: false, status: result.status, detail };
  }
  return {
    kind: "unknown",
    transient: result.status >= 500,
    status: result.status,
    detail,
  };
}

function formatGhFailure(prefix: string, result: GhCommandResult): string {
  const failure = classifyGhFailure(result);
  const lifetime = failure.transient ? "transient" : "permanent";
  return `${prefix} (${failure.kind} ${lifetime}, status ${failure.status}): ${failure.detail}`;
}
// -/ 1/2

// -- 2/2 CORE · readGhArray <- START HERE --
export function readGhArray(
  gh: GhCommandRunner,
  endpoint: string,
  cache?: GhApiCache,
): unknown[] {
  const cached = cache?.get(endpoint);
  if (cached !== undefined) return cached;

  const result = gh(["api", "--paginate", endpoint]);
  if (result.status !== 0) {
    throw new Error(formatGhFailure(`gh api failed for ${endpoint}`, result));
  }
  const chunks = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (chunks.length === 0) {
    const empty: unknown[] = [];
    cache?.set(endpoint, empty);
    return empty;
  }

  const values: unknown[] = [];
  for (const chunk of chunks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(chunk);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`gh api returned invalid JSON for ${endpoint}: ${message}`);
    }
    if (Array.isArray(parsed)) {
      values.push(...parsed);
    } else if (parsed !== null && typeof parsed === "object") {
      values.push(parsed);
    } else {
      throw new Error(`gh api returned non-array JSON for ${endpoint}`);
    }
  }
  cache?.set(endpoint, values);
  return values;
}
// -/ 2/2
