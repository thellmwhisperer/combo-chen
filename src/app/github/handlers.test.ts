/**
 * @overview GitHub application handler integration tests.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at the describe blocks  <- each preserves one extracted command contract.
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
  ISSUE,
  buildIssuePrIntent,
  buildWorkPlanPrIntent,
  describe,
  exec,
  expect,
  fakeDeps,
  home,
  it,
  join,
  normalizeMarkdownWorkPlan,
  readFileSync,
  renderWorkPlanMarkdown,
  runDirFor,
  writeCombo,
  writeFileSync,
} from "../../testing/cli-harness.js";

describe("intent and PR autoclose", () => {
  it("prints the canonical issue PR intent with the verbatim autoclose requirement", async () => {
    const h = home();
    writeCombo(runDirFor(h, "o-r-7"), {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    const ghCalls: string[][] = [];
    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        ghCalls.push(["gh", ...args]);
        if (args[0] === "issue" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({ title: "My title", body: "My body" }),
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["intent", "-n", "o-r-7"]);

    expect(ghCalls[0]).toEqual(["gh", "issue", "view", ISSUE, "--json", "title,body"]);
    expect(out).toEqual([
      [
        "Implement GitHub issue https://github.com/o/r/issues/7.",
        "",
        "Title: My title",
        "",
        "Pull request body requirement:",
        "Include this exact visible line verbatim in the PR body, outside comments, code blocks, or collapsed details:",
        "Fixes #7",
        "",
        "Issue body:",
        "My body",
      ].join("\n"),
    ]);
  });

  it("prints exactly the canonical buildIssuePrIntent, preserving shell-special content byte-for-byte", async () => {
    const h = home();
    writeCombo(runDirFor(h, "o-r-7"), {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    // Same intent the runner pushes (run command, main.ts:256) flows through the
    // same buildIssuePrIntent. Pin that the intent command introduces no
    // transformation, even for content with shell-special characters.
    const title = 'Fix `$(rm -rf)` in "quoted" ${VAR} path';
    const body = 'Line 1 with `backticks`\nLine 2 with $(cmd) and "quotes"\n\\backslash tail';
    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        if (args[0] === "issue" && args[1] === "view") {
          return { status: 0, stdout: JSON.stringify({ title, body }), stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["intent", "-n", "o-r-7"]);

    expect(out).toEqual([
      buildIssuePrIntent({ combo: { issueUrl: ISSUE }, issueTitle: title, issueBody: body }),
    ]);
  });

  it("omits the issue body section but keeps the autoclose line when the issue has no body", async () => {
    const h = home();
    writeCombo(runDirFor(h, "o-r-7"), {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        if (args[0] === "issue" && args[1] === "view") {
          // GitHub returns body: null (not "") for an issue with no body.
          return { status: 0, stdout: JSON.stringify({ title: "My title", body: null }), stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["intent", "-n", "o-r-7"]);

    expect(out).toHaveLength(1);
    expect(out[0]).toContain("Fixes #7");
    expect(out[0]).not.toContain("Issue body:");
  });

  it("throws and writes nothing to stdout when the issue fetch fails", async () => {
    const h = home();
    writeCombo(runDirFor(h, "o-r-7"), {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        if (args[0] === "issue" && args[1] === "view") {
          return { status: 1, stdout: "", stderr: "gh: not found" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    // On failure the command must throw and leave stdout empty: nothing partial
    // is ever emitted as if it were a canonical intent.
    await expect(exec(deps, ["intent", "-n", "o-r-7"])).rejects.toThrow(/Issue details not reachable/);
    expect(out).toEqual([]);
  });

  it("throws and writes nothing to stdout for an unknown combo id", async () => {
    const h = home();
    const { deps, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await expect(exec(deps, ["intent", "-n", "missing"])).rejects.toThrow();
    expect(out).toEqual([]);
  });

  it("prints the persisted work-plan intent without fetching a GitHub issue", async () => {
    const h = home();
    const dir = runDirFor(h, "plan-generic-work-1234abcd");
    const plan = normalizeMarkdownWorkPlan({
      markdown: [
        "# Generic work",
        "",
        "## Problem",
        "GitHub issues are only one carrier.",
        "",
        "## Acceptance Criteria",
        "- Plan-backed intent is inspectable without an issue URL.",
        "",
        "## Validation",
        "- pnpm test",
      ].join("\n"),
      source: { type: "local_file", reference: "/plans/generic-work.md" },
    });
    writeCombo(dir, {
      id: "plan-generic-work-1234abcd",
      issueUrl: "",
      workItemSourceType: "local_file",
      workItemSourceReference: "/plans/generic-work.md",
      workItemTitle: "Generic work",
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/plan-generic-work-1234abcd",
      branch: "combo/plan-generic-work-1234abcd",
      tmuxSession: "combo-chen-plan-generic-work-1234abcd",
      createdAt: new Date().toISOString(),
    });
    writeFileSync(join(dir, "work-plan.md"), renderWorkPlanMarkdown(plan));
    const ghCalls: string[][] = [];
    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        ghCalls.push(["gh", ...args]);
        return { status: 1, stdout: "", stderr: "GitHub should not be consulted" };
      },
    });

    await exec(deps, ["intent", "-n", "plan-generic-work-1234abcd"]);

    expect(ghCalls).toEqual([]);
    expect(out).toEqual([buildWorkPlanPrIntent(plan)]);
  });

  it("ensures a generated PR body has a visible source issue autoclose line", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    const ghCalls: string[][] = [];
    let viewed = 0;
    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        ghCalls.push(["gh", ...args]);
        if (args[0] === "pr" && args[1] === "view") {
          viewed += 1;
          if (viewed === 2) {
            return {
              status: 0,
              stdout: "Fixes #7\n\n## Intent\n\nThis mentions issue #7.\n",
              stderr: "",
            };
          }
          return {
            status: 0,
            stdout: "## Intent\n\nThis mentions issue #7.\n\n```text\nFixes #7\n```\n",
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["ensure-pr-autoclose", "-n", "o-r-7", "--pr-url", "https://github.com/o/r/pull/9"]);

    expect(ghCalls[0]).toEqual([
      "gh",
      "pr",
      "view",
      "https://github.com/o/r/pull/9",
      "--json",
      "body",
      "--jq",
      ".body",
    ]);
    expect(ghCalls[1]?.slice(0, 5)).toEqual([
      "gh",
      "pr",
      "edit",
      "https://github.com/o/r/pull/9",
      "--body-file",
    ]);
    const bodyPath = ghCalls[1]?.[5];
    expect(bodyPath).toBe(join(dir, "pr-body.autoclose.md"));
    expect(readFileSync(bodyPath!, "utf8")).toBe(
      "Fixes #7\n\n## Intent\n\nThis mentions issue #7.\n\n```text\nFixes #7\n```\n",
    );
    expect(ghCalls[2]).toEqual([
      "gh",
      "pr",
      "view",
      "https://github.com/o/r/pull/9",
      "--json",
      "body",
      "--jq",
      ".body",
    ]);
    expect(out).toEqual(["pr autoclose ensured for o-r-7"]);
  });

  it("leaves a PR body unchanged when a visible autoclose line already exists", async () => {
    const h = home();
    writeCombo(runDirFor(h, "o-r-7"), {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    const ghCalls: string[][] = [];
    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        ghCalls.push(["gh", ...args]);
        return { status: 0, stdout: "## Intent\n\nFixes #7\n", stderr: "" };
      },
    });

    await exec(deps, ["ensure-pr-autoclose", "-n", "o-r-7", "--pr-url", "https://github.com/o/r/pull/9"]);

    expect(ghCalls).toHaveLength(1);
    expect(out).toEqual(["pr autoclose already present for o-r-7"]);
  });

  it("reports a gh pr view failure while ensuring PR autoclose", async () => {
    const h = home();
    writeCombo(runDirFor(h, "o-r-7"), {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: () => ({ status: 1, stdout: "", stderr: "no pr" }),
    });

    await expect(
      exec(deps, ["ensure-pr-autoclose", "-n", "o-r-7", "--pr-url", "https://github.com/o/r/pull/9"]),
    ).rejects.toThrow("gh pr view failed for https://github.com/o/r/pull/9: no pr");
  });

  it("reports a gh pr edit failure while ensuring PR autoclose", async () => {
    const h = home();
    writeCombo(runDirFor(h, "o-r-7"), {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return { status: 0, stdout: "## Intent\n\nmentions issue #7\n", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "edit rejected" };
      },
    });

    await expect(
      exec(deps, ["ensure-pr-autoclose", "-n", "o-r-7", "--pr-url", "https://github.com/o/r/pull/9"]),
    ).rejects.toThrow("gh pr edit failed for https://github.com/o/r/pull/9: edit rejected");
  });

  it("reports a verification failure when the edited PR body still lacks autoclose", async () => {
    const h = home();
    writeCombo(runDirFor(h, "o-r-7"), {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return { status: 0, stdout: "## Intent\n\nmentions issue #7\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(
      exec(deps, ["ensure-pr-autoclose", "-n", "o-r-7", "--pr-url", "https://github.com/o/r/pull/9"]),
    ).rejects.toThrow(
      "pr autoclose verification failed for https://github.com/o/r/pull/9: body still lacks a visible GitHub autoclose keyword for o-r-7",
    );
  });
});
