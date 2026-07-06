/**
 * @overview Unit tests for the event journal subsystem. ~414 lines, testing
 *   event schema validation, JSONL append/read, PR-open idempotence, append locking, legacy alias
 *   mapping, torn-line tolerance, and the async follow/followEvents stream.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at describe("journal")   ← append, read, follow, legacy aliases
 *   2. Then describe("event schema")  ← catalogue and validation contract
 *
 *   ┌─ TEST AREAS ───────────────────────────────────────┐
 *   │ event schema  Pinned catalogue + required fields   │
 *   │ journal       JSONL read/write, append locking,    │
 *   │               PR-open idempotence, batch append,   │
 *   │               legacy aliases, torn-line tolerance,  │
 *   │               async follow                         │
 *   └─────────────────────────────────────────────────────┘
 *
 * @exports none (test file)
 * @deps vitest, node:{fs,os,path}, ./events
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  ComboEventError,
  EVENT_TYPES,
  appendEvent,
  appendEvents,
  followEvents,
  readEvents,
} from "./events.js";

function runDir(): string {
  return mkdtempSync(join(tmpdir(), "combo-chen-events-"));
}

/** Poll until the condition holds; the deadline only bounds a hung test. */
async function waitFor(condition: () => boolean, deadlineMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > deadlineMs) {
      throw new Error(`waitFor: condition not met within ${deadlineMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// -- 1/2 HELPER · event schema: catalogue + validation contract --
describe("event schema", () => {
  it("pins the v0 event catalogue — a new event without a schema does not exist", () => {
    expect(Object.keys(EVENT_TYPES).sort()).toEqual(
      [
        "combo_created",
        "coder_started",
        "coder_done",
        "coder_failed",
        "address_done",
        "address_noop",
        "gate_started",
        "gate_failed",
        "gate_status",
        "gate_validated",
        "gate_stale",
        "pr_conflict",
        "pr_opened",
        "pr_labels_updated",
        "pr_autoclose_failed",
        "needs_human",
        "worker_recovered",
        "worker_recovery_failed",
        "director_prompted",
        "external_review_requested",
        "review_comment",
        "lgtm",
        "lgtm_stale",
        "ready_for_merge",
        "merged",
        "combo_closed",
        "parked",
        "coder_retry",
        "rebase_failed",
        "rebase_conflict",
        "stopped",
        "team",
        "watch_dead",
        "watch_error",
      ].sort(),
    );
  });

  it("requires the documented payload fields per event", () => {
    expect(EVENT_TYPES.combo_created.required).toEqual(["issue_url"]);
    expect(EVENT_TYPES.team.required).toEqual(["roles"]);
    expect(EVENT_TYPES.pr_opened.required).toEqual(["url"]);
    expect(EVENT_TYPES.needs_human.required).toEqual(["reason"]);
    expect(EVENT_TYPES.worker_recovered.required).toEqual(["worker", "reason", "attempt"]);
    expect(EVENT_TYPES.director_prompted.required).toEqual(["reason", "target"]);
    expect(EVENT_TYPES.coder_failed.required).toEqual(["exit_code", "has_new_commits"]);
    expect(EVENT_TYPES.address_done.required).toEqual(["head_sha"]);
    expect(EVENT_TYPES.address_noop.required).toEqual(["head_sha"]);
    expect(EVENT_TYPES.gate_status.required).toEqual(["state"]);
    expect(EVENT_TYPES.gate_validated.required).toEqual(["sha"]);
    expect(EVENT_TYPES.gate_stale.required).toEqual(["old_sha", "new_sha"]);
    expect(EVENT_TYPES.pr_labels_updated.required).toEqual([
      "pr_url",
      "head_sha",
      "old_labels",
      "new_labels",
      "added_labels",
      "removed_labels",
      "reason",
    ]);
    expect(EVENT_TYPES.pr_conflict.required).toEqual([
      "sha",
      "pr_url",
      "merge_state",
      "action",
    ]);
    expect(EVENT_TYPES.pr_autoclose_failed.required).toEqual(["exit_code", "url"]);
    expect(EVENT_TYPES.director_prompted.required).toEqual(["reason", "target"]);
    expect(EVENT_TYPES.review_comment.required).toEqual(["author", "kind", "url"]);
    expect(EVENT_TYPES.lgtm.required).toEqual(["sha"]);
    expect(EVENT_TYPES.lgtm_stale.required).toEqual(["old_sha", "new_sha"]);
    expect(EVENT_TYPES.ready_for_merge.required).toEqual(["sha", "pr_url"]);
    expect(EVENT_TYPES.merged.required).toEqual(["sha", "by"]);
    expect(EVENT_TYPES.combo_closed.required).toEqual([]);
    expect(EVENT_TYPES.parked.required).toEqual(["by", "summary_path"]);
    expect(EVENT_TYPES.coder_retry.required).toEqual([]);
    expect(EVENT_TYPES.rebase_failed.required).toEqual(["base"]);
    expect(EVENT_TYPES.rebase_conflict.required).toEqual(["base"]);
    expect(EVENT_TYPES.watch_error.required).toEqual(["exit_code", "stderr"]);
    expect(EVENT_TYPES.watch_dead.required).toEqual(["exit_code", "stderr"]);
  });

  it("rejects unknown event names", () => {
    expect(() => appendEvent(runDir(), "rower_sank" as never, {})).toThrow(ComboEventError);
    expect(() => appendEvent(runDir(), "toString" as never, {})).toThrow(ComboEventError);
  });

  it("rejects events missing required payload fields", () => {
    expect(() => appendEvent(runDir(), "pr_opened", {})).toThrow(/url/);
  });
});

// -/ 1/2

// -- 2/2 CORE · journal: read/write, legacy aliases, async follow ← START HERE --
describe("journal", () => {
  it("appends JSONL with a timestamp and reads back in order", () => {
    const dir = runDir();
    appendEvent(dir, "combo_created", { issue_url: "https://github.com/o/r/issues/7" });
    appendEvent(dir, "needs_human", { reason: "gate_decision" });

    const events = readEvents(dir);
    expect(events).toHaveLength(2);
    expect(events[0]?.event).toBe("combo_created");
    expect(events[1]?.event).toBe("needs_human");
    expect(events[1]?.reason).toBe("gate_decision");
    expect(typeof events[0]?.t).toBe("string");
    expect(Number.isNaN(Date.parse(events[0]!.t))).toBe(false);
  });

  it("keeps appendEvent in control of reserved journal fields", () => {
    const dir = runDir();
    const entry = appendEvent(dir, "coder_started", {
      event: "gate_failed",
      t: "not-a-date",
      note: "kept",
    });

    expect(entry.event).toBe("coder_started");
    expect(entry.t).not.toBe("not-a-date");
    expect(entry.note).toBe("kept");
    expect(readEvents(dir)[0]).toMatchObject({
      event: "coder_started",
      note: "kept",
    });
  });

  it("keeps pr_opened idempotent for the same PR URL", () => {
    const dir = runDir();
    const first = appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    const second = appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    expect(second).toEqual(first);
    expect(readEvents(dir)).toEqual([first]);
  });

  it("serializes appends with a per-run lock directory", async () => {
    vi.resetModules();
    const operations: string[] = [];
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        appendFileSync: vi.fn((...args: Parameters<typeof actual.appendFileSync>) => {
          operations.push("append");
          return actual.appendFileSync(...args);
        }),
        mkdirSync: vi.fn((...args: Parameters<typeof actual.mkdirSync>) => {
          const [target] = args;
          if (String(target).endsWith(".journal.append.lock")) {
            operations.push(`lock:${String(target)}`);
          }
          return actual.mkdirSync(...args);
        }),
        rmSync: vi.fn((...args: Parameters<typeof actual.rmSync>) => {
          const [target] = args;
          if (String(target).endsWith(".journal.append.lock")) {
            operations.push(`unlock:${String(target)}`);
          }
          return actual.rmSync(...args);
        }),
      };
    });

    try {
      const journal = await import("./events.js");
      const dir = runDir();
      const lockPath = join(dir, ".journal.append.lock");

      journal.appendEvent(dir, "combo_created", { issue_url: "x" });

      expect(operations).toEqual([`lock:${lockPath}`, "append", `unlock:${lockPath}`]);
      expect(journal.readEvents(dir).map((event) => event.event)).toEqual(["combo_created"]);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("recovers a stale append lock before writing", () => {
    const dir = runDir();
    const lockPath = join(dir, ".journal.append.lock");
    mkdirSync(lockPath);
    const staleTime = new Date(Date.now() - 31_000);
    utimesSync(lockPath, staleTime, staleTime);

    appendEvent(dir, "combo_created", { issue_url: "x" });

    expect(existsSync(lockPath)).toBe(false);
    expect(readEvents(dir).map((event) => event.event)).toEqual(["combo_created"]);
  });

  it("appends the post-PR event vocabulary with its documented fields", () => {
    const dir = runDir();
    appendEvent(dir, "review_comment", {
      author: "gordon",
      kind: "judge",
      url: "https://github.com/o/r/pull/7#discussion_r1",
    });
    appendEvent(dir, "address_done", { head_sha: "abc123" });
    appendEvent(dir, "address_noop", { head_sha: "abc123" });
    appendEvent(dir, "gate_validated", { sha: "abc123", source: "no-mistakes" });
    appendEvent(dir, "gate_stale", { old_sha: "abc123", new_sha: "def456" });
    appendEvent(dir, "pr_labels_updated", {
      pr_url: "https://github.com/o/r/pull/7",
      head_sha: "def456",
      old_labels: ["combo:lgtm"],
      new_labels: ["combo:ready"],
      added_labels: ["combo:ready"],
      removed_labels: ["combo:lgtm"],
      reason: "current",
    });
    appendEvent(dir, "pr_conflict", {
      sha: "def456",
      pr_url: "https://github.com/o/r/pull/7",
      merge_state: "DIRTY",
      action: "rebase_required",
    });
    appendEvent(dir, "lgtm", { sha: "abc123" });
    appendEvent(dir, "lgtm_stale", { old_sha: "abc123", new_sha: "def456" });
    appendEvent(dir, "ready_for_merge", {
      sha: "def456",
      pr_url: "https://github.com/o/r/pull/7",
    });
    appendEvent(dir, "merged", { sha: "def456", by: "maintainer" });
    appendEvent(dir, "combo_closed", {});
    appendEvent(dir, "coder_retry", {});

    expect(readEvents(dir).map((event) => event.event)).toEqual([
      "review_comment",
      "address_done",
      "address_noop",
      "gate_validated",
      "gate_stale",
      "pr_labels_updated",
      "pr_conflict",
      "lgtm",
      "lgtm_stale",
      "ready_for_merge",
      "merged",
      "combo_closed",
      "coder_retry",
    ]);
  });

  it("reads legacy role event names as canonical aliases", () => {
    const dir = runDir();
    appendFileSync(
      join(dir, "journal.jsonl"),
      [
        JSON.stringify({ t: "2026-06-10T00:00:00.000Z", event: "rower_started" }),
        JSON.stringify({
          t: "2026-06-10T00:00:01.000Z",
          event: "rower_failed",
          exit_code: 1,
          has_new_commits: false,
        }),
        JSON.stringify({ t: "2026-06-10T00:00:02.000Z", event: "hodor_started" }),
        JSON.stringify({ t: "2026-06-10T00:00:03.000Z", event: "hodor_status", state: "idle" }),
        JSON.stringify({ t: "2026-06-10T00:00:04.000Z", event: "hodor_failed", exit_code: 2 }),
        JSON.stringify({ t: "2026-06-10T00:00:05.000Z", event: "rower_retry" }),
      ].join("\n") + "\n",
    );

    const events = readEvents(dir);
    expect(events.map((event) => event.event)).toEqual([
      "coder_started",
      "coder_failed",
      "gate_started",
      "gate_status",
      "gate_failed",
      "coder_retry",
    ]);
    expect(events[3]?.state).toBe("idle");
  });

  it("writes legacy role event aliases as canonical event names", () => {
    const dir = runDir();
    appendEvent(dir, "rower_failed", { exit_code: 1, has_new_commits: false });
    appendEvent(dir, "hodor_status", { state: "idle" });

    expect(readEvents(dir)).toMatchObject([
      { event: "coder_failed", exit_code: 1, has_new_commits: false },
      { event: "gate_status", state: "idle" },
    ]);
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
      for await (const event of followEvents(dir, { pollMs: 5, signal: controller.signal })) {
        seen.push(event.event);
      }
    })();

    // No fixed sleeps gating correctness: wait until the follower has the
    // first event, only then append the second, then wait for it to land.
    await waitFor(() => seen.length >= 1);
    appendEvent(dir, "coder_started", {});
    await waitFor(() => seen.length >= 2);
    controller.abort();
    await following;

    expect(seen).toEqual(["combo_created", "coder_started"]);
  });
  it("writes two events atomically under a single lock", () => {
    const dir = runDir();
    appendEvents(dir, [
      { event: "gate_started", payload: { source: "director_retry" } },
      { event: "gate_failed", payload: { exit_code: 1, reason: "retry_start_failed" } },
    ]);

    const events = readEvents(dir);
    expect(events).toHaveLength(2);
    expect(events[0]?.event).toBe("gate_started");
    expect(events[0]?.source).toBe("director_retry");
    expect(events[1]?.event).toBe("gate_failed");
    expect(events[1]?.exit_code).toBe(1);
    expect(events[1]?.reason).toBe("retry_start_failed");
  });

  it("deduplicates pr_opened in batch mode", () => {
    const dir = runDir();
    appendEvents(dir, [
      { event: "pr_opened", payload: { url: "https://github.com/o/r/pull/7" } },
      { event: "pr_opened", payload: { url: "https://github.com/o/r/pull/7" } },
    ]);

    const events = readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("pr_opened");
    expect(events[0]?.url).toBe("https://github.com/o/r/pull/7");
  });

  it("rejects invalid events in batch before acquiring the lock", () => {
    const dir = runDir();
    expect(() =>
      appendEvents(dir, [
        { event: "gate_started", payload: {} },
        { event: "gate_failed", payload: {} },
      ]),
    ).toThrow(/requires field "exit_code"/);

    expect(readEvents(dir)).toEqual([]);
  });
});
// -/ 2/2
