/**
 * @overview Event journal: append-only JSONL spine per combo run.
 *   ~208 lines, 12 exports, 1 canonical schema.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at EVENT_TYPES              ← defines every possible event shape
 *   2. appendEvent                        ← writes a validated event to journal
 *   3. readEvents                         ← reads + normalizes the full journal
 *   4. followEvents                       ← async iterator for tailing
 *   5. canonicalEventName                 ← legacy alias resolution
 *
 *   MAIN FLOW
 *   ─────────
 *   runner.sh → emit command → appendEvent() → journal.jsonl
 *   reader → readEvents()/followEvents() → deriveStatus() in combo.ts
 *
 *   ┌─ PUBLIC API ─────────────────────────────────────────────────────┐
 *   │ EVENT_TYPES         Canonical event catalogue (the schema)        │
 *   │ appendEvent         Write a validated event to the journal        │
 *   │ readEvents          Read all events from the journal              │
 *   │ followEvents        Async generator: yield + poll for new events  │
 *   │ canonicalEventName  Resolve legacy aliases → canonical names      │
 *   │ journalPath         Resolve journal.jsonl path for a runDir       │
 *   │ ComboEvent          Single journal entry shape                    │
 *   │ ComboEventError     Thrown on schema/validation violations        │
 *   │ latestPrUrlFromEvents  Find latest pr_opened URL in an event array │
 *   ├─ INTERNALS ──────────────────────────────────────────────────────┤
 *   │ normalizeEvent       Canonicalize event names on read             │
 *   │ sleep               Abortable setTimeout wrapper                  │
 *   │ EVENT_TYPES / LEGACY_EVENT_ALIASES / CanonicalEventName etc.     │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * @exports ComboEventError, EVENT_TYPES, CanonicalEventName, LEGACY_EVENT_ALIASES, LegacyEventName, EventName, ComboEvent, journalPath, appendEvent, readEvents, canonicalEventName, followEvents, latestPrUrlFromEvents
 * @deps node:fs, node:path
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// -- 1/4 CORE · Event catalogue + types ← START HERE --
export class ComboEventError extends Error {}

export const EVENT_TYPES = {
  combo_created: { required: ["issue_url"] },
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
  rebase_failed: { required: ["base"] },
  rebase_conflict: { required: ["base"] },
  pr_opened: { required: ["url"] },
  needs_human: { required: ["reason"] },
  review_comment: { required: ["author", "kind", "url"] },
  lgtm: { required: ["sha"] },
  lgtm_stale: { required: ["old_sha", "new_sha"] },
  ready_for_merge: { required: ["sha", "pr_url"] },
  merged: { required: ["sha", "by"] },
  combo_closed: { required: [] },
  coder_retry: { required: [] },
  stopped: { required: ["by"] },
  watch_error: { required: ["exit_code", "stderr"] },
  watch_dead: { required: ["exit_code", "stderr"] },
} as const satisfies Record<string, { required: readonly string[] }>;

export type CanonicalEventName = keyof typeof EVENT_TYPES;

export const LEGACY_EVENT_ALIASES = {
  rower_started: "coder_started",
  rower_done: "coder_done",
  rower_failed: "coder_failed",
  hodor_started: "gate_started",
  hodor_failed: "gate_failed",
  hodor_status: "gate_status",
  rower_retry: "coder_retry",
} as const satisfies Record<string, CanonicalEventName>;

export type LegacyEventName = keyof typeof LEGACY_EVENT_ALIASES;
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

export function journalPath(runDir: string): string {
  return join(runDir, JOURNAL);
}

export function appendEvent(
  runDir: string,
  event: EventName,
  payload: Record<string, unknown>,
): ComboEvent {
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
  // The run dir is created by writeCombo; emitting to a combo that was
  // never created is a caller bug and should surface, not be papered over.
  appendFileSync(journalPath(runDir), `${JSON.stringify(entry)}\n`);
  return entry;
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
      // A torn last line can happen during concurrent writes (appendFileSync
      // is not guaranteed atomic); ignored gracefully, re-read picks it up.
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
export async function* followEvents(
  runDir: string,
  options: FollowOptions = {},
): AsyncGenerator<ComboEvent> {
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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
