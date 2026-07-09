/**
 * @overview Gate application handler integration tests.
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
 * @deps ../../cli/main.test-harness
 */

import {
  ISSUE,
  appendEvent,
  decodedGeneratedGatekeeperIntent,
  describe,
  exec,
  existsSync,
  expect,
  fakeDeps,
  home,
  it,
  join,
  normalizeMarkdownWorkPlan,
  readEvents,
  readFileSync,
  renderWorkPlanMarkdown,
  runDirFor,
  type Deps,
  writeCombo,
  writeFileSync,
} from "../../cli/main.test-harness.js";

describe("gate-restart", () => {
  const HEAD = "abcdef012345abcdef012345abcdef0123456789";

  function gateDeps(h: string, overrides: Partial<Deps> = {}): ReturnType<typeof fakeDeps> {
    return fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, _cwd) => {
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return { status: 0, stdout: `${HEAD}\n`, stderr: "" };
        }
        if (args[0] === "status" && args[1] === "--porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      ...overrides,
    });
  }

  it("with no PR, restarts the initial gate with the canonical intent and autoclose guard", async () => {
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
    const { deps, calls, out } = gateDeps(h);

    await exec(deps, ["gate-restart", "-n", "o-r-7"]);

    // The restart goes through the real gate script, which bakes in the
    // canonical intent and the autoclose guard. No improvised axi run.
    const script = readFileSync(join(dir, `gatekeeper-initial-${HEAD.slice(0, 12)}.sh`), "utf8");
    expect(script).toContain("ensure-pr-autoclose");
    expect(calls.some((c) => c[0] === "tmux" && c.includes("new-window"))).toBe(true);
    expect(out.join("\n")).toContain("initial gate restarted");
  });

  it("with a PR open and a failed gate at HEAD, force-restarts the post-address gate", async () => {
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
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/9" });
    // The exact recovery case: a gate already FAILED at this same head. The
    // idempotent director path would no-op here; gate-restart must force it.
    appendEvent(dir, "gate_status", { state: "failed", head_sha: HEAD });
    const { deps, calls, out } = gateDeps(h);

    await exec(deps, ["gate-restart", "-n", "o-r-7"]);

    const script = readFileSync(join(dir, `gatekeeper-post-${HEAD.slice(0, 12)}.sh`), "utf8");
    expect(script).toContain("ensure-pr-autoclose");
    expect(calls.some((c) => c[0] === "tmux" && c.includes("new-window"))).toBe(true);
    expect(existsSync(join(dir, `gatekeeper-initial-${HEAD.slice(0, 12)}.sh`))).toBe(false);
    expect(out.join("\n")).toContain("post-address gate restarted");
    // Parity with the idempotent path: leave an address_done breadcrumb so the
    // phase moves and there is a journal trace even before the gate emits.
    expect(readEvents(dir).some((e) => e.event === "address_done" && e["head_sha"] === HEAD)).toBe(true);
  });

  it("refuses a post-address gate restart when local HEAD omits the published PR head", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    const publishedSha = "1234567890abcdef1234567890abcdef12345678";
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/9" });
    appendEvent(dir, "gate_status", { state: "idle", head_sha: publishedSha });
    appendEvent(dir, "gate_validated", { sha: publishedSha });
    appendEvent(dir, "review_comment", {
      author: "coderabbitai[bot]",
      kind: "review_comment",
      url: "https://github.com/o/r/pull/9#discussion_r1",
      head_sha: publishedSha,
    });
    const { deps, calls, out } = gateDeps(h, {
      git: (args) => {
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return { status: 0, stdout: `${HEAD}\n`, stderr: "" };
        }
        if (args[0] === "status" && args[1] === "--porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (
          args[0] === "merge-base" &&
          args[1] === "--is-ancestor" &&
          args[2] === publishedSha &&
          args[3] === HEAD
        ) {
          return { status: 1, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["gate-restart", "-n", "o-r-7"]);

    expect(out.join("\n")).toContain("coder_worktree_out_of_sync");
    expect(out.join("\n")).toContain(`does not include published gate ${publishedSha}`);
    expect(calls.some((c) => c[0] === "tmux" && c.includes("new-window"))).toBe(false);
    expect(existsSync(join(dir, `gatekeeper-post-${HEAD.slice(0, 12)}.sh`))).toBe(false);
    expect(readEvents(dir).some((e) => e.event === "address_done" && e["head_sha"] === HEAD)).toBe(false);
    expect(readEvents(dir).some((e) => e.event === "gate_stale" && e["new_sha"] === HEAD)).toBe(false);
  });

  it("with a plan-backed PR open, restarts the post-address gate without issue fetch or autoclose guard", async () => {
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
        "- Plan-backed gates reuse the persisted plan artifact.",
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
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/9" });
    appendEvent(dir, "gate_status", { state: "failed", head_sha: HEAD });
    const ghCalls: string[][] = [];
    const { deps, calls, out } = gateDeps(h, {
      gh: (args) => {
        ghCalls.push(["gh", ...args]);
        return { status: 1, stdout: "", stderr: "GitHub should not be consulted" };
      },
    });

    await exec(deps, ["gate-restart", "-n", "plan-generic-work-1234abcd"]);

    const script = readFileSync(join(dir, `gatekeeper-post-${HEAD.slice(0, 12)}.sh`), "utf8");
    expect(ghCalls).toEqual([]);
    expect(decodedGeneratedGatekeeperIntent(script)).toContain("Implement work plan Generic work.");
    expect(script).not.toContain("ensure-pr-autoclose");
    // The autoclose guard command must be a no-op for plan combos.
    expect(script).toContain('if : "$pr_url" > "$autoclose_log" 2>&1; then');
    expect(calls.some((c) => c[0] === "tmux" && c.includes("new-window"))).toBe(true);
    expect(out.join("\n")).toContain("post-address gate restarted");
  });

  it("warns but still restarts when a gate is in flight (fix_inflight) at HEAD", async () => {
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
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/9" });
    appendEvent(dir, "gate_status", { state: "fix_inflight", head_sha: HEAD });
    const { deps, out } = gateDeps(h);

    await exec(deps, ["gate-restart", "-n", "o-r-7"]);

    // It is a force lever: it still restarts, but it must surface that a gate
    // was running so the director confirms a stall before clobbering it.
    expect(out.join("\n")).toContain("in flight");
    expect(out.join("\n")).toContain("post-address gate restarted");
    expect(existsSync(join(dir, `gatekeeper-post-${HEAD.slice(0, 12)}.sh`))).toBe(true);
  });
});
