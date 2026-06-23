/**
 * @overview Unit tests for director-watch operator status formatting. ~145 lines,
 *   phase age, PR facts, worker counters, readiness, and closure actions.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at buildDirectorWatchStatusLine tests <- representative pane output.
 *   2. Fixture helpers keep wall-clock inputs fixed.
 *
 * @exports none
 * @deps vitest, ../core/events, ./director-watch-status
 */
import { describe, expect, it } from "vitest";

import type { ComboEvent } from "../core/events.js";
import { buildDirectorWatchStatusLine } from "./director-watch-status.js";

// -- 1/1 CORE · buildDirectorWatchStatusLine tests <- START HERE --
const HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function event(
  name: ComboEvent["event"],
  t: string,
  payload: Record<string, unknown> = {},
): ComboEvent {
  return { t, event: name, ...payload };
}

function successfulRollup(): unknown[] {
  return [
    { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "ExternalReview", status: "COMPLETED", conclusion: "SUCCESS" },
  ];
}

describe("buildDirectorWatchStatusLine", () => {
  it("prints a closure-pending timeline, checklist, and exact closure command", () => {
    const now = new Date("2026-06-22T12:00:00.000Z");
    const line = buildDirectorWatchStatusLine({
      comboId: "o-r-7",
      cli: "node dist/cli.mjs",
      now,
      pollSeconds: 42,
      readyRequiredChecks: ["ExternalReview"],
      events: [
        event("combo_created", "2026-06-22T11:00:00.000Z", {
          issue_url: "https://github.com/o/r/issues/7",
        }),
        event("pr_opened", "2026-06-22T11:10:00.000Z", {
          url: "https://github.com/o/r/pull/7",
        }),
        event("gate_validated", "2026-06-22T11:20:00.000Z", { sha: HEAD }),
        event("lgtm", "2026-06-22T11:25:00.000Z", { sha: HEAD }),
        event("merged", "2026-06-22T11:55:00.000Z", { sha: HEAD, by: "javi" }),
      ],
      pr: {
        state: "MERGED",
        headSha: HEAD,
        statusCheckRollup: successfulRollup(),
        polledAt: now,
      },
      workerSummaries: [
        "worker coder: unchanged_ticks=3",
        "worker reviewer: unchanged_ticks=1",
      ],
    });

    expect(line).toContain("director: watch 2026-06-22T12:00:00.000Z");
    expect(line).toContain("combo=o-r-7");
    expect(line).toContain("phase=STALLED/closure_pending age=5m");
    expect(line).toContain("pr=MERGED@bbbbbbb");
    expect(line).toContain("last=merged age=5m");
    expect(line).toContain("gh=0s ago next=42s");
    expect(line).toContain("workers=coder unchanged 3 ticks (~2m6s), reviewer unchanged 1 tick (~42s)");
    expect(line).toContain("gate=validated@bbbbbbb");
    expect(line).toContain("reviewer=lgtm@bbbbbbb");
    expect(line).toContain("ready=[pr:no gate:yes reviewer:yes checks:yes ci:yes]");
    expect(line).toContain('action="closure pending: node dist/cli.mjs closure -n o-r-7"');
  });

  it("prints review-waiting signals without depending on the live clock", () => {
    const now = new Date("2026-06-22T12:00:00.000Z");
    const line = buildDirectorWatchStatusLine({
      comboId: "o-r-7",
      cli: "node dist/cli.mjs",
      now,
      pollSeconds: 30,
      readyRequiredChecks: ["ExternalReview"],
      events: [
        event("combo_created", "2026-06-22T11:00:00.000Z", {
          issue_url: "https://github.com/o/r/issues/7",
        }),
        event("pr_opened", "2026-06-22T11:50:00.000Z", {
          url: "https://github.com/o/r/pull/7",
        }),
        event("gate_status", "2026-06-22T11:51:00.000Z", {
          state: "failed",
          head_sha: HEAD,
        }),
        event("gate_failed", "2026-06-22T11:51:00.000Z", {
          exit_code: 1,
          reason: "gate_failed",
        }),
      ],
      pr: {
        state: "OPEN",
        headSha: HEAD,
        statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
        polledAt: now,
      },
      workerSummaries: [],
    });

    expect(line).toContain("phase=STALLED/gate_failed age=9m");
    expect(line).toContain("pr=OPEN@bbbbbbb");
    expect(line).toContain("gate=failed@bbbbbbb");
    expect(line).toContain("reviewer=missing");
    expect(line).toContain("ready=[pr:yes gate:no reviewer:no checks:no ci:yes]");
    expect(line).toContain('action="needs human: gate_failed"');
  });

  it("treats prefix-pinned reviewer LGTM as current for readiness", () => {
    const now = new Date("2026-06-22T12:00:00.000Z");
    const line = buildDirectorWatchStatusLine({
      comboId: "o-r-7",
      cli: "node dist/cli.mjs",
      now,
      pollSeconds: 30,
      readyRequiredChecks: ["ExternalReview"],
      events: [
        event("pr_opened", "2026-06-22T11:50:00.000Z", {
          url: "https://github.com/o/r/pull/7",
        }),
        event("gate_validated", "2026-06-22T11:55:00.000Z", { sha: HEAD }),
        event("lgtm", "2026-06-22T11:56:00.000Z", { sha: HEAD.slice(0, 7) }),
      ],
      pr: {
        state: "OPEN",
        headSha: HEAD,
        statusCheckRollup: successfulRollup(),
        polledAt: now,
      },
      workerSummaries: [],
    });

    expect(line).toContain("reviewer=lgtm@bbbbbbb");
    expect(line).toContain("ready=[pr:yes gate:yes reviewer:yes checks:yes ci:yes]");
  });

  it("keeps degraded PR state unknown instead of routing to terminal waiting", () => {
    const now = new Date("2026-06-22T12:00:00.000Z");
    const line = buildDirectorWatchStatusLine({
      comboId: "o-r-7",
      cli: "node dist/cli.mjs",
      now,
      pollSeconds: 30,
      events: [
        event("combo_created", "2026-06-22T11:00:00.000Z", {
          issue_url: "https://github.com/o/r/issues/7",
        }),
        event("pr_opened", "2026-06-22T11:50:00.000Z", {
          url: "https://github.com/o/r/pull/7",
        }),
      ],
      pr: {
        state: "unknown",
        polledAt: now,
        error: "API rate limit exceeded",
      },
      workerSummaries: [],
    });

    expect(line).toContain("pr=unknown");
    expect(line).toContain("gh=0s ago error:API rate limit exceeded next=30s");
    expect(line).toContain("ready=[pr:unknown gate:unknown reviewer:unknown checks:unknown ci:unknown]");
    expect(line).toContain('action="waiting for GitHub PR state"');
    expect(line).not.toContain("waiting for terminal journal");
  });
});
// -/ 1/1
