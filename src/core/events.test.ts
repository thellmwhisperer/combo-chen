import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ComboEventError,
  EVENT_TYPES,
  appendEvent,
  followEvents,
  readEvents,
} from "./events.js";

function runDir(): string {
  return mkdtempSync(join(tmpdir(), "combo-chen-events-"));
}

describe("event schema", () => {
  it("pins the v0 event catalogue — a new event without a schema does not exist", () => {
    expect(Object.keys(EVENT_TYPES).sort()).toEqual(
      [
        "combo_created",
        "phase_changed",
        "rower_started",
        "rower_done",
        "rower_failed",
        "hodor_started",
        "hodor_status",
        "hodor_failed",
        "pr_opened",
        "needs_human",
        "stopped",
      ].sort(),
    );
  });

  it("requires the documented payload fields per event", () => {
    expect(EVENT_TYPES.phase_changed.required).toEqual(["from", "to"]);
    expect(EVENT_TYPES.pr_opened.required).toEqual(["url"]);
    expect(EVENT_TYPES.needs_human.required).toEqual(["reason"]);
    expect(EVENT_TYPES.rower_failed.required).toEqual(["exit_code"]);
  });

  it("rejects unknown event names", () => {
    expect(() => appendEvent(runDir(), "rower_sank" as never, {})).toThrow(ComboEventError);
  });

  it("rejects events missing required payload fields", () => {
    expect(() => appendEvent(runDir(), "pr_opened", {})).toThrow(/url/);
  });
});

describe("journal", () => {
  it("appends JSONL with a timestamp and reads back in order", () => {
    const dir = runDir();
    appendEvent(dir, "combo_created", { issue_url: "https://github.com/o/r/issues/7" });
    appendEvent(dir, "phase_changed", { from: "SETUP", to: "ROWING" });

    const events = readEvents(dir);
    expect(events).toHaveLength(2);
    expect(events[0]?.event).toBe("combo_created");
    expect(events[1]?.event).toBe("phase_changed");
    expect(events[1]?.from).toBe("SETUP");
    expect(typeof events[0]?.t).toBe("string");
    expect(Number.isNaN(Date.parse(events[0]!.t))).toBe(false);
  });

  it("reads an empty list when no journal exists yet", () => {
    expect(readEvents(runDir())).toEqual([]);
  });

  it("tolerates a torn last line (partial write) without crashing", () => {
    const dir = runDir();
    appendEvent(dir, "combo_created", { issue_url: "x" });
    const { appendFileSync } = require("node:fs") as typeof import("node:fs");
    appendFileSync(join(dir, "journal.jsonl"), '{"t":"2026-06-10T');

    const events = readEvents(dir);
    expect(events).toHaveLength(1);
  });

  it("follow yields events appended after subscription", async () => {
    const dir = runDir();
    appendEvent(dir, "combo_created", { issue_url: "x" });

    const seen: string[] = [];
    const controller = new AbortController();
    const following = (async () => {
      for await (const event of followEvents(dir, { pollMs: 10, signal: controller.signal })) {
        seen.push(event.event);
        if (seen.length === 2) controller.abort();
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 30));
    appendEvent(dir, "rower_started", {});
    await following;

    expect(seen).toEqual(["combo_created", "rower_started"]);
  });
});
