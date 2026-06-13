/**
 * The combo's spine: an append-only JSONL journal per run.
 * The event catalogue below IS the schema — events.test.ts pins it.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export class ComboEventError extends Error {}

export const EVENT_TYPES = {
  combo_created: { required: ["issue_url"] },
  coder_started: { required: [] },
  coder_done: { required: [] },
  coder_failed: { required: ["exit_code", "has_new_commits"] },
  gate_started: { required: [] },
  gate_failed: { required: ["exit_code"] },
  gate_status: { required: ["state"] },
  pr_opened: { required: ["url"] },
  needs_human: { required: ["reason"] },
  review_comment: { required: ["author", "kind", "url"] },
  lgtm: { required: ["sha"] },
  lgtm_stale: { required: ["old_sha", "new_sha"] },
  merged: { required: ["sha", "by"] },
  combo_closed: { required: [] },
  coder_retry: { required: [] },
  stopped: { required: ["by"] },
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
  /** ISO-8601 timestamp, written by appendEvent. */
  t: string;
  event: CanonicalEventName;
  [key: string]: unknown;
}

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
  const entry: ComboEvent = { t: new Date().toISOString(), event: canonical, ...payload };
  // The run dir is created by writeCombo; emitting to a combo that was
  // never created is a caller bug and should surface, not be papered over.
  appendFileSync(journalPath(runDir), `${JSON.stringify(entry)}\n`);
  return entry;
}

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
  if (event in EVENT_TYPES) return event as CanonicalEventName;
  return LEGACY_EVENT_ALIASES[event as LegacyEventName];
}

function normalizeEvent(event: unknown): ComboEvent {
  if (event === null || typeof event !== "object") return event as ComboEvent;
  const rawEvent = (event as { event?: unknown })["event"];
  if (typeof rawEvent !== "string") return event as ComboEvent;
  const canonical = canonicalEventName(rawEvent);
  if (canonical === undefined) return event as ComboEvent;
  return { ...(event as ComboEvent), event: canonical };
}

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
