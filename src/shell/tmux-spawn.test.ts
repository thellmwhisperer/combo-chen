/**
 * @overview Real-tmux contract tests for Combo v1 P2 spawn/meta/status.
 *
 *   READING GUIDE
 *   -------------
 *   1. Session + five windows   <- naming, pinning, meta, duplicates.
 *   2. Exact targets            <- alpha/alphabet prefix isolation.
 *   3. Custody + containment    <- concurrent spawn + symlink escape.
 *   4. Live endpoints + send    <- no dead meta; verified Enter.
 *
 * @exports none
 * @deps vitest, node:child_process, node:fs, node:os, node:path
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
      CB_SEND_SLEEP: "0.4",
      CB_SEND_SETTLE: "0.1",
      CB_SEND_RETRIES: "3",
    },
  };
}

function ensureRun(home: RunHome, run: string): string {
  const runDir = join(home.runs, run);
  mkdirSync(join(runDir, "agents"), { recursive: true });
  return runDir;
}

function sh(script: string, args: string[], env: NodeJS.ProcessEnv, timeout = 20_000) {
  return spawnSync("sh", [join(BIN, script), ...args], { encoding: "utf8", env, timeout });
}

function tmux(home: RunHome, args: string[]) {
  return spawnSync("tmux", ["-L", home.socket, "-f", "/dev/null", ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

function spawnAgent(
  home: RunHome,
  run: string,
  agent: string,
  extra: string[] = [],
  env: NodeJS.ProcessEnv = home.env,
): ReturnType<typeof sh> {
  return sh("cb-agent-spawn.sh", [run, agent, ...extra], env);
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

function sleep(ms: number): void {
  spawnSync("sleep", [(ms / 1000).toFixed(3)]);
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

    expect(tmux(home, ["has-session", "-t", `=combo-${run}`]).status).toBe(0);

    const windows = tmux(home, ["list-windows", "-t", `=combo-${run}`, "-F", "#{window_name}"]);
    expect(windows.status).toBe(0);
    const names = windows.stdout.trim().split("\n").filter(Boolean).sort();
    expect(names).toEqual(AGENTS.map((a) => `cb-${run}-${a}`).sort());
    expect(names).toHaveLength(5);
    expect(names.some((n) => n.includes("_cb_"))).toBe(false);

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
    expect(dup.stderr).toMatch(/already exists|endpoint already exists/);
  });

  it("isolates alpha from alphabet on create/resolve/status/send/teardown", () => {
    const home = makeHome();
    const long = "alphabet";
    const short = "alpha";
    ensureRun(home, long);
    ensureRun(home, short);

    expect(spawnAgent(home, long, "launcher").status).toBe(0);
    expect(spawnAgent(home, short, "launcher").status).toBe(0);

    const sessions = tmux(home, ["list-sessions", "-F", "#{session_name}"]);
    const names = sessions.stdout.trim().split("\n").filter(Boolean).sort();
    expect(names).toEqual([`combo-${long}`, `combo-${short}`].sort());

    const longWins = tmux(home, ["list-windows", "-t", `=combo-${long}`, "-F", "#{window_name}"]);
    const shortWins = tmux(home, ["list-windows", "-t", `=combo-${short}`, "-F", "#{window_name}"]);
    expect(longWins.stdout).toContain(`cb-${long}-launcher`);
    expect(longWins.stdout).not.toContain(`cb-${short}-launcher`);
    expect(shortWins.stdout).toContain(`cb-${short}-launcher`);
    expect(shortWins.stdout).not.toContain(`cb-${long}-launcher`);

    // Non-exact has-session would prefix-match; exact must distinguish.
    expect(tmux(home, ["has-session", "-t", `=combo-${short}`]).status).toBe(0);
    expect(tmux(home, ["has-session", "-t", `=combo-${long}`]).status).toBe(0);

    const statusShort = sh("cb-status.sh", [short, "launcher"], home.env);
    expect(statusShort.status).toBe(0);
    expect(statusShort.stdout).toContain("session_live=1");
    expect(statusShort.stdout).toContain(`agent.launcher.window=combo-${short}:cb-${short}-launcher`);
    expect(statusShort.stdout).not.toContain(`cb-${long}-launcher`);

    const marker = `ALPHA-ONLY-${Date.now()}`;
    expect(sh("cb-send.sh", [short, "launcher", `echo ${marker}`], home.env).status).toBe(0);
    sleep(250);
    expect(sh("cb-peek.sh", [short, "launcher", "40"], home.env).stdout).toContain(marker);
    expect(sh("cb-peek.sh", [long, "launcher", "40"], home.env).stdout).not.toContain(marker);

    const lib = `
set -eu
. "${join(BIN, "cb-tmux.sh")}"
cb_tmux_kill_session "combo-${short}"
`;
    expect(spawnSync("sh", ["-c", lib], { encoding: "utf8", env: home.env, timeout: 10_000 }).status).toBe(0);
    expect(tmux(home, ["has-session", "-t", `=combo-${short}`]).status).not.toBe(0);
    expect(tmux(home, ["has-session", "-t", `=combo-${long}`]).status).toBe(0);
    expect(tmux(home, ["list-windows", "-t", `=combo-${long}`, "-F", "#{window_name}"]).stdout).toContain(
      `cb-${long}-launcher`,
    );
  }, 30_000);

  it("serializes concurrent same-run same-agent spawn to one winner", async () => {
    const home = makeHome();
    const run = "race";
    ensureRun(home, run);
    // Pre-create session so contenders only race on window+meta.
    expect(spawnAgent(home, run, "launcher").status).toBe(0);

    const raceEnv = {
      ...home.env,
      CB_SPAWN_LOCK_TIMEOUT_SECONDS: "60",
      CB_SPAWN_LOCK_STALE_SECONDS: "120",
    };
    const children = Array.from({ length: 20 }, () =>
      spawn("sh", [join(BIN, "cb-agent-spawn.sh"), run, "coder"], {
        env: raceEnv,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );

    const results = await Promise.all(
      children.map(
        (child) =>
          new Promise<{ status: number | null; stdout: string; stderr: string }>((resolvePromise) => {
            let stdout = "";
            let stderr = "";
            child.stdout?.on("data", (chunk: Buffer | string) => {
              stdout += String(chunk);
            });
            child.stderr?.on("data", (chunk: Buffer | string) => {
              stderr += String(chunk);
            });
            child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
          }),
      ),
    );

    const winners = results.filter((r) => r.status === 0);
    const losers = results.filter((r) => r.status !== 0);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(19);
    expect(winners[0]?.stdout.trim()).toMatch(/^@\d+$/);

    const windows = tmux(home, ["list-windows", "-t", `=combo-${run}`, "-F", "#{window_name}"]);
    const coderWindows = windows.stdout
      .trim()
      .split("\n")
      .filter((n) => n === `cb-${run}-coder`);
    expect(coderWindows).toHaveLength(1);

    const meta = readMeta(home, run, "coder");
    expect(meta.window_id).toBe(winners[0]?.stdout.trim());
    expect(meta.run).toBe(run);
  }, 40_000);

  it("rejects agents symlink escape so peer run meta stays intact", () => {
    const home = makeHome();
    const a = "arun";
    const b = "brun";
    const aDir = ensureRun(home, a);
    ensureRun(home, b);

    // Remove real agents dir and point it at B's agents.
    rmSync(join(aDir, "agents"), { recursive: true, force: true });
    symlinkSync(join(home.runs, b, "agents"), join(aDir, "agents"));

    expect(spawnAgent(home, b, "coder").status).toBe(0);
    const before = readFileSync(join(home.runs, b, "agents", "coder.meta"), "utf8");

    const escaped = spawnAgent(home, a, "coder");
    expect(escaped.status).not.toBe(0);
    expect(escaped.stderr).toMatch(/symlink|escapes/);

    const after = readFileSync(join(home.runs, b, "agents", "coder.meta"), "utf8");
    expect(after).toBe(before);
    expect(after).toContain("run=brun");
    // A must still be a symlink escape (not replaced by a real agents dir publish).
    const link = spawnSync("readlink", [join(aDir, "agents")], { encoding: "utf8" });
    expect(link.status).toBe(0);
    expect(link.stdout.trim().length).toBeGreaterThan(0);
  });

  it("does not publish meta for invalid shell or missing cwd endpoints", () => {
    const home = makeHome();
    const run = "deadend";
    const runDir = ensureRun(home, run);

    const missingCwd = spawnAgent(home, run, "launcher", ["--cwd", join(runDir, "nope")]);
    expect(missingCwd.status).not.toBe(0);
    expect(existsSync(join(runDir, "agents", "launcher.meta"))).toBe(false);

    const badShellEnv = {
      ...home.env,
      SHELL: join(home.home, "no-such-shell"),
    };
    const badShell = spawnAgent(home, run, "launcher", [], badShellEnv);
    expect(badShell.status).not.toBe(0);
    expect(existsSync(join(runDir, "agents", "launcher.meta"))).toBe(false);
    // Exact session must not be falsely reported live with durable meta.
    const status = sh("cb-status.sh", [run, "launcher"], home.env);
    expect(status.stdout).not.toMatch(/agent\.launcher\.window_id=@/);
  });

  it("resolves send/peek/status and verifies Enter with a first-enter swallow", () => {
    const home = makeHome();
    const run = "issue-312-send";
    ensureRun(home, run);
    const marker = `P2-MARKER-${Date.now()}`;
    expect(spawnAgent(home, run, "coder").status).toBe(0);
    sleep(300);

    const sent = sh("cb-send.sh", [run, "coder", `echo ${marker}`], home.env);
    expect(sent.status, sent.stderr).toBe(0);
    sleep(250);
    const peek = sh("cb-peek.sh", [run, "coder", "80"], home.env);
    expect(peek.status, peek.stderr).toBe(0);
    expect(peek.stdout).toContain(marker);

    const status = sh("cb-status.sh", [run, "coder"], home.env);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain(`run=${run}`);
    expect(status.stdout).toContain("session_live=1");
    expect(status.stdout).toContain(`agent.coder.window=combo-${run}:cb-${run}-coder`);

    // Fake composer: first Enter is swallowed; second submits.
    // Keep paths short so send-keys does not hard-wrap the launch command.
    const swallow = "issue-312-swallow";
    ensureRun(home, swallow);
    const fakeDir = mkdtempSync(join(tmpdir(), "fc-"));
    homes.push(fakeDir);
    const fake = join(fakeDir, "fc.py");
    writeFileSync(
      fake,
      `#!/usr/bin/env python3
import sys, time, tty, termios
fd = sys.stdin.fileno()
old = termios.tcgetattr(fd)
try:
    tty.setraw(fd)
    buf = []
    enters = 0
    sys.stdout.write("> ")
    sys.stdout.flush()
    while True:
        ch = sys.stdin.read(1)
        if ch in ("\\r", "\\n"):
            enters += 1
            if enters == 1:
                continue
            sys.stdout.write("\\r\\nGOT:" + "".join(buf) + "\\r\\n")
            sys.stdout.flush()
            while True:
                time.sleep(3600)
        elif ch == "\\x03":
            break
        elif ch in ("\\x7f", "\\b"):
            if buf:
                buf.pop()
                sys.stdout.write("\\b \\b")
                sys.stdout.flush()
        else:
            buf.append(ch)
            sys.stdout.write(ch)
            sys.stdout.flush()
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
`,
      { mode: 0o755 },
    );

    expect(
      spawnAgent(home, swallow, "reviewer", [
        "--mode",
        "shell",
        "--cwd",
        fakeDir,
        "--cmd",
        "exec python3 ./fc.py",
      ]).status,
    ).toBe(0);
    sleep(400);
    expect(sh("cb-status.sh", [swallow, "reviewer"], home.env).stdout).toMatch(/command=Python/i);

    const payload = `SWALLOW-${Date.now()}`;
    const verified = sh("cb-send.sh", [swallow, "reviewer", payload], {
      ...home.env,
      CB_SEND_RETRIES: "3",
      CB_SEND_SLEEP: "0.3",
    });
    expect(verified.status, verified.stderr).toBe(0);
    sleep(300);
    const pane = sh("cb-peek.sh", [swallow, "reviewer", "40"], home.env);
    expect(pane.status, pane.stderr).toBe(0);
    expect(pane.stdout).toContain(`GOT:${payload}`);

    // Exhaust retries against a composer that never accepts Enter.
    const stuck = "issue-312-stuck";
    ensureRun(home, stuck);
    const neverDir = mkdtempSync(join(tmpdir(), "ns-"));
    homes.push(neverDir);
    const never = join(neverDir, "ns.py");
    writeFileSync(
      never,
      `#!/usr/bin/env python3
import sys, tty, termios
fd = sys.stdin.fileno()
old = termios.tcgetattr(fd)
try:
    tty.setraw(fd)
    buf = []
    sys.stdout.write("> ")
    sys.stdout.flush()
    while True:
        ch = sys.stdin.read(1)
        if ch in ("\\r", "\\n"):
            continue
        elif ch == "\\x03":
            break
        else:
            buf.append(ch)
            sys.stdout.write(ch)
            sys.stdout.flush()
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
`,
      { mode: 0o755 },
    );
    expect(
      spawnAgent(home, stuck, "gate", ["--mode", "shell", "--cwd", neverDir, "--cmd", "exec python3 ./ns.py"])
        .status,
    ).toBe(0);
    sleep(400);
    const failSend = sh("cb-send.sh", [stuck, "gate", "NEVERLAND"], {
      ...home.env,
      CB_SEND_RETRIES: "2",
      CB_SEND_SLEEP: "0.3",
    });
    expect(failSend.status).not.toBe(0);
    expect(failSend.stderr).toMatch(/swallowed|still holds payload/);
  }, 45_000);

  it("kills windows and sessions idempotently with exact targets", () => {
    const home = makeHome();
    const run = "issue-312-kill";
    spawnFive(home, run);
    const meta = readMeta(home, run, "gate");
    const windowId = meta.window_id as string;

    const lib = `
set -eu
. "${join(BIN, "cb-tmux.sh")}"
cb_tmux_kill "${windowId}"
cb_tmux_kill "${windowId}"
cb_tmux_kill_session "combo-${run}"
cb_tmux_kill_session "combo-${run}"
`;
    const kill = spawnSync("sh", ["-c", lib], { encoding: "utf8", env: home.env, timeout: 10_000 });
    expect(kill.status, kill.stderr).toBe(0);
    expect(tmux(home, ["has-session", "-t", `=combo-${run}`]).status).not.toBe(0);
  }, 15_000);

  it("keeps two concurrent runs isolated under send/status/teardown", () => {
    const home = makeHome();
    const runA = "issue-312-aa01";
    const runB = "issue-312-bb02";
    spawnFive(home, runA);
    spawnFive(home, runB);

    const markerB = `ONLY-B-${Date.now()}`;
    expect(sh("cb-send.sh", [runB, "reviewer", `echo ${markerB}`], home.env).status).toBe(0);
    sleep(250);

    const peekB = sh("cb-peek.sh", [runB, "reviewer", "80"], home.env);
    expect(peekB.stdout).toContain(markerB);
    const peekA = sh("cb-peek.sh", [runA, "reviewer", "80"], home.env);
    expect(peekA.stdout).not.toContain(markerB);

    const lib = `
set -eu
. "${join(BIN, "cb-tmux.sh")}"
cb_tmux_kill_session "combo-${runA}"
`;
    expect(spawnSync("sh", ["-c", lib], { encoding: "utf8", env: home.env, timeout: 10_000 }).status).toBe(0);
    expect(tmux(home, ["has-session", "-t", `=combo-${runA}`]).status).not.toBe(0);
    expect(tmux(home, ["has-session", "-t", `=combo-${runB}`]).status).toBe(0);

    const windowsB = tmux(home, ["list-windows", "-t", `=combo-${runB}`, "-F", "#{window_name}"]);
    const namesB = windowsB.stdout.trim().split("\n").filter(Boolean).sort();
    expect(namesB).toEqual(AGENTS.map((a) => `cb-${runB}-${a}`).sort());

    const statusB = sh("cb-status.sh", [runB], home.env);
    expect(statusB.status).toBe(0);
    expect(statusB.stdout).toContain("session_live=1");

    const bad = sh("cb-peek.sh", [runA, "coder", "10"], home.env);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/session missing|unresolved|no metadata/);
  }, 30_000);

  it("never resolves an agent target outside combo-<runId>", () => {
    const home = makeHome();
    const run = "issue-312-scope";
    ensureRun(home, run);
    expect(spawnAgent(home, run, "launcher").status).toBe(0);

    const foreign = tmux(home, ["new-session", "-d", "-s", "foreign-other", "-n", `cb-${run}-launcher`]);
    expect(foreign.status, foreign.stderr).toBe(0);
    expect(tmux(home, ["kill-window", "-t", `=combo-${run}:cb-${run}-launcher`]).status).toBe(0);

    const metaPath = join(home.runs, run, "agents", "launcher.meta");
    const meta = readFileSync(metaPath, "utf8");
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

    const send = sh("cb-send.sh", [run, "launcher", "echo should-not-land"], home.env);
    expect(send.status).not.toBe(0);
  }, 15_000);

  it("writes agent meta atomically and keeps decision paths free of capture-pane", () => {
    const home = makeHome();
    const run = "issue-312-meta";
    ensureRun(home, run);
    expect(spawnAgent(home, run, "gate", ["--mode", "shell"]).status).toBe(0);
    const metaPath = join(home.runs, run, "agents", "gate.meta");
    expect(existsSync(metaPath)).toBe(true);
    expect(existsSync(`${metaPath}.tmp`)).toBe(false);

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
    expect(readFileSync(join(BIN, "cb-peek.sh"), "utf8")).toMatch(/cb_tmux_capture/);

    const binNoop = spawnAgent(home, run, "coder", ["--mode", "bin", "--bin", "claude"]);
    expect(binNoop.status).not.toBe(0);
    expect(binNoop.stderr).toMatch(/mode=bin requires --cmd/);
  });
});
