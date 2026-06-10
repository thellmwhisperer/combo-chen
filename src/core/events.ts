/**
 * The combo's spine: an append-only JSONL journal per run.
 * The event catalogue below IS the schema — events.test.ts pins it.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export class ComboEventError extends Error {}

export const EVENT_TYPES = {
  combo_created: { required: ["issue_url"] },
  phase_changed: { required: ["from", "to"] },
  rower_started: { required: [] },
  rower_done: { required: [] },
  rower_failed: { required: ["exit_code"] },
  hodor_started: { required: [] },
  hodor_status: { required: ["raw"] },
  hodor_failed: { required: ["exit_code"] },
  pr_opened: { required: ["url"] },
  needs_human: { required: ["reason"] },
  stopped: { required: ["by"] },
} as const satisfies Record<string, { required: readonly string[] }>;

export type EventName = keyof typeof EVENT_TYPES;

export interface ComboEvent {
  /** ISO-8601 timestamp, written by appendEvent. */
  t: string;
  event: EventName;
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
  const schema = EVENT_TYPES[event];
  if (!schema) {
    throw new ComboEventError(`Unknown event "${String(event)}"`);
  }
  for (const field of schema.required) {
    if (payload[field] === undefined) {
      throw new ComboEventError(`Event "${event}" requires field "${field}"`);
    }
  }
  const entry: ComboEvent = { t: new Date().toISOString(), event, ...payload };
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
      events.push(JSON.parse(line) as ComboEvent);
    } catch {
      // A torn last line can happen during concurrent writes (appendFileSync
      // is not guaranteed atomic); ignored gracefully, re-read picks it up.
    }
  }
  return events;
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
