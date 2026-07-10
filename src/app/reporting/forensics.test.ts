/**
 * @overview Unit tests for combo forensics reports. ~230 lines, fixture-driven incidents.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at describe("forensics analyzer") <- core report incidents.
 *   2. Then markdown test                    <- human-readable rendering.
 *
 *   MAIN FLOW
 *   ---------
 *   combo fixture + journal events + probe facts -> analyzeForensicsCombo -> facts/incidents/markdown
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   event, combo
 *
 * @exports none
 * @deps ../../core/events, ../../core/state, ./forensics, vitest
 */
import { describe, expect, it } from "vitest";

import type { ComboEvent } from "../../core/events.js";
import type { ComboRecord } from "../../core/state.js";
import { analyzeForensicsCombo, renderForensicsMarkdown } from "./forensics.js";

// -- 1/2 HELPER · Fixtures --
function event(t: string, name: ComboEvent["event"], fields: Record<string, unknown> = {}): ComboEvent {
  return { t, event: name, ...fields };
}

const combo: ComboRecord = {
  id: "o-r-55",
  issueUrl: "https://github.com/o/r/issues/55",
  repoDir: "/repos/r",
  worktree: "/repos/r/.worktrees/issue-55",
  branch: "combo/issue-55",
  tmuxSession: "combo-chen-o-r-55",
  createdAt: "2026-06-11T10:00:00.000Z",
};
// -/ 1/2

// -- 2/2 CORE · forensics analyzer <- START HERE --
describe("forensics analyzer", () => {
  it("flags green CI without a current reviewer verdict and distinguishes live windows", () => {
    const report = analyzeForensicsCombo({
      combo,
      events: [
        event("2026-06-11T10:00:00.000Z", "combo_created", { issue_url: combo.issueUrl }),
        event("2026-06-11T10:00:30.000Z", "coder_started"),
        event("2026-06-11T10:05:00.000Z", "coder_done"),
        event("2026-06-11T10:05:05.000Z", "gate_started"),
        event("2026-06-11T10:08:00.000Z", "gate_validated", { sha: "abc123" }),
        event("2026-06-11T10:08:30.000Z", "pr_opened", { url: "https://github.com/o/r/pull/55" }),
        event("2026-06-11T10:09:00.000Z", "lgtm", { sha: "abc123" }),
        event("2026-06-11T10:10:00.000Z", "lgtm_stale", {
          old_sha: "abc123",
          new_sha: "def456",
        }),
      ],
      github: {
        pr: {
          url: "https://github.com/o/r/pull/55",
          headSha: "def456",
          state: "OPEN",
          ci: "success",
          readyRequiredChecks: "success",
        },
        issue: { state: "OPEN" },
      },
      tmux: { sessionExists: true, windows: ["coder", "reviewer", "gatekeeper"] },
    });

    expect(report.timings.coderMs).toBe(270_000);
    expect(report.timings.timeToPrMs).toBe(510_000);
    expect(report.gates.ci).toBe("success");
    expect(report.gates.reviewer.current).toBe(false);
    expect(report.processes.reviewerWindow).toBe(true);
    expect(report.incidents.map((incident) => incident.id)).toEqual([
      "missing_reviewer_verdict",
      "stale_lgtm_after_push",
      "process_without_github_gate",
    ]);

    const markdown = renderForensicsMarkdown([report]);
    expect(markdown).toContain("## o-r-55");
    expect(markdown).toContain("Coder: 4m 30s");
    expect(markdown).toContain("reviewer current verdict: no");
    expect(markdown).toContain("required READY checks: success");
    expect(markdown).toContain("reviewer window exists: yes");
    expect(markdown).toContain("missing_reviewer_verdict");
  });

  it("flags a merged PR whose source issue is still open and local combo status is stale", () => {
    const report = analyzeForensicsCombo({
      combo,
      events: [
        event("2026-06-11T10:00:00.000Z", "combo_created", { issue_url: combo.issueUrl }),
        event("2026-06-11T10:06:00.000Z", "pr_opened", { url: "https://github.com/o/r/pull/55" }),
      ],
      github: {
        pr: {
          url: "https://github.com/o/r/pull/55",
          headSha: "def456",
          state: "MERGED",
          mergedAt: "2026-06-11T10:12:00.000Z",
          ci: "success",
        },
        issue: { state: "OPEN" },
      },
      tmux: { sessionExists: false, windows: [] },
    });

    expect(report.incidents.map((incident) => incident.id)).toEqual([
      "merged_pr_open_issue",
      "local_status_stale",
    ]);
  });

  it("flags PR head drift from the local worktree and renders the next safe action", () => {
    const report = analyzeForensicsCombo({
      combo,
      events: [
        event("2026-06-11T10:00:00.000Z", "combo_created", { issue_url: combo.issueUrl }),
        event("2026-06-11T10:08:30.000Z", "pr_opened", { url: "https://github.com/o/r/pull/55" }),
      ],
      local: {
        worktreeHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      github: {
        pr: {
          url: "https://github.com/o/r/pull/55",
          headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          state: "OPEN",
          ci: "pending",
          readyRequiredChecks: "pending",
        },
        issue: { state: "OPEN" },
      },
    });

    expect(report.gates.localWorktreeHeadSha).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(report.incidents.map((incident) => incident.id)).toEqual(["pr_head_local_drift"]);

    const markdown = renderForensicsMarkdown([report]);
    expect(markdown).toContain("Local worktree HEAD: aaaaaaa");
    expect(markdown).toContain(
      "pr_head_local_drift (warning): PR head bbbbbbb differs from local worktree aaaaaaa; fetch PR head for review or sync combo worktree.",
    );
  });

  it("renders a copy-ready dogfood outcome block with head and review-check state", () => {
    const headSha = "abc123";
    const report = analyzeForensicsCombo({
      combo,
      events: [
        event("2026-06-11T10:00:00.000Z", "combo_created", { issue_url: combo.issueUrl }),
        event("2026-06-11T10:05:05.000Z", "gate_started"),
        event("2026-06-11T10:08:00.000Z", "gate_validated", { sha: headSha }),
        event("2026-06-11T10:08:30.000Z", "pr_opened", { url: "https://github.com/o/r/pull/55" }),
        event("2026-06-11T10:09:00.000Z", "lgtm", { sha: headSha }),
        event("2026-06-11T10:11:00.000Z", "ready_for_merge", {
          pr_url: "https://github.com/o/r/pull/55",
          sha: headSha,
        }),
      ],
      github: {
        pr: {
          url: "https://github.com/o/r/pull/55",
          headSha,
          state: "OPEN",
          ci: "success",
          readyRequiredChecks: "success",
        },
        issue: { state: "OPEN" },
      },
      tmux: { sessionExists: true, windows: ["coder", "gatekeeper"] },
    });

    const markdown = renderForensicsMarkdown([report]);

    expect(markdown).toContain("- Outcome:");
    expect(markdown).toContain("  - PR link: https://github.com/o/r/pull/55");
    expect(markdown).toContain("  - Head SHA: abc123");
    expect(markdown).toContain(
      "  - Review/check state: reviewer=current · gatekeeper=current · required READY checks=success · CI=success",
    );
    expect(markdown).toContain("  - Failures found: none");
    expect(markdown).toContain("  - Follow-up bugs: none recorded");
  });

  it("includes generic plan work item source and title in reports", () => {
    const planCombo: ComboRecord = {
      ...combo,
      id: "plan-let-plans-launch-combos-12345678",
      issueUrl: "",
      workItemSourceType: "local_file",
      workItemSourceReference: "/plans/issue-134.md",
      workItemTitle: "Let plans launch combos",
    };

    const report = analyzeForensicsCombo({
      combo: planCombo,
      events: [
        event("2026-06-11T10:00:00.000Z", "combo_created", {
          work_item_source_type: "local_file",
          work_item_source_reference: "/plans/issue-134.md",
          work_item_title: "Let plans launch combos",
        }),
      ],
    });

    expect(report.workItem).toMatchObject({
      title: "Let plans launch combos",
      sourceType: "local_file",
      sourceReference: "/plans/issue-134.md",
    });
    const markdown = renderForensicsMarkdown([report]);
    expect(markdown).toContain("- Work item: Let plans launch combos (local_file:/plans/issue-134.md)");
    expect(markdown).not.toContain("GitHub issue:");
  });
});
// -/ 2/2
