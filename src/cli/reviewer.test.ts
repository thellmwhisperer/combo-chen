/**
 * @overview Unit tests for reviewer CLI helpers. ~700 lines, journal predicates and reviewer flows.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at reviewer journal helpers <- pure LGTM/terminal predicates.
 *   2. Then activateReviewer             <- reviewer + director-watch tmux windows.
 *   3. Then tickReviewer                 <- PR state handling.
 *
 *   MAIN FLOW
 *   ---------
 *   fake journal/gh/tmux -> reviewer helper -> events, tmux calls, output
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   combo
 *
 * @exports none
 * @deps vitest, node:{fs,os,path}, ../core/{events,runtime-ledger,state,work-plan}, ../infra/{config,config-snapshot}, ./reviewer
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appendEvent, readEvents, type ComboEvent } from "../core/events.js";
import { RUNTIME_LEDGER_FILE } from "../core/runtime-ledger.js";
import { runDirFor, writeCombo, type ComboRecord } from "../core/state.js";
import { normalizeGitHubIssueWorkPlan, normalizeMarkdownWorkPlan, renderWorkPlanMarkdown } from "../core/work-plan.js";
import { loadConfig } from "../infra/config.js";
import { writeConfigSnapshot } from "../infra/config-snapshot.js";
import {
  activateReviewer,
  canonicalLgtmShaForHead,
  closurePendingReviewerEvent,
  hasJournaledLgtm,
  hasMergedEvent,
  latestOpenedPrUrl,
  livePinnedLgtmSha,
  terminalReviewerEvent,
  tickReviewer,
} from "./reviewer.js";

// -- 1/4 HELPER · combo fixture --
function combo(overrides: Partial<ComboRecord> = {}): ComboRecord {
  return {
    id: "o-r-7",
    issueUrl: "https://github.com/o/r/issues/7",
    repoDir: mkdtempSync(join(tmpdir(), "combo-chen-repo-")),
    worktree: join(tmpdir(), "combo-chen-worktree"),
    branch: "combo/issue-7",
    tmuxSession: "combo-chen-o-r-7",
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}
// -/ 1/4

// -- 2/4 HELPER · reviewer journal helpers --
describe("cli reviewer journal helpers", () => {
  it("tracks the currently live LGTM pin through stale events", () => {
    const events = [
      { t: "2026-06-11T00:00:00.000Z", event: "lgtm", sha: "abc123" },
      {
        t: "2026-06-11T00:01:00.000Z",
        event: "review_comment",
        url: "https://github.com/o/r/pull/7#issuecomment-1",
      },
      { t: "2026-06-11T00:02:00.000Z", event: "lgtm_stale", old_sha: "abc123", new_sha: "def456" },
      { t: "2026-06-11T00:03:00.000Z", event: "lgtm", sha: "def456" },
    ] satisfies ComboEvent[];

    expect(livePinnedLgtmSha(events)).toBe("def456");
    expect(hasJournaledLgtm(events, "abc123")).toBe(true);
    expect(hasJournaledLgtm(events, "fff999")).toBe(false);
  });

  it("canonicalizes short LGTM pins to the full PR head SHA", () => {
    const head = "e4e7dd43c6cc0d5f1234567890abcdef12345678";

    expect(canonicalLgtmShaForHead("e4e7dd4", head)).toBe(head);
    expect(canonicalLgtmShaForHead("abc123", head)).toBe("abc123");
  });

  it("finds terminal reviewer and merge events from the journal", () => {
    const events = [
      { t: "2026-06-11T00:00:00.000Z", event: "pr_opened", url: "https://github.com/o/r/pull/7" },
      { t: "2026-06-11T00:01:00.000Z", event: "merged", sha: "head456", by: "maintainer" },
      { t: "2026-06-11T00:02:00.000Z", event: "combo_closed" },
    ] satisfies ComboEvent[];

    expect(terminalReviewerEvent(events)).toMatchObject({ event: "combo_closed" });
    expect(closurePendingReviewerEvent(events)).toBeUndefined();
    expect(hasMergedEvent(events, ["squash789", "head456"])).toBe(true);
    expect(hasMergedEvent(events, ["squash789"])).toBe(false);
  });

  it("finds unclosed merged events as closure pending", () => {
    const events = [
      { t: "2026-06-11T00:00:00.000Z", event: "pr_opened", url: "https://github.com/o/r/pull/7" },
      { t: "2026-06-11T00:01:00.000Z", event: "merged", sha: "merge789", by: "maintainer" },
    ] satisfies ComboEvent[];

    expect(closurePendingReviewerEvent(events)).toMatchObject({ event: "merged", sha: "merge789" });
  });

  it("returns the latest opened PR URL from the journal", () => {
    const runDir = mkdtempSync(join(tmpdir(), "combo-chen-reviewer-"));

    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(runDir, "lgtm", { sha: "abc123" });
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/8" });

    expect(latestOpenedPrUrl(runDir)).toBe("https://github.com/o/r/pull/8");
  });
});
// -/ 2/4

// -- 3/4 CORE · activateReviewer tests <- START HERE --
describe("activateReviewer", () => {
  it("starts the reviewer and watcher windows for the latest opened PR", () => {
    const calls: string[][] = [];
    const out: string[] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(home, record.id);

    writeCombo(runDir, record);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    activateReviewer({
      deps: {
        env: { COMBO_CHEN_HOME: home },
        out: (line) => out.push(line),
        tmux: (args) => {
          calls.push(args);
          return { status: 0, stdout: "coder\ngatekeeper\n", stderr: "" };
        },
      },
      home,
      comboId: record.id,
      cli: "node /repo/dist/cli.mjs",
    });

    expect(calls[0]).toEqual(["list-windows", "-t", "combo-chen-o-r-7", "-F", "#{window_name}"]);
    expect(calls[1]).toEqual(["list-windows", "-t", "combo-chen-o-r-7", "-F", "#{window_name}"]);
    expect(calls[2]).toEqual(["list-windows", "-t", "combo-chen-o-r-7", "-F", "#{window_name}"]);
    expect(calls[3]?.slice(0, 5)).toEqual(["new-window", "-t", "combo-chen-o-r-7", "-n", "reviewer"]);
    expect(calls[3]?.at(-1)).toContain("https://github.com/o/r/pull/7");
    expect(calls[4]?.slice(0, 5)).toEqual([
      "new-window",
      "-t",
      "combo-chen-o-r-7",
      "-n",
      "director-watch",
    ]);
    expect(calls[4]?.at(-1)).toContain(
      `COMBO_CHEN_HOME='${home}' node /repo/dist/cli.mjs director-tick -n 'o-r-7'`,
    );
    expect(out).toEqual([
      "reviewer: claude reviewing https://github.com/o/r/pull/7 in combo-chen-o-r-7:reviewer",
      "director-watch: polling combo hard signals every 120s",
    ]);
    const ledger = JSON.parse(readFileSync(join(runDir, RUNTIME_LEDGER_FILE), "utf8")) as {
      prUrl?: string;
      roleWindows: Record<string, string>;
    };
    expect(ledger.prUrl).toBe("https://github.com/o/r/pull/7");
    expect(ledger.roleWindows).toMatchObject({
      reviewer: "reviewer",
      directorWatch: "director-watch",
    });
  });

  it("uses the launch config snapshot even when repo TOML changes before activation", () => {
    const calls: string[][] = [];
    const out: string[] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(home, record.id);

    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      [
        "[limits]",
        "babysit_poll_seconds = 5",
        "",
        "[reviewer]",
        'prompt = "launch reviewer prompt"',
        "",
        "[reviewer.claude]",
        'command = "claude-launch {prompt}"',
        "",
      ].join("\n"),
    );
    writeCombo(runDir, record);
    writeConfigSnapshot(runDir, loadConfig({ repoDir: record.repoDir, env: {} }));
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      [
        "[limits]",
        "babysit_poll_seconds = 999",
        "",
        "[reviewer]",
        'prompt = "mutated reviewer prompt"',
        "",
        "[reviewer.claude]",
        'command = "claude-mutated {prompt}"',
        "",
      ].join("\n"),
    );

    activateReviewer({
      deps: {
        env: { COMBO_CHEN_HOME: home },
        out: (line) => out.push(line),
        tmux: (args) => {
          calls.push(args);
          return { status: 0, stdout: "coder\ngatekeeper\n", stderr: "" };
        },
      },
      home,
      comboId: record.id,
      cli: "node /repo/dist/cli.mjs",
    });

    expect(calls[3]?.at(-1)).toContain("claude-launch");
    expect(calls[3]?.at(-1)).toContain("launch reviewer prompt");
    expect(calls[3]?.at(-1)).not.toContain("claude-mutated");
    expect(calls[3]?.at(-1)).not.toContain("mutated reviewer prompt");
    expect(calls[4]?.at(-1)).toContain("sleep 5");
    expect(calls[4]?.at(-1)).not.toContain("sleep 999");
    expect(out).toEqual([
      "reviewer: claude reviewing https://github.com/o/r/pull/7 in combo-chen-o-r-7:reviewer",
      "director-watch: polling combo hard signals every 5s",
    ]);
  });

  it("includes a plan-backed combo's persisted work plan in the reviewer prompt", () => {
    const calls: string[][] = [];
    const out: string[] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo({
      id: "plan-reviewer-context-1234abcd",
      issueUrl: "",
      workItemSourceType: "local_file",
      workItemSourceReference: "/plans/reviewer-context.md",
      workItemTitle: "Reviewer context",
      branch: "combo/plan-reviewer-context-1234abcd",
      tmuxSession: "combo-chen-plan-reviewer-context-1234abcd",
    });
    const runDir = runDirFor(home, record.id);
    const plan = normalizeMarkdownWorkPlan({
      markdown: [
        "# Reviewer context",
        "",
        "## Problem",
        "Reviewers need the normalized plan, not just a PR URL.",
        "",
        "## Acceptance Criteria",
        "- Reviewer prompt carries the persisted plan context.",
      ].join("\n"),
      source: { type: "local_file", reference: "/plans/reviewer-context.md" },
    });

    writeCombo(runDir, record);
    writeFileSync(join(runDir, "work-plan.md"), renderWorkPlanMarkdown(plan));
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/77" });

    activateReviewer({
      deps: {
        env: { COMBO_CHEN_HOME: home },
        out: (line) => out.push(line),
        tmux: (args) => {
          calls.push(args);
          return { status: 0, stdout: "coder\ngatekeeper\n", stderr: "" };
        },
      },
      home,
      comboId: record.id,
      cli: "node /repo/dist/cli.mjs",
    });

    const reviewerCommand = calls.find((call) => call[0] === "new-window" && call.includes("reviewer"))?.at(-1) ?? "";
    expect(reviewerCommand).toContain("Work plan context:");
    expect(reviewerCommand).toContain("# Reviewer context");
    expect(reviewerCommand).toContain("Source: local_file /plans/reviewer-context.md");
    expect(reviewerCommand).toContain("- Reviewer prompt carries the persisted plan context.");
    expect(out[0]).toBe(
      "reviewer: claude reviewing https://github.com/o/r/pull/77 in combo-chen-plan-reviewer-context-1234abcd:reviewer",
    );
  });

  it("includes a GitHub issue combo's persisted work plan in the reviewer prompt", () => {
    const calls: string[][] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const issueUrl = "https://github.com/o/r/issues/7";
    const record = combo({
      workItemSourceType: "github_issue",
      workItemSourceReference: issueUrl,
      workItemTitle: "Issue reviewer context",
    });
    const runDir = runDirFor(home, record.id);
    const plan = normalizeMarkdownWorkPlan({
      markdown: [
        "# Issue reviewer context",
        "",
        "## Problem",
        "GitHub issue launches still normalize into the same plan artifact.",
        "",
        "## Acceptance Criteria",
        "- Reviewer prompt carries issue-derived work-plan context.",
      ].join("\n"),
      source: { type: "github_issue", reference: issueUrl },
    });

    writeCombo(runDir, record);
    writeFileSync(join(runDir, "work-plan.md"), renderWorkPlanMarkdown(plan));
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    activateReviewer({
      deps: {
        env: { COMBO_CHEN_HOME: home },
        out: () => undefined,
        tmux: (args) => {
          calls.push(args);
          return { status: 0, stdout: "coder\ngatekeeper\n", stderr: "" };
        },
      },
      home,
      comboId: record.id,
      cli: "node /repo/dist/cli.mjs",
    });

    const reviewerCommand = calls.find((call) => call[0] === "new-window" && call.includes("reviewer"))?.at(-1) ?? "";
    expect(reviewerCommand).toContain("Work plan context:");
    expect(reviewerCommand).toContain("# Issue reviewer context");
    expect(reviewerCommand).toContain(`Source: github_issue ${issueUrl}`);
    expect(reviewerCommand).toContain("- Reviewer prompt carries issue-derived work-plan context.");
  });

  it("activates reviewer for an issue-sourced work plan without acceptance criteria", () => {
    const calls: string[][] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const issueUrl = "https://github.com/o/r/issues/7";
    const record = combo({
      workItemSourceType: "github_issue",
      workItemSourceReference: issueUrl,
      workItemTitle: "Issue without formal criteria",
    });
    const runDir = runDirFor(home, record.id);
    const plan = normalizeGitHubIssueWorkPlan({
      issueUrl,
      title: "Issue without formal criteria",
      body: "## Problem\nSome existing GitHub issues do not carry an acceptance-criteria heading.",
    });

    writeCombo(runDir, record);
    writeFileSync(join(runDir, "work-plan.md"), renderWorkPlanMarkdown(plan));
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    expect(() =>
      activateReviewer({
        deps: {
          env: { COMBO_CHEN_HOME: home },
          out: () => undefined,
          tmux: (args) => {
            calls.push(args);
            return { status: 0, stdout: "coder\ngatekeeper\n", stderr: "" };
          },
        },
        home,
        comboId: record.id,
        cli: "node /repo/dist/cli.mjs",
      }),
    ).not.toThrow();

    const reviewerCommand = calls.find((call) => call[0] === "new-window" && call.includes("reviewer"))?.at(-1) ?? "";
    expect(reviewerCommand).toContain("Work plan context:");
    expect(reviewerCommand).toContain("# Issue without formal criteria");
    expect(reviewerCommand).toContain("## Acceptance Criteria\n_Not specified._");
  });

  it("ignores incomplete work item metadata when no persisted plan is readable", () => {
    const calls: string[][] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo({
      issueUrl: "",
      workItemSourceType: "local_file",
      workItemSourceReference: undefined,
      workItemTitle: "Migrated partial metadata",
    });
    const runDir = runDirFor(home, record.id);

    writeCombo(runDir, record);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    expect(() =>
      activateReviewer({
        deps: {
          env: { COMBO_CHEN_HOME: home },
          out: () => undefined,
          tmux: (args) => {
            calls.push(args);
            return { status: 0, stdout: "coder\ngatekeeper\n", stderr: "" };
          },
        },
        home,
        comboId: record.id,
        cli: "node /repo/dist/cli.mjs",
      }),
    ).not.toThrow();

    const reviewerCommand = calls.find((call) => call[0] === "new-window" && call.includes("reviewer"))?.at(-1) ?? "";
    expect(reviewerCommand).not.toContain("Work plan context:");
  });

  it("rejects activation before a PR has opened", () => {
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(home, record.id);

    writeCombo(runDir, record);

    expect(() =>
      activateReviewer({
        deps: {
          env: { COMBO_CHEN_HOME: home },
          out: () => undefined,
          tmux: () => ({ status: 0, stdout: "", stderr: "" }),
        },
        home,
        comboId: record.id,
        cli: "node /repo/dist/cli.mjs",
      }),
    ).toThrow("Cannot activate reviewer for o-r-7: no pr_opened event in the journal");
  });

  it("rolls back the reviewer window when director watcher startup fails", () => {
    const calls: string[][] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(home, record.id);
    let watcherFailed = false;

    writeCombo(runDir, record);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    expect(() =>
      activateReviewer({
        deps: {
          env: { COMBO_CHEN_HOME: home },
          out: () => undefined,
          tmux: (args) => {
            calls.push(args);
            if (args[0] === "new-window" && args.includes("director-watch")) {
              watcherFailed = true;
              return { status: 1, stdout: "", stderr: "watcher boom" };
            }
            if (args[0] === "list-windows" && watcherFailed) {
              return { status: 0, stdout: "reviewer\n", stderr: "" };
            }
            return { status: 0, stdout: "", stderr: "" };
          },
        },
        home,
        comboId: record.id,
        cli: "node /repo/dist/cli.mjs",
      }),
    ).toThrow('tmux failed to start director watcher in "combo-chen-o-r-7": watcher boom');

    expect(calls.at(-1)).toEqual(["kill-window", "-t", "combo-chen-o-r-7:reviewer"]);
  });
});
// -/ 3/4

// -- 4/4 CORE · tickReviewer tests --
describe("tickReviewer", () => {
  it("reports a merged PR as closure pending without local teardown", async () => {
    const calls: string[][] = [];
    const out: string[] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(home, record.id);

    writeCombo(runDir, record);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    await tickReviewer({
      deps: {
        env: { COMBO_CHEN_HOME: home },
        out: (line) => out.push(line),
        tmux: (args) => {
          calls.push(["tmux", ...args]);
          return { status: 0, stdout: "", stderr: "" };
        },
        git: (args, cwd) => {
          calls.push(["git", `cwd=${cwd}`, ...args]);
          return { status: 0, stdout: "", stderr: "" };
        },
        gh: (args) => {
          calls.push(["gh", ...args]);
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: "head456",
              state: "MERGED",
              mergedBy: { login: "maintainer" },
              mergedAt: "2026-06-11T11:20:00.000Z",
              mergeCommit: { oid: "merge789" },
            }),
            stderr: "",
          };
        },
        sleep: () => Promise.resolve(),
      },
      home,
      comboId: record.id,
    });

    expect(readEvents(runDir).slice(-1)).toMatchObject([
      {
        event: "merged",
        sha: "merge789",
        by: "maintainer",
        mergedAt: "2026-06-11T11:20:00.000Z",
        source: "reviewer",
      },
    ]);
    expect(readEvents(runDir).some((event) => event.event === "combo_closed")).toBe(false);
    expect(calls.some((call) => call[0] === "git")).toBe(false);
    expect(calls.some((call) => call[0] === "tmux")).toBe(false);
    expect(calls.find((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "view"))
      ?.toContain("headRefOid,state,mergedAt,mergedBy,mergeCommit");
    expect(out).toEqual(["reviewer: merged merge789 by maintainer; closure pending: combo-chen closure -n o-r-7"]);
  });

  it("treats a merged PR without merge commit metadata as a transient failure", async () => {
    const calls: string[][] = [];
    const out: string[] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(home, record.id);

    writeCombo(runDir, record);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    await tickReviewer({
      deps: {
        env: { COMBO_CHEN_HOME: home },
        out: (line) => out.push(line),
        tmux: (args) => {
          calls.push(["tmux", ...args]);
          return { status: 0, stdout: "", stderr: "" };
        },
        git: (args, cwd) => {
          calls.push(["git", `cwd=${cwd}`, ...args]);
          return { status: 0, stdout: "", stderr: "" };
        },
        gh: (args) => {
          calls.push(["gh", ...args]);
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: "head456",
              state: "MERGED",
              mergedBy: { login: "maintainer" },
              mergedAt: "2026-06-11T11:20:00.000Z",
            }),
            stderr: "",
          };
        },
        sleep: () => Promise.resolve(),
      },
      home,
      comboId: record.id,
    });

    expect(readEvents(runDir).map((event) => event.event)).toEqual(["pr_opened"]);
    expect(calls.some((call) => call[0] === "git")).toBe(false);
    expect(calls.some((call) => call[0] === "tmux")).toBe(false);
    expect(out).toEqual([
      "reviewer: transient_failure: merged PR data missing mergeCommit.oid for o-r-7; will retry on next tick",
    ]);
  });

  it("journals a closed PR and stops the combo without local git cleanup", async () => {
    const calls: string[][] = [];
    const out: string[] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(home, record.id);

    writeCombo(runDir, record);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    await tickReviewer({
      deps: {
        env: { COMBO_CHEN_HOME: home },
        out: (line) => out.push(line),
        tmux: (args) => {
          calls.push(["tmux", ...args]);
          return { status: 0, stdout: "", stderr: "" };
        },
        git: (args, cwd) => {
          calls.push(["git", `cwd=${cwd}`, ...args]);
          return { status: 0, stdout: "", stderr: "" };
        },
        gh: (args) => {
          calls.push(["gh", ...args]);
          return {
            status: 0,
            stdout: '{"headRefOid":"def456","state":"CLOSED","mergedBy":null}',
            stderr: "",
          };
        },
        sleep: () => Promise.resolve(),
      },
      home,
      comboId: record.id,
    });

    expect(readEvents(runDir).slice(-2)).toMatchObject([
      { event: "needs_human", reason: "pr_closed" },
      { event: "combo_closed" },
    ]);
    expect(calls).toContainEqual(["tmux", "kill-session", "-t", "combo-chen-o-r-7"]);
    expect(calls.some((call) => call[0] === "git")).toBe(false);
    expect(out).toEqual(["reviewer: closed"]);
  });

  it("ignores GitHub LGTM pins from authors outside reviewer.logins", async () => {
    const out: string[] = [];
    const home = mkdtempSync(join(tmpdir(), "combo-chen-home-"));
    const record = combo();
    const runDir = runDirFor(home, record.id);

    writeFileSync(
      join(record.repoDir, "combo-chen.toml"),
      [
        "[reviewer]",
        'logins = ["trusted-reviewer"]',
        "",
        "[reviewer.claude]",
        'command = "claude {prompt}"',
        "",
      ].join("\n"),
    );
    writeCombo(runDir, record);
    appendEvent(runDir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    await tickReviewer({
      deps: {
        env: { COMBO_CHEN_HOME: home },
        out: (line) => out.push(line),
        tmux: () => ({ status: 0, stdout: "", stderr: "" }),
        git: () => ({ status: 0, stdout: "", stderr: "" }),
        gh: (args) => {
          if (args[0] === "pr") {
            return { status: 0, stdout: '{"headRefOid":"def4560","state":"OPEN"}', stderr: "" };
          }
          if (args.join(" ").includes("issues/7/comments")) {
            return {
              status: 0,
              stdout: JSON.stringify([
                {
                  body: "lgtm @ def4560",
                  user: { login: "drive-by" },
                  created_at: "2026-06-11T00:00:00Z",
                },
              ]),
              stderr: "",
            };
          }
          if (args.join(" ").includes("pulls/7/reviews")) {
            return { status: 0, stdout: "[]", stderr: "" };
          }
          return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
        },
        sleep: () => Promise.resolve(),
      },
      home,
      comboId: record.id,
    });

    expect(readEvents(runDir).map((event) => event.event)).toEqual(["pr_opened"]);
    expect(out).toEqual(["reviewer: no pinned lgtm for o-r-7"]);
  });
});
// -/ 4/4
