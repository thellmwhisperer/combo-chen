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
      return { status: 0, stdout: "[]", stderr: "" };
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
  it("exposes the v0 commands and hidden runner helpers", () => {
    const { deps } = fakeDeps();
    const names = createProgram(deps)
      .commands.map((c) => c.name())
      .sort();
    expect(names).toEqual(
      [
        "activate-thread-sitter",
        "emit",
        "events",
        "nudge-review-comments",
        "run",
        "status",
        "stop",
      ].sort(),
    );
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

    await exec(deps, ["emit", "-n", "o-r-7", "rower_failed", "--field", "exit_code=3"]);

    const events = readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("rower_failed");
    expect(events[0]?.["exit_code"]).toBe(3);
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
    expect(runner).toContain("no-mistakes axi run");

    const gitCall = calls.find((c) => c[0] === "git" && c.includes("worktree"));
    expect(gitCall).toBeDefined();

    const tmuxNewSession = calls.find((c) => c[0] === "tmux" && c[1] === "new-session");
    expect(tmuxNewSession).toContain("combo-chen-o-r-7");

    const events = readEvents(runDir);
    expect(events[0]?.event).toBe("combo_created");
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
