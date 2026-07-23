/**
 * @overview Real-tmux contract tests for Combo v1 P2 spawn/meta/status.
 *
 *   READING GUIDE
 *   -------------
 *   1. Session + five windows   <- naming, pinning, meta, duplicates.
 *   2. Send / peek / status     <- meta resolution inside combo-<runId>.
 *   3. Concurrent runs          <- teardown of one never hits the other.
 *
 * @exports none
 * @deps vitest, node:child_process, node:fs, node:os, node:path
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const BIN = join(ROOT, "bin");
const AGENTS = ["launcher", "coder", "reviewer", "gate", "cleaner"] as const;

type RunHome = {
  env: NodeJS.ProcessEnv;
  runs: string;
  socket: string;
  home: string;
};

const homes: string[] = [];
const sockets: string[] = [];

function tmuxAvailable(): boolean {
  const result = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  return result.status === 0;
}

function makeHome(): RunHome {
  const home = mkdtempSync(join(tmpdir(), "cb-tmux-"));
  homes.push(home);
  const runs = join(home, "runs");
  mkdirSync(runs, { recursive: true });
  const socket = `cbtest-${process.pid}-${homes.length}-${Date.now()}`;
  sockets.push(socket);
  return {
    home,
    runs,
    socket,
    env: {
      ...process.env,
      CB_RUNS_DIR: runs,
      CB_TMUX_SOCKET: socket,
      CB_TMUX_CONF: "/dev/null",
    },
  };
}

function ensureRun(home: RunHome, run: string): string {
  const runDir = join(home.runs, run);
  mkdirSync(join(runDir, "agents"), { recursive: true });
  return runDir;
}

function sh(script: string, args: string[], env: NodeJS.ProcessEnv, timeout = 15_000) {
  return spawnSync("sh", [join(BIN, script), ...args], { encoding: "utf8", env, timeout });
}

function tmux(home: RunHome, args: string[]) {
  return spawnSync("tmux", ["-L", home.socket, "-f", "/dev/null", ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

function spawnAgent(home: RunHome, run: string, agent: string, extra: string[] = []): ReturnType<typeof sh> {
  return sh("cb-agent-spawn.sh", [run, agent, ...extra], home.env);
}

function spawnFive(home: RunHome, run: string): void {
  ensureRun(home, run);
  for (const agent of AGENTS) {
    const result = spawnAgent(home, run, agent);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toMatch(/^@\d+$/);
  }
}

function readMeta(home: RunHome, run: string, agent: string): Record<string, string> {
  const text = readFileSync(join(home.runs, run, "agents", `${agent}.meta`), "utf8");
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line.includes("=")) continue;
    const i = line.indexOf("=");
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

function windowOption(home: RunHome, target: string, option: string): string {
  const result = tmux(home, ["show-window-options", "-t", target, option]);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    spawnSync("tmux", ["-L", socket, "-f", "/dev/null", "kill-server"], {
      encoding: "utf8",
      timeout: 5_000,
    });
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const describeTmux = tmuxAvailable() ? describe : describe.skip;

describeTmux("cb-tmux + spawn", () => {
  it("creates one combo-<runId> session with five pinned agent windows and meta", () => {
    const home = makeHome();
    const run = "issue-312-a1f2";
    spawnFive(home, run);

    const has = tmux(home, ["has-session", "-t", `combo-${run}`]);
    expect(has.status).toBe(0);

    const windows = tmux(home, ["list-windows", "-t", `combo-${run}`, "-F", "#{window_name}"]);
    expect(windows.status).toBe(0);
    const names = windows.stdout.trim().split("\n").filter(Boolean).sort();
    expect(names).toEqual(AGENTS.map((a) => `cb-${run}-${a}`).sort());
    expect(names).toHaveLength(5);

    for (const agent of AGENTS) {
      const meta = readMeta(home, run, agent);
      expect(meta.run).toBe(run);
      expect(meta.agent).toBe(agent);
      expect(meta.window).toBe(`combo-${run}:cb-${run}-${agent}`);
      expect(meta.window_id).toMatch(/^@\d+$/);
      expect(meta.mode).toMatch(/^(shell|tui)$/);
      expect(meta.started).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      const windowId = meta.window_id as string;

      const auto = windowOption(home, windowId, "automatic-rename");
      const allow = windowOption(home, windowId, "allow-rename");
      expect(auto).toMatch(/automatic-rename off/);
      expect(allow).toMatch(/allow-rename off/);
    }
  }, 20_000);

  it("refuses a duplicate agent window name", () => {
    const home = makeHome();
    const run = "issue-312-dup1";
    ensureRun(home, run);
    expect(spawnAgent(home, run, "launcher").status).toBe(0);
    const dup = spawnAgent(home, run, "launcher");
    expect(dup.status).not.toBe(0);
    expect(dup.stderr).toMatch(/already exists/);
  });

  it("resolves send, peek, and status from run-local meta only", () => {
    const home = makeHome();
    const run = "issue-312-send";
    ensureRun(home, run);
    const marker = `P2-MARKER-${Date.now()}`;
    expect(spawnAgent(home, run, "coder").status).toBe(0);

    const sent = sh("cb-send.sh", [run, "coder", `printf '%s\\n' '${marker}'`], home.env);
    expect(sent.status, sent.stderr).toBe(0);

    // Give the shell a beat to echo.
    spawnSync("sleep", ["0.2"]);
    const peek = sh("cb-peek.sh", [run, "coder", "80"], home.env);
    expect(peek.status, peek.stderr).toBe(0);
    expect(peek.stdout).toContain(marker);

    const status = sh("cb-status.sh", [run, "coder"], home.env);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain(`run=${run}`);
    expect(status.stdout).toContain("phase=");
    expect(status.stdout).toContain(`agent.coder.window=combo-${run}:cb-${run}-coder`);
    expect(status.stdout).toMatch(/agent\.coder\.window_id=@\d+/);
    expect(status.stdout).toMatch(/agent\.coder\.command=.+/);
    expect(status.stdout).toContain("session_live=1");
  }, 15_000);

  it("kills windows and sessions idempotently", () => {
    const home = makeHome();
    const run = "issue-312-kill";
    spawnFive(home, run);
    const meta = readMeta(home, run, "gate");

    const lib = `
set -eu
. "${join(BIN, "cb-tmux.sh")}"
cb_tmux_kill "${meta.window_id}"
cb_tmux_kill "${meta.window_id}"
cb_tmux_kill_session "combo-${run}"
cb_tmux_kill_session "combo-${run}"
`;
    const kill = spawnSync("sh", ["-c", lib], { encoding: "utf8", env: home.env, timeout: 10_000 });
    expect(kill.status, kill.stderr).toBe(0);
    expect(tmux(home, ["has-session", "-t", `combo-${run}`]).status).not.toBe(0);
  }, 15_000);

  it("keeps two concurrent runs isolated under send/status/teardown", () => {
    const home = makeHome();
    const runA = "issue-312-aa01";
    const runB = "issue-312-bb02";
    spawnFive(home, runA);
    spawnFive(home, runB);

    const markerB = `ONLY-B-${Date.now()}`;
    expect(sh("cb-send.sh", [runB, "reviewer", `printf '%s\\n' '${markerB}'`], home.env).status).toBe(0);
    spawnSync("sleep", ["0.2"]);

    const peekB = sh("cb-peek.sh", [runB, "reviewer", "80"], home.env);
    expect(peekB.stdout).toContain(markerB);
    const peekA = sh("cb-peek.sh", [runA, "reviewer", "80"], home.env);
    expect(peekA.stdout).not.toContain(markerB);

    // Teardown A must not touch B.
    const lib = `
set -eu
. "${join(BIN, "cb-tmux.sh")}"
cb_tmux_kill_session "combo-${runA}"
`;
    expect(spawnSync("sh", ["-c", lib], { encoding: "utf8", env: home.env, timeout: 10_000 }).status).toBe(0);
    expect(tmux(home, ["has-session", "-t", `combo-${runA}`]).status).not.toBe(0);
    expect(tmux(home, ["has-session", "-t", `combo-${runB}`]).status).toBe(0);

    const windowsB = tmux(home, ["list-windows", "-t", `combo-${runB}`, "-F", "#{window_name}"]);
    const namesB = windowsB.stdout.trim().split("\n").filter(Boolean).sort();
    expect(namesB).toEqual(AGENTS.map((a) => `cb-${runB}-${a}`).sort());

    const statusB = sh("cb-status.sh", [runB], home.env);
    expect(statusB.status).toBe(0);
    expect(statusB.stdout).toContain("session_live=1");
    for (const agent of AGENTS) {
      expect(statusB.stdout).toContain(`agent.${agent}.window=combo-${runB}:cb-${runB}-${agent}`);
    }

    // Meta for A still exists on disk but resolve must fail without the session.
    const bad = sh("cb-peek.sh", [runA, "coder", "10"], home.env);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/session missing|unresolved|no metadata/);
  }, 30_000);

  it("never resolves an agent target outside combo-<runId>", () => {
    const home = makeHome();
    const run = "issue-312-scope";
    ensureRun(home, run);
    expect(spawnAgent(home, run, "launcher").status).toBe(0);

    // Plant a foreign session that reuses the agent window name shape, then
    // remove the real in-session window so only the foreign name remains.
    const foreign = tmux(home, ["new-session", "-d", "-s", "foreign-other", "-n", `cb-${run}-launcher`]);
    expect(foreign.status, foreign.stderr).toBe(0);
    expect(tmux(home, ["kill-window", "-t", `combo-${run}:cb-${run}-launcher`]).status).toBe(0);

    const metaPath = join(home.runs, run, "agents", "launcher.meta");
    const meta = readFileSync(metaPath, "utf8");
    // Corrupt ids and deliberately point the name fallback at the foreign session.
    writeFileSync(
      metaPath,
      meta
        .split("\n")
        .map((line) => {
          if (line.startsWith("window_id=")) return "window_id=@99999";
          if (line.startsWith("window=")) return `window=foreign-other:cb-${run}-launcher`;
          return line;
        })
        .join("\n"),
    );

    const peek = sh("cb-peek.sh", [run, "launcher", "5"], home.env);
    expect(peek.status).not.toBe(0);
    expect(peek.stderr).toMatch(/unresolved target|session missing/);

    // Even an explicit foreign window name must not be used once the run
    // session no longer owns that agent endpoint.
    const send = sh("cb-send.sh", [run, "launcher", "echo should-not-land"], home.env);
    expect(send.status).not.toBe(0);
  }, 15_000);

  it("writes agent meta atomically and keeps journal scripts decision-free of capture-pane", () => {
    const home = makeHome();
    const run = "issue-312-meta";
    ensureRun(home, run);
    expect(spawnAgent(home, run, "gate", ["--mode", "shell", "--bin", ""]).status).toBe(0);
    const metaPath = join(home.runs, run, "agents", "gate.meta");
    expect(existsSync(metaPath)).toBe(true);
    expect(existsSync(`${metaPath}.tmp`)).toBe(false);
    // No leftover temp files from the atomic write.
    const agentsDir = join(home.runs, run, "agents");
    const leftovers = spawnSync("sh", ["-c", `ls -A '${agentsDir}'`], { encoding: "utf8" });
    expect(leftovers.stdout.trim().split("\n")).toEqual(["gate.meta"]);

    // Decision-path scripts must not call capture-pane; only peek (and the
    // sourceable capture helper used by peek/status humans) may.
    const decisionScripts = [
      "cb-emit.sh",
      "cb-wait.sh",
      "cb-run-state.sh",
      "cb-agent-spawn.sh",
      "cb-send.sh",
    ];
    for (const name of decisionScripts) {
      const body = readFileSync(join(BIN, name), "utf8");
      expect(body, name).not.toMatch(/capture-pane/);
    }
    const peekBody = readFileSync(join(BIN, "cb-peek.sh"), "utf8");
    expect(peekBody).toMatch(/cb_tmux_capture/);
  });
});
