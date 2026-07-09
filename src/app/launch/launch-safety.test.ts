/**
 * @overview Launch ordering and safety integration tests.
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
  CONFIG_SNAPSHOT_FILE,
  ISSUE,
  describe,
  exec,
  existsSync,
  expect,
  fakeDeps,
  home,
  it,
  join,
  mkdirSync,
  mkdtempSync,
  readEvents,
  readFileSync,
  runDirFor,
  tmpdir,
  writeFileSync,
} from "../../cli/main.test-harness.js";

// -- 1/1 CORE · command contracts <- START HERE --
describe("run ordering and safety", () => {
  it("leases the combo worktree from Treehouse and creates the branch from origin/main", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir]);

    expect(calls).toContainEqual(["git", `cwd=${repoDir}`, "fetch", "origin", "main"]);
    expect(calls).toContainEqual([
      "treehouse",
      `cwd=${repoDir}`,
      "get",
      "--lease",
      "--lease-holder",
      "o-r-7",
    ]);
    expect(calls).toContainEqual([
      "git",
      `cwd=${join(repoDir, ".worktrees", "issue-7")}`,
      "switch",
      "-c",
      "combo/issue-7",
      "origin/main",
    ]);
    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(
      false,
    );
  });

  it("allows --base to override the combo branch base ref", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir, "--base", "origin/release-candidate"]);

    expect(calls).toContainEqual([
      "git",
      `cwd=${join(repoDir, ".worktrees", "issue-7")}`,
      "switch",
      "-c",
      "combo/issue-7",
      "origin/release-candidate",
    ]);
  });

  it("refuses to launch from a dirty source checkout before creating the worktree", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "branch" && args[1] === "--show-current")
          return { status: 0, stdout: "main\n", stderr: "" };
        if (args[0] === "status" && args[1] === "--porcelain")
          return { status: 0, stdout: " M src/x.ts\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /uncommitted changes/,
    );

    expect(calls.some((c) => c[0] === "git" && c.includes("worktree") && c.includes("add"))).toBe(false);
  });

  it("prints overture and blocks an existing local branch before creating launch resources", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "branch" && args[1] === "--show-current")
          return { status: 0, stdout: "main\n", stderr: "" };
        if (args[0] === "branch" && args[1] === "--list")
          return { status: 0, stdout: "combo/issue-7\n", stderr: "" };
        if (args[0] === "status" && args[1] === "--porcelain") return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /branch.*combo\/issue-7.*exists locally/,
    );

    expect(out).toContain("overture o-r-7");
    expect(out).toContain("X branch_free: combo/issue-7 already exists locally");
    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(
      false,
    );
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-session")).toBe(false);

    const artifact = JSON.parse(readFileSync(join(runDirFor(h, "o-r-7"), "overture.json"), "utf8")) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; detail?: string }>;
    };
    expect(artifact.ok).toBe(false);
    expect(artifact.checks).toContainEqual({
      id: "branch_free",
      resource: "combo/issue-7",
      status: "failed",
      detail: "already exists locally",
    });
  });

  it("prints overture and blocks an existing worktree path before creating launch resources", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    mkdirSync(worktree, { recursive: true });
    const { deps, calls, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /worktree_free.*path already exists/,
    );

    expect(out).toContain("overture o-r-7");
    expect(out).toContain(`X worktree_free: ${worktree} path already exists`);
    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(
      false,
    );
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-session")).toBe(false);
    expect(existsSync(join(runDirFor(h, "o-r-7"), "combo.json"))).toBe(false);

    const artifact = JSON.parse(readFileSync(join(runDirFor(h, "o-r-7"), "overture.json"), "utf8")) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; resource: string; detail?: string }>;
    };
    expect(artifact.ok).toBe(false);
    expect(artifact.checks).toContainEqual({
      id: "worktree_free",
      resource: worktree,
      status: "failed",
      detail: "path already exists",
    });
  });

  it("prints overture and blocks an existing tmux session before creating launch resources", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "has-session" && args.at(-1) === "combo-chen-o-r-7") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /tmux_session_free.*session already exists/,
    );

    expect(out).toContain("overture o-r-7");
    expect(out).toContain("X tmux_session_free: combo-chen-o-r-7 session already exists");
    expect(calls).toContainEqual(["tmux", "has-session", "-t", "combo-chen-o-r-7"]);
    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(
      false,
    );
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-session")).toBe(false);
    expect(existsSync(join(runDirFor(h, "o-r-7"), "combo.json"))).toBe(false);

    const artifact = JSON.parse(readFileSync(join(runDirFor(h, "o-r-7"), "overture.json"), "utf8")) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; resource: string; detail?: string }>;
    };
    expect(artifact.ok).toBe(false);
    expect(artifact.checks).toContainEqual({
      id: "tmux_session_free",
      resource: "combo-chen-o-r-7",
      status: "failed",
      detail: "session already exists",
    });
  });

  it("blocks an active no-mistakes run for the derived branch before creating launch resources", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: (args, cwd) => {
        calls.push(["no-mistakes", `cwd=${cwd}`, ...args]);
        expect(cwd).toBe(repoDir);
        if (args[0] === "status") return { status: 0, stdout: "daemon: running\n", stderr: "" };
        expect(args).toEqual(["axi", "status"]);
        return {
          status: 0,
          stdout: [
            "run:",
            '  id: "01KV-OLD"',
            "  branch: combo/issue-7",
            "  status: running",
            "  worktree: /repos/r/.worktrees/issue-7",
            "  steps[1]{step,status,findings,duration_ms}:",
            "    ci,running,0,0",
          ].join("\n"),
          stderr: "",
        };
      },
    });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /no_mistakes_run_free.*combo\/issue-7/,
    );

    expect(out).toContain("X no_mistakes_run_free: combo/issue-7 active no-mistakes run is running");
    expect(calls).toContainEqual(["no-mistakes", `cwd=${repoDir}`, "status"]);
    expect(calls).toContainEqual(["no-mistakes", `cwd=${repoDir}`, "axi", "status"]);
    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(
      false,
    );
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-session")).toBe(false);

    const artifact = JSON.parse(readFileSync(join(runDirFor(h, "o-r-7"), "overture.json"), "utf8")) as {
      ok: boolean;
      resources: { noMistakes?: { branch?: string; status?: string; worktree?: string } };
      checks: Array<{ id: string; status: string; resource: string; detail?: string }>;
    };
    expect(artifact.ok).toBe(false);
    expect(artifact.resources.noMistakes).toMatchObject({
      branch: "combo/issue-7",
      status: "running",
      worktree: "/repos/r/.worktrees/issue-7",
    });
    expect(artifact.checks).toContainEqual({
      id: "no_mistakes_run_free",
      resource: "combo/issue-7",
      status: "failed",
      detail: "active no-mistakes run is running",
    });
  });

  it("blocks an active no-mistakes run for the same worktree even when its branch differs", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: (args, cwd) => {
        calls.push(["no-mistakes", `cwd=${cwd}`, ...args]);
        if (args[0] === "status") return { status: 0, stdout: "daemon: running\n", stderr: "" };
        return {
          status: 0,
          stdout: [
            "run:",
            '  id: "01KV-OLD"',
            "  branch: combo/sibling-branch",
            "  status: running",
            `      worktree: "${worktree}"`,
            "  steps[1]{step,status,findings,duration_ms}:",
            "    ci,running,0,0",
          ].join("\n"),
          stderr: "",
        };
      },
    });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /no_mistakes_run_free.*issue-7/,
    );

    expect(out).toContain(`X no_mistakes_run_free: ${worktree} active no-mistakes run is running`);
    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(
      false,
    );
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-session")).toBe(false);

    const artifact = JSON.parse(readFileSync(join(runDirFor(h, "o-r-7"), "overture.json"), "utf8")) as {
      ok: boolean;
      resources: { noMistakes?: { branch?: string; status?: string; worktree?: string } };
      checks: Array<{ id: string; status: string; resource: string; detail?: string }>;
    };
    expect(artifact.ok).toBe(false);
    expect(artifact.resources.noMistakes).toMatchObject({
      branch: "combo/sibling-branch",
      status: "running",
      worktree,
    });
    expect(artifact.checks).toContainEqual({
      id: "no_mistakes_run_free",
      resource: worktree,
      status: "failed",
      detail: "active no-mistakes run is running",
    });
  });

  it("blocks a non-origin base ref that cannot be resolved locally before creating launch resources", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "rev-parse" && args[1] === "--verify") {
          return { status: 128, stdout: "", stderr: "fatal: Needed a single revision\n" };
        }
        if (args[0] === "branch" && args[1] === "--show-current")
          return { status: 0, stdout: "main\n", stderr: "" };
        if (args[0] === "status" && args[1] === "--porcelain") return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(
      exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir, "--base", "feature/missing"]),
    ).rejects.toThrow(/base_ref_resolved.*feature\/missing/);

    expect(out).toContain(
      "X base_ref_resolved: feature/missing git rev-parse --verify feature/missing failed: fatal: Needed a single revision",
    );
    expect(calls).toContainEqual(["git", `cwd=${repoDir}`, "rev-parse", "--verify", "feature/missing"]);
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
      id: "base_ref_resolved",
      resource: "feature/missing",
      status: "failed",
      detail: "git rev-parse --verify feature/missing failed: fatal: Needed a single revision",
    });
  });

  it("refuses to launch from a non-main source checkout before creating the worktree", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "branch" && args[1] === "--show-current")
          return { status: 0, stdout: "docs/launch-combo-resume\n", stderr: "" };
        if (args[0] === "status" && args[1] === "--porcelain") return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(/must be on main/);

    expect(calls.some((c) => c[0] === "git" && c.includes("worktree") && c.includes("add"))).toBe(false);
  });

  it("allows the required source branch to come from run config", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(join(repoDir, "combo-chen.toml"), '[run]\nsource_branch = "develop"\n');
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "branch" && args[1] === "--show-current")
          return { status: 0, stdout: "develop\n", stderr: "" };
        if (args[0] === "status" && args[1] === "--porcelain") return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir]);

    expect(calls).toContainEqual([
      "git",
      `cwd=${join(repoDir, ".worktrees", "issue-7")}`,
      "switch",
      "-c",
      "combo/issue-7",
      "origin/main",
    ]);
  });

  it("rejects an unsafe gnhf coder command before creating a worktree or tmux session", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      '[coder.codex]\ncommand = "npx -y gnhf --agent codex --current-branch {prompt}"\n',
    );
    const { deps, calls } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /Unsafe coder invocation/,
    );

    expect(calls.some((c) => c[0] === "git" && c.includes("worktree") && c.includes("add"))).toBe(false);
    expect(calls.some((c) => c[0] === "tmux" && c[1] === "new-session")).toBe(false);
    expect(existsSync(join(runDirFor(h, "o-r-7"), "overture.json"))).toBe(true);
    expect(existsSync(join(runDirFor(h, "o-r-7"), "combo.json"))).toBe(false);
  });

  it("rejects an unsafe reviewer command before creating a worktree or tmux session", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      '[reviewer.claude]\ncommand = "claude {prompt} && rm -f /tmp/review.md"\n',
    );
    const { deps, calls } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /reviewer command must be one plain command/,
    );

    expect(calls.some((c) => c[0] === "git" && c.includes("worktree") && c.includes("add"))).toBe(false);
    expect(calls.some((c) => c[0] === "tmux" && c[1] === "new-session")).toBe(false);
    expect(existsSync(join(runDirFor(h, "o-r-7"), "overture.json"))).toBe(true);
    expect(existsSync(join(runDirFor(h, "o-r-7"), "combo.json"))).toBe(false);
  });

  it("journals combo_created before the tmux session starts", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    let journalAtSessionStart: string[] | undefined;
    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        if (args[0] === "has-session") return { status: 1, stdout: "", stderr: "" };
        if (args[0] === "new-session") {
          journalAtSessionStart = readEvents(runDirFor(h, "o-r-7")).map((e) => e.event);
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir]);

    expect(journalAtSessionStart).toEqual(["combo_created"]);
  });

  it("prints overture and blocks a repo origin mismatch before creating launch resources", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const mismatchedOrigin = "git@github.com:someone/else.git";
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "remote" && args[1] === "get-url" && args[2] === "origin") {
          return { status: 0, stdout: `${mismatchedOrigin}\n`, stderr: "" };
        }
        if (args[0] === "branch" && args[1] === "--show-current")
          return { status: 0, stdout: "main\n", stderr: "" };
        if (args[0] === "status" && args[1] === "--porcelain") return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /repo_matches_issue.*someone\/else/,
    );

    expect(out).toContain("overture o-r-7");
    expect(out).toContain(`X repo_matches_issue: ${mismatchedOrigin} origin mismatch; issue belongs to o/r`);
    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(
      false,
    );
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-session")).toBe(false);
    expect(existsSync(join(runDirFor(h, "o-r-7"), "combo.json"))).toBe(false);

    const artifact = JSON.parse(readFileSync(join(runDirFor(h, "o-r-7"), "overture.json"), "utf8")) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; resource: string; detail?: string }>;
    };
    expect(artifact.ok).toBe(false);
    expect(artifact.checks).toContainEqual({
      id: "repo_matches_issue",
      resource: mismatchedOrigin,
      status: "failed",
      detail: "origin mismatch; issue belongs to o/r",
    });
  });

  it("refuses an origin that merely contains the issue's owner/repo as a prefix", async () => {
    // o/r-fork contains "o/r"; only exact slug equality may pass the guard.
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const origin = "git@github.com:o/r-fork.git";
    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args) =>
        args[0] === "remote"
          ? { status: 0, stdout: `${origin}\n`, stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
    });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(/origin/i);

    const artifact = JSON.parse(readFileSync(join(runDirFor(h, "o-r-7"), "overture.json"), "utf8")) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; resource: string; detail?: string }>;
    };
    expect(artifact.ok).toBe(false);
    expect(artifact.checks).toContainEqual({
      id: "repo_matches_issue",
      resource: origin,
      status: "failed",
      detail: "origin mismatch; issue belongs to o/r",
    });
  });

  it("rolls back the run dir, the worktree, and the branch when config snapshot write fails", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const runDir = runDirFor(h, "o-r-7");
    const snapshotPath = join(runDir, CONFIG_SNAPSHOT_FILE);
    const teardownSnapshots: Array<{ step: string; runDirExists: boolean; comboExists: boolean }> = [];
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "branch" && args[1] === "--show-current")
          return { status: 0, stdout: "main\n", stderr: "" };
        if (args[0] === "status" && args[1] === "--porcelain") return { status: 0, stdout: "", stderr: "" };
        if (args[0] === "switch" && args[1] === "-c") {
          mkdirSync(snapshotPath, { recursive: true });
        }
        if (args[0] === "branch" && args[1] === "-D") {
          teardownSnapshots.push({
            step: "branch-delete",
            runDirExists: existsSync(runDir),
            comboExists: existsSync(join(runDir, "combo.json")),
          });
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      treehouse: (args, cwd) => {
        calls.push(["treehouse", `cwd=${cwd}`, ...args]);
        if (args[0] === "return") {
          teardownSnapshots.push({
            step: "treehouse-return",
            runDirExists: existsSync(runDir),
            comboExists: existsSync(join(runDir, "combo.json")),
          });
        }
        return { status: 0, stdout: `${join(repoDir, ".worktrees", "issue-7")}\n`, stderr: "" };
      },
    });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      CONFIG_SNAPSHOT_FILE,
    );

    const treehouseGetIndex = calls.findIndex((c) => c[0] === "treehouse" && c.includes("get"));
    const treehouseReturnIndex = calls.findIndex((c) => c[0] === "treehouse" && c.includes("return"));
    const branchDeleteIndex = calls.findIndex(
      (c) => c[0] === "git" && c.includes("branch") && c.includes("-D"),
    );
    expect(treehouseGetIndex).toBeGreaterThan(-1);
    expect(calls[treehouseReturnIndex]).toEqual([
      "treehouse",
      `cwd=${repoDir}`,
      "return",
      "--force",
      join(repoDir, ".worktrees", "issue-7"),
    ]);
    expect(calls[branchDeleteIndex]).toEqual(["git", `cwd=${repoDir}`, "branch", "-D", "combo/issue-7"]);
    expect(treehouseReturnIndex).toBeGreaterThan(treehouseGetIndex);
    expect(branchDeleteIndex).toBeGreaterThan(treehouseReturnIndex);
    expect(teardownSnapshots).toEqual([
      { step: "treehouse-return", runDirExists: false, comboExists: false },
      { step: "branch-delete", runDirExists: false, comboExists: false },
    ]);
    expect(existsSync(runDir)).toBe(false);
    expect(calls.some((c) => c[0] === "tmux" && c[1] === "new-session")).toBe(false);
  });

  it("rolls back the run dir, the worktree, and the branch when tmux fails to start the session", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) =>
        args[0] === "new-session"
          ? { status: 1, stdout: "", stderr: "no terminal" }
          : { status: 1, stdout: "", stderr: "" },
    });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(/tmux/i);

    const treehouseReturnIndex = calls.findIndex((c) => c[0] === "treehouse" && c.includes("return"));
    const treehouseReturn = calls[treehouseReturnIndex];
    expect(treehouseReturn).toBeDefined();
    expect(treehouseReturn).toContain("return");
    expect(treehouseReturn).toContain("--force");
    expect(treehouseReturn).toContain(join(repoDir, ".worktrees", "issue-7"));

    // Retry after a tmux failure must be idempotent: the branch created by
    // `git switch -c` has to go too, and only after Treehouse returned the
    // worktree so the branch is no longer checked out there.
    const branchDeleteIndex = calls.findIndex(
      (c) => c[0] === "git" && c.includes("branch") && c.includes("-D"),
    );
    const branchDelete = calls[branchDeleteIndex];
    expect(branchDelete).toBeDefined();
    expect(branchDelete).toContain(`cwd=${repoDir}`);
    expect(branchDelete).toContain("combo/issue-7");
    expect(treehouseReturnIndex).toBeLessThan(branchDeleteIndex);

    expect(existsSync(runDirFor(h, "o-r-7"))).toBe(false);
  });

  it("rejects and rolls back a dirty Treehouse lease before creating the combo branch", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "branch" && args[1] === "--show-current") {
          return { status: 0, stdout: "main\n", stderr: "" };
        }
        if (args[0] === "status" && args[1] === "--porcelain" && cwd.includes(".worktrees/issue-7")) {
          return { status: 0, stdout: "?? residue\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /treehouse lease returned dirty worktree/,
    );

    expect(calls).toContainEqual([
      "treehouse",
      `cwd=${repoDir}`,
      "return",
      "--force",
      join(repoDir, ".worktrees", "issue-7"),
    ]);
    expect(calls).toContainEqual(["git", `cwd=${repoDir}`, "branch", "-D", "combo/issue-7"]);
    expect(calls.some((c) => c[0] === "git" && c.includes("switch"))).toBe(false);
    expect(existsSync(runDirFor(h, "o-r-7"))).toBe(false);
  });

  it("accepts an exact owner/repo match in ssh and https shapes, case-insensitively", async () => {
    for (const remoteUrl of [
      "git@github.com:o/r.git",
      "https://github.com/o/r.git",
      "https://github.com/O/R",
    ]) {
      const { deps } = fakeDeps({
        env: { COMBO_CHEN_HOME: home() },
        git: (args) => {
          if (args[0] === "remote") return { status: 0, stdout: `${remoteUrl}\n`, stderr: "" };
          if (args[0] === "branch" && args[1] === "--show-current") {
            return { status: 0, stdout: "main\n", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      });

      await expect(
        exec(deps, ["run", "--issue", ISSUE, "--repo", mkdtempSync(join(tmpdir(), "combo-chen-repo-"))]),
      ).resolves.toBeUndefined();
    }
  });
});
// -/ 1/1
