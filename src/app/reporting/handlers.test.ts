/**
 * @overview Reporting application handler integration tests: remaining command contracts.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at the describe blocks  <- command contracts and their effects.
 *
 *   MAIN FLOW
 *   ---------
 *   shared fakeDeps -> createProgram -> extracted handler -> recorded effects
 *
 *   PUBLIC API
 *   ----------
 *   None (test file).
 *
 *   INTERNALS
 *   ---------
 *   Command-specific fixtures live inside their describe block.
 *
 * @exports none
 * @deps ../../testing/cli-harness
 */

import {
  PASSIVE_UPDATE_DISABLE_ENV,
  appendEvent,
  describe,
  exec,
  expect,
  fakeDeps,
  home,
  it,
  join,
  loadConfig,
  mkdirSync,
  mkdtempSync,
  runDirFor,
  seedNeedsHumanCombo,
  tmpdir,
  writeCombo,
  writeConfigSnapshot,
  writeFileSync,
} from "../../testing/cli-harness.js";

// -- 1/1 CORE · command contracts <- START HERE --
describe("forensics", () => {
  function seedIssueCombo(homeDir: string, id: string, issueNumber: number): string {
    const dir = runDirFor(homeDir, id);
    writeCombo(dir, {
      id,
      issueUrl: `https://github.com/o/r/issues/${issueNumber}`,
      repoDir: "/repos/r",
      worktree: `/repos/r/.worktrees/issue-${issueNumber}`,
      branch: `combo/issue-${issueNumber}`,
      tmuxSession: `combo-chen-${id}`,
      createdAt: "2026-06-11T10:00:00.000Z",
    });
    return dir;
  }

  it("renders a markdown report for selected issue numbers from local run logs", async () => {
    const h = home();
    const dir = seedIssueCombo(h, "o-r-7", 7);
    seedIssueCombo(h, "o-r-8", 8);
    writeFileSync(
      join(dir, "journal.jsonl"),
      [
        {
          t: "2026-06-11T10:00:00.000Z",
          event: "combo_created",
          issue_url: "https://github.com/o/r/issues/7",
        },
        { t: "2026-06-11T10:01:00.000Z", event: "coder_started" },
        { t: "2026-06-11T10:05:00.000Z", event: "coder_done" },
        { t: "2026-06-11T10:08:00.000Z", event: "pr_opened", url: "https://github.com/o/r/pull/9" },
        { t: "2026-06-11T10:10:00.000Z", event: "lgtm", sha: "abc123" },
        { t: "2026-06-11T10:12:00.000Z", event: "lgtm_stale", old_sha: "abc123", new_sha: "def456" },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
    );
    const { deps, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["forensics", "--issues", "7"]);

    expect(out.join("\n")).toContain("# combo-chen forensics");
    expect(out.join("\n")).toContain("## o-r-7");
    expect(out.join("\n")).toContain("Coder: 4m");
    expect(out.join("\n")).toContain("stale_lgtm_after_push");
    expect(out.join("\n")).not.toContain("## o-r-8");
  });

  it("reports an actionable no-match message for issue outcome lookups", async () => {
    const h = home();
    seedIssueCombo(h, "o-r-7", 7);
    const { deps, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["forensics", "--issues", "210"]);

    expect(out.join("\n")).toContain("# combo-chen forensics");
    expect(out.join("\n")).toContain(
      "No matching issue-backed combos for --issues 210 in this COMBO_CHEN_HOME.",
    );
    expect(out.join("\n")).toContain("Use -n <combo-id> for plan-backed runs or rerun after launch.");
  });

  it("refuses to record an incomplete outcome without a PR link and head SHA", async () => {
    const h = home();
    seedIssueCombo(h, "o-r-7", 7);
    const ghCalls: string[][] = [];
    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        ghCalls.push(args);
        if (args[0] === "issue" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({ state: "OPEN", closedAt: null }),
            stderr: "",
          };
        }
        if (args[0] === "issue" && args[1] === "comment") {
          return { status: 0, stdout: "https://github.com/o/r/issues/7#issuecomment-1\n", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await expect(exec(deps, ["forensics", "--issues", "7", "--record-outcome"])).rejects.toThrow(
      "Cannot record forensics outcome for o-r-7: missing PR link and head SHA",
    );

    expect(ghCalls.some((args) => args[0] === "issue" && args[1] === "comment")).toBe(false);
  });

  it("records the generated outcome block on the source issue when requested", async () => {
    const h = home();
    const dir = seedIssueCombo(h, "o-r-7", 7);
    writeFileSync(
      join(dir, "journal.jsonl"),
      [
        {
          t: "2026-06-11T10:00:00.000Z",
          event: "combo_created",
          issue_url: "https://github.com/o/r/issues/7",
        },
        { t: "2026-06-11T10:08:00.000Z", event: "pr_opened", url: "https://github.com/o/r/pull/9" },
        { t: "2026-06-11T10:09:00.000Z", event: "gate_validated", sha: "def4560" },
        { t: "2026-06-11T10:10:00.000Z", event: "lgtm", sha: "def4560" },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
    );
    const ghCalls: string[][] = [];
    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        ghCalls.push(args);
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: "def4560",
              state: "OPEN",
              mergeStateStatus: "CLEAN",
              statusCheckRollup: [
                { __typename: "CheckRun", name: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
                { __typename: "CheckRun", name: "CodeRabbit", status: "COMPLETED", conclusion: "SUCCESS" },
              ],
            }),
            stderr: "",
          };
        }
        if (args[0] === "issue" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({ state: "OPEN", closedAt: null }),
            stderr: "",
          };
        }
        if (args[0] === "api" && args.join(" ").includes("issues/9/comments")) {
          return {
            status: 0,
            stdout: JSON.stringify([
              { body: "lgtm @ def4560", user: { login: "claude" }, created_at: "2026-06-11T10:10:00Z" },
            ]),
            stderr: "",
          };
        }
        if (args[0] === "api" && args.join(" ").includes("pulls/9/reviews")) {
          return { status: 0, stdout: "[]", stderr: "" };
        }
        if (args[0] === "issue" && args[1] === "comment") {
          return { status: 0, stdout: "https://github.com/o/r/issues/7#issuecomment-1\n", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["forensics", "--issues", "7", "--record-outcome"]);

    const commentCall = ghCalls.find((args) => args[0] === "issue" && args[1] === "comment");
    expect(commentCall).toEqual([
      "issue",
      "comment",
      "https://github.com/o/r/issues/7",
      "--body",
      expect.stringContaining("combo-chen forensics outcome for `o-r-7`"),
    ]);
    const body = commentCall?.[4] ?? "";
    expect(body).toContain("- PR link: https://github.com/o/r/pull/9");
    expect(body).toContain("- Head SHA: def4560");
    expect(body).toContain("- Review/check state: reviewer=current");
    expect(body).toContain("- Failures found: none");
    expect(body).toContain("- Follow-up bugs: none recorded");
    expect(out.join("\n")).toContain(
      "forensics: recorded outcome for o-r-7 on https://github.com/o/r/issues/7",
    );
  });

  it("emits JSON reports with the same core facts", async () => {
    const h = home();
    const dir = seedIssueCombo(h, "o-r-7", 7);
    writeFileSync(
      join(dir, "journal.jsonl"),
      [
        {
          t: "2026-06-11T10:00:00.000Z",
          event: "combo_created",
          issue_url: "https://github.com/o/r/issues/7",
        },
        { t: "2026-06-11T10:08:00.000Z", event: "pr_opened", url: "https://github.com/o/r/pull/9" },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
    );
    const { deps, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["forensics", "--issues", "7", "--format", "json"]);

    const parsed = JSON.parse(out.join("\n")) as { reports: Array<{ id: string; prUrl?: string }> };
    expect(parsed.reports).toHaveLength(1);
    expect(parsed.reports[0]).toMatchObject({
      id: "o-r-7",
      prUrl: "https://github.com/o/r/pull/9",
    });
  });

  it("enriches reports with live GitHub PR and issue facts", async () => {
    const h = home();
    const openDir = seedIssueCombo(h, "o-r-7", 7);
    const mergedDir = seedIssueCombo(h, "o-r-8", 8);
    writeFileSync(
      join(openDir, "journal.jsonl"),
      [
        {
          t: "2026-06-11T10:00:00.000Z",
          event: "combo_created",
          issue_url: "https://github.com/o/r/issues/7",
        },
        { t: "2026-06-11T10:07:00.000Z", event: "pr_opened", url: "https://github.com/o/r/pull/9" },
        { t: "2026-06-11T10:08:00.000Z", event: "gate_validated", sha: "def456" },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
    );
    writeFileSync(
      join(mergedDir, "journal.jsonl"),
      [
        {
          t: "2026-06-11T11:00:00.000Z",
          event: "combo_created",
          issue_url: "https://github.com/o/r/issues/8",
        },
        { t: "2026-06-11T11:07:00.000Z", event: "pr_opened", url: "https://github.com/o/r/pull/10" },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
    );
    const ghCalls: string[][] = [];
    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        ghCalls.push(args);
        if (args[0] === "pr" && args[1] === "view" && args[2] === "https://github.com/o/r/pull/9") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: "def456",
              state: "OPEN",
              mergeStateStatus: "CLEAN",
              statusCheckRollup: [
                { __typename: "CheckRun", name: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
                {
                  __typename: "CheckRun",
                  name: "ExternalReview",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                },
              ],
            }),
            stderr: "",
          };
        }
        if (args[0] === "pr" && args[1] === "view" && args[2] === "https://github.com/o/r/pull/10") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: "999aaa",
              state: "MERGED",
              mergedAt: "2026-06-11T11:20:00.000Z",
              mergeStateStatus: "CLEAN",
              statusCheckRollup: [
                { __typename: "CheckRun", name: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
              ],
            }),
            stderr: "",
          };
        }
        if (args[0] === "issue" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({ state: "OPEN", closedAt: null }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["forensics", "--issues", "7,8", "--format", "json"]);

    const parsed = JSON.parse(out.join("\n")) as {
      reports: Array<{
        id: string;
        timeline: { mergedAt?: string };
        gates: {
          ci: string;
          issueClosed: boolean | "unknown";
          reviewer: { current: boolean; headSha?: string };
        };
        incidents: Array<{ id: string }>;
      }>;
    };
    const open = parsed.reports.find((report) => report.id === "o-r-7");
    const merged = parsed.reports.find((report) => report.id === "o-r-8");
    expect(open).toMatchObject({
      gates: {
        ci: "success",
        reviewer: { current: false, headSha: "def456" },
        issueClosed: false,
      },
    });
    expect(open?.incidents.map((incident) => incident.id)).toContain("missing_reviewer_verdict");
    expect(merged).toMatchObject({
      timeline: { mergedAt: "2026-06-11T11:20:00.000Z" },
      gates: { ci: "success", issueClosed: false },
    });
    expect(merged?.incidents.map((incident) => incident.id)).toContain("merged_pr_open_issue");
    expect(ghCalls).toContainEqual([
      "pr",
      "view",
      "https://github.com/o/r/pull/9",
      "--json",
      "headRefOid,state,mergedAt,mergeStateStatus,statusCheckRollup",
    ]);
    expect(ghCalls).toContainEqual([
      "issue",
      "view",
      "https://github.com/o/r/issues/8",
      "--json",
      "state,closedAt",
    ]);
  });

  it("uses the launch config snapshot for GitHub check classification after repo TOML changes", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(join(repoDir, "combo-chen.toml"), '[reviewer]\nambient = ["launch-bot"]\n');
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: "https://github.com/o/r/issues/7",
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: "2026-06-11T10:00:00.000Z",
    });
    writeConfigSnapshot(dir, loadConfig({ repoDir, env: {} }));
    writeFileSync(join(repoDir, "combo-chen.toml"), '[reviewer]\nambient = ["drift-bot"]\n');
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/9" });

    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: "def456",
              state: "OPEN",
              mergeStateStatus: "CLEAN",
              statusCheckRollup: [
                { __typename: "CheckRun", name: "launch-bot", status: "COMPLETED", conclusion: "FAILURE" },
                { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
              ],
            }),
            stderr: "",
          };
        }
        if (args[0] === "issue" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({ state: "OPEN", closedAt: null }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["forensics", "--issues", "7", "--format", "json"]);

    const parsed = JSON.parse(out.join("\n")) as {
      reports: Array<{ gates: { ci: string; ambientReviewer: string } }>;
    };
    expect(parsed.reports[0]?.gates).toMatchObject({
      ci: "success",
      ambientReviewer: "failure",
    });
  });

  it("reports plan work item facts by name without fetching a GitHub issue", async () => {
    const h = home();
    const id = "plan-let-plans-launch-combos-12345678";
    const planPath = "/plans/issue-134.md";
    const dir = runDirFor(h, id);
    writeCombo(dir, {
      id,
      issueUrl: "",
      workItemSourceType: "local_file",
      workItemSourceReference: planPath,
      workItemTitle: "Let plans launch combos",
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/plan-let-plans-launch-combos-12345678",
      branch: "combo/plan-let-plans-launch-combos-12345678",
      tmuxSession: `combo-chen-${id}`,
      createdAt: "2026-06-11T10:00:00.000Z",
    });
    appendEvent(dir, "combo_created", {
      issue_url: "",
      work_item_source_type: "local_file",
      work_item_source_reference: planPath,
      work_item_title: "Let plans launch combos",
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/44" });

    const ghCalls: string[][] = [];
    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        ghCalls.push(args);
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: "def456",
              state: "OPEN",
              statusCheckRollup: [{ __typename: "CheckRun", name: "CI", conclusion: "SUCCESS" }],
            }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["forensics", "-n", id, "--format", "json"]);

    const parsed = JSON.parse(out.join("\n")) as {
      reports: Array<{ workItem?: { title?: string; sourceType: string; sourceReference?: string } }>;
    };
    expect(parsed.reports[0]?.workItem).toMatchObject({
      title: "Let plans launch combos",
      sourceType: "local_file",
      sourceReference: planPath,
    });
    expect(ghCalls.some((call) => call[0] === "issue" && call[1] === "view")).toBe(false);
  });
});

describe("needs-human-report", () => {
  it("reports needs_human counts by reason", async () => {
    const h = home();
    const { deps, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h, [PASSIVE_UPDATE_DISABLE_ENV]: "1" } });
    const runDir = seedNeedsHumanCombo(h);
    appendEvent(runDir, "needs_human", { reason: "worker_stalled" });
    appendEvent(runDir, "needs_human", { reason: "worker_stalled" });
    appendEvent(runDir, "needs_human", { reason: "gate_decision" });

    await exec(deps, ["needs-human-report"]);

    expect(out).toContain("needs_human total: 3");
    expect(out).toContain("worker_stalled: 2");
    expect(out).toContain("gate_decision: 1");
  });

  it("reports worker_stalled events that later completed normally without another human request", async () => {
    const h = home();
    const { deps, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h, [PASSIVE_UPDATE_DISABLE_ENV]: "1" } });
    const runDir = seedNeedsHumanCombo(h);
    appendEvent(runDir, "needs_human", { reason: "worker_stalled", worker: "gatekeeper" });
    appendEvent(runDir, "ready_for_merge", {
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      pr_url: "https://github.com/o/r/pull/7",
    });
    appendEvent(runDir, "needs_human", { reason: "worker_stalled", worker: "reviewer" });
    appendEvent(runDir, "needs_human", { reason: "gate_decision" });
    appendEvent(runDir, "ready_for_merge", {
      sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      pr_url: "https://github.com/o/r/pull/7",
    });

    await exec(deps, ["needs-human-report"]);

    expect(out).toContain("worker_stalled followed by normal completion without human action: 1/2");
  });

  it("skips corrupted combos in needs_human reports", async () => {
    const h = home();
    const { deps, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h, [PASSIVE_UPDATE_DISABLE_ENV]: "1" } });
    const runDir = seedNeedsHumanCombo(h);
    appendEvent(runDir, "needs_human", { reason: "worker_stalled" });
    const badDir = runDirFor(h, "bad-combo");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "combo.json"), "{not json\n");

    await exec(deps, ["needs-human-report"]);

    expect(out.some((line) => line.startsWith("skipped bad-combo:"))).toBe(true);
    expect(out).toContain("needs_human total: 1");
    expect(out).toContain("worker_stalled: 1");
  });
});
// -/ 1/1
