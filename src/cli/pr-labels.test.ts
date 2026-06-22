/**
 * @overview Unit tests for combo PR label projection.
 *   ~289 lines, deterministic GitHub-label state from journal + live PR facts.
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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readEvents, type ComboEvent } from "../core/events.js";
import type { GhResult } from "./github.js";
import { diffComboPrLabels, projectComboPrLabels, syncComboPrLabels } from "./pr-labels.js";

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

function runDir(): string {
  return mkdtempSync(join(tmpdir(), "combo-chen-pr-labels-"));
}

function ghOk(stdout: unknown = ""): GhResult {
  return { status: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "" };
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

  it("uses configured ambient check names for the CodeRabbit-equivalent label before the fallback", () => {
    expect(
      labels({
        events: [event("pr_opened", { url: PR_URL }), event("lgtm", { sha: HEAD })],
        pr: {
          state: "OPEN",
          headSha: HEAD,
          statusCheckRollup: [
            checkRun("CodeRabbit", "FAILURE"),
            checkRun("ReviewDog", "SUCCESS"),
          ],
        },
        ambientCheckNames: ["ReviewDog"],
      }),
    ).toEqual(["combo:lgtm", "combo:coderabbit-green"]);
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

  it("applies an idempotent fake-GitHub label diff and journals mutation metadata", () => {
    const calls: string[][] = [];
    let liveLabels: Array<{ name: string }> = [{ name: "combo:ready" }, { name: "documentation" }];
    const gh = (args: string[]): GhResult => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "view") {
        return ghOk({
          headRefOid: HEAD,
          state: "OPEN",
          labels: liveLabels,
          statusCheckRollup: [checkRun("CodeRabbit", "SUCCESS")],
        });
      }
      if (args[0] === "pr" && args[1] === "edit" && args[3] === "--remove-label") {
        const removed = new Set(String(args[4]).split(","));
        liveLabels = liveLabels.filter((label) => !removed.has(label.name));
        return ghOk();
      }
      if (args[0] === "pr" && args[1] === "edit" && args[3] === "--add-label") {
        liveLabels = liveLabels.concat(String(args[4]).split(",").map((name) => ({ name })));
        return ghOk();
      }
      return { status: 1, stdout: "", stderr: `unexpected gh call: ${args.join(" ")}` };
    };
    const dir = runDir();

    const result = syncComboPrLabels({
      gh,
      runDir: dir,
      prUrl: PR_URL,
      events: [event("pr_opened", { url: PR_URL }), event("lgtm", { sha: HEAD })],
      codeRabbitCheckNames: ["CodeRabbit"],
      source: "test",
    });

    expect(result.changed).toBe(true);
    expect(result.diff).toEqual({
      add: ["combo:lgtm", "combo:coderabbit-green"],
      remove: ["combo:ready"],
    });
    expect(calls).toEqual([
      ["pr", "view", PR_URL, "--json", "headRefOid,state,mergeStateStatus,statusCheckRollup,labels"],
      ["pr", "edit", PR_URL, "--remove-label", "combo:ready"],
      ["pr", "view", PR_URL, "--json", "headRefOid,state,mergeStateStatus,statusCheckRollup,labels"],
      ["pr", "edit", PR_URL, "--add-label", "combo:lgtm,combo:coderabbit-green"],
      ["pr", "view", PR_URL, "--json", "headRefOid,state,mergeStateStatus,statusCheckRollup,labels"],
    ]);
    expect(readEvents(dir)).toHaveLength(2);
    expect(readEvents(dir)[0]).toMatchObject({
      event: "pr_labels_updated",
      pr_url: PR_URL,
      head_sha: HEAD,
      old_labels: ["combo:ready", "documentation"],
      new_labels: ["documentation"],
      added_labels: [],
      removed_labels: ["combo:ready"],
      reason: "current",
      source: "test",
    });
    expect(readEvents(dir)[1]).toMatchObject({
      event: "pr_labels_updated",
      pr_url: PR_URL,
      head_sha: HEAD,
      old_labels: ["documentation"],
      new_labels: ["documentation", "combo:lgtm", "combo:coderabbit-green"],
      added_labels: ["combo:lgtm", "combo:coderabbit-green"],
      removed_labels: [],
      reason: "current",
      source: "test",
    });
  });

  it("journals a successful removal with refreshed labels before a later add failure", () => {
    const calls: string[][] = [];
    let liveLabels: Array<{ name: string }> = [{ name: "combo:ready" }, { name: "documentation" }];
    const gh = (args: string[]): GhResult => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "view") {
        return ghOk({
          headRefOid: HEAD,
          state: "OPEN",
          labels: liveLabels,
          statusCheckRollup: [checkRun("CodeRabbit", "SUCCESS")],
        });
      }
      if (args[0] === "pr" && args[1] === "edit" && args[3] === "--remove-label") {
        liveLabels = [{ name: "documentation" }];
        return ghOk();
      }
      if (args[0] === "pr" && args[1] === "edit" && args[3] === "--add-label") {
        return { status: 1, stdout: "", stderr: "add failed" };
      }
      return { status: 1, stdout: "", stderr: `unexpected gh call: ${args.join(" ")}` };
    };
    const dir = runDir();

    expect(() =>
      syncComboPrLabels({
        gh,
        runDir: dir,
        prUrl: PR_URL,
        events: [event("pr_opened", { url: PR_URL }), event("lgtm", { sha: HEAD })],
        codeRabbitCheckNames: ["CodeRabbit"],
        source: "test",
      }),
    ).toThrow("add failed");

    expect(calls).toEqual([
      ["pr", "view", PR_URL, "--json", "headRefOid,state,mergeStateStatus,statusCheckRollup,labels"],
      ["pr", "edit", PR_URL, "--remove-label", "combo:ready"],
      ["pr", "view", PR_URL, "--json", "headRefOid,state,mergeStateStatus,statusCheckRollup,labels"],
      ["pr", "edit", PR_URL, "--add-label", "combo:lgtm,combo:coderabbit-green"],
    ]);
    expect(readEvents(dir)).toHaveLength(1);
    expect(readEvents(dir)[0]).toMatchObject({
      event: "pr_labels_updated",
      pr_url: PR_URL,
      head_sha: HEAD,
      old_labels: ["combo:ready", "documentation"],
      new_labels: ["documentation"],
      added_labels: [],
      removed_labels: ["combo:ready"],
      reason: "current",
      source: "test",
    });
  });

  it("skips GitHub mutations and journal writes when live labels already match", () => {
    const calls: string[][] = [];
    const gh = (args: string[]): GhResult => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "view") {
        return ghOk({
          headRefOid: HEAD,
          state: "OPEN",
          labels: [{ name: "combo:lgtm" }, { name: "combo:coderabbit-green" }],
          statusCheckRollup: [checkRun("CodeRabbit", "SUCCESS")],
        });
      }
      return { status: 1, stdout: "", stderr: `unexpected gh call: ${args.join(" ")}` };
    };
    const dir = runDir();

    const result = syncComboPrLabels({
      gh,
      runDir: dir,
      prUrl: PR_URL,
      events: [event("pr_opened", { url: PR_URL }), event("lgtm", { sha: HEAD })],
      codeRabbitCheckNames: ["CodeRabbit"],
    });

    expect(result.changed).toBe(false);
    expect(result.diff).toEqual({ add: [], remove: [] });
    expect(calls).toEqual([
      ["pr", "view", PR_URL, "--json", "headRefOid,state,mergeStateStatus,statusCheckRollup,labels"],
    ]);
    expect(readEvents(dir)).toEqual([]);
  });
});
// -/ 1/1
