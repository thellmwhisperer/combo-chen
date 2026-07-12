/**
 * @overview Event journal: append-only JSONL spine per combo run.
 *   ~350 lines, 14 exports, 1 canonical schema, per-run append locking.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at EVENT_TYPES              ← defines every possible event shape
 *   2. appendEvent / appendEvents         ← write validated event(s) to journal
 *   3. readEvents                         ← reads + normalizes the full journal
 *   4. followEvents                       ← async iterator for tailing
 *   5. canonicalEventName                 ← legacy alias resolution
 *
 *   MAIN FLOW
 *   ─────────
 *   runner.sh → emit command → appendEvent() → journal lock → journal.jsonl
 *   reader → readEvents()/followEvents() → deriveStatus() in combo.ts
 *
 *   ┌─ PUBLIC API ─────────────────────────────────────────────────────┐
 *   │ EVENT_TYPES         Canonical event catalogue (the schema)        │
 *   │ appendEvent         Write a validated event to the journal        │
 *   │ appendEvents        Write validated events under a single lock    │
 *   │ readEvents          Read all events from the journal              │
 *   │ followEvents        Async generator: yield + poll for new events  │
 *   │ canonicalEventName  Resolve legacy aliases → canonical names      │
 *   │ journalPath         Resolve journal.jsonl path for a runDir       │
 *   │ ComboEvent          Single journal entry shape                    │
 *   │ ComboEventError     Thrown on schema/validation violations        │
 *   │ latestPrUrlFromEvents  Find latest pr_opened URL in an event array │
 *   │ sleep               Abortable setTimeout wrapper                  │
 *   ├─ INTERNALS ──────────────────────────────────────────────────────┤
 *   │ withJournalAppendLock  Serializes writers per run directory       │
 *   │ existingPrOpenedEvent  Suppresses duplicate PR-open records       │
 *   │ normalizeEvent         Canonicalize event names on read           │
 *   │ EVENT_TYPES / CanonicalEventName / legacy alias normalization     │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * @exports ComboEventError, EVENT_TYPES, CanonicalEventName, EventName, ComboEvent, journalPath, appendEvent, appendEvents, readEvents, canonicalEventName, followEvents, latestPrUrlFromEvents, sleep
 * @deps node:fs, node:path, ./guards
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { isErrnoException } from "./guards.js";

// -- 1/4 CORE · Event catalogue + types ← START HERE --
export class ComboEventError extends Error {}

export const EVENT_TYPES = {
  combo_created: { required: ["issue_url"] },
  team: { required: ["roles"] },
  coder_started: { required: [] },
  coder_done: { required: [] },
  coder_failed: { required: ["exit_code", "has_new_commits"] },
  address_done: { required: ["head_sha"] },
  address_noop: { required: ["head_sha"] },
  gate_started: { required: [] },
  gate_failed: { required: ["exit_code"] },
  gate_status: { required: ["state"] },
  gate_validated: { required: ["sha"] },
  gate_stale: { required: ["old_sha", "new_sha"] },
  pr_conflict: { required: ["sha", "pr_url", "merge_state", "action"] },
  rebase_failed: { required: ["base"] },
  rebase_conflict: { required: ["base"] },
  pr_opened: { required: ["url"] },
  pr_labels_updated: {
    required: ["pr_url", "head_sha", "old_labels", "new_labels", "added_labels", "removed_labels", "reason"],
  },
  pr_autoclose_failed: { required: ["exit_code", "url"] },
  needs_human: { required: ["reason"] },
  worker_recovered: { required: ["worker", "reason", "attempt"] },
  worker_recovery_failed: { required: ["worker", "reason", "attempt"] },
  director_prompted: { required: ["reason", "target"] },
  // v1 pre-publish local review loop (PRD s3/s11). identity carries the
  // producing {model, runtime}; code is the 0-3 verdict routing code.
  local_review_requested: { required: ["round", "sha"] },
  local_verdict: { required: ["round", "code", "verdict_path", "identity"] },
  // decision answers a needs_human escalation; needs_human_ref points at the
  // journal timestamp of the needs_human event it resolves.
  decision: { required: ["needs_human_ref", "verb"] },
  follow_ups: { required: ["round", "items"] },
  review_comment: { required: ["author", "kind", "url"] },
  lgtm: { required: ["sha"] },
  lgtm_stale: { required: ["old_sha", "new_sha"] },
  ready_for_merge: { required: ["sha", "pr_url"] },
  merged: { required: ["sha", "by"] },
  combo_closed: { required: [] },
  parked: { required: ["by", "summary_path"] },
  coder_retry: { required: [] },
  stopped: { required: ["by"] },
  watch_error: { required: ["exit_code", "stderr"] },
  watch_dead: { required: ["exit_code", "stderr"] },
} as const satisfies Record<string, { required: readonly string[] }>;

export type CanonicalEventName = keyof typeof EVENT_TYPES;

const LEGACY_EVENT_ALIASES = {
  rower_started: "coder_started",
  rower_done: "coder_done",
  rower_failed: "coder_failed",
  hodor_started: "gate_started",
  hodor_failed: "gate_failed",
  hodor_status: "gate_status",
  rower_retry: "coder_retry",
} as const satisfies Record<string, CanonicalEventName>;

type LegacyEventName = keyof typeof LEGACY_EVENT_ALIASES;
export type EventName = CanonicalEventName | LegacyEventName;

export interface ComboEvent {
  t: string;
  event: CanonicalEventName;
  [key: string]: unknown;
}

export function latestPrUrlFromEvents(events: ComboEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.event === "pr_opened" && typeof event.url === "string") return event.url;
  }
  return undefined;
}

// -/ 1/4

// -- 2/4 CORE · appendEvent --

const JOURNAL = "journal.jsonl";
const JOURNAL_APPEND_LOCK = ".journal.append.lock";
const JOURNAL_APPEND_LOCK_TIMEOUT_MS = 5000;
const JOURNAL_APPEND_LOCK_STALE_MS = 30000;
const JOURNAL_APPEND_LOCK_POLL_MS = 10;
const JOURNAL_LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

export function journalPath(runDir: string): string {
  return join(runDir, JOURNAL);
}

/**
 * Journal timestamps double as event identity (a decision resolves a
 * needs_human by its t via needs_human_ref), so two entries must never share
 * one. Same-millisecond appends advance past the last journaled timestamp.
 */
function allocateTimestamp(candidate: string, lastT: string | undefined): string {
  if (lastT === undefined || Number.isNaN(Date.parse(lastT)) || candidate > lastT) return candidate;
  return new Date(Date.parse(lastT) + 1).toISOString();
}

function lastJournalTimestamp(runDir: string): string | undefined {
  const last = readEvents(runDir).at(-1);
  return typeof last?.t === "string" ? last.t : undefined;
}

export function appendEvent(runDir: string, event: EventName, payload: Record<string, unknown>): ComboEvent {
  const canonical = canonicalEventName(event);
  if (canonical === undefined) {
    throw new ComboEventError(`Unknown event "${String(event)}"`);
  }
  const schema = EVENT_TYPES[canonical];
  for (const field of schema.required) {
    if (payload[field] === undefined) {
      throw new ComboEventError(`Event "${canonical}" requires field "${field}"`);
    }
  }
  const { event: _ignoredEvent, t: _ignoredTimestamp, ...safePayload } = payload;
  const entry: ComboEvent = {
    ...safePayload,
    t: new Date().toISOString(),
    event: canonical,
  };
  return withJournalAppendLock(runDir, () => {
    const existingPrOpened = existingPrOpenedEvent(runDir, canonical, safePayload);
    if (existingPrOpened !== undefined) return existingPrOpened;
    entry.t = allocateTimestamp(entry.t, lastJournalTimestamp(runDir));
    // The run dir is created by writeCombo; emitting to a combo that was
    // never created is a caller bug and should surface, not be papered over.
    appendFileSync(journalPath(runDir), `${JSON.stringify(entry)}\n`);
    return entry;
  });
}

function existingPrOpenedEvent(
  runDir: string,
  event: CanonicalEventName,
  payload: Record<string, unknown>,
): ComboEvent | undefined {
  if (event !== "pr_opened" || typeof payload["url"] !== "string") return undefined;
  return readEvents(runDir).find(
    (candidate) => candidate.event === "pr_opened" && candidate["url"] === payload["url"],
  );
}

function withJournalAppendLock<T>(runDir: string, action: () => T): T {
  const lockPath = acquireJournalAppendLock(runDir);
  try {
    return action();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function acquireJournalAppendLock(runDir: string): string {
  const lockPath = join(runDir, JOURNAL_APPEND_LOCK);
  const deadline = Date.now() + JOURNAL_APPEND_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      mkdirSync(lockPath);
      return lockPath;
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
      if (isStaleJournalAppendLock(lockPath)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new ComboEventError(`Timed out waiting for journal append lock at ${lockPath}`);
      }
      sleepSync(Math.min(JOURNAL_APPEND_LOCK_POLL_MS, remainingMs));
    }
  }
}

function isStaleJournalAppendLock(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > JOURNAL_APPEND_LOCK_STALE_MS;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return true;
    throw error;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(JOURNAL_LOCK_SLEEP, 0, 0, ms);
}

export function appendEvents(
  runDir: string,
  entries: Array<{ event: EventName; payload: Record<string, unknown> }>,
): ComboEvent[] {
  const validated: Array<{
    canonical: CanonicalEventName;
    entry: ComboEvent;
    safePayload: Record<string, unknown>;
  }> = [];
  for (const { event, payload } of entries) {
    const canonical = canonicalEventName(event);
    if (canonical === undefined) {
      throw new ComboEventError(`Unknown event "${String(event)}"`);
    }
    const schema = EVENT_TYPES[canonical];
    for (const field of schema.required) {
      if (payload[field] === undefined) {
        throw new ComboEventError(`Event "${canonical}" requires field "${field}"`);
      }
    }
    const { event: _ignoredEvent, t: _ignoredTimestamp, ...safePayload } = payload;
    const entry: ComboEvent = {
      ...safePayload,
      t: new Date().toISOString(),
      event: canonical,
    };
    validated.push({ canonical, entry, safePayload });
  }

  return withJournalAppendLock(runDir, () => {
    const result: ComboEvent[] = [];
    let lastT = lastJournalTimestamp(runDir);
    for (const { canonical, entry, safePayload } of validated) {
      const existing = existingPrOpenedEvent(runDir, canonical, safePayload);
      if (existing !== undefined) {
        result.push(existing);
      } else {
        entry.t = allocateTimestamp(entry.t, lastT);
        lastT = entry.t;
        appendFileSync(journalPath(runDir), `${JSON.stringify(entry)}\n`);
        result.push(entry);
      }
    }
    return result;
  });
}

// -/ 2/4

// -- 3/4 CORE · readEvents + canonicalEventName --

export function readEvents(runDir: string): ComboEvent[] {
  const path = journalPath(runDir);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n");
  const events: ComboEvent[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      events.push(normalizeEvent(parsed));
    } catch {
      // A crash, legacy writer, or manual repair can leave a torn line.
      // Ignore it rather than poisoning status; future complete lines still read.
    }
  }
  return events;
}

export function canonicalEventName(event: string): CanonicalEventName | undefined {
  if (Object.hasOwn(EVENT_TYPES, event)) return event as CanonicalEventName;
  if (Object.hasOwn(LEGACY_EVENT_ALIASES, event)) {
    return LEGACY_EVENT_ALIASES[event as LegacyEventName];
  }
  return undefined;
}

function normalizeEvent(event: unknown): ComboEvent {
  if (event === null || typeof event !== "object") return event as ComboEvent;
  const rawEvent = (event as { event?: unknown })["event"];
  if (typeof rawEvent !== "string") return event as ComboEvent;
  const canonical = canonicalEventName(rawEvent);
  if (canonical === undefined) return event as ComboEvent;
  return { ...(event as ComboEvent), event: canonical };
}
// -/ 3/4

// -- 4/4 HELPER · followEvents (async tail) --
interface FollowOptions {
  pollMs?: number;
  signal?: AbortSignal;
}

/**
 * Async iterator over the journal: yields existing events, then polls for
 * new ones. Polling (not fs.watch) keeps behavior identical across macOS,
 * Linux, and network volumes. Journals are small; re-reading per poll is
 * the simple thing that is also correct.
 */
export async function* followEvents(runDir: string, options: FollowOptions = {}): AsyncGenerator<ComboEvent> {
  const pollMs = options.pollMs ?? 500;
  let yielded = 0;

  while (!options.signal?.aborted) {
    const events = readEvents(runDir);
    while (yielded < events.length) {
      yield events[yielded]!;
      yielded += 1;
    }
    await sleep(pollMs, options.signal);
  }
}

/** Abortable setTimeout wrapper shared by journal followers and retry loops. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
// -/ 4/4
