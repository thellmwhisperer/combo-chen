/**
 * @overview Unit tests for combo PR label projection.
 *   ~175 lines, deterministic GitHub-label state from journal + live PR facts.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at projectComboPrLabels tests <- desired live labels.
 *   2. Then diffComboPrLabels tests        <- add/remove plan for GitHub.
 *   3. Test helpers                        <- event/check fixtures.
 *
 *   MAIN FLOW
 *   ---------
 *   journal events + fake PR/check facts -> desired combo labels -> add/remove diff
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   event, checkRun, labels
 *
 * @exports none
 * @deps vitest, ../core/events, ./pr-labels
 */
import { describe, expect, it } from "vitest";

import type { ComboEvent } from "../core/events.js";
import { diffComboPrLabels, projectComboPrLabels } from "./pr-labels.js";

// -- 1/1 CORE - label projection tests <- START HERE --
const OLD_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PR_URL = "https://github.com/o/r/pull/7";

function event(name: ComboEvent["event"], payload: Record<string, unknown> = {}): ComboEvent {
  return { t: new Date(0).toISOString(), event: name, ...payload };
}

function checkRun(name: string, conclusion: string): unknown {
  return { __typename: "CheckRun", name, status: "COMPLETED", conclusion };
}

function labels(input: Parameters<typeof projectComboPrLabels>[0]): string[] {
  return projectComboPrLabels(input).labels;
}

describe("combo PR label projection", () => {
  it("returns no combo labels for non-open PRs and removes only known combo labels", () => {
    const projection = projectComboPrLabels({
      events: [event("pr_opened", { url: PR_URL })],
      pr: { state: "MERGED", headSha: HEAD },
    });

    expect(projection.labels).toEqual([]);
    expect(projection.reason).toBe("pr_not_open");
    expect(
      diffComboPrLabels(["bug", "combo:ready", "combo:working-reviewer"], projection.labels),
    ).toEqual({
      add: [],
      remove: ["combo:working-reviewer", "combo:ready"],
    });
  });

  it("projects a single work-in-progress label with coder taking reviewer precedence", () => {
    expect(
      labels({
        events: [event("pr_opened", { url: PR_URL })],
        pr: { state: "OPEN", headSha: HEAD },
        activity: { reviewerActive: true },
      }),
    ).toEqual(["combo:working-reviewer"]);

    expect(
      labels({
        events: [
          event("pr_opened", { url: PR_URL }),
          event("review_comment", {
            author: "reviewer",
            kind: "requested_changes",
            url: "https://github.com/o/r/pull/7#discussion_r1",
            head_sha: HEAD,
          }),
        ],
        pr: { state: "OPEN", headSha: HEAD },
        activity: { reviewerActive: true },
      }),
    ).toEqual(["combo:working-coder"]);

    expect(
      labels({
        events: [event("pr_opened", { url: PR_URL })],
        pr: { state: "OPEN", headSha: HEAD },
        activity: { gateActive: true, reviewerActive: true },
      }),
    ).toEqual(["combo:working-gate"]);
  });

  it("projects current-head LGTM, CodeRabbit, and READY labels only when live signals agree", () => {
    expect(
      labels({
        events: [
          event("pr_opened", { url: PR_URL }),
          event("gate_validated", { sha: HEAD }),
          event("lgtm", { sha: HEAD }),
          event("ready_for_merge", { sha: HEAD, pr_url: PR_URL }),
        ],
        pr: {
          state: "OPEN",
          headSha: HEAD,
          statusCheckRollup: [
            checkRun("unit", "SUCCESS"),
            checkRun("CodeRabbit", "SUCCESS"),
            checkRun("ReviewDog", "SUCCESS"),
          ],
        },
        requiredCheckNames: ["ReviewDog"],
        codeRabbitCheckNames: ["CodeRabbit"],
      }),
    ).toEqual(["combo:lgtm", "combo:coderabbit-green", "combo:ready"]);
  });

  it("plans removal of stale current-head signal labels after a PR head changes", () => {
    const projection = projectComboPrLabels({
      events: [
        event("pr_opened", { url: PR_URL }),
        event("gate_validated", { sha: OLD_HEAD }),
        event("lgtm", { sha: OLD_HEAD }),
        event("ready_for_merge", { sha: OLD_HEAD, pr_url: PR_URL }),
      ],
      pr: {
        state: "OPEN",
        headSha: HEAD,
        statusCheckRollup: [checkRun("unit", "SUCCESS"), checkRun("CodeRabbit", "SUCCESS")],
      },
      codeRabbitCheckNames: ["CodeRabbit"],
    });

    expect(projection.labels).toEqual(["combo:coderabbit-green", "combo:stale"]);
    expect(
      diffComboPrLabels(
        ["combo:lgtm", "combo:coderabbit-green", "combo:ready", "documentation"],
        projection.labels,
      ),
    ).toEqual({
      add: ["combo:stale"],
      remove: ["combo:lgtm", "combo:ready"],
    });
  });

  it("removes CodeRabbit green when the live check is no longer SUCCESS", () => {
    const projection = projectComboPrLabels({
      events: [event("pr_opened", { url: PR_URL }), event("lgtm", { sha: HEAD })],
      pr: {
        state: "OPEN",
        headSha: HEAD,
        statusCheckRollup: [checkRun("unit", "SUCCESS"), checkRun("CodeRabbit", "FAILURE")],
      },
      codeRabbitCheckNames: ["CodeRabbit"],
    });

    expect(projection.labels).toEqual(["combo:lgtm"]);
    expect(diffComboPrLabels(["combo:coderabbit-green"], projection.labels)).toEqual({
      add: ["combo:lgtm"],
      remove: ["combo:coderabbit-green"],
    });
  });

  it("invalidates READY-style labels when GitHub reports the PR is dirty or conflicting", () => {
    const projection = projectComboPrLabels({
      events: [
        event("pr_opened", { url: PR_URL }),
        event("gate_validated", { sha: HEAD }),
        event("lgtm", { sha: HEAD }),
        event("ready_for_merge", { sha: HEAD, pr_url: PR_URL }),
      ],
      pr: {
        state: "OPEN",
        headSha: HEAD,
        mergeStateStatus: "DIRTY",
        statusCheckRollup: [checkRun("unit", "SUCCESS"), checkRun("CodeRabbit", "SUCCESS")],
      },
      codeRabbitCheckNames: ["CodeRabbit"],
    });

    expect(projection.labels).toEqual(["combo:conflict"]);
    expect(
      diffComboPrLabels(["combo:lgtm", "combo:coderabbit-green", "combo:ready"], projection.labels),
    ).toEqual({
      add: ["combo:conflict"],
      remove: ["combo:lgtm", "combo:coderabbit-green", "combo:ready"],
    });
  });
});
// -/ 1/1
