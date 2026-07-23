/**
 * @overview Real-tmux contract tests for Combo v1 P2 spawn/meta/status.
 *
 *   READING GUIDE
 *   -------------
 *   1. Windows + meta + pinning
 *   2. Exact targets, custody, containment
 *   3. Live endpoints + verified Enter
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
  rmdirSync,
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
type Home = { env: NodeJS.ProcessEnv; runs: string; socket: string; home: string };
const homes: string[] = [];
const sockets: string[] = [];

const tmuxOk = () => spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
const sleep = (ms: number) => spawnSync("sleep", [(ms / 1000).toFixed(3)]);

function makeHome(): Home {
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
      CB_SEND_SLEEP: "0.35",
      CB_SEND_SETTLE: "0.1",
      CB_SEND_RETRIES: "3",
    },
  };
}

function ensureRun(h: Home, run: string) {
  const d = join(h.runs, run);
  mkdirSync(join(d, "agents"), { recursive: true });
  return d;
}

function sh(script: string, args: string[], env: NodeJS.ProcessEnv, timeout = 20_000) {
  return spawnSync("sh", [join(BIN, script), ...args], { encoding: "utf8", env, timeout });
}

function tmux(h: Home, args: string[]) {
  return spawnSync("tmux", ["-L", h.socket, "-f", "/dev/null", ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

function spawnAgent(h: Home, run: string, agent: string, extra: string[] = [], env = h.env) {
  return sh("cb-agent-spawn.sh", [run, agent, ...extra], env);
}

function collectChild(child: ReturnType<typeof spawn>) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveChild) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (status) => resolveChild({ status, stdout, stderr }));
  });
}

function spawnFive(h: Home, run: string) {
  ensureRun(h, run);
  for (const a of AGENTS) {
    const r = spawnAgent(h, run, a);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toMatch(/^@\d+$/);
  }
}

function readMeta(h: Home, run: string, agent: string) {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(h.runs, run, "agents", `${agent}.meta`), "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

function writeFake(dir: string, name: string, body: string) {
  const p = join(dir, name);
  writeFileSync(p, body, { mode: 0o755 });
  return p;
}

const FAKE_SWALLOW = `#!/usr/bin/env python3
import sys,time,tty,termios
fd=sys.stdin.fileno(); old=termios.tcgetattr(fd)
try:
  tty.setraw(fd); buf=[]; n=0
  sys.stdout.write("> "); sys.stdout.flush()
  while True:
    ch=sys.stdin.read(1)
    if ch in ("\\r","\\n"):
      n+=1
      if n==1: continue
      sys.stdout.write("\\r\\nGOT:"+"".join(buf)+"\\r\\n"); sys.stdout.flush()
      while True: time.sleep(3600)
    elif ch=="\\x03": break
    else:
      buf.append(ch); sys.stdout.write(ch); sys.stdout.flush()
finally: termios.tcsetattr(fd, termios.TCSADRAIN, old)
`;

const FAKE_STUCK = `#!/usr/bin/env python3
import sys,tty,termios
fd=sys.stdin.fileno(); old=termios.tcgetattr(fd)
try:
  tty.setraw(fd); buf=[]
  sys.stdout.write("> "); sys.stdout.flush()
  while True:
    ch=sys.stdin.read(1)
    if ch in ("\\r","\\n"): continue
    elif ch=="\\x03": break
    else:
      buf.append(ch); sys.stdout.write(ch); sys.stdout.flush()
finally: termios.tcsetattr(fd, termios.TCSADRAIN, old)
`;

afterEach(() => {
  for (const s of sockets.splice(0)) {
    spawnSync("tmux", ["-L", s, "-f", "/dev/null", "kill-server"], { encoding: "utf8", timeout: 5_000 });
  }
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const d = tmuxOk() ? describe : describe.skip;

d("cb-tmux + spawn", () => {
  it("creates five pinned windows with atomic meta", () => {
    const h = makeHome();
    const run = "issue-312-a1f2";
    spawnFive(h, run);
    expect(tmux(h, ["has-session", "-t", `=combo-${run}`]).status).toBe(0);
    const names = tmux(h, ["list-windows", "-t", `=combo-${run}`, "-F", "#{window_name}"])
      .stdout.trim()
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(names).toEqual(AGENTS.map((a) => `cb-${run}-${a}`).sort());
    expect(names.some((n) => n.includes("_cb_"))).toBe(false);
    for (const a of AGENTS) {
      const m = readMeta(h, run, a);
      expect(m).toMatchObject({
        run,
        agent: a,
        window: `combo-${run}:cb-${run}-${a}`,
      });
      expect(m.window_id).toMatch(/^@\d+$/);
      const id = m.window_id as string;
      expect(tmux(h, ["show-window-options", "-t", id, "automatic-rename"]).stdout).toMatch(/off/);
      expect(tmux(h, ["show-window-options", "-t", id, "allow-rename"]).stdout).toMatch(/off/);
    }
  }, 20_000);

  it("refuses sequential duplicate agent windows", () => {
    const h = makeHome();
    ensureRun(h, "dup");
    expect(spawnAgent(h, "dup", "launcher").status).toBe(0);
    const r = spawnAgent(h, "dup", "launcher");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/already exists|endpoint already exists/);
  });

  it("isolates alpha from alphabet on create/resolve/status/send/teardown", () => {
    const h = makeHome();
    const long = "alphabet";
    const short = "alpha";
    ensureRun(h, long);
    ensureRun(h, short);
    expect(spawnAgent(h, long, "launcher").status).toBe(0);
    expect(spawnAgent(h, short, "launcher").status).toBe(0);
    const sessions = tmux(h, ["list-sessions", "-F", "#{session_name}"]).stdout.trim().split("\n").sort();
    expect(sessions).toEqual([`combo-${long}`, `combo-${short}`].sort());
    expect(tmux(h, ["list-windows", "-t", `=combo-${long}`, "-F", "#{window_name}"]).stdout).toContain(
      `cb-${long}-launcher`,
    );
    expect(tmux(h, ["list-windows", "-t", `=combo-${short}`, "-F", "#{window_name}"]).stdout).toContain(
      `cb-${short}-launcher`,
    );
    const st = sh("cb-status.sh", [short, "launcher"], h.env);
    expect(st.stdout).toContain("session_live=1");
    expect(st.stdout).toContain(`cb-${short}-launcher`);
    expect(st.stdout).not.toContain(`cb-${long}-launcher`);
    const marker = `ALPHA-${Date.now()}`;
    expect(sh("cb-send.sh", [short, "launcher", `echo ${marker}`], h.env).status).toBe(0);
    sleep(250);
    expect(sh("cb-peek.sh", [short, "launcher", "40"], h.env).stdout).toContain(marker);
    expect(sh("cb-peek.sh", [long, "launcher", "40"], h.env).stdout).not.toContain(marker);
    const kill = spawnSync(
      "sh",
      ["-c", `. "${join(BIN, "cb-tmux.sh")}"; cb_tmux_kill_session "combo-${short}"`],
      { encoding: "utf8", env: h.env, timeout: 10_000 },
    );
    expect(kill.status).toBe(0);
    expect(tmux(h, ["has-session", "-t", `=combo-${short}`]).status).not.toBe(0);
    expect(tmux(h, ["has-session", "-t", `=combo-${long}`]).status).toBe(0);
  }, 30_000);

  it("serializes concurrent same-run same-agent spawn to one winner", async () => {
    const h = makeHome();
    ensureRun(h, "race");
    expect(spawnAgent(h, "race", "launcher").status).toBe(0);
    const env = { ...h.env, CB_SPAWN_LOCK_TIMEOUT_SECONDS: "60", CB_SPAWN_LOCK_STALE_SECONDS: "120" };
    const kids = Array.from({ length: 20 }, () =>
      spawn("sh", [join(BIN, "cb-agent-spawn.sh"), "race", "coder"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    const results = await Promise.all(
      kids.map(
        (c) =>
          new Promise<{ status: number | null; stdout: string }>((res) => {
            let stdout = "";
            c.stdout?.on("data", (b) => {
              stdout += String(b);
            });
            c.on("close", (status) => res({ status, stdout }));
          }),
      ),
    );
    const winners = results.filter((r) => r.status === 0);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r.status !== 0)).toHaveLength(19);
    const coders = tmux(h, ["list-windows", "-t", "=combo-race", "-F", "#{window_name}"])
      .stdout.trim()
      .split("\n")
      .filter((n) => n === "cb-race-coder");
    expect(coders).toHaveLength(1);
    expect(readMeta(h, "race", "coder").window_id).toBe(winners[0]?.stdout.trim());
  }, 40_000);

  it.each([
    ["ownerless", null],
    ["malformed", "not-a-valid-owner\n"],
  ])("reclaims a stale %s spawn lock without redirect noise", (_kind, ownerRecord) => {
    const h = makeHome();
    const runDir = ensureRun(h, `stale-${_kind}`);
    const lock = join(runDir, ".spawn.lock");
    mkdirSync(lock);
    if (ownerRecord !== null) writeFileSync(join(lock, "owner"), ownerRecord);
    const result = spawnAgent(h, `stale-${_kind}`, "coder", [], {
      ...h.env,
      CB_SPAWN_LOCK_STALE_SECONDS: "0",
      CB_SPAWN_LOCK_TIMEOUT_SECONDS: "2",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toMatch(/No such file or directory/);
    expect(existsSync(lock)).toBe(false);
  });

  it("preserves well-formed dead-owner spawn lock recovery", () => {
    const h = makeHome();
    const runDir = ensureRun(h, "stale-dead-owner");
    const lock = join(runDir, ".spawn.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "99999999 abandoned-owner-token\n");
    const result = spawnAgent(h, "stale-dead-owner", "coder", [], {
      ...h.env,
      CB_SPAWN_LOCK_STALE_SECONDS: "0",
      CB_SPAWN_LOCK_TIMEOUT_SECONDS: "2",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  it("does not steal an ownerless stale spawn lock that gains a live owner during reap", () => {
    const h = makeHome();
    const runDir = ensureRun(h, "stale-live-race");
    const lock = join(runDir, ".spawn.lock");
    const owner = join(lock, "owner");
    const fakeBin = join(h.home, "fake-bin");
    mkdirSync(lock);
    mkdirSync(fakeBin);
    writeFake(
      fakeBin,
      "mkdir",
      `#!/bin/sh
if [ "$1" = "$CB_TEST_REAP" ]; then
  /bin/mkdir "$@"
  printf '%s\n' "$CB_TEST_LIVE_OWNER" >"$CB_TEST_OWNER"
  exit 0
fi
exec /bin/mkdir "$@"
`,
    );
    const result = spawnAgent(h, "stale-live-race", "coder", [], {
      ...h.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      CB_TEST_REAP: join(lock, ".reap"),
      CB_TEST_OWNER: owner,
      CB_TEST_LIVE_OWNER: `${process.pid} replacement-token`,
      CB_SPAWN_LOCK_STALE_SECONDS: "0",
      CB_SPAWN_LOCK_TIMEOUT_SECONDS: "1",
    });
    expect(result.status).toBe(75);
    expect(readFileSync(owner, "utf8")).toBe(`${process.pid} replacement-token\n`);
    expect(existsSync(lock)).toBe(true);
  });

  it.each(["existing", "dangling"])(
    "does not follow a %s symlink at the predictable meta staging path",
    async (targetKind) => {
      const h = makeHome();
      const run = `meta-link-${targetKind}`;
      const runDir = ensureRun(h, run);
      const lock = join(runDir, ".spawn.lock");
      const owner = join(lock, "owner");
      mkdirSync(lock);
      writeFileSync(owner, `${process.pid} test-barrier\n`);
      const child = spawn("sh", [join(BIN, "cb-agent-spawn.sh"), run, "coder"], {
        env: {
          ...h.env,
          CB_SPAWN_LOCK_STALE_SECONDS: "120",
          CB_SPAWN_LOCK_TIMEOUT_SECONDS: "5",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(child.pid).toBeTypeOf("number");
      const victim = join(h.home, `${targetKind}-meta-victim`);
      if (targetKind === "existing") writeFileSync(victim, "PRECIOUS\n");
      const tmp = join(runDir, "agents", `.coder.meta.tmp.${child.pid}`);
      symlinkSync(victim, tmp);
      rmSync(owner);
      rmdirSync(lock);

      const result = await collectChild(child);
      expect(result.status).not.toBe(0);
      if (targetKind === "existing") expect(readFileSync(victim, "utf8")).toBe("PRECIOUS\n");
      else expect(existsSync(victim)).toBe(false);
    },
    15_000,
  );

  it("rejects agents symlink escape so peer run meta stays intact", () => {
    const h = makeHome();
    const aDir = ensureRun(h, "arun");
    ensureRun(h, "brun");
    rmSync(join(aDir, "agents"), { recursive: true, force: true });
    symlinkSync(join(h.runs, "brun", "agents"), join(aDir, "agents"));
    expect(spawnAgent(h, "brun", "coder").status).toBe(0);
    const before = readFileSync(join(h.runs, "brun", "agents", "coder.meta"), "utf8");
    const escaped = spawnAgent(h, "arun", "coder");
    expect(escaped.status).not.toBe(0);
    expect(escaped.stderr).toMatch(/symlink|escapes/);
    expect(readFileSync(join(h.runs, "brun", "agents", "coder.meta"), "utf8")).toBe(before);
    expect(spawnSync("readlink", [join(aDir, "agents")], { encoding: "utf8" }).status).toBe(0);
  });

  it("rejects symlinked run dir before sourcing side-effecting config.env", () => {
    const h = makeHome();
    const marker = join(h.home, "config-side-effect");
    const outside = join(h.home, "outside-run");
    mkdirSync(join(outside, "agents"), { recursive: true });
    writeFileSync(join(outside, "config.env"), `touch '${marker}'\nexport CB_WORKTREE='${outside}'\n`);
    // runs/<run> is a symlink escape; containment must refuse before source.
    symlinkSync(outside, join(h.runs, "evilrun"));
    const bad = spawnAgent(h, "evilrun", "launcher");
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/symlink|escapes/);
    expect(existsSync(marker)).toBe(false);
  });

  it("does not publish meta for invalid shell or missing cwd", () => {
    const h = makeHome();
    const runDir = ensureRun(h, "deadend");
    expect(spawnAgent(h, "deadend", "launcher", ["--cwd", join(runDir, "nope")]).status).not.toBe(0);
    expect(existsSync(join(runDir, "agents", "launcher.meta"))).toBe(false);
    const bad = spawnAgent(h, "deadend", "launcher", [], {
      ...h.env,
      SHELL: join(h.home, "no-such-shell"),
    });
    expect(bad.status).not.toBe(0);
    expect(existsSync(join(runDir, "agents", "launcher.meta"))).toBe(false);
  });

  it("send/peek/status + verified Enter swallow/stuck composers", () => {
    const h = makeHome();
    const run = "send1";
    ensureRun(h, run);
    const marker = `M-${Date.now()}`;
    expect(spawnAgent(h, run, "coder").status).toBe(0);
    sleep(250);
    expect(sh("cb-send.sh", [run, "coder", `echo ${marker}`], h.env).status).toBe(0);
    sleep(200);
    expect(sh("cb-peek.sh", [run, "coder", "40"], h.env).stdout).toContain(marker);
    expect(sh("cb-status.sh", [run, "coder"], h.env).stdout).toContain("session_live=1");

    const sw = "sw1";
    ensureRun(h, sw);
    const fd = mkdtempSync(join(tmpdir(), "fc-"));
    homes.push(fd);
    writeFake(fd, "fc.py", FAKE_SWALLOW);
    expect(
      spawnAgent(h, sw, "reviewer", ["--mode", "shell", "--cwd", fd, "--cmd", "exec python3 ./fc.py"]).status,
    ).toBe(0);
    sleep(350);
    expect(sh("cb-status.sh", [sw, "reviewer"], h.env).stdout).toMatch(/command=Python/i);
    const payload = `S-${Date.now()}`;
    expect(sh("cb-send.sh", [sw, "reviewer", payload], h.env).status).toBe(0);
    sleep(250);
    expect(sh("cb-peek.sh", [sw, "reviewer", "40"], h.env).stdout).toContain(`GOT:${payload}`);

    const st = "st1";
    ensureRun(h, st);
    const nd = mkdtempSync(join(tmpdir(), "ns-"));
    homes.push(nd);
    writeFake(nd, "ns.py", FAKE_STUCK);
    expect(
      spawnAgent(h, st, "gate", ["--mode", "shell", "--cwd", nd, "--cmd", "exec python3 ./ns.py"]).status,
    ).toBe(0);
    sleep(350);
    const fail = sh("cb-send.sh", [st, "gate", "NEVERLAND"], {
      ...h.env,
      CB_SEND_RETRIES: "2",
      CB_SEND_SLEEP: "0.25",
    });
    expect(fail.status).not.toBe(0);
    expect(fail.stderr).toMatch(/swallowed|still holds payload/);
  }, 45_000);

  it("kills windows/sessions idempotently with exact targets", () => {
    const h = makeHome();
    spawnFive(h, "kill1");
    const id = readMeta(h, "kill1", "gate").window_id as string;
    const r = spawnSync(
      "sh",
      [
        "-c",
        `. "${join(BIN, "cb-tmux.sh")}"; cb_tmux_kill "${id}"; cb_tmux_kill "${id}"; cb_tmux_kill_session "combo-kill1"; cb_tmux_kill_session "combo-kill1"`,
      ],
      { encoding: "utf8", env: h.env, timeout: 10_000 },
    );
    expect(r.status).toBe(0);
    expect(tmux(h, ["has-session", "-t", "=combo-kill1"]).status).not.toBe(0);
  }, 15_000);

  it("keeps two concurrent runs isolated under send/status/teardown", () => {
    const h = makeHome();
    spawnFive(h, "aa01");
    spawnFive(h, "bb02");
    const marker = `B-${Date.now()}`;
    expect(sh("cb-send.sh", ["bb02", "reviewer", `echo ${marker}`], h.env).status).toBe(0);
    sleep(250);
    expect(sh("cb-peek.sh", ["bb02", "reviewer", "40"], h.env).stdout).toContain(marker);
    expect(sh("cb-peek.sh", ["aa01", "reviewer", "40"], h.env).stdout).not.toContain(marker);
    spawnSync("sh", ["-c", `. "${join(BIN, "cb-tmux.sh")}"; cb_tmux_kill_session "combo-aa01"`], {
      encoding: "utf8",
      env: h.env,
      timeout: 10_000,
    });
    expect(tmux(h, ["has-session", "-t", "=combo-aa01"]).status).not.toBe(0);
    expect(tmux(h, ["has-session", "-t", "=combo-bb02"]).status).toBe(0);
    expect(sh("cb-status.sh", ["bb02"], h.env).stdout).toContain("session_live=1");
    expect(sh("cb-peek.sh", ["aa01", "coder", "5"], h.env).status).not.toBe(0);
  }, 30_000);

  it("never resolves targets outside combo-<runId>", () => {
    const h = makeHome();
    ensureRun(h, "scope");
    expect(spawnAgent(h, "scope", "launcher").status).toBe(0);
    expect(tmux(h, ["new-session", "-d", "-s", "foreign-other", "-n", "cb-scope-launcher"]).status).toBe(0);
    expect(tmux(h, ["kill-window", "-t", "=combo-scope:cb-scope-launcher"]).status).toBe(0);
    const metaPath = join(h.runs, "scope", "agents", "launcher.meta");
    writeFileSync(
      metaPath,
      readFileSync(metaPath, "utf8")
        .split("\n")
        .map((l) => {
          if (l.startsWith("window_id=")) return "window_id=@99999";
          if (l.startsWith("window=")) return "window=foreign-other:cb-scope-launcher";
          return l;
        })
        .join("\n"),
    );
    expect(sh("cb-peek.sh", ["scope", "launcher", "5"], h.env).status).not.toBe(0);
    expect(sh("cb-send.sh", ["scope", "launcher", "echo x"], h.env).status).not.toBe(0);
  }, 15_000);

  it("returns nonzero when the pane dies after Enter", () => {
    const h = makeHome();
    const run = "deadpane";
    ensureRun(h, run);
    // mode=tui endpoint whose process exits as soon as it consumes a line/Enter.
    expect(spawnAgent(h, run, "coder", ["--mode", "tui", "--cmd", "read line"]).status).toBe(0);
    sleep(250);
    const sent = sh("cb-send.sh", [run, "coder", "BYE"], h.env);
    expect(sent.status).not.toBe(0);
    expect(sent.stderr).toMatch(/dead or missing|failed to send Enter/);
  }, 20_000);

  it("returns nonzero when the pane exits shortly after composer clear", () => {
    const h = makeHome();
    const run = "delayexit";
    ensureRun(h, run);
    // Accepts the line (composer clear), then exits after a brief delay so the
    // pane is already dead before cb-send returns — final pre-success live check.
    expect(
      spawnAgent(h, run, "reviewer", ["--mode", "tui", "--cmd", "sh -c 'read line; sleep 0.05; exit 0'"])
        .status,
    ).toBe(0);
    sleep(250);
    const sent = sh("cb-send.sh", [run, "reviewer", "LATER"], {
      ...h.env,
      CB_SEND_SLEEP: "0.25",
      CB_SEND_SETTLE: "0.05",
      CB_SEND_RETRIES: "2",
    });
    expect(sent.status).not.toBe(0);
    expect(sent.stderr).toMatch(/dead or missing/);
  }, 20_000);

  it("ignores stale window ids reused by another role after server restart", () => {
    const h = makeHome();
    const run = "reuse";
    ensureRun(h, run);
    const first = spawnAgent(h, run, "coder");
    expect(first.status, first.stderr).toBe(0);
    const staleId = first.stdout.trim();
    expect(staleId).toMatch(/^@\d+$/);
    expect(readMeta(h, run, "coder").window_id).toBe(staleId);

    // Kill the isolated server; on-disk meta remains. Next spawn may reuse @N.
    expect(tmux(h, ["kill-server"]).status).toBe(0);
    sleep(100);

    const launcher = spawnAgent(h, run, "launcher");
    expect(launcher.status, launcher.stderr).toBe(0);
    const launcherId = launcher.stdout.trim();
    // Numeric id reuse is the interesting case; always assert no misroute.
    expect(readMeta(h, run, "launcher").window_id).toBe(launcherId);

    // Stale coder meta must not resolve to launcher (even if ids match).
    const coderStatus = sh("cb-status.sh", [run, "coder"], h.env).stdout;
    expect(coderStatus).toContain("agent.coder.resolved=");
    expect(coderStatus).not.toContain(`agent.coder.resolved=${launcherId}`);
    // Empty resolved field: line ends at '=' with no target.
    expect(coderStatus.split("\n").some((l) => l === "agent.coder.resolved=")).toBe(true);
    const mis = sh("cb-send.sh", [run, "coder", "echo SHOULD-NOT-LAND"], h.env);
    expect(mis.status).not.toBe(0);
    sleep(200);
    expect(sh("cb-peek.sh", [run, "launcher", "40"], h.env).stdout).not.toContain("SHOULD-NOT-LAND");

    // Missing original role can respawn; custody replaces stale meta only after live endpoint.
    const again = spawnAgent(h, run, "coder");
    expect(again.status, again.stderr).toBe(0);
    const coderId = again.stdout.trim();
    expect(coderId).toMatch(/^@\d+$/);
    expect(readMeta(h, run, "coder").window_id).toBe(coderId);
    expect(readMeta(h, run, "coder").window).toBe(`combo-${run}:cb-${run}-coder`);
    expect(sh("cb-status.sh", [run, "coder"], h.env).stdout).toContain(`agent.coder.resolved=${coderId}`);
    expect(sh("cb-status.sh", [run, "launcher"], h.env).stdout).toContain(
      `agent.launcher.resolved=${launcherId}`,
    );
  }, 30_000);

  it("guards decision paths and rejects mode=bin without --cmd", () => {
    const h = makeHome();
    ensureRun(h, "meta1");
    expect(spawnAgent(h, "meta1", "gate").status).toBe(0);
    expect(existsSync(join(h.runs, "meta1", "agents", "gate.meta"))).toBe(true);
    for (const name of ["cb-emit.sh", "cb-wait.sh", "cb-run-state.sh", "cb-agent-spawn.sh", "cb-send.sh"]) {
      expect(readFileSync(join(BIN, name), "utf8")).not.toMatch(/capture-pane/);
    }
    expect(readFileSync(join(BIN, "cb-peek.sh"), "utf8")).toMatch(/cb_tmux_capture/);
    const bin = spawnAgent(h, "meta1", "coder", ["--mode", "bin", "--bin", "claude"]);
    expect(bin.status).not.toBe(0);
    expect(bin.stderr).toMatch(/mode=bin requires --cmd/);
  });
});
