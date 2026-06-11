import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appendEvent, readEvents } from "../core/events.js";
import { runDirFor, writeCombo } from "../core/state.js";
import { ROWER_THREAD_ARTIFACT } from "../roles/rower.js";
import { createProgram, type Deps } from "./main.js";

function home(): string {
  return mkdtempSync(join(tmpdir(), "combo-chen-cli-"));
}

function fakeDeps(overrides: Partial<Deps> = {}): { deps: Deps; calls: string[][]; out: string[] } {
  const calls: string[][] = [];
  const out: string[] = [];
  const sessions = new Set<string>();
  const deps: Deps = {
    env: {},
    out: (line) => out.push(line),
    tmux: (args) => {
      calls.push(["tmux", ...args]);
      const flagIndex = args.indexOf("-t") !== -1 ? args.indexOf("-t") : args.indexOf("-s");
      const target = flagIndex === -1 ? "" : (args[flagIndex + 1] ?? "");
      if (args[0] === "has-session") {
        return { status: sessions.has(target) ? 0 : 1, stdout: "", stderr: "" };
      }
      if (args[0] === "new-session") sessions.add(target);
      if (args[0] === "kill-session") sessions.delete(target);
      return { status: 0, stdout: "", stderr: "" };
    },
    git: (args, cwd) => {
      calls.push(["git", `cwd=${cwd}`, ...args]);
      return { status: 0, stdout: "", stderr: "" };
    },
    gh: (args) => {
      calls.push(["gh", ...args]);
      if (args[0] === "issue" && args[1] === "view") {
        return {
          status: 0,
          stdout: JSON.stringify({ title: "Issue title", body: "Issue body" }),
          stderr: "",
        };
      }
      return { status: 0, stdout: "[]", stderr: "" };
    },
    sleep: (ms) => {
      calls.push(["sleep", String(ms)]);
      return Promise.resolve();
    },
    issueExists: () => true,
    ...overrides,
  };
  return { deps, calls, out };
}

const ISSUE = "https://github.com/o/r/issues/7";
const CODEX_THREAD_ID = "019eb3f5-c135-76d2-88c5-0aa8edfe4c84";

async function exec(deps: Deps, argv: string[]): Promise<void> {
  const program = createProgram(deps);
  await program.parseAsync(["node", "combo-chen", ...argv]);
}

function seedCodexGnhfRun(worktree: string): void {
  const gnhfRun = join(worktree, ".gnhf", "runs", "implement-github-iss-e6510c");
  mkdirSync(gnhfRun, { recursive: true });
  writeFileSync(
    join(gnhfRun, "iteration-1.jsonl"),
    `${JSON.stringify({ type: "thread.started", thread_id: CODEX_THREAD_ID })}\n`,
  );
}

describe("command surface", () => {
  it("exposes the configured command surface", () => {
    const { deps } = fakeDeps();
    const names = createProgram(deps)
      .commands.map((c) => c.name())
      .sort();
    expect(names).toEqual(
      [
        "activate-judge",
        "activate-thread-sitter",
        "attach",
        "emit",
        "events",
        "judge-tick",
        "nudge-review-comments",
        "run",
        "status",
        "stop",
      ].sort(),
    );
  });
});

describe("attach", () => {
  function seedCombo(homeDir: string, id: string, createdAt: string): void {
    const issueNumber = id.split("-").at(-1) ?? "7";
    writeCombo(runDirFor(homeDir, id), {
      id,
      issueUrl: `https://github.com/o/r/issues/${issueNumber}`,
      repoDir: "/repos/r",
      worktree: `/repos/r/.worktrees/issue-${issueNumber}`,
      branch: `combo/issue-${issueNumber}`,
      tmuxSession: `combo-chen-${id}`,
      createdAt,
    });
  }

  it("resolves the only running combo without --name and attaches to its session", async () => {
    const h = home();
    seedCombo(h, "stale-o-r-6", "2026-06-10T10:00:00.000Z");
    seedCombo(h, "o-r-7", "2026-06-10T11:00:00.000Z");
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "has-session") {
          return {
            status: args.at(-1) === "combo-chen-o-r-7" ? 0 : 1,
            stdout: "",
            stderr: "no such session",
          };
        }
        if (args[0] === "list-panes") return { status: 0, stdout: "0\n1\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["attach"]);

    expect(calls).toContainEqual(["tmux", "attach", "-t", "combo-chen-o-r-7"]);
    expect(calls.some((call) => call[1] === "split-window")).toBe(false);
  });

  it("requires --name when several combos are running", async () => {
    const h = home();
    seedCombo(h, "o-r-7", "2026-06-10T10:00:00.000Z");
    seedCombo(h, "o-r-8", "2026-06-10T11:00:00.000Z");
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "has-session") return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(exec(deps, ["attach"])).rejects.toThrow(/--name/);

    expect(calls.some((call) => call[1] === "attach")).toBe(false);
  });

  it("uses a friendly error when the named combo's tmux session is gone", async () => {
    const h = home();
    seedCombo(h, "o-r-7", "2026-06-10T10:00:00.000Z");
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "has-session") {
          return { status: 1, stdout: "", stderr: "can't find session: combo-chen-o-r-7" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    let message = "";
    try {
      await exec(deps, ["attach", "--name", "o-r-7"]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/Combo "o-r-7" is not running/);
    expect(message).toContain('tmux session "combo-chen-o-r-7" does not exist');
    expect(message).not.toContain("can't find session");
    expect(calls.some((call) => call[1] === "attach")).toBe(false);
  });

  it("recreates a missing journal pane before attaching", async () => {
    const h = home();
    seedCombo(h, "o-r-7", "2026-06-10T10:00:00.000Z");
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "has-session") return { status: 0, stdout: "", stderr: "" };
        if (args[0] === "list-panes") return { status: 0, stdout: "0\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["attach", "--name", "o-r-7"]);

    const splitIndex = calls.findIndex((call) => call[1] === "split-window");
    const attachIndex = calls.findIndex((call) => call[1] === "attach");
    expect(calls[splitIndex]).toEqual([
      "tmux",
      "split-window",
      "-d",
      "-v",
      "-l",
      "12",
      "-t",
      "combo-chen-o-r-7:rower",
      expect.stringContaining("events --follow -n o-r-7"),
    ]);
    expect(calls[attachIndex]).toEqual(["tmux", "attach", "-t", "combo-chen-o-r-7"]);
    expect(splitIndex).toBeLessThan(attachIndex);
    expect(calls.some((call) => call[1] === "select-pane")).toBe(false);
  });
});

describe("activate-thread-sitter", () => {
  it("starts the resumed sitter window and the review-comment watcher from the rower thread artifact", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      "[limits]\nbabysit_poll_seconds = 7\n\n[rower.codex]\nresume_command = \"codex --profile sitter resume {thread_id}\"\n\n[thread_sitter]\nwindow_name = \"sitter\"\nwatch_window_name = \"sitter-watch\"\n",
    );
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    writeFileSync(
      join(dir, ROWER_THREAD_ARTIFACT),
      `${JSON.stringify({
        agent: "codex",
        thread_id: CODEX_THREAD_ID,
        source: ".gnhf/runs/implement-github-iss-e6510c/iteration-1.jsonl",
      })}\n`,
    );
    const { deps, calls } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["activate-thread-sitter", "-n", "o-r-7"]);

    const newWindows = calls.filter((call) => call[0] === "tmux" && call[1] === "new-window");
    expect(newWindows).toHaveLength(2);
    expect(newWindows[0]).toContain("sitter");
    expect(newWindows[0]?.at(-1)).toBe(`codex --profile sitter resume '${CODEX_THREAD_ID}'`);
    expect(newWindows[1]).toContain("sitter-watch");
    expect(newWindows[1]?.at(-1)).toContain("nudge-review-comments -n 'o-r-7'");
    expect(newWindows[1]?.at(-1)).toContain("sleep 7");
    expect(calls.some((call) => call[0] === "git")).toBe(false);
    expect(calls.some((call) => call[0] === "gh")).toBe(false);
  });

  it("kills the sitter window when the watcher window fails to start", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      '[thread_sitter]\nwindow_name = "sitter"\nwatch_window_name = "sitter-watch"\n',
    );
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    writeFileSync(
      join(dir, ROWER_THREAD_ARTIFACT),
      `${JSON.stringify({
        agent: "codex",
        thread_id: CODEX_THREAD_ID,
        source: ".gnhf/runs/implement-github-iss-e6510c/iteration-1.jsonl",
      })}\n`,
    );
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "new-window" && args.includes("sitter-watch")) {
          return { status: 1, stdout: "", stderr: "duplicate window" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(exec(deps, ["activate-thread-sitter", "-n", "o-r-7"])).rejects.toThrow(
      /tmux failed to start sitter-watch: duplicate window/,
    );

    expect(calls).toContainEqual(["tmux", "kill-window", "-t", "combo-chen-o-r-7:sitter"]);
  });
});

describe("nudge-review-comments", () => {
  it("routes a fetched PR comment once using read-only GitHub calls and no repo writes", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      '[thread_sitter]\nreview_nudge_prompt = "Please address {url}"\nwindow_name = "sitter"\n',
    );
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        calls.push(["gh", ...args]);
        const endpoint = args.at(-1);
        if (endpoint === "repos/o/r/issues/7/comments") {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                html_url: "https://github.com/o/r/pull/7#issuecomment-1",
                user: { login: "coderabbitai" },
                body: "Please handle this.",
              },
            ]),
            stderr: "",
          };
        }
        return { status: 0, stdout: "[]", stderr: "" };
      },
    });

    await exec(deps, ["nudge-review-comments", "-n", "o-r-7"]);
    await exec(deps, ["nudge-review-comments", "-n", "o-r-7"]);

    const events = readEvents(dir).filter((event) => event.event === "review_comment");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      author: "coderabbitai",
      kind: "pr_comment",
      url: "https://github.com/o/r/pull/7#issuecomment-1",
    });

    const tmuxCalls = calls.filter((call) => call[0] === "tmux" && call[1] === "send-keys");
    expect(tmuxCalls).toHaveLength(2);
    expect(tmuxCalls[0]).toContain("combo-chen-o-r-7:sitter");
    expect(tmuxCalls[0]?.at(-1)).toBe("Please address 'https://github.com/o/r/pull/7#issuecomment-1'");
    expect(calls.some((call) => call[0] === "git")).toBe(false);
    const ghCalls = calls.filter((call) => call[0] === "gh");
    expect(ghCalls).not.toHaveLength(0);
    expect(ghCalls.every((call) => call[1] === "api" && !call.includes("--method"))).toBe(true);
  });
});

describe("emit", () => {
  it("appends a validated event to the combo journal", async () => {
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
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, [
      "emit",
      "-n",
      "o-r-7",
      "rower_failed",
      "--field",
      "exit_code=3",
      "--field",
      "has_new_commits=true",
    ]);

    const events = readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("rower_failed");
    expect(events[0]?.["exit_code"]).toBe(3);
    expect(events[0]?.["has_new_commits"]).toBe(true);
  });

  it("accepts hodor_status from the CLI with its current state", async () => {
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
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, [
      "emit",
      "-n",
      "o-r-7",
      "hodor_status",
      "--field",
      "state=fix_inflight",
      "--field",
      "head_sha=0123456789abcdef0123456789abcdef01234567",
    ]);

    const events = readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "hodor_status",
      state: "fix_inflight",
      head_sha: "0123456789abcdef0123456789abcdef01234567",
    });
  });

  it("accepts post-PR event vocabulary with its required fields", async () => {
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
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, [
      "emit",
      "-n",
      "o-r-7",
      "review_comment",
      "--field",
      "author=gordon",
      "--field",
      "kind=judge",
      "--field",
      "url=https://github.com/o/r/pull/7#discussion_r1",
    ]);
    await exec(deps, ["emit", "-n", "o-r-7", "lgtm", "--field", "sha=abc123"]);
    await exec(deps, [
      "emit",
      "-n",
      "o-r-7",
      "lgtm_stale",
      "--field",
      "old_sha=abc123",
      "--field",
      "new_sha=def456",
    ]);
    await exec(deps, ["emit", "-n", "o-r-7", "merged", "--field", "sha=def456", "--field", "by=javi"]);
    await exec(deps, ["emit", "-n", "o-r-7", "combo_closed"]);
    await exec(deps, ["emit", "-n", "o-r-7", "rower_retry"]);

    expect(readEvents(dir).map((event) => event.event)).toEqual([
      "review_comment",
      "lgtm",
      "lgtm_stale",
      "merged",
      "combo_closed",
      "rower_retry",
    ]);
  });

  it("surfaces emitting to a combo that was never created (caller bug)", async () => {
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: home() } });
    await expect(exec(deps, ["emit", "-n", "ghost", "rower_started"])).rejects.toThrow(/ENOENT/);
  });

  it("persists the codex thread artifact when rower_done is emitted", async () => {
    const h = home();
    const worktree = mkdtempSync(join(tmpdir(), "combo-chen-worktree-"));
    seedCodexGnhfRun(worktree);
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
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["emit", "-n", "o-r-7", "rower_done"]);

    expect(JSON.parse(readFileSync(join(dir, ROWER_THREAD_ARTIFACT), "utf8"))).toEqual({
      agent: "codex",
      thread_id: CODEX_THREAD_ID,
      source: ".gnhf/runs/implement-github-iss-e6510c/iteration-1.jsonl",
    });
    expect(readEvents(dir).map((event) => event.event)).toEqual(["rower_done"]);
  });
});

describe("run", () => {
  it("creates the record, the runner script, the tmux session, and the birth event", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir]);

    const runDir = runDirFor(h, "o-r-7");
    expect(existsSync(join(runDir, "combo.json"))).toBe(true);
    const runner = readFileSync(join(runDir, "runner.sh"), "utf8");
    expect(runner).toContain("gnhf");
    const gatePush = runner.indexOf("git push no-mistakes HEAD");
    const axiRun = runner.indexOf("no-mistakes axi run");
    expect(gatePush).toBeGreaterThan(-1);
    expect(axiRun).toBeGreaterThan(gatePush);
    expect(runner).toContain("activate-judge -n o-r-7");

    const gitCall = calls.find((c) => c[0] === "git" && c.includes("worktree"));
    expect(gitCall).toBeDefined();

    const tmuxNewSession = calls.find((c) => c[0] === "tmux" && c[1] === "new-session");
    expect(tmuxNewSession).toContain("combo-chen-o-r-7");
    const tmuxNewWindows = calls.filter((c) => c[0] === "tmux" && c[1] === "new-window");
    const hodorWindow = tmuxNewWindows.find((call) => call.includes("hodor"));
    expect(hodorWindow).toEqual([
      "tmux",
      "new-window",
      "-t",
      "combo-chen-o-r-7",
      "-n",
      "hodor",
      expect.stringContaining("no-mistakes attach"),
    ]);
    expect(hodorWindow?.at(-1)).toContain(join(repoDir, ".worktrees", "issue-7"));
    expect(tmuxNewWindows.some((call) => call.includes("watch"))).toBe(false);
    expect(calls).toContainEqual([
      "tmux",
      "split-window",
      "-d",
      "-v",
      "-l",
      "12",
      "-t",
      "combo-chen-o-r-7:rower",
      expect.stringContaining("events --follow -n o-r-7"),
    ]);
    expect(calls.some((call) => call[1] === "select-pane")).toBe(false);

    const events = readEvents(runDir);
    expect(events[0]?.event).toBe("combo_created");
  });

  it("uses configured hodor attach retry settings in the hodor tmux window", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      "[hodor]\nattach_timeout_seconds = 45\nattach_retry_interval_seconds = 15\n",
    );
    const { deps, calls } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir]);

    const hodorWindow = calls.find(
      (call) => call[0] === "tmux" && call[1] === "new-window" && call.includes("hodor"),
    );
    const command = hodorWindow?.at(-1) ?? "";
    expect(command).toContain('if [ "$attempt" -gt 3 ]; then');
    expect(command).toContain('echo "hodor-attach: timed out after 45 seconds" >&2');
    expect(command).toContain('echo "hodor-attach: waiting for hodor (attempt $attempt/3)..." >&2');
    expect(command).toContain("sleep 15");
  });

  it("does not delete run state or worktree when journal-pane rollback cannot kill tmux", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "has-session") return { status: 1, stdout: "", stderr: "" };
        if (args[0] === "new-session") return { status: 0, stdout: "", stderr: "" };
        if (args[0] === "list-panes") return { status: 0, stdout: "0\n", stderr: "" };
        if (args[0] === "split-window") return { status: 1, stdout: "", stderr: "pane failed" };
        if (args[0] === "kill-session") return { status: 1, stdout: "", stderr: "server busy" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /tmux rollback failed.*server busy/,
    );

    const runDir = runDirFor(h, "o-r-7");
    expect(existsSync(join(runDir, "combo.json"))).toBe(true);
    const killIndex = calls.findIndex((call) => call[0] === "tmux" && call[1] === "kill-session");
    expect(killIndex).toBeGreaterThan(-1);
    expect(calls.some((call) => call[0] === "git" && call.includes("remove"))).toBe(false);
    expect(calls.some((call) => call[0] === "git" && call.includes("-D"))).toBe(false);
  });

  it("rolls back run state after killing tmux when journal-pane setup fails", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "has-session") return { status: 1, stdout: "", stderr: "" };
        if (args[0] === "new-session") return { status: 0, stdout: "", stderr: "" };
        if (args[0] === "list-panes") return { status: 0, stdout: "0\n", stderr: "" };
        if (args[0] === "split-window") return { status: 1, stdout: "", stderr: "pane failed" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /journal pane.*pane failed/,
    );

    const splitIndex = calls.findIndex((call) => call[0] === "tmux" && call[1] === "split-window");
    const killIndex = calls.findIndex((call) => call[0] === "tmux" && call[1] === "kill-session");
    const worktreeRemoveIndex = calls.findIndex(
      (call) => call[0] === "git" && call.includes("worktree") && call.includes("remove"),
    );
    const branchDeleteIndex = calls.findIndex((call) => call[0] === "git" && call.includes("-D"));
    expect(splitIndex).toBeGreaterThan(-1);
    expect(killIndex).toBeGreaterThan(splitIndex);
    expect(worktreeRemoveIndex).toBeGreaterThan(killIndex);
    expect(branchDeleteIndex).toBeGreaterThan(worktreeRemoveIndex);
    expect(existsSync(join(runDirFor(h, "o-r-7"), "combo.json"))).toBe(false);
  });

  it("keeps a repo-level hodor command override verbatim in the runner", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const customHodor = "custom-hodor --gate local && no-mistakes axi run --yes";
    writeFileSync(join(repoDir, "combo-chen.toml"), `[hodor]\ncommand = "${customHodor}"\n`);
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir]);

    const runner = readFileSync(join(runDirFor(h, "o-r-7"), "runner.sh"), "utf8");
    expect(runner).toContain(customHodor);
    expect(runner).not.toContain("git push no-mistakes HEAD");
  });

  it("renders hodor command placeholders with safely quoted issue facts in the runner", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const hodorCommand =
      "no-mistakes axi run --yes --url {issue_url} --title {issue_title} --body {issue_body} --branch {branch}";
    writeFileSync(join(repoDir, "combo-chen.toml"), `[hodor]\ncommand = ${JSON.stringify(hodorCommand)}\n`);
    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        if (args[0] === "issue" && args[1] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              title: `Title "double" and 'single'`,
              body: `First line
It's "quoted"; touch /tmp/hodor-owned
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
    expect(runner).toContain(`--title 'Title "double" and '\\''single'\\'''`);
    expect(runner).toContain(`--body 'First line
It'\\''s "quoted"; touch /tmp/hodor-owned
$(echo boom)'`);
    expect(runner).toContain("--branch 'combo/issue-7'");
    expect(spawnSync("sh", ["-n", runnerPath], { encoding: "utf8" }).status).toBe(0);
  });

  it("rejects unknown hodor command placeholders during runner generation", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(join(repoDir, "combo-chen.toml"), '[hodor]\ncommand = "no-mistakes axi run {isue_url}"\n');
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await expect(exec(deps, ["run", "--issue", ISSUE, "--repo", repoDir])).rejects.toThrow(
      /Unknown hodor placeholder \{isue_url\}/,
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

describe("status", () => {
  it("prints one line per combo with phase and needs-human flag", async () => {
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
    appendEvent(dir, "rower_started", {});
    appendEvent(dir, "needs_human", { reason: "gate_decision" });

    const { deps, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });
    await exec(deps, ["status"]);

    const text = out.join("\n");
    expect(text).toContain("o-r-7");
    expect(text).toContain("ROWING");
    expect(text).toContain("gate_decision");
  });
});

describe("activate-judge", () => {
  it("opens a gordon tmux window with the configured judge command for the opened PR", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      [
        '[roles]',
        'gordon = ["local"]',
        '',
        '[gordon]',
        'protocol = "Protocol 7989 + overlay 8034"',
        '',
        '[gordon.local]',
        'command = "judge-bot --pr {pr_url} --protocol {protocol} --prompt {prompt}"',
        '',
        '[limits]',
        'babysit_poll_seconds = 17',
        '',
      ].join("\n"),
    );
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const { deps, calls, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });
    await exec(deps, ["activate-judge", "-n", "o-r-7"]);

    const judgeWindow = calls.find(
      (c) => c[0] === "tmux" && c[1] === "new-window" && c.includes("gordon"),
    );
    expect(judgeWindow).toBeDefined();
    expect(judgeWindow).toContain("combo-chen-o-r-7");

    const command = judgeWindow?.at(-1) ?? "";
    expect(command).toContain("judge-bot");
    expect(command).toContain("'https://github.com/o/r/pull/7'");
    expect(command).toContain("'Protocol 7989 + overlay 8034'");
    expect(command).toContain("COMMENT reviews");
    expect(command).toContain("lgtm @ <sha>");

    const watchWindow = calls.find(
      (c) => c[0] === "tmux" && c[1] === "new-window" && c.includes("gordon-watch"),
    );
    expect(watchWindow).toBeDefined();
    expect(watchWindow).toContain("combo-chen-o-r-7");

    const watchCommand = watchWindow?.at(-1) ?? "";
    expect(watchCommand).toContain(`COMBO_CHEN_HOME='${h}'`);
    expect(watchCommand).toContain("judge-tick -n 'o-r-7'");
    expect(watchCommand).toContain("gordon: (merged|closed|already terminal)");
    expect(watchCommand).toContain("sleep 17");
    expect(out.join("\n")).toContain("gordon");
    expect(out.join("\n")).toContain("gordon-watch");
  });

  it("refuses activation before the combo has an opened PR in the journal", async () => {
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

    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });
    await expect(exec(deps, ["activate-judge", "-n", "o-r-7"])).rejects.toThrow(/pr_opened/);
  });

  it("checks for existing gordon windows before replacing them", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "list-windows") {
          return { status: 0, stdout: "rower\ngordon\ngordon-watch\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, ["activate-judge", "-n", "o-r-7"]);

    const listIndex = calls.findIndex((c) => c[1] === "list-windows");
    const killGordonIndex = calls.findIndex((c) => c.join(" ") === "tmux kill-window -t combo-chen-o-r-7:gordon");
    const newGordonIndex = calls.findIndex(
      (c) => c[1] === "new-window" && c.includes("gordon"),
    );
    expect(listIndex).toBeGreaterThan(-1);
    expect(killGordonIndex).toBeGreaterThan(listIndex);
    expect(killGordonIndex).toBeLessThan(newGordonIndex);
  });
});

describe("judge-tick", () => {
  it("journals a merged PR, tears down local state, and leaves the remote branch alone", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const teardownSnapshots: Array<{ step: string; events: string[] }> = [];
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "kill-session") {
          teardownSnapshots.push({ step: "kill-session", events: readEvents(dir).map((event) => event.event) });
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        const step =
          args[0] === "fetch"
            ? "fetch"
            : args[0] === "merge-base"
              ? "verify"
              : args[0] === "worktree"
                ? "worktree-remove"
                : args[0] === "branch"
                  ? "branch-delete"
                  : args[0] ?? "git";
        teardownSnapshots.push({ step, events: readEvents(dir).map((event) => event.event) });
        return { status: 0, stdout: "", stderr: "" };
      },
      gh: (args) => {
        calls.push(["gh", ...args]);
        return {
          status: 0,
          stdout:
            '{"headRefOid":"head456","baseRefName":"main","mergeCommit":{"oid":"squash789"},"state":"MERGED","mergedBy":{"login":"javi"}}',
          stderr: "",
        };
      },
    });

    await exec(deps, ["judge-tick", "-n", "o-r-7"]);

    expect(readEvents(dir).slice(-2)).toMatchObject([
      { event: "merged", sha: "squash789", by: "javi" },
      { event: "combo_closed" },
    ]);

    const mergedIndex = readEvents(dir).findIndex((event) => event.event === "merged");
    const closedIndex = readEvents(dir).findIndex((event) => event.event === "combo_closed");
    expect(mergedIndex).toBeLessThan(closedIndex);

    const killSessionIndex = calls.findIndex((c) => c[0] === "tmux" && c[1] === "kill-session");
    const fetchIndex = calls.findIndex((c) => c[0] === "git" && c.includes("fetch"));
    const verifyIndex = calls.findIndex(
      (c) => c[0] === "git" && c.includes("merge-base") && c.includes("--is-ancestor"),
    );
    const worktreeRemoveIndex = calls.findIndex(
      (c) => c[0] === "git" && c.includes("worktree") && c.includes("remove"),
    );
    const branchDeleteIndex = calls.findIndex((c) => c[0] === "git" && c.includes("-D"));

    expect(calls[killSessionIndex]).toEqual(["tmux", "kill-session", "-t", "combo-chen-o-r-7"]);
    expect(calls[verifyIndex]).toEqual([
      "git",
      `cwd=${repoDir}`,
      "merge-base",
      "--is-ancestor",
      "squash789",
      "origin/main",
    ]);
    expect(calls[worktreeRemoveIndex]).toEqual([
      "git",
      `cwd=${repoDir}`,
      "worktree",
      "remove",
      "--force",
      join(repoDir, ".worktrees", "issue-7"),
    ]);
    expect(calls[branchDeleteIndex]).toEqual(["git", `cwd=${repoDir}`, "branch", "-D", "combo/issue-7"]);
    expect(killSessionIndex).toBeGreaterThan(-1);
    expect(fetchIndex).toBeGreaterThan(-1);
    expect(verifyIndex).toBeGreaterThan(fetchIndex);
    expect(worktreeRemoveIndex).toBeGreaterThan(verifyIndex);
    expect(branchDeleteIndex).toBeGreaterThan(worktreeRemoveIndex);
    expect(killSessionIndex).toBeGreaterThan(branchDeleteIndex);
    expect(teardownSnapshots).toEqual([
      { step: "fetch", events: ["pr_opened", "merged"] },
      { step: "verify", events: ["pr_opened", "merged"] },
      { step: "worktree-remove", events: ["pr_opened", "merged"] },
      { step: "branch-delete", events: ["pr_opened", "merged"] },
      { step: "kill-session", events: ["pr_opened", "merged", "combo_closed"] },
    ]);
    expect(calls.some((c) => c[0] === "git" && c.includes("push") && c.includes("--delete"))).toBe(false);

    const prView = calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "view");
    expect(prView).toContain("--json");
    expect(prView).toContain("headRefOid,state,mergedBy,baseRefName,mergeCommit");
    expect(out.join("\n")).toContain("merged squash789 by javi");
  });

  it("retries merged teardown until combo_closed is journaled", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(dir, "merged", { sha: "squash789", by: "javi" });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        calls.push(["gh", ...args]);
        return {
          status: 0,
          stdout:
            '{"headRefOid":"head456","baseRefName":"main","mergeCommit":{"oid":"squash789"},"state":"MERGED","mergedBy":{"login":"javi"}}',
          stderr: "",
        };
      },
    });

    await exec(deps, ["judge-tick", "-n", "o-r-7"]);

    expect(readEvents(dir).map((event) => event.event)).toEqual(["pr_opened", "merged", "combo_closed"]);
    expect(calls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "view")).toBe(true);
    expect(calls.some((c) => c[0] === "tmux" && c[1] === "kill-session")).toBe(true);
    expect(out.join("\n")).not.toContain("already terminal");
  });

  it("does not duplicate a legacy merged event that used the PR head sha", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(dir, "merged", { sha: "head456", by: "javi" });

    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: () => ({
        status: 0,
        stdout:
          '{"headRefOid":"head456","baseRefName":"main","mergeCommit":{"oid":"squash789"},"state":"MERGED","mergedBy":{"login":"javi"}}',
        stderr: "",
      }),
    });

    await exec(deps, ["judge-tick", "-n", "o-r-7"]);

    expect(readEvents(dir).map((event) => event.event)).toEqual(["pr_opened", "merged", "combo_closed"]);
    expect(readEvents(dir).filter((event) => event.event === "merged")).toHaveLength(1);
  });

  it("keeps merged teardown retryable when local cleanup fails", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(join(repoDir, "combo-chen.toml"), "[limits]\nteardown_git_retries = 0\n");
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    let cleanupCanSucceed = false;
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (!cleanupCanSucceed && args[0] === "merge-base") {
          return { status: 1, stdout: "", stderr: "not propagated yet" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      gh: (args) => {
        calls.push(["gh", ...args]);
        return {
          status: 0,
          stdout:
            '{"headRefOid":"head456","baseRefName":"main","mergeCommit":{"oid":"squash789"},"state":"MERGED","mergedBy":{"login":"javi"}}',
          stderr: "",
        };
      },
    });

    await exec(deps, ["judge-tick", "-n", "o-r-7"]);

    expect(readEvents(dir).map((event) => event.event)).toEqual(["pr_opened", "merged"]);
    expect(calls.some((c) => c[0] === "tmux" && c[1] === "kill-session")).toBe(false);
    expect(out.join("\n")).toContain("teardown pending");

    cleanupCanSucceed = true;
    await exec(deps, ["judge-tick", "-n", "o-r-7"]);

    expect(readEvents(dir).map((event) => event.event)).toEqual(["pr_opened", "merged", "combo_closed"]);
    expect(calls.filter((c) => c[0] === "tmux" && c[1] === "kill-session")).toHaveLength(1);
  });

  it("retries merge verification with configured backoff before closing the combo", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      "[limits]\nteardown_git_retries = 2\nteardown_git_backoff_seconds = 3\n",
    );
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    let verifyAttempts = 0;
    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      git: (args, cwd) => {
        calls.push(["git", `cwd=${cwd}`, ...args]);
        if (args[0] === "merge-base") {
          verifyAttempts += 1;
          if (verifyAttempts < 3) return { status: 1, stdout: "", stderr: "stale base ref" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      gh: (args) => {
        calls.push(["gh", ...args]);
        return {
          status: 0,
          stdout:
            '{"headRefOid":"head456","baseRefName":"main","mergeCommit":{"oid":"squash789"},"state":"MERGED","mergedBy":{"login":"javi"}}',
          stderr: "",
        };
      },
    });

    await exec(deps, ["judge-tick", "-n", "o-r-7"]);

    expect(verifyAttempts).toBe(3);
    expect(calls.filter((c) => c[0] === "sleep")).toEqual([
      ["sleep", "3000"],
      ["sleep", "6000"],
    ]);
    expect(readEvents(dir).map((event) => event.event)).toEqual(["pr_opened", "merged", "combo_closed"]);
  });

  it("journals a closed PR for human salvage, stops the combo, and keeps local work", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        calls.push(["gh", ...args]);
        return {
          status: 0,
          stdout: '{"headRefOid":"def456","state":"CLOSED","mergedBy":null}',
          stderr: "",
        };
      },
    });

    await exec(deps, ["judge-tick", "-n", "o-r-7"]);

    expect(readEvents(dir).slice(-2)).toMatchObject([
      { event: "needs_human", reason: "pr_closed" },
      { event: "combo_closed" },
    ]);

    const killSession = calls.find((c) => c[0] === "tmux" && c[1] === "kill-session");
    expect(killSession).toEqual(["tmux", "kill-session", "-t", "combo-chen-o-r-7"]);
    expect(calls.some((c) => c[0] === "git")).toBe(false);
    expect(out.join("\n")).toContain("closed");
  });

  it("stales a pinned LGTM on a new PR head and starts an incremental re-review", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      [
        '[roles]',
        'gordon = ["local"]',
        '',
        '[gordon]',
        'protocol = "Protocol 7989 + overlay 8034"',
        '',
        '[gordon.local]',
        'command = "judge-bot --pr {pr_url} --prompt {prompt}"',
        '',
      ].join("\n"),
    );
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(dir, "lgtm", { sha: "abc123" });

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        calls.push(["gh", ...args]);
        return { status: 0, stdout: '{"headRefOid":"def456"}', stderr: "" };
      },
    });

    await exec(deps, ["judge-tick", "-n", "o-r-7"]);

    const stale = readEvents(dir).at(-1);
    expect(stale).toMatchObject({
      event: "lgtm_stale",
      old_sha: "abc123",
      new_sha: "def456",
    });

    const judgeWindow = calls.find(
      (c) => c[0] === "tmux" && c[1] === "new-window" && c.includes("gordon"),
    );
    expect(judgeWindow).toBeDefined();

    const command = judgeWindow?.at(-1) ?? "";
    expect(command).toContain("judge-bot");
    expect(command).toContain("abc123..def456");
    expect(command).toContain("lgtm @ def456");
    expect(command).toContain("COMMENT reviews");
    expect(out.join("\n")).toContain("lgtm_stale abc123 -> def456");
  });

  it("derives a pinned LGTM from GitHub comments and stales it on a new PR head", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      [
        '[roles]',
        'gordon = ["local"]',
        '',
        '[gordon.local]',
        'command = "judge-bot --pr {pr_url} --prompt {prompt}"',
        '',
      ].join("\n"),
    );
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const { deps, calls } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        calls.push(["gh", ...args]);
        if (args[0] === "pr") {
          return { status: 0, stdout: '{"headRefOid":"def456"}', stderr: "" };
        }
        if (args.join(" ").includes("issues/7/comments")) {
          return {
            status: 0,
            stdout: '[{"body":"lgtm @ abc123","created_at":"2026-06-11T00:00:00Z"}]',
            stderr: "",
          };
        }
        if (args.join(" ").includes("pulls/7/reviews")) {
          return { status: 0, stdout: "[]", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["judge-tick", "-n", "o-r-7"]);

    expect(readEvents(dir).map((event) => event.event)).toEqual([
      "pr_opened",
      "lgtm",
      "lgtm_stale",
    ]);
    expect(readEvents(dir)[1]).toMatchObject({ event: "lgtm", sha: "abc123" });
    expect(readEvents(dir)[2]).toMatchObject({
      event: "lgtm_stale",
      old_sha: "abc123",
      new_sha: "def456",
    });
    expect(calls.some((c) => c.join(" ").includes("issues/7/comments"))).toBe(true);
    expect(calls.some((c) => c.join(" ").includes("pulls/7/reviews"))).toBe(true);
  });

  it("finds a GitHub LGTM pin from paginated comment arrays", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      [
        '[roles]',
        'gordon = ["local"]',
        '',
        '[gordon.local]',
        'command = "judge-bot --pr {pr_url} --prompt {prompt}"',
        '',
      ].join("\n"),
    );
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        if (args[0] === "pr") {
          return { status: 0, stdout: '{"headRefOid":"def456"}', stderr: "" };
        }
        if (args.join(" ").includes("issues/7/comments")) {
          return {
            status: 0,
            stdout:
              '[]\n[{"body":"lgtm @ abc123","created_at":"2026-06-11T00:01:00Z"}]',
            stderr: "",
          };
        }
        if (args.join(" ").includes("pulls/7/reviews")) {
          return { status: 0, stdout: "[]", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["judge-tick", "-n", "o-r-7"]);

    expect(readEvents(dir)[1]).toMatchObject({ event: "lgtm", sha: "abc123" });
  });

  it("treats a short GitHub LGTM pin as current when it prefixes the full PR head", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      [
        '[roles]',
        'gordon = ["local"]',
        '',
        '[gordon.local]',
        'command = "judge-bot --pr {pr_url} --prompt {prompt}"',
        '',
      ].join("\n"),
    );
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });

    const fullSha = "e4e7dd43c6cc0d5f1234567890abcdef12345678";
    const shortSha = fullSha.slice(0, 7);
    expect(fullSha).toHaveLength(40);

    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) => {
        if (args[0] === "pr") {
          return { status: 0, stdout: `{"headRefOid":"${fullSha}"}`, stderr: "" };
        }
        if (args.join(" ").includes("issues/7/comments")) {
          return {
            status: 0,
            stdout: `[{"body":"lgtm @ ${shortSha}","created_at":"2026-06-11T00:00:00Z"}]`,
            stderr: "",
          };
        }
        if (args.join(" ").includes("pulls/7/reviews")) {
          return { status: 0, stdout: "[]", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
      },
    });

    await exec(deps, ["judge-tick", "-n", "o-r-7"]);
    await exec(deps, ["judge-tick", "-n", "o-r-7"]);

    expect(out.join("\n")).toContain(`gordon: lgtm current at ${fullSha}`);
    expect(calls.some((c) => c[0] === "tmux" && c[1] === "new-window")).toBe(false);

    const events = readEvents(dir);
    expect(events.filter((event) => event.event === "lgtm_stale")).toHaveLength(0);
    const lgtms = events.filter((event) => event.event === "lgtm");
    expect(lgtms).toHaveLength(1);
    expect(lgtms[0]).toMatchObject({ sha: fullSha });
  });

  it("does not consume a pinned LGTM when the incremental re-review window fails to start", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      [
        '[roles]',
        'gordon = ["local"]',
        '',
        '[gordon.local]',
        'command = "judge-bot --pr {pr_url} --prompt {prompt}"',
        '',
      ].join("\n"),
    );
    const dir = runDirFor(h, "o-r-7");
    writeCombo(dir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    });
    appendEvent(dir, "pr_opened", { url: "https://github.com/o/r/pull/7" });
    appendEvent(dir, "lgtm", { sha: "abc123" });

    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      gh: (args) =>
        args[0] === "pr"
          ? { status: 0, stdout: '{"headRefOid":"def456"}', stderr: "" }
          : { status: 0, stdout: "[]", stderr: "" },
      tmux: (args) =>
        args[0] === "new-window"
          ? { status: 1, stdout: "", stderr: "window limit reached" }
          : { status: 0, stdout: "", stderr: "" },
    });

    await expect(exec(deps, ["judge-tick", "-n", "o-r-7"])).rejects.toThrow(/re-review/);

    expect(readEvents(dir).map((event) => event.event)).toEqual(["pr_opened", "lgtm"]);
  });
});

describe("events", () => {
  it("renders post-PR events through --follow", async () => {
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
    appendEvent(dir, "merged", { sha: "def456", by: "javi" });

    const stop = new Error("observed followed event");
    const out: string[] = [];
    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h, COMBO_CHEN_POLL_MS: "1" },
      out: (line) => {
        out.push(line);
        if (line.includes('"event":"merged"')) throw stop;
      },
    });

    await expect(exec(deps, ["events", "-n", "o-r-7", "--follow"])).rejects.toBe(stop);
    expect(JSON.parse(out[0] ?? "{}")).toMatchObject({
      event: "merged",
      sha: "def456",
      by: "javi",
    });
  });
});

describe("stop", () => {
  it("kills the tmux session and journals who stopped it", async () => {
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

    const { deps, calls } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });
    await exec(deps, ["stop", "-n", "o-r-7"]);

    expect(calls.some((c) => c[0] === "tmux" && c[1] === "kill-session")).toBe(true);
    const events = readEvents(dir);
    expect(events.at(-1)?.event).toBe("stopped");
  });

  it("does not journal stopped when the tmux kill fails (the journal never lies)", async () => {
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

    const { deps } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) =>
        args[0] === "kill-session"
          ? { status: 1, stdout: "", stderr: "no server running" }
          : { status: 0, stdout: "", stderr: "" },
    });

    await expect(exec(deps, ["stop", "-n", "o-r-7"])).rejects.toThrow(/kill/i);
    expect(readEvents(dir)).toEqual([]);
  });
});

describe("resolvePollMs", () => {
  it("reads COMBO_CHEN_POLL_MS and falls back to undefined (core default applies)", async () => {
    const { resolvePollMs } = await import("./main.js");
    expect(resolvePollMs({ COMBO_CHEN_POLL_MS: "250" })).toBe(250);
    expect(resolvePollMs({ COMBO_CHEN_POLL_MS: "nonsense" })).toBeUndefined();
    expect(resolvePollMs({})).toBeUndefined();
  });
});

describe("run ordering and safety", () => {
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

  it("refuses a repo whose origin does not match the issue's owner/repo", async () => {
    const { deps } = fakeDeps({
      git: (args) =>
        args[0] === "remote"
          ? { status: 0, stdout: "git@github.com:someone/else.git\n", stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
    });

    await expect(
      exec(deps, ["run", "--issue", ISSUE, "--repo", mkdtempSync(join(tmpdir(), "combo-chen-repo-"))]),
    ).rejects.toThrow(/origin/i);
  });

  it("refuses an origin that merely contains the issue's owner/repo as a prefix", async () => {
    // o/r-fork contains "o/r"; only exact slug equality may pass the guard.
    const { deps } = fakeDeps({
      git: (args) =>
        args[0] === "remote"
          ? { status: 0, stdout: "git@github.com:o/r-fork.git\n", stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
    });

    await expect(
      exec(deps, ["run", "--issue", ISSUE, "--repo", mkdtempSync(join(tmpdir(), "combo-chen-repo-"))]),
    ).rejects.toThrow(/origin/i);
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

    const worktreeRemoveIndex = calls.findIndex((c) => c[0] === "git" && c.includes("remove"));
    const worktreeRemove = calls[worktreeRemoveIndex];
    expect(worktreeRemove).toBeDefined();
    expect(worktreeRemove).toContain("worktree");
    expect(worktreeRemove).toContain("--force");
    expect(worktreeRemove).toContain(join(repoDir, ".worktrees", "issue-7"));

    // Retry after a tmux failure must be idempotent: the branch created by
    // `worktree add -b` has to go too, and only after the worktree (a branch
    // checked out in a worktree can't be deleted).
    const branchDeleteIndex = calls.findIndex(
      (c) => c[0] === "git" && c.includes("branch") && c.includes("-D"),
    );
    const branchDelete = calls[branchDeleteIndex];
    expect(branchDelete).toBeDefined();
    expect(branchDelete).toContain(`cwd=${repoDir}`);
    expect(branchDelete).toContain("combo/issue-7");
    expect(worktreeRemoveIndex).toBeLessThan(branchDeleteIndex);

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
        git: (args) =>
          args[0] === "remote"
            ? { status: 0, stdout: `${remoteUrl}\n`, stderr: "" }
            : { status: 0, stdout: "", stderr: "" },
      });

      await expect(
        exec(deps, ["run", "--issue", ISSUE, "--repo", mkdtempSync(join(tmpdir(), "combo-chen-repo-"))]),
      ).resolves.toBeUndefined();
    }
  });
});
