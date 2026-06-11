import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_HODOR_COMMAND } from "../infra/config.js";
import type { ComboEvent } from "./events.js";
import { buildRunnerScript, deriveStatus, shellQuote } from "./combo.js";

function ev(event: ComboEvent["event"], extra: Record<string, unknown> = {}): ComboEvent {
  return { t: new Date().toISOString(), event, ...extra };
}

describe("deriveStatus", () => {
  it("starts in SETUP", () => {
    expect(deriveStatus([]).phase).toBe("SETUP");
    expect(deriveStatus([ev("combo_created", { issue_url: "x" })]).phase).toBe("SETUP");
  });

  it("advances through the documented phases", () => {
    const events = [ev("combo_created", { issue_url: "x" }), ev("rower_started")];
    expect(deriveStatus(events).phase).toBe("ROWING");

    events.push(ev("rower_done"), ev("hodor_started"));
    expect(deriveStatus(events).phase).toBe("GATING");

    events.push(ev("pr_opened", { url: "https://github.com/o/r/pull/9" }));
    const status = deriveStatus(events);
    expect(status.phase).toBe("JUDGING");
    expect(status.pr).toBe("https://github.com/o/r/pull/9");
  });

  it("latches needs_human until the next phase advance", () => {
    const events = [ev("rower_started"), ev("needs_human", { reason: "gate_decision" })];
    const status = deriveStatus(events);
    expect(status.needsHuman).toBe(true);
    expect(status.reason).toBe("gate_decision");

    events.push(ev("hodor_started"));
    expect(deriveStatus(events).needsHuman).toBe(false);
  });

  it("marks failures as STALLED and needing a human", () => {
    const status = deriveStatus([ev("rower_started"), ev("rower_failed", { exit_code: 1, has_new_commits: false })]);
    expect(status.phase).toBe("STALLED");
    expect(status.needsHuman).toBe(true);
  });

  it("terminal stop wins over everything", () => {
    const status = deriveStatus([
      ev("rower_started"),
      ev("needs_human", { reason: "x" }),
      ev("stopped", { by: "human" }),
    ]);
    expect(status.phase).toBe("STOPPED");
    expect(status.needsHuman).toBe(false);
  });

  it("treats merged and closed PR events as terminal", () => {
    for (const terminal of [
      ev("merged", { sha: "def456", by: "javi" }),
      ev("combo_closed"),
    ]) {
      const status = deriveStatus([
        ev("pr_opened", { url: "https://github.com/o/r/pull/9" }),
        ev("needs_human", { reason: "pr_ready" }),
        terminal,
      ]);
      expect(status.phase).toBe("STOPPED");
      expect(status.needsHuman).toBe(false);
    }
  });
});

describe("buildRunnerScript", () => {
  const combo = {
    id: "o-r-7",
    issueUrl: "https://github.com/o/r/issues/7",
    repoDir: "/repos/r",
    worktree: "/repos/r/.worktrees/issue-7",
    branch: "combo/issue-7",
    tmuxSession: "combo-chen-o-r-7",
    createdAt: "2026-06-10T00:00:00.000Z",
  };

  const script = buildRunnerScript({
    combo,
    rowerCommand: 'npx -y gnhf --agent codex --current-branch "Implement issue 7"',
    hodorCommand: "no-mistakes axi run",
    emit: "node /opt/combo/dist/cli.mjs emit -n o-r-7",
    activateThreadSitter: "node /opt/combo/dist/cli.mjs activate-thread-sitter -n o-r-7",
    activateJudge: "node /opt/combo/dist/cli.mjs activate-judge -n o-r-7",
  });

  it("runs inside the worktree", () => {
    expect(script).toContain("cd '/repos/r/.worktrees/issue-7'");
  });

  it("sequences rower, hodor, pr detection, and the final handoff to humans", () => {
    const rower = script.indexOf("gnhf");
    const hodor = script.indexOf("no-mistakes axi run");
    const pr = script.indexOf("gh pr list");
    const threadSitter = script.indexOf("activate-thread-sitter");
    const handoff = script.indexOf("pr_ready");
    expect(rower).toBeGreaterThan(-1);
    expect(hodor).toBeGreaterThan(rower);
    expect(pr).toBeGreaterThan(hodor);
    expect(threadSitter).toBeGreaterThan(pr);
    expect(handoff).toBeGreaterThan(threadSitter);
  });

  it("emits lifecycle events with captured exit codes on failure", () => {
    expect(script).toContain("emit -n o-r-7 rower_started");
    expect(script).toContain("emit -n o-r-7 rower_done");
    expect(script).toContain("rower_failed");
    expect(script).toContain("hodor_failed");
    expect(script).toContain("exit_code=$code");
  });

  it("runs the rower with stdout and stderr redirected to rower.log beside the runner", () => {
    expect(script).toContain('rower_log="$(dirname "$0")/rower.log"');
    expect(script).toContain(') > "$rower_log" 2>&1; then');

    const rower = script.indexOf("gnhf");
    const redirected = script.indexOf(') > "$rower_log" 2>&1; then');
    const rowerDone = script.indexOf("emit -n o-r-7 rower_done");
    expect(rower).toBeGreaterThan(-1);
    expect(redirected).toBeGreaterThan(rower);
    expect(rowerDone).toBeGreaterThan(redirected);
  });

  it("emits rower_done when a fake rower exits after seeing non-TTY stdout", () => {
    const dir = mkdtempSync(join(tmpdir(), "combo-chen-runner-"));
    const worktree = join(dir, "worktree");
    const bin = join(dir, "bin");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(bin, { recursive: true });

    const eventsPath = join(dir, "events.log");
    const fakeEmit = join(bin, "emit");
    writeFileSync(
      fakeEmit,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$EVENTS_LOG"
`,
    );
    chmodSync(fakeEmit, 0o755);

    const fakeRower = join(bin, "fake-rower");
    writeFileSync(
      fakeRower,
      `#!/bin/sh
if [ -t 1 ]; then
  echo "interactive final screen" >&2
  exit 91
fi
echo "fake rower completed"
echo "fake rower stderr" >&2
exit 0
`,
    );
    chmodSync(fakeRower, 0o755);

    const fakeGh = join(bin, "gh");
    writeFileSync(fakeGh, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeGh, 0o755);

    const runnerPath = join(dir, "runner.sh");
    writeFileSync(
      runnerPath,
      buildRunnerScript({
        combo: { ...combo, worktree },
        rowerCommand: shellQuote(fakeRower),
        hodorCommand: "true",
        emit: shellQuote(fakeEmit),
        activateThreadSitter: ":",
        activateJudge: ":",
      }),
    );
    chmodSync(runnerPath, 0o755);

    const result = spawnSync("sh", [runnerPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        EVENTS_LOG: eventsPath,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      },
    });

    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0,
      stdout: "",
      stderr: "",
    });
    expect(readFileSync(eventsPath, "utf8").trim().split("\n")).toEqual([
      "rower_started",
      "rower_done",
      "hodor_started",
      "hodor_status --field state=fix_inflight --field head_sha=",
      "hodor_status --field state=idle --field head_sha=",
      "needs_human --field reason=pr_missing",
    ]);
    expect(readFileSync(join(dir, "rower.log"), "utf8")).toBe(
      "fake rower completed\nfake rower stderr\n",
    );
  });

  it("emits hodor_failed with the gate push exit code when the default pre-push fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "combo-chen-runner-"));
    const worktree = join(dir, "worktree");
    const bin = join(dir, "bin");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(bin, { recursive: true });

    const eventsPath = join(dir, "events.log");
    const hodorLog = join(dir, "hodor.log");
    const fakeEmit = join(bin, "emit");
    writeFileSync(
      fakeEmit,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$EVENTS_LOG"
`,
    );
    chmodSync(fakeEmit, 0o755);

    const fakeGit = join(bin, "git");
    writeFileSync(
      fakeGit,
      `#!/bin/sh
if [ "$1" = "push" ]; then
  printf 'git %s\\n' "$*" >> "$HODOR_LOG"
  exit 17
fi
if [ "$1" = "remote" ]; then
  printf 'git %s\\n' "$*" >> "$HODOR_LOG"
  exit 0
fi
if [ "$1" = "rev-parse" ]; then
  printf 'fake-head\\n'
  exit 0
fi
exit 1
`,
    );
    chmodSync(fakeGit, 0o755);

    const fakeNoMistakes = join(bin, "no-mistakes");
    writeFileSync(
      fakeNoMistakes,
      `#!/bin/sh
printf 'no-mistakes %s\\n' "$*" >> "$HODOR_LOG"
`,
    );
    chmodSync(fakeNoMistakes, 0o755);

    const runnerPath = join(dir, "runner.sh");
    writeFileSync(
      runnerPath,
      buildRunnerScript({
        combo: { ...combo, worktree },
        rowerCommand: "true",
        hodorCommand: DEFAULT_HODOR_COMMAND,
        emit: shellQuote(fakeEmit),
        activateThreadSitter: ":",
        activateJudge: ":",
      }),
    );
    chmodSync(runnerPath, 0o755);

    const result = spawnSync("sh", [runnerPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        EVENTS_LOG: eventsPath,
        HODOR_LOG: hodorLog,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      },
    });

    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 17,
      stdout: "",
      stderr: "",
    });
    expect(readFileSync(eventsPath, "utf8").trim().split("\n")).toEqual([
      "rower_started",
      "rower_done",
      "hodor_started",
      "hodor_status --field state=fix_inflight --field head_sha=fake-head",
      "hodor_status --field state=failed --field head_sha=fake-head",
      "hodor_failed --field exit_code=17",
    ]);
    expect(readFileSync(hodorLog, "utf8")).toBe(
      "git remote get-url no-mistakes\ngit push no-mistakes HEAD\n",
    );
  });

  it("runs the default axi command without a gate push when the no-mistakes remote is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "combo-chen-runner-"));
    const worktree = join(dir, "worktree");
    const bin = join(dir, "bin");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(bin, { recursive: true });

    const eventsPath = join(dir, "events.log");
    const hodorLog = join(dir, "hodor.log");
    const fakeEmit = join(bin, "emit");
    writeFileSync(
      fakeEmit,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$EVENTS_LOG"
`,
    );
    chmodSync(fakeEmit, 0o755);

    const fakeGit = join(bin, "git");
    writeFileSync(
      fakeGit,
      `#!/bin/sh
if [ "$1" = "remote" ]; then
  printf 'git %s\\n' "$*" >> "$HODOR_LOG"
  exit 2
fi
if [ "$1" = "push" ]; then
  printf 'git %s\\n' "$*" >> "$HODOR_LOG"
  exit 17
fi
if [ "$1" = "rev-parse" ]; then
  printf 'fake-head\\n'
  exit 0
fi
exit 1
`,
    );
    chmodSync(fakeGit, 0o755);

    const fakeNoMistakes = join(bin, "no-mistakes");
    writeFileSync(
      fakeNoMistakes,
      `#!/bin/sh
printf 'no-mistakes %s\\n' "$*" >> "$HODOR_LOG"
`,
    );
    chmodSync(fakeNoMistakes, 0o755);

    const fakeGh = join(bin, "gh");
    writeFileSync(fakeGh, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeGh, 0o755);

    const runnerPath = join(dir, "runner.sh");
    writeFileSync(
      runnerPath,
      buildRunnerScript({
        combo: { ...combo, worktree },
        rowerCommand: "true",
        hodorCommand: DEFAULT_HODOR_COMMAND,
        emit: shellQuote(fakeEmit),
        activateThreadSitter: ":",
        activateJudge: ":",
      }),
    );
    chmodSync(runnerPath, 0o755);

    const result = spawnSync("sh", [runnerPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        EVENTS_LOG: eventsPath,
        HODOR_LOG: hodorLog,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      },
    });

    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0,
      stdout: "",
      stderr: "",
    });
    expect(readFileSync(eventsPath, "utf8").trim().split("\n")).toEqual([
      "rower_started",
      "rower_done",
      "hodor_started",
      "hodor_status --field state=fix_inflight --field head_sha=fake-head",
      "hodor_status --field state=idle --field head_sha=fake-head",
      "needs_human --field reason=pr_missing",
    ]);
    expect(readFileSync(hodorLog, "utf8")).toBe(
      "git remote get-url no-mistakes\nno-mistakes axi run\n",
    );
  });

  it("emits gate_waiting when no-mistakes stops at an axi approval gate", () => {
    const dir = mkdtempSync(join(tmpdir(), "combo-chen-runner-"));
    const worktree = join(dir, "worktree");
    const bin = join(dir, "bin");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(bin, { recursive: true });

    const headSha = "0123456789abcdef0123456789abcdef01234567";
    const gateToon = `run:
  id: "01KTVVPK0VM15NWE7NVF63F9YR"
  branch: combo/issue-24
  status: awaiting_approval
  head: ${headSha}
  pr: "https://github.com/thellmwhisperer/combo-chen/pull/24"
  findings[1]{id,step,severity,title}:
    ci-1,ci,ask-user,"CI monitoring timed out after 4h"
  steps[4]{step,status,findings,duration_ms}:
    review,completed,0,367445
    test,completed,0,240398
    push,completed,0,1976
    ci,awaiting_approval,1,14400400
outcome: awaiting_approval
next_step: "no-mistakes axi respond --run 01KTVVPK0VM15NWE7NVF63F9YR --yes"
`;

    const eventsPath = join(dir, "events.log");
    const fakeEmit = join(bin, "emit");
    writeFileSync(
      fakeEmit,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$EVENTS_LOG"
`,
    );
    chmodSync(fakeEmit, 0o755);

    const fakeGit = join(bin, "git");
    writeFileSync(
      fakeGit,
      `#!/bin/sh
if [ "$1" = "rev-parse" ]; then
  printf '${headSha}\\n'
  exit 0
fi
exit 1
`,
    );
    chmodSync(fakeGit, 0o755);

    const fakeNoMistakes = join(bin, "no-mistakes");
    writeFileSync(
      fakeNoMistakes,
      `#!/bin/sh
cat <<'TOON'
${gateToon}TOON
`,
    );
    chmodSync(fakeNoMistakes, 0o755);

    const fakeGh = join(bin, "gh");
    writeFileSync(
      fakeGh,
      `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$GH_LOG"
printf 'https://github.com/thellmwhisperer/combo-chen/pull/24\\n'
`,
    );
    chmodSync(fakeGh, 0o755);

    const runnerPath = join(dir, "runner.sh");
    writeFileSync(
      runnerPath,
      buildRunnerScript({
        combo: { ...combo, worktree, branch: "combo/issue-24" },
        rowerCommand: "true",
        hodorCommand: `${shellQuote(fakeNoMistakes)} axi run --intent ${shellQuote("Implement issue 24")}`,
        emit: shellQuote(fakeEmit),
        activateThreadSitter: ":",
        activateJudge: ":",
      }),
    );
    chmodSync(runnerPath, 0o755);

    const result = spawnSync("sh", [runnerPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        EVENTS_LOG: eventsPath,
        GH_LOG: join(dir, "gh.log"),
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      },
    });

    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0,
      stdout: "",
      stderr: "",
    });
    expect(readFileSync(eventsPath, "utf8").trim().split("\n")).toEqual([
      "rower_started",
      "rower_done",
      "hodor_started",
      `hodor_status --field state=fix_inflight --field head_sha=${headSha}`,
      `hodor_status --field state=awaiting_approval --field head_sha=${headSha}`,
      "needs_human --field reason=gate_waiting",
    ]);
    expect(readFileSync(join(dir, "hodor.log"), "utf8")).toBe(gateToon);
  });

  it("emits rower_failed with branch-vs-base commit evidence when a rower commits then exits nonzero", () => {
    const dir = mkdtempSync(join(tmpdir(), "combo-chen-runner-"));
    const worktree = join(dir, "worktree");
    const bin = join(dir, "bin");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(bin, { recursive: true });

    for (const args of [
      ["init"],
      ["config", "user.email", "codex@example.com"],
      ["config", "user.name", "Codex"],
    ]) {
      const result = spawnSync("git", args, { cwd: worktree, encoding: "utf8" });
      expect({ args, status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    }
    writeFileSync(join(worktree, "README.md"), "base\n");
    for (const args of [
      ["add", "README.md"],
      ["commit", "-m", "base"],
    ]) {
      const result = spawnSync("git", args, { cwd: worktree, encoding: "utf8" });
      expect({ args, status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    }
    const baseSha = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: worktree,
      encoding: "utf8",
    }).stdout.trim();

    const eventsPath = join(dir, "events.log");
    const fakeEmit = join(bin, "emit");
    writeFileSync(
      fakeEmit,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$EVENTS_LOG"
`,
    );
    chmodSync(fakeEmit, 0o755);

    const fakeRower = join(bin, "fake-rower");
    writeFileSync(
      fakeRower,
      `#!/bin/sh
printf 'rower change\\n' > rower.txt
git add rower.txt
git commit -m 'rower change'
exit 130
`,
    );
    chmodSync(fakeRower, 0o755);

    const runnerPath = join(dir, "runner.sh");
    writeFileSync(
      runnerPath,
      buildRunnerScript({
        combo: { ...combo, worktree },
        rowerCommand: shellQuote(fakeRower),
        hodorCommand: "true",
        emit: shellQuote(fakeEmit),
        activateThreadSitter: ":",
        activateJudge: ":",
      }),
    );
    chmodSync(runnerPath, 0o755);

    const result = spawnSync("sh", [runnerPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        EVENTS_LOG: eventsPath,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      },
    });
    const headSha = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: worktree,
      encoding: "utf8",
    }).stdout.trim();

    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 130,
      stdout: "",
      stderr: "",
    });
    expect(readFileSync(eventsPath, "utf8").trim().split("\n")).toEqual([
      "rower_started",
      [
        "rower_failed",
        "--field exit_code=130",
        "--field has_new_commits=true",
        `--field base_sha=${baseSha}`,
        `--field head_sha=${headSha}`,
        "--field new_commit_count=1",
      ].join(" "),
    ]);
  });

  it("detects the PR by branch", () => {
    expect(script).toContain("--head 'combo/issue-7'");
  });

  it("hands off as pr_ready only when a PR exists, pr_missing otherwise", () => {
    const prReady = script.indexOf("reason=pr_ready");
    const prMissing = script.indexOf("reason=pr_missing");
    const prUrlBranch = script.indexOf('if [ -n "${pr_url:-}" ]');
    const prMissingElse = script.lastIndexOf("else");
    const threadSitter = script.indexOf("activate-thread-sitter");
    expect(prReady).toBeGreaterThan(-1);
    expect(prMissing).toBeGreaterThan(-1);
    // pr_ready lives inside the if-branch that saw a URL; pr_missing in the
    // final else (lastIndexOf: earlier elses belong to rower/hodor failure).
    expect(prUrlBranch).toBeLessThan(prReady);
    expect(prReady).toBeLessThan(prMissingElse);
    expect(prMissing).toBeGreaterThan(prMissingElse);
    expect(threadSitter).toBeGreaterThan(prUrlBranch);
    expect(threadSitter).toBeLessThan(prMissingElse);
  });

  it("activates the judge after journaling the opened PR and before human handoff", () => {
    const prOpened = script.indexOf('pr_opened --field url="$pr_url"');
    const activateJudge = script.indexOf("activate-judge -n o-r-7");
    const handoff = script.indexOf("reason=pr_ready");
    expect(prOpened).toBeGreaterThan(-1);
    expect(activateJudge).toBeGreaterThan(prOpened);
    expect(activateJudge).toBeLessThan(handoff);
  });

  it("single-quotes derived values so paths with spaces or metacharacters stay literal", () => {
    const spaced = buildRunnerScript({
      combo: { ...combo, worktree: "/repos/my repo/.worktrees/issue-7", branch: "combo/it's-7" },
      rowerCommand: "gnhf",
      hodorCommand: "no-mistakes axi run",
      emit: "emit",
      activateThreadSitter: "activate-thread-sitter",
      activateJudge: "activate-judge -n o-r-7",
    });
    expect(spaced).toContain("cd '/repos/my repo/.worktrees/issue-7'");
    expect(spaced).toContain("--head 'combo/it'\\''s-7'");
  });
});
