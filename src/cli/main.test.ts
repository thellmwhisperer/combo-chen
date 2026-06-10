import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appendEvent, readEvents } from "../core/events.js";
import { runDirFor, writeCombo } from "../core/state.js";
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
    issueExists: () => true,
    ...overrides,
  };
  return { deps, calls, out };
}

const ISSUE = "https://github.com/o/r/issues/7";

async function exec(deps: Deps, argv: string[]): Promise<void> {
  const program = createProgram(deps);
  await program.parseAsync(["node", "combo-chen", ...argv]);
}

describe("command surface", () => {
  it("exposes exactly the v0 commands", () => {
    const { deps } = fakeDeps();
    const names = createProgram(deps)
      .commands.map((c) => c.name())
      .sort();
    expect(names).toEqual(["emit", "events", "run", "status", "stop"].sort());
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

  it("surfaces emitting to a combo that was never created (caller bug)", async () => {
    const { deps } = fakeDeps({ env: { COMBO_CHEN_HOME: home() } });
    await expect(exec(deps, ["emit", "-n", "ghost", "rower_started"])).rejects.toThrow(/ENOENT/);
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
});
