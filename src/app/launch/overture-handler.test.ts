/**
 * @overview Overture launch handler integration tests.
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
 * @deps ../../cli/main.test-harness
 */

import {
  ISSUE,
  defaultDeps,
  describe,
  exec,
  expect,
  fakeDeps,
  home,
  it,
  join,
  mkdirSync,
  mkdtempSync,
  readConfigSnapshot,
  readEvents,
  readFileSync,
  runDirFor,
  tmpdir,
  writeFileSync,
} from "../../cli/main.test-harness.js";

// -- 1/1 CORE · command contracts <- START HERE --
describe("overture", () => {
  it("runs overture directly for a clean issue without creating launch resources", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["overture", "--issue", ISSUE, "--repo", repoDir]);

    expect(out).toContain("overture o-r-7");
    expect(out).toContain(`OK work_item_readable: ${ISSUE}`);
    expect(out).toContain("OK branch_free: combo/issue-7");
    expect(out).toContain(`OK no_mistakes_available: ${repoDir}`);
    expect(out).toContain("OK no_mistakes_run_free: combo/issue-7 no active run");
    expect(out).toContain("OK team_identity: team undeclared; identity check skipped");
    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(
      false,
    );
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-session")).toBe(false);

    const artifact = JSON.parse(readFileSync(join(runDirFor(h, "o-r-7"), "overture.json"), "utf8")) as {
      ok: boolean;
      resources: { comboId: string; branch: string; worktree: string; tmuxSession: string };
      checks: Array<{ id: string; status: string; resource: string }>;
    };
    expect(artifact.ok).toBe(true);
    expect(artifact.resources).toMatchObject({
      comboId: "o-r-7",
      branch: "combo/issue-7",
      worktree: join(repoDir, ".worktrees", "issue-7"),
      tmuxSession: "combo-chen-o-r-7",
    });
    expect(artifact.checks).toContainEqual({
      id: "branch_free",
      status: "ok",
      resource: "combo/issue-7",
    });
    expect(artifact.checks).toContainEqual({
      id: "no_mistakes_available",
      status: "ok",
      resource: repoDir,
    });
    expect(artifact.checks).toContainEqual({
      id: "team_identity",
      status: "ok",
      resource: "team",
      detail: "undeclared; identity check skipped",
    });
  });

  it("passes overture when declared team identity matches the resolved gatekeeper", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      ["[team.gatekeeper]", 'binary = "no-mistakes"', 'agent = "claude"', 'model = "opus"'].join("\n"),
    );
    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      resolveTeamIdentity: (role) => ({
        role,
        identity: { binary: "no-mistakes", agent: "claude", model: "opus" },
      }),
    });

    await exec(deps, ["overture", "--issue", ISSUE, "--repo", repoDir]);

    const rendered = out.join("\n");
    expect(rendered).toContain("OK team_identity: team");
    expect(rendered).toContain("gatekeeper | no-mistakes/claude/opus | no-mistakes/claude/opus | match");

    const artifact = JSON.parse(readFileSync(join(runDirFor(h, "o-r-7"), "overture.json"), "utf8")) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; resource: string; detail?: string }>;
    };
    expect(artifact.ok).toBe(true);
    expect(artifact.checks).toContainEqual({
      id: "team_identity",
      status: "ok",
      resource: "team",
      detail: expect.stringContaining(
        "gatekeeper | no-mistakes/claude/opus | no-mistakes/claude/opus | match",
      ),
    });
  });

  it("passes overture with the production resolver for a declared gnhf codex coder", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const operatorHome = home();
    const codexHome = home();
    mkdirSync(join(operatorHome, ".gnhf"), { recursive: true });
    writeFileSync(
      join(operatorHome, ".gnhf", "config.yml"),
      ["agentArgsOverride:", "  codex:", "    - --profile", "    - sitter"].join("\n"),
    );
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5"\n');
    writeFileSync(join(codexHome, "sitter.config.toml"), 'model = "gpt-5.5"\n');
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      ["[team.coder]", 'binary = "npx"', 'agent = "gnhf/codex"', 'model = "gpt-5.5"'].join("\n"),
    );
    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h, HOME: operatorHome, CODEX_HOME: codexHome },
      resolveTeamIdentity: defaultDeps().resolveTeamIdentity,
    });

    await exec(deps, ["overture", "--issue", ISSUE, "--repo", repoDir]);

    const rendered = out.join("\n");
    expect(rendered).toContain("OK team_identity: team");
    expect(rendered).toContain("coder | npx/gnhf/codex/gpt-5.5 | npx/gnhf/codex/gpt-5.5 | match");
  });

  it("fails overture when the resolved gatekeeper agent mismatches the declared team", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      ["[team.gatekeeper]", 'binary = "no-mistakes"', 'agent = "claude"', 'model = "opus"'].join("\n"),
    );
    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      resolveTeamIdentity: (role) => ({
        role,
        identity: { binary: "no-mistakes", agent: "codex", model: "opus" },
      }),
    });

    await expect(exec(deps, ["overture", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /team_identity/,
    );

    const rendered = out.join("\n");
    expect(rendered).toContain("X team_identity: team");
    expect(rendered).toContain("gatekeeper | no-mistakes/claude/opus | no-mistakes/codex/opus | mismatch");

    const artifact = JSON.parse(readFileSync(join(runDirFor(h, "o-r-7"), "overture.json"), "utf8")) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; resource: string; detail?: string }>;
    };
    expect(artifact.ok).toBe(false);
    expect(artifact.checks).toContainEqual({
      id: "team_identity",
      status: "failed",
      resource: "team",
      detail: expect.stringContaining(
        "gatekeeper | no-mistakes/claude/opus | no-mistakes/codex/opus | mismatch",
      ),
    });
  });

  it("fails overture when only the resolved team model mismatches", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      ["[team.reviewer]", 'binary = "opencode"', 'agent = "claude"', 'model = "opus"'].join("\n"),
    );
    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      resolveTeamIdentity: (role) => ({
        role,
        identity: { binary: "opencode", agent: "claude", model: "sonnet" },
      }),
    });

    await expect(exec(deps, ["overture", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /team_identity/,
    );

    expect(out.join("\n")).toContain("reviewer | opencode/claude/opus | opencode/claude/sonnet | mismatch");
  });

  it("journals and snapshots the resolved team when launch identity is declared", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const gatekeeper = { binary: "no-mistakes", agent: "claude", model: "opus" };
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      [
        "[team.gatekeeper]",
        `binary = "${gatekeeper.binary}"`,
        `agent = "${gatekeeper.agent}"`,
        `model = "${gatekeeper.model}"`,
      ].join("\n"),
    );
    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      resolveTeamIdentity: (role) => ({ role, identity: gatekeeper }),
    });

    await exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir]);

    const runDir = runDirFor(h, "o-r-7");
    expect(readConfigSnapshot(runDir).resolvedTeam).toEqual({ gatekeeper });
    const events = readEvents(runDir);
    expect(events.map((event) => event.event).slice(0, 2)).toEqual(["combo_created", "team"]);
    expect(events[1]).toMatchObject({ event: "team", roles: { gatekeeper } });
  });

  it("runs overture directly for a clean local work plan and records the full resource ledger", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const planPath = join(repoDir, "launch-plan.md");
    writeFileSync(
      planPath,
      [
        "# Local plan runway",
        "",
        "## Problem",
        "A local plan should get the same deterministic runway as an issue.",
        "",
        "## Acceptance Criteria",
        "- The direct overture command records plan resources.",
      ].join("\n"),
    );
    const ghCalls: string[][] = [];
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      issueExists: () => {
        throw new Error("issue lookup should not run for --plan");
      },
      gh: (args) => {
        ghCalls.push(["gh", ...args]);
        return { status: 0, stdout: "[]", stderr: "" };
      },
    });

    await exec(deps, [
      "overture",
      "--plan",
      planPath,
      "--repo",
      repoDir,
      "--base",
      "origin/release-candidate",
    ]);

    const id = out[0]?.replace(/^overture\s+/, "") ?? "";
    expect(id).toMatch(/^plan-local-plan-runway-[0-9a-f]{8}$/);
    expect(out).toContain(`OK work_item_readable: ${planPath}`);
    expect(out).toContain(`OK base_ref_resolved: origin/release-candidate`);
    expect(out.every((line) => !line.startsWith("X "))).toBe(true);
    expect(ghCalls).toEqual([]);
    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(
      false,
    );
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-session")).toBe(false);

    const artifact = JSON.parse(readFileSync(join(runDirFor(h, id), "overture.json"), "utf8")) as {
      ok: boolean;
      resources: {
        comboId: string;
        base: string;
        baseRef: string;
        branch: string;
        runDir: string;
        sourceReference: string;
        sourceTitle: string;
        sourceType: string;
        tmuxSession: string;
        worktree: string;
      };
      checks: Array<{ id: string; status: string; resource: string }>;
    };
    expect(artifact.ok).toBe(true);
    expect(artifact.checks.every((check) => check.status === "ok")).toBe(true);
    expect(artifact.resources).toMatchObject({
      comboId: id,
      base: "origin/release-candidate",
      baseRef: "origin/release-candidate",
      branch: `combo/${id}`,
      runDir: runDirFor(h, id),
      sourceReference: "launch-plan.md",
      sourceTitle: "Local plan runway",
      sourceType: "local_file",
      tmuxSession: `combo-chen-${id}`,
      worktree: join(repoDir, ".worktrees", id),
    });
  });

  it("blocks an issue overture when the target repo origin cannot be confirmed", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "remote" && args[1] === "get-url" && args[2] === "origin") {
          return { status: 2, stdout: "", stderr: "error: No such remote 'origin'\n" };
        }
        if (args[0] === "branch" && args[1] === "--show-current")
          return { status: 0, stdout: "main\n", stderr: "" };
        if (args[0] === "status" && args[1] === "--porcelain") return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(exec(deps, ["overture", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /repo_matches_issue.*origin unavailable/,
    );

    expect(out).toContain("X repo_matches_issue: origin origin unavailable: error: No such remote 'origin'");
    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(
      false,
    );
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-session")).toBe(false);

    const artifact = JSON.parse(readFileSync(join(runDirFor(h, "o-r-7"), "overture.json"), "utf8")) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; resource: string; detail?: string }>;
    };
    expect(artifact.ok).toBe(false);
    expect(artifact.checks).toContainEqual({
      id: "repo_matches_issue",
      status: "failed",
      resource: "origin",
      detail: "origin unavailable: error: No such remote 'origin'",
    });
  });
});
// -/ 1/1
