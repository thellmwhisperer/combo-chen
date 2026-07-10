/**
 * @overview Director application handler integration tests: remaining command contracts.
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
  ISSUE,
  buildDirectorWatchCommand,
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
  readFileSync,
  runDirFor,
  shellQuote,
  spawnSync,
  tmpdir,
  writeCombo,
  writeConfigSnapshot,
  writeExecutable,
  writeFileSync,
  writeRuntimeLedger,
} from "../../testing/cli-harness.js";

// -- 1/1 CORE · command contracts <- START HERE --
describe("director-watch command", () => {
  it("uses the launch config snapshot while emitting one compact dashboard line per tick", async () => {
    const h = home();
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    writeFileSync(join(repoDir, "combo-chen.toml"), "[limits]\nbabysit_poll_seconds = 42\n");
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
    writeConfigSnapshot(dir, loadConfig({ repoDir, env: {} }));
    writeFileSync(join(repoDir, "combo-chen.toml"), "[limits]\nbabysit_poll_seconds = 3\n");
    const { deps, calls, out } = fakeDeps({ env: { COMBO_CHEN_HOME: h } });

    await exec(deps, ["director-watch", "-n", "o-r-7", "--iterations", "2"]);

    expect(calls).toContainEqual(["sleep", "42000"]);
    expect(calls).not.toContainEqual(["sleep", "3000"]);
    const statusLines = out.filter((line) => line.startsWith("director: watch "));
    expect(statusLines).toHaveLength(2);
    expect(statusLines.every((line) => line.includes("combo=o-r-7"))).toBe(true);
    expect(statusLines.every((line) => line.includes("gh=not-polled next=42s"))).toBe(true);
    expect(statusLines.every((line) => line.includes("ready=["))).toBe(true);
    expect(statusLines.every((line) => line.includes('action="'))).toBe(true);
    expect(statusLines.every((line) => line.trimStart().startsWith("{"))).toBe(false);
    expect(out).toEqual(statusLines);
    expect(out.some((line) => line === "director: tick complete for o-r-7")).toBe(false);
  });

  it("survives one failed director tick, journals watch_error, and runs the next tick", () => {
    const h = home();
    const tickCount = join(h, "tick-count");
    const watchEvents = join(h, "watch-events.log");
    const fakeCli = join(h, "fake-combo-chen");
    writeExecutable(
      fakeCli,
      [
        "#!/bin/sh",
        `tick_count=${shellQuote(tickCount)}`,
        `watch_events=${shellQuote(watchEvents)}`,
        'command="$1"',
        "shift",
        'if [ "$command" = "director-tick" ]; then',
        "  count=0",
        '  [ -f "$tick_count" ] && count=$(cat "$tick_count")',
        "  count=$((count + 1))",
        '  printf "%s\\n" "$count" > "$tick_count"',
        '  if [ "$count" -eq 1 ]; then',
        '    echo "secondary rate limit" >&2',
        "    exit 2",
        "  fi",
        '  echo "reviewer: already terminal"',
        "  exit 0",
        "fi",
        'if [ "$command" = "emit" ]; then',
        '  printf "%s\\n" "$*" >> "$watch_events"',
        "  exit 0",
        "fi",
        'echo "unexpected command: $command" >&2',
        "exit 99",
        "",
      ].join("\n"),
    );

    const command = buildDirectorWatchCommand({
      cli: shellQuote(fakeCli),
      comboHome: h,
      comboId: "o-r-7",
      pollSeconds: 0,
      watchFailureLimit: 3,
      watchBackoffMaxSeconds: 3600,
    });

    const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });

    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    expect(readFileSync(tickCount, "utf8").trim()).toBe("2");
    const events = readFileSync(watchEvents, "utf8");
    expect(events.match(/\bwatch_error\b/g)).toHaveLength(1);
    expect(events).toContain("exit_code=2");
    expect(events).toContain("stderr=secondary rate limit");
    expect(events).not.toContain("watch_dead");
  });

  it("backs off when director-tick reports an exit-zero transient failure marker", () => {
    const h = home();
    const tickCount = join(h, "tick-count");
    const watchEvents = join(h, "watch-events.log");
    const fakeCli = join(h, "fake-combo-chen");
    writeExecutable(
      fakeCli,
      [
        "#!/bin/sh",
        `tick_count=${shellQuote(tickCount)}`,
        `watch_events=${shellQuote(watchEvents)}`,
        'command="$1"',
        "shift",
        'if [ "$command" = "director-tick" ]; then',
        "  count=0",
        '  [ -f "$tick_count" ] && count=$(cat "$tick_count")',
        "  count=$((count + 1))",
        '  printf "%s\\n" "$count" > "$tick_count"',
        '  if [ "$count" -eq 1 ]; then',
        '    echo "reviewer: transient_failure: gh pr view failed for o-r-7 (status 1): API rate limit exceeded"',
        "    exit 0",
        "  fi",
        '  echo "reviewer: already terminal"',
        "  exit 0",
        "fi",
        'if [ "$command" = "emit" ]; then',
        '  printf "%s\\n" "$*" >> "$watch_events"',
        "  exit 0",
        "fi",
        'echo "unexpected command: $command" >&2',
        "exit 99",
        "",
      ].join("\n"),
    );

    const command = buildDirectorWatchCommand({
      cli: shellQuote(fakeCli),
      comboHome: h,
      comboId: "o-r-7",
      pollSeconds: 0,
      watchFailureLimit: 3,
      watchBackoffMaxSeconds: 3600,
    });

    const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });

    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    expect(readFileSync(tickCount, "utf8").trim()).toBe("2");
    const events = readFileSync(watchEvents, "utf8");
    expect(events.match(/\bwatch_error\b/g)).toHaveLength(1);
    expect(events).toContain("exit_code=75");
    expect(events).toContain("gh pr view failed");
    expect(events).not.toContain("watch_dead");
  });

  it("journals watch_dead and exits non-zero after the configured consecutive failure limit", () => {
    const h = home();
    const tickCount = join(h, "tick-count");
    const watchEvents = join(h, "watch-events.log");
    const fakeCli = join(h, "fake-combo-chen");
    writeExecutable(
      fakeCli,
      [
        "#!/bin/sh",
        `tick_count=${shellQuote(tickCount)}`,
        `watch_events=${shellQuote(watchEvents)}`,
        'command="$1"',
        "shift",
        'if [ "$command" = "director-tick" ]; then',
        "  count=0",
        '  [ -f "$tick_count" ] && count=$(cat "$tick_count")',
        "  count=$((count + 1))",
        '  printf "%s\\n" "$count" > "$tick_count"',
        '  echo "gh secondary rate limit" >&2',
        "  exit 7",
        "fi",
        'if [ "$command" = "emit" ]; then',
        '  printf "%s\\n" "$*" >> "$watch_events"',
        "  exit 0",
        "fi",
        'echo "unexpected command: $command" >&2',
        "exit 99",
        "",
      ].join("\n"),
    );

    const command = buildDirectorWatchCommand({
      cli: shellQuote(fakeCli),
      comboHome: h,
      comboId: "o-r-7",
      pollSeconds: 0,
      watchFailureLimit: 3,
      watchBackoffMaxSeconds: 3600,
    });

    const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });

    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 7 });
    expect(readFileSync(tickCount, "utf8").trim()).toBe("3");
    const events = readFileSync(watchEvents, "utf8");
    expect(events.match(/\bwatch_error\b/g)).toHaveLength(3);
    expect(events.match(/\bwatch_dead\b/g)).toHaveLength(1);
    expect(events).toContain("consecutive_failures=3");
    expect(events).toContain("exit_code=7");
    expect(events).toContain("stderr=gh secondary rate limit");
  });

  it("doubles backoff on each consecutive failure", () => {
    const h = home();
    const tickCount = join(h, "tick-count");
    const sleepLog = join(h, "sleep-log");
    const fakeCli = join(h, "fake-combo-chen");
    const fakeSleep = join(h, "sleep");
    writeExecutable(
      fakeSleep,
      ["#!/bin/sh", `printf '%s\\n' "$1" >> ${shellQuote(sleepLog)}`, ""].join("\n"),
    );
    writeExecutable(
      fakeCli,
      [
        "#!/bin/sh",
        `tick_count=${shellQuote(tickCount)}`,
        'command="$1"',
        "shift",
        'if [ "$command" = "director-tick" ]; then',
        "  count=0",
        '  [ -f "$tick_count" ] && count=$(cat "$tick_count")',
        "  count=$((count + 1))",
        '  printf "%s\\n" "$count" > "$tick_count"',
        '  echo "gh secondary rate limit" >&2',
        "  exit 7",
        "fi",
        'echo "unexpected command: $command" >&2',
        "exit 99",
        "",
      ].join("\n"),
    );

    const command = buildDirectorWatchCommand({
      cli: shellQuote(fakeCli),
      comboHome: h,
      comboId: "o-r-7",
      pollSeconds: 5,
      watchFailureLimit: 6,
      watchBackoffMaxSeconds: 3600,
    });

    const result = spawnSync("/bin/sh", ["-c", command], {
      encoding: "utf8",
      env: { PATH: `${h}:/usr/bin:/bin`, HOME: process.env["HOME"] },
    });

    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 7 });
    const sleeps = readFileSync(sleepLog, "utf8").trim().split("\n").map(Number);
    expect(sleeps).toEqual([5, 10, 20, 40, 80]);
  });

  it("caps backoff at 3600 when the doubling exceeds 1800", () => {
    const h = home();
    const tickCount = join(h, "tick-count");
    const sleepLog = join(h, "sleep-log");
    const fakeCli = join(h, "fake-combo-chen");
    const fakeSleep = join(h, "sleep");
    writeExecutable(
      fakeSleep,
      ["#!/bin/sh", `printf '%s\\n' "$1" >> ${shellQuote(sleepLog)}`, ""].join("\n"),
    );
    writeExecutable(
      fakeCli,
      [
        "#!/bin/sh",
        `tick_count=${shellQuote(tickCount)}`,
        'command="$1"',
        "shift",
        'if [ "$command" = "director-tick" ]; then',
        "  count=0",
        '  [ -f "$tick_count" ] && count=$(cat "$tick_count")',
        "  count=$((count + 1))",
        '  printf "%s\\n" "$count" > "$tick_count"',
        '  echo "gh secondary rate limit" >&2',
        "  exit 7",
        "fi",
        'echo "unexpected command: $command" >&2',
        "exit 99",
        "",
      ].join("\n"),
    );

    const command = buildDirectorWatchCommand({
      cli: shellQuote(fakeCli),
      comboHome: h,
      comboId: "o-r-7",
      pollSeconds: 5,
      watchFailureLimit: 12,
      watchBackoffMaxSeconds: 3600,
    });

    const result = spawnSync("/bin/sh", ["-c", command], {
      encoding: "utf8",
      env: { PATH: `${h}:/usr/bin:/bin`, HOME: process.env["HOME"] },
    });

    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 7 });
    const sleeps = readFileSync(sleepLog, "utf8").trim().split("\n").map(Number);
    expect(sleeps).toEqual([5, 10, 20, 40, 80, 160, 320, 640, 1280, 2560, 3600]);
  });

  it("uses the configured max backoff for the first failed sleep and later doublings", () => {
    const h = home();
    const tickCount = join(h, "tick-count");
    const sleepLog = join(h, "sleep-log");
    const fakeCli = join(h, "fake-combo-chen");
    const fakeSleep = join(h, "sleep");
    writeExecutable(
      fakeSleep,
      ["#!/bin/sh", `printf '%s\\n' "$1" >> ${shellQuote(sleepLog)}`, ""].join("\n"),
    );
    writeExecutable(
      fakeCli,
      [
        "#!/bin/sh",
        `tick_count=${shellQuote(tickCount)}`,
        'command="$1"',
        "shift",
        'if [ "$command" = "director-tick" ]; then',
        "  count=0",
        '  [ -f "$tick_count" ] && count=$(cat "$tick_count")',
        "  count=$((count + 1))",
        '  printf "%s\\n" "$count" > "$tick_count"',
        '  echo "reviewer: transient_failure: gh pr view failed for o-r-7 (status 1): rate limit"',
        "  exit 0",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );

    const command = buildDirectorWatchCommand({
      cli: shellQuote(fakeCli),
      comboHome: h,
      comboId: "o-r-7",
      pollSeconds: 99,
      watchFailureLimit: 4,
      watchBackoffMaxSeconds: 7,
    });

    const result = spawnSync("/bin/sh", ["-c", command], {
      encoding: "utf8",
      env: { PATH: `${h}:/usr/bin:/bin`, HOME: process.env["HOME"] },
    });

    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 75 });
    const sleeps = readFileSync(sleepLog, "utf8").trim().split("\n").map(Number);
    expect(sleeps).toEqual([7, 7, 7]);
  });
});

describe("director-prompt", () => {
  it("sends a director prompt command through tmux and journals it", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    const record = {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    };
    writeCombo(dir, record);
    writeRuntimeLedger(
      dir,
      buildRuntimeLedger({
        combo: record,
        runDir: dir,
        cli: "combo-chen",
        roleWindows: { director: "director" },
      }),
    );
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "list-windows") {
          return { status: 0, stdout: "coder\ndirector\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, [
      "director-prompt",
      "-n",
      "o-r-7",
      "--reason",
      "ambiguous_signal",
      "Inspect",
      "the",
      "gate",
      "signal",
    ]);

    expect(calls).toContainEqual([
      "tmux",
      "paste-buffer",
      "-d",
      "-b",
      "combo-chen-nudge-combo-chen-o-r-7-director",
      "-t",
      "combo-chen-o-r-7:director",
    ]);
    expect(readEvents(dir).at(-1)).toMatchObject({
      event: "director_prompted",
      reason: "ambiguous_signal",
      target: "combo-chen-o-r-7:director",
      prompt_preview: expect.stringContaining("Inspect the gate signal"),
    });
    expect(out).toEqual(["director-prompt: prompted combo-chen-o-r-7:director for o-r-7 (ambiguous_signal)"]);
  });
});
// -/ 1/1
