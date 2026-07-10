/**
 * @overview Combo launch application handler integration tests.
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
  CONFIG_SNAPSHOT_FILE,
  ISSUE,
  chmodSync,
  decodedGeneratedGatekeeperIntent,
  describe,
  exec,
  existsSync,
  expect,
  fakeDeps,
  home,
  it,
  join,
  listCombos,
  mkdirSync,
  mkdtempSync,
  readConfigSnapshot,
  readEvents,
  readFileSync,
  runDirFor,
  shellQuote,
  spawnSync,
  tmpdir,
  writeFileSync,
} from "../../testing/cli-harness.js";

// -- 1/1 CORE · command contracts <- START HERE --
describe("run", () => {
  it("creates the record, the runner script, the tmux session, and the birth event", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir]);

    const runDir = runDirFor(h, "o-r-7");
    expect(existsSync(join(runDir, "combo.json"))).toBe(true);
    const ledger = JSON.parse(readFileSync(join(runDir, "runtime-ledger.json"), "utf8")) as {
      schemaVersion: number;
      comboId: string;
      repoDir: string;
      runDir: string;
      roleWindows: Record<string, string>;
      logs: Record<string, string>;
      commands: Record<string, string>;
      workItem: Record<string, string>;
      prUrl?: string;
    };
    expect(ledger).toMatchObject({
      schemaVersion: 1,
      comboId: "o-r-7",
      repoDir,
      runDir,
      branch: "combo/issue-7",
      worktree: join(repoDir, ".worktrees", "issue-7"),
      tmuxSession: "combo-chen-o-r-7",
      roleWindows: {
        journal: "journal",
        director: "director",
        coder: "coder",
        gatekeeper: "gatekeeper",
        reviewer: "reviewer",
        directorWatch: "director-watch",
      },
      logs: {
        gatekeeper: join(runDir, "gatekeeper.log"),
        autoclose: join(runDir, "autoclose.log"),
        rebase: join(runDir, "rebase.log"),
      },
      workItem: {
        sourceType: "github_issue",
        sourceReference: ISSUE,
        title: "Issue title",
        issueUrl: ISSUE,
      },
      promptTargets: {
        director: "combo-chen-o-r-7:director",
        workPlan: join(runDir, "work-plan.md"),
      },
    });
    expect(ledger.commands.resume).toContain("resume -n 'o-r-7'");
    expect(ledger.commands.eventsFollow).toContain("events --follow -n 'o-r-7'");
    expect(ledger.commands.attach).toContain("attach -n 'o-r-7'");
    expect(ledger.prUrl).toBeUndefined();
    expect(ledger.roleWindows).not.toHaveProperty("gateRunner");
    expect(existsSync(join(runDir, CONFIG_SNAPSHOT_FILE))).toBe(true);
    expect(readConfigSnapshot(runDir).roles).toMatchObject({
      coder: "codex",
      gatekeeper: "no-mistakes",
      merge: "human",
    });
    const runner = readFileSync(join(runDir, "runner.sh"), "utf8");
    expect(runner).toContain("gnhf");
    const daemonStart = runner.indexOf("no-mistakes daemon start");
    const mirrorPush = runner.indexOf('git push -o "$mirror_intent" no-mistakes');
    const axiRun = runner.indexOf("no-mistakes axi run");
    expect(daemonStart).toBeGreaterThan(-1);
    expect(mirrorPush).toBeGreaterThan(daemonStart);
    expect(axiRun).toBeGreaterThan(daemonStart);
    expect(axiRun).toBeGreaterThan(mirrorPush);
    expect(runner).toContain("mirror_intent='no-mistakes.intent=");
    expect(runner).not.toContain("activate-coder");
    expect(runner).toContain("activate-reviewer -n 'o-r-7'");

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
    expect(calls.some((c) => c[0] === "git" && c.includes("worktree") && c.includes("add"))).toBe(false);

    const tmuxNewSession = calls.find((c) => c[0] === "tmux" && c[1] === "new-session");
    expect(tmuxNewSession).toEqual([
      "tmux",
      "new-session",
      "-d",
      "-s",
      "combo-chen-o-r-7",
      "-n",
      "journal",
      expect.stringContaining("events --follow -n 'o-r-7'"),
    ]);
    const tmuxNewWindows = calls.filter((c) => c[0] === "tmux" && c[1] === "new-window");
    expect(tmuxNewWindows.map((call) => call[call.indexOf("-n") + 1])).toEqual([
      "director",
      "coder",
      "gatekeeper",
      "reviewer",
      "director-watch",
    ]);
    const coderWindow = tmuxNewWindows.find((call) => call[call.indexOf("-n") + 1] === "coder");
    expect(coderWindow).toEqual([
      "tmux",
      "new-window",
      "-t",
      "combo-chen-o-r-7",
      "-n",
      "coder",
      expect.stringContaining("COMBO_CHEN_RUNNER_PROGRESS=1 sh"),
    ]);
    const directorWindow = tmuxNewWindows.find((call) => call[call.indexOf("-n") + 1] === "director");
    expect(directorWindow).toEqual([
      "tmux",
      "new-window",
      "-t",
      "combo-chen-o-r-7",
      "-n",
      "director",
      expect.stringContaining("Combo director for o-r-7"),
    ]);
    expect(directorWindow?.at(-1)).toContain("claude");
    const gatekeeperWindow = tmuxNewWindows.find((call) => call.includes("gatekeeper"));
    expect(gatekeeperWindow).toEqual([
      "tmux",
      "new-window",
      "-t",
      "combo-chen-o-r-7",
      "-n",
      "gatekeeper",
      expect.stringContaining("no-mistakes attach"),
    ]);
    expect(gatekeeperWindow?.at(-1)).toContain(join(repoDir, ".worktrees", "issue-7"));
    const reviewerWindow = tmuxNewWindows.find((call) => call.includes("reviewer"));
    expect(reviewerWindow).toEqual([
      "tmux",
      "new-window",
      "-t",
      "combo-chen-o-r-7",
      "-n",
      "reviewer",
      expect.stringContaining("reviewer window idle"),
    ]);
    const directorWatchWindow = tmuxNewWindows.find((call) => call.includes("director-watch"));
    expect(directorWatchWindow).toEqual([
      "tmux",
      "new-window",
      "-t",
      "combo-chen-o-r-7",
      "-n",
      "director-watch",
      expect.stringContaining("director-tick -n 'o-r-7'"),
    ]);
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "split-window")).toBe(false);
    expect(calls.some((call) => call[1] === "select-pane")).toBe(false);

    const events = readEvents(runDir);
    expect(events[0]?.event).toBe("combo_created");
  });

  it("preserves human-readable role topology through a first-pass READY and closure path", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const prUrl = "https://github.com/o/r/pull/7";
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const mergeSha = "cccccccccccccccccccccccccccccccccccccccc";
    let prState: "OPEN" | "MERGED" = "OPEN";
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        calls.push(["gh", ...args]);
        if (args[0] === "issue" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({ title: "Issue title", body: "Issue body" }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        if (args[0] === "pr" && args[1] === "edit") return { status: 0, stdout: "", stderr: "" };
        if (args[0] === "pr" && args[1] === "view") {
          const fields = args.at(-1) ?? "";
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: headSha,
              state: prState,
              baseRefName: "main",
              mergeStateStatus: "CLEAN",
              mergeCommit: prState === "MERGED" ? { oid: mergeSha } : null,
              mergedAt: prState === "MERGED" ? "2026-06-11T10:12:00.000Z" : null,
              mergedBy: prState === "MERGED" ? { login: "maintainer" } : null,
              ...(fields.includes("labels") ? { labels: [] } : {}),
              statusCheckRollup: [
                { __typename: "CheckRun", name: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
                { __typename: "CheckRun", name: "CodeRabbit", status: "COMPLETED", conclusion: "SUCCESS" },
              ],
            }),
            stderr: "",
          };
        }
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir]);

    expect(out).toContain(
      "   topology: journal=journal · director=director · coder=coder · gatekeeper=gatekeeper · reviewer=reviewer · director-watch=director-watch · coder-response=coder",
    );
    const initialWindows = calls.filter((call) => call[0] === "tmux" && call[1] === "new-window");
    expect(calls.find((call) => call[0] === "tmux" && call[1] === "new-session")).toEqual([
      "tmux",
      "new-session",
      "-d",
      "-s",
      "combo-chen-o-r-7",
      "-n",
      "journal",
      expect.stringContaining("events --follow -n 'o-r-7'"),
    ]);
    expect(initialWindows.map((call) => call[call.indexOf("-n") + 1])).toEqual([
      "director",
      "coder",
      "gatekeeper",
      "reviewer",
      "director-watch",
    ]);
    expect(initialWindows.find((call) => call.includes("coder"))?.at(-1)).toContain(
      "COMBO_CHEN_RUNNER_PROGRESS=1 sh",
    );
    expect(initialWindows.find((call) => call.includes("gatekeeper"))?.at(-1)).toContain(
      "no-mistakes attach",
    );
    expect(initialWindows.find((call) => call.includes("reviewer"))?.at(-1)).toContain(
      "reviewer window idle",
    );
    expect(initialWindows.find((call) => call.includes("director-watch"))?.at(-1)).toContain("director-tick");
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "split-window")).toBe(false);
    expect(calls.some((call) => call.includes("coder-responding"))).toBe(false);

    await exec(deps, ["emit", "-n", "o-r-7", "pr_opened", "--field", `url=${prUrl}`]);
    await exec(deps, ["emit", "-n", "o-r-7", "gate_validated", "--field", `sha=${headSha}`]);
    await exec(deps, ["emit", "-n", "o-r-7", "lgtm", "--field", `sha=${headSha}`]);
    await exec(deps, ["director-tick", "-n", "o-r-7"]);

    expect(readEvents(runDirFor(h, "o-r-7"))).toContainEqual(
      expect.objectContaining({ event: "ready_for_merge", sha: headSha, pr_url: prUrl }),
    );
    const postReadyWindows = calls.filter((call) => call[0] === "tmux" && call[1] === "new-window");
    expect(postReadyWindows.map((call) => call[call.indexOf("-n") + 1])).toEqual([
      "director",
      "coder",
      "gatekeeper",
      "reviewer",
      "director-watch",
    ]);
    expect(calls.some((call) => call.includes("coder-responding"))).toBe(false);
    expect(out.some((line) => line.startsWith("director: watch "))).toBe(true);
    expect(out.some((line) => line === "director: tick complete for o-r-7")).toBe(false);

    prState = "MERGED";
    await exec(deps, ["closure", "-n", "o-r-7"]);

    expect(readEvents(runDirFor(h, "o-r-7"))).toContainEqual(
      expect.objectContaining({ event: "combo_closed", source: "closure" }),
    );
    expect(calls).toContainEqual(["tmux", "kill-session", "-t", "combo-chen-o-r-7"]);
    expect(calls.some((call) => call.includes("coder-responding"))).toBe(false);
  });

  it("launches from a local markdown plan and persists the normalized work-plan artifact", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const planPath = join(repoDir, "launch-plan.md");
    writeFileSync(
      planPath,
      [
        "# Let plans launch combos",
        "",
        "## Problem",
        "GitHub issues are currently the only launch carrier.",
        "",
        "## Scope Boundaries",
        "- Accept a local markdown plan.",
        "- Do not require a GitHub issue URL.",
        "",
        "## Acceptance Criteria",
        "- `combo-chen run --plan launch-plan.md --repo .` starts a combo.",
        "- The run records the normalized plan artifact.",
        "",
        "## Validation Commands",
        "- `pnpm test`",
      ].join("\n"),
    );
    const ghCalls: string[][] = [];
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      issueExists: () => {
        throw new Error("issue lookup should not run for --plan");
      },
      gh: (args) => {
        ghCalls.push(["gh", ...args]);
        return { status: 0, stdout: "[]", stderr: "" };
      },
    });

    await exec(deps, ["run", "--plan", planPath, "--repo", repoDir]);

    expect(ghCalls).toEqual([]);
    const [combo] = listCombos(h);
    expect(combo).toMatchObject({
      workItemSourceType: "local_file",
      workItemSourceReference: "launch-plan.md",
      workItemTitle: "Let plans launch combos",
    });
    expect(combo?.id).toMatch(/^plan-let-plans-launch-combos-[0-9a-f]{8}$/);
    expect(combo?.branch).toBe(`combo/${combo?.id}`);
    expect(combo?.worktree).toBe(join(repoDir, ".worktrees", combo?.id ?? ""));

    const runDir = runDirFor(h, combo!.id);
    const ledger = JSON.parse(readFileSync(join(runDir, "runtime-ledger.json"), "utf8")) as {
      schemaVersion: number;
      comboId: string;
      workItem: Record<string, string>;
      roleWindows: Record<string, string>;
      commands: Record<string, string>;
    };
    expect(ledger).toMatchObject({
      schemaVersion: 1,
      comboId: combo!.id,
      repoDir,
      runDir,
      branch: combo!.branch,
      worktree: combo!.worktree,
      tmuxSession: combo!.tmuxSession,
      roleWindows: {
        coder: "coder",
        gatekeeper: "gatekeeper",
        directorWatch: "director-watch",
      },
      workItem: {
        sourceType: "local_file",
        sourceReference: "launch-plan.md",
        title: "Let plans launch combos",
      },
      promptTargets: {
        workPlan: join(runDir, "work-plan.md"),
      },
    });
    expect(ledger.roleWindows).not.toHaveProperty("gateRunner");
    expect(ledger.commands.resume).toContain(`resume -n '${combo!.id}'`);

    const artifact = readFileSync(join(runDir, "work-plan.md"), "utf8");
    expect(artifact).toContain("# Let plans launch combos");
    expect(artifact).toContain("Source: local_file launch-plan.md");
    expect(artifact).not.toContain(planPath);
    expect(artifact).toContain("- The run records the normalized plan artifact.");

    const runner = readFileSync(join(runDir, "runner.sh"), "utf8");
    expect(runner).toContain("Implement work plan Let plans launch combos.");
    expect(runner).toContain("Read the normalized work plan artifact");
    expect(runner).toContain("no-mistakes axi run --intent");
    expect(runner).not.toContain("ensure-pr-autoclose");
    expect(runner).not.toContain("Fixes #");
    expect(spawnSync("sh", ["-n", join(runDir, "runner.sh")], { encoding: "utf8" }).status).toBe(0);

    expect(calls).toContainEqual([
      "treehouse",
      `cwd=${repoDir}`,
      "get",
      "--lease",
      "--lease-holder",
      combo!.id,
    ]);
    expect(calls).toContainEqual([
      "git",
      `cwd=${combo!.worktree}`,
      "switch",
      "-c",
      combo!.branch,
      "origin/main",
    ]);
    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(
      false,
    );
    const events = readEvents(runDir);
    expect(events[0]).toMatchObject({
      event: "combo_created",
      work_item_source_type: "local_file",
      work_item_source_reference: "launch-plan.md",
      work_item_title: "Let plans launch combos",
    });
  });

  it("redacts external markdown plan source references before persistence", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const externalDir = mkdtempSync(join(tmpdir(), "combo-chen-private-user-"));
    const planPath = join(externalDir, "secret-plan.md");
    writeFileSync(
      planPath,
      [
        "# External work",
        "",
        "## Problem",
        "The plan lives outside the target repo.",
        "",
        "## Acceptance Criteria",
        "- Persisted source references do not expose the external path.",
      ].join("\n"),
    );
    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      issueExists: () => {
        throw new Error("issue lookup should not run for --plan");
      },
    });

    await exec(deps, ["run", "--plan", planPath, "--repo", repoDir]);

    const [combo] = listCombos(h);
    expect(combo?.workItemSourceType).toBe("local_file");
    expect(combo?.workItemSourceReference).toMatch(/^external:[0-9a-f]{12}$/);
    expect(combo?.workItemSourceReference).not.toContain(externalDir);
    expect(combo?.id).toContain("plan-external-work-");

    const artifact = readFileSync(join(runDirFor(h, combo!.id), "work-plan.md"), "utf8");
    expect(artifact).toContain(`Source: local_file ${combo!.workItemSourceReference}`);
    expect(artifact).not.toContain(externalDir);
  });

  it("shell-quotes the combo id in runner command invocations", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const hostileIssue = "https://github.com/o; echo pwn/r's/issues/7";
    const hostileId = "o; echo pwn-r's-7";
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["run", "--issue", hostileIssue, "--repo", repoDir]);

    const runnerPath = join(runDirFor(h, hostileId), "runner.sh");
    const runner = readFileSync(runnerPath, "utf8");
    expect(runner).toContain(`emit -n ${shellQuote(hostileId)} coder_started`);
    expect(runner).toContain(`emit -n ${shellQuote(hostileId)} pr_opened`);
    expect(runner).not.toContain("activate-coder");
    expect(runner).toContain(`activate-reviewer -n ${shellQuote(hostileId)}`);
    expect(runner).toContain(`ensure-pr-autoclose -n ${shellQuote(hostileId)} --pr-url`);
    expect(spawnSync("sh", ["-n", runnerPath], { encoding: "utf8" }).status).toBe(0);
  });

  it("uses configured gatekeeper attach retry settings in the gatekeeper tmux window", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      "[hodor]\nattach_timeout_seconds = 45\nattach_retry_interval_seconds = 15\n",
    );
    const { deps, calls } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir]);

    const gatekeeperWindow = calls.find(
      (call) => call[0] === "tmux" && call[1] === "new-window" && call.includes("gatekeeper"),
    );
    const command = gatekeeperWindow?.at(-1) ?? "";
    expect(command).toContain("expected_branch='combo/issue-7'");
    expect(command).toContain("expected_head=$(git rev-parse --short=7 HEAD 2>/dev/null || true)");
    expect(command).toContain("attach_max_attempts=3");
    expect(command).toContain('echo "gatekeeper-attach: timed out after 45 seconds" >&2');
    expect(command).toContain(
      'echo "gatekeeper-attach: waiting for gatekeeper on $expected_branch@$expected_head (attempt $attempt/$attach_max_attempts)..." >&2',
    );
    expect(command).toContain("sleep 15");
  });

  it("waits for an active no-mistakes run before attaching when attach would exit cleanly", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir]);

    const gatekeeperWindow = calls.find(
      (call) => call[0] === "tmux" && call[1] === "new-window" && call.includes("gatekeeper"),
    );
    const command = gatekeeperWindow?.at(-1) ?? "";
    const head = "abc1234";
    const bin = mkdtempSync(join(tmpdir(), "combo-chen-bin-"));
    const noMistakesCalls = join(bin, "no-mistakes-calls");
    const statusAttempts = join(bin, "status-attempts");
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh
  if [ "$1" = "rev-parse" ]; then
    printf '${head}\\n'
    exit 0
  fi
  exit 64
  `,
    );
    writeFileSync(
      join(bin, "no-mistakes"),
      `#!/bin/sh
  printf '%s\\n' "$*" >> "$NO_MISTAKES_CALLS"
  if [ "$1" = "axi" ] && [ "$2" = "status" ]; then
    count=0
    if [ -f "$NO_MISTAKES_STATUS_ATTEMPTS" ]; then
      count=$(cat "$NO_MISTAKES_STATUS_ATTEMPTS")
    fi
    count=$((count + 1))
    printf '%s\\n' "$count" > "$NO_MISTAKES_STATUS_ATTEMPTS"
    if [ "$count" -lt 2 ]; then
      printf 'No active run.\\n'
    else
      printf 'run:\\n  id: 01ATTACH\\n  branch: combo/issue-7\\n  head: ${head}\\n  status: running\\n'
    fi
    exit 0
  fi
  if [ "$1" = "attach" ]; then
    printf 'attached\\n'
    exit 0
  fi
  exit 64
  `,
    );
    writeFileSync(
      join(bin, "sleep"),
      `#!/bin/sh
  printf 'sleep %s\\n' "$*" >> "$NO_MISTAKES_CALLS"
  exit 0
  `,
    );
    chmodSync(join(bin, "git"), 0o755);
    chmodSync(join(bin, "no-mistakes"), 0o755);
    chmodSync(join(bin, "sleep"), 0o755);

    const result = spawnSync("sh", ["-c", command], {
      encoding: "utf8",
      env: {
        ...process.env,
        COMBO_CHEN_GATEKEEPER_WINDOW_HOLD: "0",
        NO_MISTAKES_CALLS: noMistakesCalls,
        NO_MISTAKES_STATUS_ATTEMPTS: statusAttempts,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("attached");
    expect(readFileSync(noMistakesCalls, "utf8").trim().split(/\r?\n/)).toEqual([
      "axi status",
      "sleep 10",
      "axi status",
      "attach --run 01ATTACH",
    ]);
  });

  it("cleans run state and treehouse lease even when tmux rollback kill fails", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "has-session") return { status: 1, stdout: "", stderr: "" };
        if (args[0] === "new-session") return { status: 0, stdout: "", stderr: "" };
        if (args[0] === "list-windows") return { status: 0, stdout: "journal\n", stderr: "" };
        if (args[0] === "new-window" && args.includes("director")) {
          return { status: 1, stdout: "", stderr: "window failed" };
        }
        if (args[0] === "kill-session") return { status: 1, stdout: "", stderr: "server busy" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /director.*window failed.*tmux rollback failed.*server busy/,
    );

    const runDir = runDirFor(h, "o-r-7");
    expect(existsSync(join(runDir, "combo.json"))).toBe(false);
    const killIndex = calls.findIndex((call) => call[0] === "tmux" && call[1] === "kill-session");
    expect(killIndex).toBeGreaterThan(-1);
    const treehouseReturnIndex = calls.findIndex(
      (call) => call[0] === "treehouse" && call.includes("return"),
    );
    const branchDeleteIndex = calls.findIndex((call) => call[0] === "git" && call.includes("-D"));
    expect(treehouseReturnIndex).toBeGreaterThan(killIndex);
    expect(branchDeleteIndex).toBeGreaterThan(treehouseReturnIndex);
  });

  it("reports failed best-effort worktree and branch rollback operations", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "has-session") return { status: 1, stdout: "", stderr: "" };
        if (args[0] === "new-session") return { status: 0, stdout: "", stderr: "" };
        if (args[0] === "list-windows") return { status: 0, stdout: "journal\n", stderr: "" };
        if (args[0] === "new-window" && args.includes("director")) {
          return { status: 1, stdout: "", stderr: "window failed" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    const treehouse = deps.treehouse;
    deps.treehouse = (args, cwd) => {
      if (args[0] !== "return") return treehouse(args, cwd);
      calls.push(["treehouse", `cwd=${cwd}`, ...args]);
      return { status: 1, stdout: "", stderr: "lease busy" };
    };
    const git = deps.git;
    deps.git = (args, cwd) => {
      if (!(args[0] === "branch" && args[1] === "-D")) return git(args, cwd);
      calls.push(["git", `cwd=${cwd}`, ...args]);
      return { status: 1, stdout: "", stderr: "branch checked out" };
    };

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /director.*window failed/,
    );

    expect(out).toContain(
      `warning: failed to return treehouse worktree ${join(repoDir, ".worktrees", "issue-7")}: lease busy`,
    );
    expect(out).toContain(
      "warning: failed to delete combo branch combo/issue-7 from " + repoDir + ": branch checked out",
    );
  });

  it("rolls back run state after killing tmux when role-window setup fails", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "has-session") return { status: 1, stdout: "", stderr: "" };
        if (args[0] === "new-session") return { status: 0, stdout: "", stderr: "" };
        if (args[0] === "list-windows") return { status: 0, stdout: "journal\n", stderr: "" };
        if (args[0] === "new-window" && args.includes("director")) {
          return { status: 1, stdout: "", stderr: "window failed" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /director.*window failed/,
    );

    const directorIndex = calls.findIndex(
      (call) => call[0] === "tmux" && call[1] === "new-window" && call.includes("director"),
    );
    const killIndex = calls.findIndex((call) => call[0] === "tmux" && call[1] === "kill-session");
    const treehouseReturnIndex = calls.findIndex(
      (call) => call[0] === "treehouse" && call.includes("return"),
    );
    const branchDeleteIndex = calls.findIndex((call) => call[0] === "git" && call.includes("-D"));
    expect(directorIndex).toBeGreaterThan(-1);
    expect(killIndex).toBeGreaterThan(directorIndex);
    expect(treehouseReturnIndex).toBeGreaterThan(killIndex);
    expect(branchDeleteIndex).toBeGreaterThan(treehouseReturnIndex);
    expect(existsSync(join(runDirFor(h, "o-r-7"), "combo.json"))).toBe(false);
  });

  it("blocks an occupied run dir before creating a worktree", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const runDir = runDirFor(h, "o-r-7");
    mkdirSync(join(runDir, CONFIG_SNAPSHOT_FILE), { recursive: true });
    const { deps, calls } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(/run_dir_free/);

    expect(calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("add"))).toBe(
      false,
    );
    expect(
      calls.some((call) => call[0] === "git" && call.includes("worktree") && call.includes("remove")),
    ).toBe(false);
    expect(calls.some((call) => call[0] === "git" && call.includes("-D"))).toBe(false);
    expect(existsSync(runDir)).toBe(true);
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "new-session")).toBe(false);
  });

  it("forces publish-only mode on a no-placeholder repo-level no-mistakes gatekeeper command", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const customGatekeeper = `printf '%s:%s' "\${intent}" "\${issue_body}" && no-mistakes axi run --intent "\${intent}"`;
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      `[gatekeeper]\ncommand = ${JSON.stringify(customGatekeeper)}\n`,
    );
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir]);

    const runner = readFileSync(join(runDirFor(h, "o-r-7"), "runner.sh"), "utf8");
    expect(runner).toContain(customGatekeeper);
    expect(runner).toContain('no-mistakes axi run --intent "${intent}" --skip=ci');
    expect(runner).not.toContain("git push no-mistakes HEAD");
  });

  it("renders the default gatekeeper intent with an explicit issue autoclose keyword", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        if (args[0] === "issue" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              title: "Autoclose source issue",
              body: "This only mentions issue #7 without a closing keyword.",
            }),
            stderr: "",
          };
        }
        return { status: 0, stdout: "[]", stderr: "" };
      },
    });

    await exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir]);

    const runnerPath = join(runDirFor(h, "o-r-7"), "runner.sh");
    const runner = readFileSync(runnerPath, "utf8");
    expect(runner).toContain("no-mistakes axi run --intent");
    const decodedIntent = decodedGeneratedGatekeeperIntent(runner);
    expect(decodedIntent).toContain("This only mentions issue #7 without a closing keyword.");
    expect(decodedIntent).toContain("Fixes #7");
    expect(spawnSync("sh", ["-n", runnerPath], { encoding: "utf8" }).status).toBe(0);
  });

  it("renders gatekeeper command placeholders with safely quoted issue facts in the runner", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const gatekeeperCommand =
      "no-mistakes axi run --yes --url {issue_url} --title {issue_title} --body {issue_body} --branch {branch}";
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      `[gatekeeper]\ncommand = ${JSON.stringify(gatekeeperCommand)}\n`,
    );
    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        if (args[0] === "issue" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              title: `Title "double" and 'single'`,
              body: `First line
  It's "quoted"; touch /tmp/gatekeeper-owned
  $(echo boom)`,
            }),
            stderr: "",
          };
        }
        return { status: 0, stdout: "[]", stderr: "" };
      },
    });

    await exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir]);

    const runnerPath = join(runDirFor(h, "o-r-7"), "runner.sh");
    const runner = readFileSync(runnerPath, "utf8");
    expect(runner).toContain("--url 'https://github.com/o/r/issues/7'");
    expect(runner).toContain("--skip=ci");
    expect(runner).toContain(`--title 'Title "double" and '\\''single'\\'''`);
    expect(runner).toContain(`--body 'First line
  It'\\''s "quoted"; touch /tmp/gatekeeper-owned
  $(echo boom)'`);
    expect(runner).toContain("--branch 'combo/issue-7'");
    expect(spawnSync("sh", ["-n", runnerPath], { encoding: "utf8" }).status).toBe(0);
  });

  it("rejects unknown gatekeeper command placeholders during runner generation", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      '[gatekeeper]\ncommand = "no-mistakes axi run {isue_url}"\n',
    );
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /Unknown gatekeeper placeholder \{isue_url\}/,
    );
  });

  it("refuses to run when the issue does not exist", async () => {
    const { deps } = fakeDeps({ issueExists: () => false });
    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", home()])).rejects.toThrow(/issue/i);
  });

  it("refuses a second combo for the same issue while the session lives", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });
    await exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir]);

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(/already/i);
  });
});
// -/ 1/1
