/**
 * @overview Deep status dashboard integration tests.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at the describe block  <- command contracts and their effects.
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
 *   Command-specific fixtures live inside the describe block.
 *
 * @exports none
 * @deps ../../testing/cli-harness
 */

import {
  ISSUE,
  appendEvent,
  buildRuntimeLedger,
  describe,
  exec,
  expect,
  fakeDeps,
  home,
  it,
  join,
  loadConfig,
  mkdtempSync,
  readEvents,
  runDirFor,
  tmpdir,
  writeCombo,
  writeConfigSnapshot,
  writeFileSync,
  writeRuntimeLedger,
} from "../../testing/cli-harness.js";

// -- 1/1 CORE · command contracts <- START HERE --
describe("status", () => {
  it("prints downstream no-mistakes CI state in deep mode for stale stalled combos", async () => {
    const h = home();
    const worktree = "/repos/r/.worktrees/issue-7";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "gate_started", {});
    appendEvent(dir, "gate_failed", { exit_code: 1 });

    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: (args: string[], cwd: string) => {
        expect(args).toEqual(["axi", "status"]);
        expect(cwd).toBe(worktree);
        return {
          status: 0,
          stdout: [
            "run:",
            '  id: "01KV-CI"',
            "  branch: combo/issue-7",
            "  status: running",
            "  head: abc1234",
            "  steps[9]{step,status,findings,duration_ms}:",
            "    intent,completed,0,1",
            "    review,completed,0,1",
            "    ci,running,0,0",
          ].join("\n"),
          stderr: "",
        };
      },
    });
    await exec(deps, ["status", "--deep"]);

    const text = out.join("\n");
    expect(text).toContain("STALLED");
    expect(text).toContain("gate_failed");
    expect(text).toContain("no-mistakes running ci");
  });

  it("keeps status --deep observational and never mutates PR labels", async () => {
    const h = home();
    const worktree = "/repos/r/.worktrees/issue-7";
    const prUrl = "https://github.com/o/r/pull/7";
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: prUrl });
    appendEvent(dir, "gate_started", {});

    const { deps, calls } = fakeDeps({
      env: {
        COMBO_CHEN_HOME: h,
        COMBO_CHEN_PR_LABEL_GREEN_CHECK_NAMES: "ExternalReview Pro",
      },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "has-session") return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
      noMistakes: () => ({
        status: 0,
        stdout: [
          "run:",
          "  branch: combo/issue-7",
          "  status: running",
          "  steps[1]{step,status,findings,duration_ms}:",
          "    ci,running,0,0",
        ].join("\n"),
        stderr: "",
      }),
      gh: (args) => {
        calls.push(["gh", ...args]);
        if (args[0] === "pr" && args[1] === "view") {
          const fields = args.at(-1) ?? "";
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: headSha,
              state: "OPEN",
              ...(fields.includes("labels") ? { labels: [{ name: "combo:ready" }] } : {}),
              ...(fields.includes("statusCheckRollup")
                ? {
                    statusCheckRollup: [
                      { name: "test", conclusion: "SUCCESS" },
                      { name: "ExternalReview", conclusion: "FAILURE" },
                      { name: "ExternalReview Pro", conclusion: "SUCCESS" },
                    ],
                  }
                : {}),
            }),
            stderr: "",
          };
        }
        if (args[0] === "pr" && args[1] === "edit") {
          return { status: 1, stdout: "", stderr: "status must not mutate labels" };
        }
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["status", "--deep"]);

    expect(calls.filter((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "edit")).toEqual([]);
    expect(readEvents(dir).filter((event) => event.event === "pr_labels_updated")).toEqual([]);
  });

  it("prints awaiting no-mistakes gate finding ids and respond command in deep mode", async () => {
    const h = home();
    const worktree = "/repos/r/.worktrees/issue-7";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "gate_started", {});
    appendEvent(dir, "needs_human", { reason: "gate_waiting" });

    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: () => ({
        status: 0,
        stdout: [
          "run:",
          '  id: "01KV-GATE"',
          "  branch: combo/issue-7",
          "  status: waiting",
          '  findings: "2 awaiting"',
          "findings[2]{id,status,title}:",
          '  NM-1,awaiting,"missing test"',
          '  NM-2,awaiting,"needs docs"',
          "outcome: awaiting_approval",
          'next_step: "no-mistakes axi respond --run 01KV-GATE --finding NM-1 --yes"',
        ].join("\n"),
        stderr: "",
      }),
    });
    await exec(deps, ["status", "--deep"]);

    const text = out.join("\n");
    expect(text).toContain("awaiting review gate: NM-1, NM-2");
    expect(text).toContain("respond: no-mistakes axi respond --run 01KV-GATE --finding NM-1 --yes");
  });

  it("does not classify zero awaiting findings as an awaiting review gate in deep mode", async () => {
    const h = home();
    const worktree = "/repos/r/.worktrees/issue-7";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "gate_started", {});

    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: () => ({
        status: 0,
        stdout: [
          "run:",
          "  branch: combo/issue-7",
          "  status: running",
          '  findings: "0 awaiting"',
          "steps[1]{step,status,findings,duration_ms}:",
          "  review,running,0,0",
        ].join("\n"),
        stderr: "",
      }),
    });
    await exec(deps, ["status", "--deep"]);

    const text = out.join("\n");
    expect(text).toContain("no-mistakes running review");
    expect(text).not.toContain("awaiting review gate");
  });

  it("prints PR ready for reviewer in deep mode when GitHub checks are green and no reviewer pin exists", async () => {
    const h = home();
    const worktree = "/repos/r/.worktrees/issue-7";
    const prUrl = "https://github.com/o/r/pull/7";
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: prUrl });
    appendEvent(dir, "gate_failed", { exit_code: 1 });

    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: () => ({
        status: 0,
        stdout: ["run:", "  branch: combo/issue-7", "  status: completed"].join("\n"),
        stderr: "",
      }),
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: headSha,
              state: "OPEN",
              statusCheckRollup: [
                { name: "test", conclusion: "SUCCESS" },
                { name: "CodeRabbit", conclusion: "SUCCESS" },
              ],
            }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });
    await exec(deps, ["status", "--deep"]);

    const text = out.join("\n");
    expect(text).toContain("STALLED");
    expect(text).toContain("gate_failed");
    expect(text).not.toContain("PR ready for reviewer");
  });

  it("prints PR head drift in deep mode when the local worktree is behind the PR", async () => {
    const h = home();
    const worktree = "/repos/r/.worktrees/issue-7";
    const prUrl = "https://github.com/o/r/pull/7";
    const localHeadSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const prHeadSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: prUrl });
    appendEvent(dir, "gate_failed", { exit_code: 1 });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: () => ({ status: 0, stdout: "", stderr: "" }),
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          expect(cwd).toBe(worktree);
          return { status: 0, stdout: `${localHeadSha}\n`, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      noMistakes: () => ({
        status: 1,
        stdout: "No active run.\n",
        stderr: "",
      }),
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: prHeadSha,
              state: "OPEN",
              mergeStateStatus: "CLEAN",
              statusCheckRollup: [
                { name: "test", conclusion: "SUCCESS" },
                { name: "CodeRabbit", conclusion: "SUCCESS" },
              ],
            }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["status", "--deep"]);

    const text = out.join("\n");
    expect(text).toContain("PR head drift: local aaaaaaa differs from PR bbbbbbb");
    expect(text).toContain("fetch PR head for review or sync combo worktree");
    expect(calls).toContainEqual(["git", `cwd=${worktree}`, "rev-parse", "HEAD"]);
  });

  it("uses the runtime ledger PR URL for deep GitHub status when the journal lacks pr_opened", async () => {
    const h = home();
    const worktree = "/repos/r/.worktrees/issue-7";
    const prUrl = "https://github.com/o/r/pull/7";
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const dir = runDirFor(h, "o-r-7");
    const combo = {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    };
    writeCombo(dir, combo);
    writeRuntimeLedger(dir, buildRuntimeLedger({ combo, runDir: dir, cli: "combo-chen", prUrl }));
    appendEvent(dir, "gate_started", {});
    appendEvent(dir, "gate_failed", { exit_code: 1 });

    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: () => ({
        status: 1,
        stdout: "No active run.\n",
        stderr: "",
      }),
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: headSha,
              state: "OPEN",
              statusCheckRollup: [
                { name: "test", conclusion: "SUCCESS" },
                { name: "CodeRabbit", conclusion: "SUCCESS" },
              ],
            }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });
    await exec(deps, ["status", "--deep"]);

    const text = out.join("\n");
    expect(text).toContain(prUrl);
    expect(text).not.toContain("PR ready for reviewer");
  });

  it("allows configured required READY checks to be the only green checks in deep mode", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      ["[ready]", 'required_checks = ["reviewdog"]'].join("\n"),
    );
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const prUrl = "https://github.com/o/r/pull/7";
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: prUrl });
    appendEvent(dir, "gate_failed", { exit_code: 1 });

    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: () => ({
        status: 0,
        stdout: ["run:", "  branch: combo/issue-7", "  status: completed"].join("\n"),
        stderr: "",
      }),
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: headSha,
              state: "OPEN",
              statusCheckRollup: [{ name: "ReviewDog", conclusion: "SUCCESS" }],
            }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });
    await exec(deps, ["status", "--deep"]);

    expect(out.join("\n")).not.toContain("PR ready for reviewer");
  });

  it("does not report PR ready for reviewer when a configured required READY check fails", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      ["[ready]", 'required_checks = ["reviewdog"]'].join("\n"),
    );
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const prUrl = "https://github.com/o/r/pull/7";
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: prUrl });
    appendEvent(dir, "gate_failed", { exit_code: 1 });

    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: () => ({
        status: 0,
        stdout: ["run:", "  branch: combo/issue-7", "  status: completed"].join("\n"),
        stderr: "",
      }),
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: headSha,
              state: "OPEN",
              statusCheckRollup: [{ name: "ReviewDog", conclusion: "FAILURE" }],
            }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });
    await exec(deps, ["status", "--deep"]);

    expect(out.join("\n")).not.toContain("PR ready for reviewer");
  });

  it("does not report PR ready for reviewer when a required READY check is skipped", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      ["[ready]", 'required_checks = ["CodeRabbit"]'].join("\n"),
    );
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const prUrl = "https://github.com/o/r/pull/7";
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: prUrl });
    appendEvent(dir, "gate_failed", { exit_code: 1 });

    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: () => ({
        status: 1,
        stdout: "No active run.\n",
        stderr: "",
      }),
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: headSha,
              state: "OPEN",
              statusCheckRollup: [
                { name: "test", conclusion: "SUCCESS" },
                { name: "CodeRabbit", conclusion: "SKIPPED" },
              ],
            }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["status", "--deep"]);

    expect(out.join("\n")).not.toContain("PR ready for reviewer");
  });

  it("uses the launch config snapshot for deep downstream status after repo TOML changes", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(join(repoDir, "combo-chen.toml"), '[reviewer]\nambient = ["launch-bot"]\n');
    const worktree = join(repoDir, ".worktrees", "issue-7");
    const prUrl = "https://github.com/o/r/pull/7";
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree,
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    writeConfigSnapshot(dir, loadConfig({ repoDir, env: {} }));
    writeFileSync(join(repoDir, "combo-chen.toml"), '[reviewer]\nambient = ["drift-bot"]\n');
    appendEvent(dir, "pr_opened", { url: prUrl });
    appendEvent(dir, "gate_failed", { exit_code: 1 });

    const { deps, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      noMistakes: () => ({
        status: 0,
        stdout: ["run:", "  branch: combo/issue-7", "  status: completed"].join("\n"),
        stderr: "",
      }),
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              headRefOid: headSha,
              state: "OPEN",
              statusCheckRollup: [
                { name: "launch-bot", conclusion: "FAILURE" },
                { name: "test", conclusion: "SUCCESS" },
                { name: "CodeRabbit", conclusion: "SUCCESS" },
              ],
            }),
            stderr: "",
          };
        }
        if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["status", "--deep"]);

    expect(out.join("\n")).not.toContain("PR ready for reviewer");
  });
});
// -/ 1/1
