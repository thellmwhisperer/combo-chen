/**
 * @overview Unit tests for core combo orchestration. ~1340 lines, testing
 *   phase derivation (deriveStatus) and the runner shell script generator
 *   (buildRunnerScript) with real subprocess execution.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at describe("buildRunnerScript")  ← most important test area
 *   2. Then describe("deriveStatus")           ← phase state machine contract
 *
 *   ┌─ TEST AREAS ──────────────────────────────────────────────┐
 *   │ deriveStatus         Verifies the phase state machine      │
 *   │ buildRunnerScript    Verifies the generated runner script  │
 *   └────────────────────────────────────────────────────────────┘
 *
 * @exports none (test file)
 * @deps vitest, node:{child_process,fs,os,path}, ../infra/config,
 *   ../roles/gatekeeper, ./events, ./combo
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_GATEKEEPER_COMMAND } from "../infra/config.js";
import { buildGatekeeperInvocation } from "../roles/gatekeeper.js";
import type { ComboEvent } from "./events.js";
import { buildRunnerScript, deriveStatus, shellQuote } from "./combo.js";

function ev(event: ComboEvent["event"], extra: Record<string, unknown> = {}): ComboEvent {
  return { t: new Date().toISOString(), event, ...extra };
}

// -- 1/2 CORE · Phase derivation tests (deriveStatus) --


describe("deriveStatus", () => {
  it("starts in SETUP", () => {
    expect(deriveStatus([]).phase).toBe("SETUP");
    expect(deriveStatus([ev("combo_created", { issue_url: "x" })]).phase).toBe("SETUP");
  });

  it("advances through the documented phases", () => {
    const events = [ev("combo_created", { issue_url: "x" }), ev("coder_started")];
    expect(deriveStatus(events).phase).toBe("CODING");

    events.push(ev("coder_done"), ev("gate_started"));
    expect(deriveStatus(events).phase).toBe("GATING");

    events.push(ev("pr_opened", { url: "https://github.com/o/r/pull/9" }));
    const status = deriveStatus(events);
    expect(status.phase).toBe("REVIEWING");
    expect(status.pr).toBe("https://github.com/o/r/pull/9");
  });

  it("marks the combo READY only from a ready_for_merge event", () => {
    const status = deriveStatus([
      ev("pr_opened", { url: "https://github.com/o/r/pull/9" }),
      ev("gate_validated", { sha: "def456" }),
      ev("lgtm", { sha: "def456" }),
      ev("ready_for_merge", {
        sha: "def456",
        pr_url: "https://github.com/o/r/pull/9",
      }),
    ]);

    expect(status.phase).toBe("READY");
    expect(status.needsHuman).toBe(false);
    expect(status.pr).toBe("https://github.com/o/r/pull/9");
  });

  it("moves a READY combo back to REVIEWING when head-bound signals go stale", () => {
    for (const staleEvent of [
      ev("lgtm_stale", { old_sha: "def456", new_sha: "fedcba" }),
      ev("gate_stale", { old_sha: "def456", new_sha: "fedcba" }),
      ev("address_done", { head_sha: "fedcba" }),
    ]) {
      const status = deriveStatus([
        ev("pr_opened", { url: "https://github.com/o/r/pull/9" }),
        ev("ready_for_merge", {
          sha: "def456",
          pr_url: "https://github.com/o/r/pull/9",
        }),
        staleEvent,
      ]);

      expect(status.phase).toBe("REVIEWING");
      expect(status.needsHuman).toBe(false);
      expect(status.pr).toBe("https://github.com/o/r/pull/9");
    }
  });

  it("returns an existing PR to REVIEWING when a follow-up gate completes", () => {
    for (const gateDone of [
      ev("gate_status", { state: "idle", head_sha: "fedcba" }),
      ev("gate_validated", { sha: "fedcba" }),
    ]) {
      const status = deriveStatus([
        ev("pr_opened", { url: "https://github.com/o/r/pull/9" }),
        ev("gate_started"),
        gateDone,
      ]);

      expect(status.phase).toBe("REVIEWING");
      expect(status.needsHuman).toBe(false);
      expect(status.pr).toBe("https://github.com/o/r/pull/9");
    }
  });

  it("latches needs_human until the next phase advance", () => {
    const events = [ev("coder_started"), ev("needs_human", { reason: "gate_decision" })];
    const status = deriveStatus(events);
    expect(status.needsHuman).toBe(true);
    expect(status.reason).toBe("gate_decision");

    events.push(ev("gate_started"));
    expect(deriveStatus(events).needsHuman).toBe(false);
  });

  it("marks failures as STALLED and needing a human", () => {
    for (const failed of [
      ev("coder_failed", { exit_code: 1, has_new_commits: false }),
      ev("gate_failed", { exit_code: 17 }),
      ev("pr_autoclose_failed", { exit_code: 18, url: "https://github.com/o/r/pull/9" }),
      ev("rebase_failed", { base: "base-sha" }),
      ev("rebase_conflict", { base: "base-sha" }),
    ]) {
      const status = deriveStatus([failed]);
      expect(status.phase).toBe("STALLED");
      expect(status.needsHuman).toBe(true);
    }
  });

  it("terminal stop wins over everything", () => {
    const status = deriveStatus([
      ev("coder_started"),
      ev("needs_human", { reason: "x" }),
      ev("stopped", { by: "human" }),
    ]);
    expect(status.phase).toBe("STOPPED");
    expect(status.needsHuman).toBe(false);
  });

  it("does not treat parking for reboot as terminal", () => {
    const status = deriveStatus([
      ev("coder_started"),
      ev("coder_failed", { exit_code: 124, has_new_commits: true }),
      ev("parked", { by: "maintainer", summary_path: "/runs/o-r-7/park-handoff.md" }),
    ]);
    expect(status.phase).toBe("STALLED");
    expect(status.needsHuman).toBe(true);
    expect(status.reason).toBe("coder_failed");
  });

  it("keeps merged PRs actionable until closure records combo_closed", () => {
    const merged = deriveStatus([
      ev("pr_opened", { url: "https://github.com/o/r/pull/9" }),
      ev("needs_human", { reason: "pr_ready" }),
      ev("merged", { sha: "def456", by: "maintainer" }),
    ]);
    expect(merged.phase).toBe("STALLED");
    expect(merged.needsHuman).toBe(true);
    expect(merged.reason).toBe("closure_pending");

    const closed = deriveStatus([
      ev("pr_opened", { url: "https://github.com/o/r/pull/9" }),
      ev("needs_human", { reason: "pr_ready" }),
      ev("merged", { sha: "def456", by: "maintainer" }),
      ev("combo_closed"),
    ]);
    expect(closed.phase).toBe("STOPPED");
    expect(closed.needsHuman).toBe(false);
  });
});
// -/ 1/2

// -- 2/2 CORE · Runner script generation tests ← START HERE --
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
  const renderedDefaultGatekeeperCommand = buildGatekeeperInvocation({
    gatekeeperCommand: DEFAULT_GATEKEEPER_COMMAND,
    combo,
    issueTitle: "Issue title",
    issueBody: "Issue body",
  });

  const script = buildRunnerScript({
    combo,
    coderCommand: 'npx -y gnhf --agent codex --current-branch "Implement issue 7"',
    gatekeeperCommand: "no-mistakes axi run",
    emit: "node /opt/combo/dist/cli.mjs emit -n o-r-7",
    activateCoder: "node /opt/combo/dist/cli.mjs activate-coder -n o-r-7",
    activateReviewer: "node /opt/combo/dist/cli.mjs activate-reviewer -n o-r-7",
    ensurePrAutoclose: "node /opt/combo/dist/cli.mjs ensure-pr-autoclose -n o-r-7 --pr-url",
  });

  it("runs inside the worktree", () => {
    expect(script).toContain("cd '/repos/r/.worktrees/issue-7'");
  });

  it("rebases the worker branch against the requested base ref", () => {
    const customBase = buildRunnerScript({
      combo,
      baseRef: "origin/release-candidate",
      coderCommand: "gnhf",
      gatekeeperCommand: "no-mistakes axi run",
      emit: "emit",
      activateCoder: "activate-coder",
      activateReviewer: "activate-reviewer",
    });
    expect(customBase).toContain("git fetch origin 'release-candidate'");
    expect(customBase).toContain("git rebase 'origin/release-candidate'");
    expect(customBase).toContain("git merge-base HEAD 'origin/release-candidate'");
  });

  it("sequences coder, gatekeeper, PR detection, and reviewer activation", () => {
    const coder = script.indexOf("gnhf");
    const gatekeeper = script.indexOf("no-mistakes axi run");
    const pr = script.indexOf("gh pr list");
    const activateCoder = script.indexOf("activate-coder");
    const activateReviewer = script.indexOf("activate-reviewer");
    expect(coder).toBeGreaterThan(-1);
    expect(gatekeeper).toBeGreaterThan(coder);
    expect(pr).toBeGreaterThan(gatekeeper);
    expect(activateCoder).toBeGreaterThan(pr);
    expect(activateReviewer).toBeGreaterThan(activateCoder);
  });

  it("can guard the gatekeeper run with a branch-scoped gate lease", () => {
    const leased = buildRunnerScript({
      combo,
      coderCommand: "true",
      gatekeeperCommand: "no-mistakes axi run",
      emit: "emit",
      activateCoder: "activate-coder",
      activateReviewer: "activate-reviewer",
      gateLeaseAcquire: "combo-chen gate-lease acquire -n o-r-7",
      gateLeaseRelease: "combo-chen gate-lease release -n o-r-7",
    });

    const acquire = leased.indexOf('combo-chen gate-lease acquire -n o-r-7 --head-sha "$gatekeeper_start_sha"');
    const fixInflight = leased.indexOf("gate_status --field state=fix_inflight");
    const gatekeeper = leased.indexOf("no-mistakes axi run");

    expect(acquire).toBeGreaterThan(leased.indexOf("gatekeeper_start_sha=$(git rev-parse HEAD"));
    expect(fixInflight).toBeGreaterThan(acquire);
    expect(gatekeeper).toBeGreaterThan(fixInflight);
    expect(leased).toContain('if [ "$gate_lease_code" -eq 75 ]; then exit 0; fi');
    expect(leased).toContain('if [ "$gate_lease_code" -eq 76 ]; then exit 0; fi');
    expect(leased).toContain("combo-chen gate-lease release -n o-r-7");
  });

  it("emits lifecycle events with captured exit codes on failure", () => {
    expect(script).toContain("emit -n o-r-7 coder_started");
    expect(script).toContain("emit -n o-r-7 coder_done");
    expect(script).toContain("coder_failed");
    expect(script).toContain("gate_failed");
    expect(script).toContain("exit_code=$code");
  });

  it("streams coder stdout and stderr to tmux while keeping coder.log beside the runner", () => {
    expect(script).toContain('coder_log="$(dirname "$0")/coder.log"');
    expect(script).toContain('2>&1 | tee "$coder_log"');
    expect(script).toContain('code=$(cat "$coder_status" 2>/dev/null || printf \'1\')');

    const coder = script.indexOf("gnhf");
    const streamed = script.indexOf('2>&1 | tee "$coder_log"');
    const coderDone = script.indexOf("emit -n o-r-7 coder_done");
    expect(coder).toBeGreaterThan(-1);
    expect(streamed).toBeGreaterThan(coder);
    expect(coderDone).toBeGreaterThan(streamed);
  });

  it("runs the coder with stdin closed so the runner cannot block for input", () => {
    expect(script).toContain(") < /dev/null 2>&1 | tee \"$coder_log\"");
  });

  it("runs the gatekeeper phase with stdin closed so auth prompts cannot block the runner", () => {
    expect(script).toContain(') < /dev/null > "$gatekeeper_log" 2>&1 || gatekeeper_code=$?');
  });

  it("fetches and rebases origin/main before the coder starts", () => {
    const dir = mkdtempSync(join(tmpdir(), "combo-chen-runner-"));
    const worktree = join(dir, "worktree");
    const bin = join(dir, "bin");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(bin, { recursive: true });

    const tracePath = join(dir, "trace.log");
    const fakeEmit = join(bin, "emit");
    writeFileSync(
      fakeEmit,
      `#!/bin/sh
printf 'emit %s\\n' "$*" >> "$TRACE_LOG"
`,
    );
    chmodSync(fakeEmit, 0o755);

    const fakeGit = join(bin, "git");
    writeFileSync(
      fakeGit,
      `#!/bin/sh
printf 'git %s\\n' "$*" >> "$TRACE_LOG"
if [ "$1" = "fetch" ]; then exit 0; fi
if [ "$1" = "rebase" ]; then exit 0; fi
if [ "$1" = "rev-parse" ]; then printf 'fake-head\\n'; exit 0; fi
exit 1
`,
    );
    chmodSync(fakeGit, 0o755);

    const fakeCoder = join(bin, "fake-coder");
    writeFileSync(
      fakeCoder,
      `#!/bin/sh
printf 'coder ran\\n' >> "$TRACE_LOG"
`,
    );
    chmodSync(fakeCoder, 0o755);

    const fakeGh = join(bin, "gh");
    writeFileSync(fakeGh, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeGh, 0o755);
    const mirrorIntent = Buffer.from(
      "Implement GitHub issue https://github.com/o/r/issues/7. Title: Demo Fixes #7",
      "utf8",
    ).toString("base64");

    const runnerPath = join(dir, "runner.sh");
    writeFileSync(
      runnerPath,
      buildRunnerScript({
        combo: { ...combo, worktree },
        coderCommand: shellQuote(fakeCoder),
        gatekeeperCommand: "true",
        emit: shellQuote(fakeEmit),
        activateCoder: ":",
        activateReviewer: ":",
      }),
    );
    chmodSync(runnerPath, 0o755);

    const result = spawnSync("sh", [runnerPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        TRACE_LOG: tracePath,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      },
    });

    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0,
      stdout: "",
      stderr: "",
    });
    expect(readFileSync(tracePath, "utf8").trim().split("\n").slice(0, 5)).toEqual([
      "git fetch origin main",
      "git rebase origin/main",
      "git rev-parse HEAD",
      "emit coder_started",
      "coder ran",
    ]);
  });

  it("journals rebase_conflict and exits before coder starts when the rebase fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "combo-chen-runner-"));
    const worktree = join(dir, "worktree");
    const bin = join(dir, "bin");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(bin, { recursive: true });

    const tracePath = join(dir, "trace.log");
    const fakeEmit = join(bin, "emit");
    writeFileSync(
      fakeEmit,
      `#!/bin/sh
printf 'emit %s\\n' "$*" >> "$TRACE_LOG"
`,
    );
    chmodSync(fakeEmit, 0o755);

    const fakeGit = join(bin, "git");
    writeFileSync(
      fakeGit,
      `#!/bin/sh
printf 'git %s\\n' "$*" >> "$TRACE_LOG"
if [ "$1" = "fetch" ]; then exit 0; fi
if [ "$1" = "rebase" ]; then exit 42; fi
if [ "$1" = "merge-base" ]; then printf 'merge-base-sha\\n'; exit 0; fi
exit 1
`,
    );
    chmodSync(fakeGit, 0o755);

    const fakeCoder = join(bin, "fake-coder");
    writeFileSync(
      fakeCoder,
      `#!/bin/sh
printf 'coder ran\\n' >> "$TRACE_LOG"
`,
    );
    chmodSync(fakeCoder, 0o755);

    const runnerPath = join(dir, "runner.sh");
    writeFileSync(
      runnerPath,
      buildRunnerScript({
        combo: { ...combo, worktree },
        coderCommand: shellQuote(fakeCoder),
        gatekeeperCommand: "true",
        emit: shellQuote(fakeEmit),
        activateCoder: ":",
        activateReviewer: ":",
      }),
    );
    chmodSync(runnerPath, 0o755);

    const result = spawnSync("sh", [runnerPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        TRACE_LOG: tracePath,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      },
    });

    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 1,
      stdout: "",
      stderr: "",
    });
    expect(readFileSync(tracePath, "utf8").trim().split("\n")).toEqual([
      "git fetch origin main",
      "git rebase origin/main",
      "git merge-base HEAD origin/main",
      "emit rebase_conflict --field base=merge-base-sha",
    ]);
  });

  it("journals rebase_failed and exits before coder starts when git fetch fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "combo-chen-runner-"));
    const worktree = join(dir, "worktree");
    const bin = join(dir, "bin");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(bin, { recursive: true });

    const tracePath = join(dir, "trace.log");
    const fakeEmit = join(bin, "emit");
    writeFileSync(
      fakeEmit,
      `#!/bin/sh
printf 'emit %s\\n' "$*" >> "$TRACE_LOG"
`,
    );
    chmodSync(fakeEmit, 0o755);

    const fakeGit = join(bin, "git");
    writeFileSync(
      fakeGit,
      `#!/bin/sh
printf 'git %s\\n' "$*" >> "$TRACE_LOG"
if [ "$1" = "fetch" ]; then exit 128; fi
if [ "$1" = "merge-base" ]; then printf 'merge-base-sha\\n'; exit 0; fi
exit 1
`,
    );
    chmodSync(fakeGit, 0o755);

    const fakeCoder = join(bin, "fake-coder");
    writeFileSync(
      fakeCoder,
      `#!/bin/sh
printf 'coder ran\\n' >> "$TRACE_LOG"
`,
    );
    chmodSync(fakeCoder, 0o755);

    const runnerPath = join(dir, "runner.sh");
    writeFileSync(
      runnerPath,
      buildRunnerScript({
        combo: { ...combo, worktree },
        coderCommand: shellQuote(fakeCoder),
        gatekeeperCommand: "true",
        emit: shellQuote(fakeEmit),
        activateCoder: ":",
        activateReviewer: ":",
      }),
    );
    chmodSync(runnerPath, 0o755);

    const result = spawnSync("sh", [runnerPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        TRACE_LOG: tracePath,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      },
    });

    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 1,
      stdout: "",
      stderr: "",
    });
    expect(readFileSync(tracePath, "utf8").trim().split("\n")).toEqual([
      "git fetch origin main",
      "git merge-base HEAD origin/main",
      "emit rebase_failed --field base=merge-base-sha",
    ]);
  });

  it("emits coder_done when a fake coder exits after seeing non-TTY stdout", () => {
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

    const fakeCoder = join(bin, "fake-coder");
    writeFileSync(
      fakeCoder,
      `#!/bin/sh
if [ -t 1 ]; then
  echo "interactive final screen" >&2
  exit 91
fi
echo "fake coder completed"
echo "fake coder stderr" >&2
exit 0
`,
    );
    chmodSync(fakeCoder, 0o755);

    const fakeGh = join(bin, "gh");
    writeFileSync(fakeGh, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeGh, 0o755);

    const fakeGit = join(bin, "git");
    writeFileSync(
      fakeGit,
      `#!/bin/sh
if [ "$1" = "fetch" ]; then exit 0; fi
if [ "$1" = "rebase" ]; then exit 0; fi
if [ "$1" = "rev-parse" ]; then exit 1; fi
exit 1
`,
    );
    chmodSync(fakeGit, 0o755);

    const runnerPath = join(dir, "runner.sh");
    writeFileSync(
      runnerPath,
      buildRunnerScript({
        combo: { ...combo, worktree },
        coderCommand: shellQuote(fakeCoder),
        gatekeeperCommand: "true",
        emit: shellQuote(fakeEmit),
        activateCoder: ":",
        activateReviewer: ":",
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
      stdout: "fake coder completed\nfake coder stderr\n",
      stderr: "",
    });
    expect(readFileSync(eventsPath, "utf8").trim().split("\n")).toEqual([
      "coder_started",
      "coder_done",
      "gate_started",
      "gate_status --field state=fix_inflight --field head_sha=",
      "gate_status --field state=idle --field head_sha=",
      "needs_human --field reason=pr_missing",
    ]);
    expect(readFileSync(join(dir, "coder.log"), "utf8")).toBe(
      "fake coder completed\nfake coder stderr\n",
    );
  });

  it("preserves the real coder exit code when streaming through tee", () => {
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

    const fakeCoder = join(bin, "fake-coder");
    writeFileSync(
      fakeCoder,
      `#!/bin/sh
echo "coder started"
echo "coder failed loudly" >&2
exit 42
`,
    );
    chmodSync(fakeCoder, 0o755);

    const fakeGit = join(bin, "git");
    writeFileSync(
      fakeGit,
      `#!/bin/sh
if [ "$1" = "fetch" ]; then exit 0; fi
if [ "$1" = "rebase" ]; then exit 0; fi
if [ "$1" = "rev-parse" ]; then printf 'head-sha\\n'; exit 0; fi
if [ "$1" = "rev-list" ]; then printf '0\\n'; exit 0; fi
exit 1
`,
    );
    chmodSync(fakeGit, 0o755);

    const runnerPath = join(dir, "runner.sh");
    writeFileSync(
      runnerPath,
      buildRunnerScript({
        combo: { ...combo, worktree },
        coderCommand: shellQuote(fakeCoder),
        gatekeeperCommand: "true",
        emit: shellQuote(fakeEmit),
        activateCoder: ":",
        activateReviewer: ":",
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
      status: 42,
      stdout: "coder started\ncoder failed loudly\n",
      stderr: "",
    });
    expect(readFileSync(join(dir, "coder.log"), "utf8")).toBe("coder started\ncoder failed loudly\n");
    expect(readFileSync(eventsPath, "utf8").trim().split("\n")).toEqual([
      "coder_started",
      [
        "coder_failed",
        "--field exit_code=42",
        "--field has_new_commits=false",
        "--field base_sha=head-sha",
        "--field head_sha=head-sha",
        "--field new_commit_count=0",
      ].join(" "),
    ]);
  });

  it("fails the coder phase when tee cannot preserve coder.log", () => {
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

    const fakeCoder = join(bin, "fake-coder");
    writeFileSync(
      fakeCoder,
      `#!/bin/sh
echo "coder completed"
exit 0
`,
    );
    chmodSync(fakeCoder, 0o755);

    const fakeTee = join(bin, "tee");
    writeFileSync(
      fakeTee,
      `#!/bin/sh
while IFS= read -r line; do
  printf '%s\\n' "$line"
done
exit 1
`,
    );
    chmodSync(fakeTee, 0o755);

    const fakeGit = join(bin, "git");
    writeFileSync(
      fakeGit,
      `#!/bin/sh
if [ "$1" = "fetch" ]; then exit 0; fi
if [ "$1" = "rebase" ]; then exit 0; fi
if [ "$1" = "rev-parse" ]; then printf 'head-sha\\n'; exit 0; fi
if [ "$1" = "rev-list" ]; then printf '0\\n'; exit 0; fi
exit 1
`,
    );
    chmodSync(fakeGit, 0o755);

    const runnerPath = join(dir, "runner.sh");
    writeFileSync(
      runnerPath,
      buildRunnerScript({
        combo: { ...combo, worktree },
        coderCommand: shellQuote(fakeCoder),
        gatekeeperCommand: "true",
        emit: shellQuote(fakeEmit),
        activateCoder: ":",
        activateReviewer: ":",
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
      status: 1,
      stdout: "coder completed\n",
      stderr: "",
    });
    expect(readFileSync(eventsPath, "utf8").trim().split("\n")).toEqual([
      "coder_started",
      [
        "coder_failed",
        "--field exit_code=1",
        "--field has_new_commits=false",
        "--field base_sha=head-sha",
        "--field head_sha=head-sha",
        "--field new_commit_count=0",
      ].join(" "),
    ]);
  });

  it("starts no-mistakes daemon before the default axi run", () => {
    const dir = mkdtempSync(join(tmpdir(), "combo-chen-runner-"));
    const worktree = join(dir, "worktree");
    const bin = join(dir, "bin");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(bin, { recursive: true });

    const eventsPath = join(dir, "events.log");
    const gatekeeperLog = join(dir, "gatekeeper.log");
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
if [ "$1" = "fetch" ]; then exit 0; fi
if [ "$1" = "rebase" ]; then exit 0; fi
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
printf 'no-mistakes %s\\n' "$*" >> "$GATEKEEPER_LOG"
`,
    );
    chmodSync(fakeNoMistakes, 0o755);

    const runnerPath = join(dir, "runner.sh");
    writeFileSync(
      runnerPath,
      buildRunnerScript({
        combo: { ...combo, worktree },
        coderCommand: "true",
        gatekeeperCommand: renderedDefaultGatekeeperCommand,
        emit: shellQuote(fakeEmit),
        activateCoder: ":",
        activateReviewer: ":",
      }),
    );
    chmodSync(runnerPath, 0o755);

    const result = spawnSync("sh", [runnerPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        EVENTS_LOG: eventsPath,
        GATEKEEPER_LOG: gatekeeperLog,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      },
    });

    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0,
      stdout: "",
      stderr: "",
    });
    expect(readFileSync(eventsPath, "utf8").trim().split("\n")).toEqual([
      "coder_started",
      "coder_done",
      "gate_started",
      "gate_status --field state=fix_inflight --field head_sha=fake-head",
      "gate_status --field state=idle --field head_sha=fake-head",
      "needs_human --field reason=pr_missing",
    ]);
    const gatekeeperOutput = readFileSync(gatekeeperLog, "utf8");
    expect(gatekeeperOutput).toContain("no-mistakes daemon start\nno-mistakes axi run --intent");
    expect(gatekeeperOutput).toContain("--skip=ci");
    expect(gatekeeperOutput).toContain("Implement GitHub issue https://github.com/o/r/issues/7.");
    expect(gatekeeperOutput).not.toContain("git push no-mistakes");
  });

  it("publishes the no-mistakes mirror with intent before the default axi run", () => {
    const dir = mkdtempSync(join(tmpdir(), "combo-chen-runner-"));
    const worktree = join(dir, "worktree");
    const bin = join(dir, "bin");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(bin, { recursive: true });

    const eventsPath = join(dir, "events.log");
    const gatekeeperLog = join(dir, "gatekeeper.log");
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
  printf 'git %s\\n' "$*" >> "$GATEKEEPER_LOG"
  exit 0
fi
if [ "$1" = "ls-remote" ]; then
  printf 'git %s\\n' "$*" >> "$GATEKEEPER_LOG"
  printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\trefs/heads/combo/issue-7\\n'
  exit 0
fi
if [ "$1" = "push" ]; then
  printf 'git %s\\n' "$*" >> "$GATEKEEPER_LOG"
  exit 0
fi
if [ "$1" = "fetch" ]; then exit 0; fi
if [ "$1" = "rebase" ]; then exit 0; fi
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
printf 'no-mistakes %s\\n' "$*" >> "$GATEKEEPER_LOG"
`,
    );
    chmodSync(fakeNoMistakes, 0o755);

    const fakeGh = join(bin, "gh");
    writeFileSync(fakeGh, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeGh, 0o755);
    const mirrorIntent = Buffer.from(
      "Implement GitHub issue https://github.com/o/r/issues/7. Title: Demo Fixes #7",
      "utf8",
    ).toString("base64");

    const runnerPath = join(dir, "runner.sh");
    writeFileSync(
      runnerPath,
      buildRunnerScript({
        combo: { ...combo, worktree },
        coderCommand: "true",
        gatekeeperCommand: renderedDefaultGatekeeperCommand,
        gatekeeperMirrorIntent: mirrorIntent,
        emit: shellQuote(fakeEmit),
        activateCoder: ":",
        activateReviewer: ":",
      }),
    );
    chmodSync(runnerPath, 0o755);

    const result = spawnSync("sh", [runnerPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        EVENTS_LOG: eventsPath,
        GATEKEEPER_LOG: gatekeeperLog,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      },
    });

    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0,
      stdout: "",
      stderr: "",
    });
    expect(readFileSync(eventsPath, "utf8").trim().split("\n")).toEqual([
      "coder_started",
      "coder_done",
      "gate_started",
      "gate_status --field state=fix_inflight --field head_sha=fake-head",
      "gate_status --field state=idle --field head_sha=fake-head",
      "needs_human --field reason=pr_missing",
    ]);
    const gatekeeperOutput = readFileSync(gatekeeperLog, "utf8");
    expect(gatekeeperOutput).toContain("git remote get-url no-mistakes");
    expect(gatekeeperOutput).toContain("git ls-remote --heads no-mistakes combo/issue-7");
    expect(gatekeeperOutput).toContain(
      `git push -o no-mistakes.intent=${mirrorIntent} no-mistakes --force-with-lease=refs/heads/combo/issue-7:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa HEAD:refs/heads/combo/issue-7`,
    );
    expect(gatekeeperOutput.match(/no-mistakes daemon start/g)).toHaveLength(1);
    expect(gatekeeperOutput).toContain("no-mistakes axi run --intent");
    expect(gatekeeperOutput).toContain("--skip=ci");
    expect(gatekeeperOutput).toContain("Implement GitHub issue https://github.com/o/r/issues/7.");
    expect(gatekeeperOutput).toContain("Fixes #7");
  });

  it("continues mirror publish when daemon start reports an already-running daemon", () => {
    const dir = mkdtempSync(join(tmpdir(), "combo-chen-runner-"));
    const worktree = join(dir, "worktree");
    const bin = join(dir, "bin");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(bin, { recursive: true });

    const eventsPath = join(dir, "events.log");
    const gatekeeperLog = join(dir, "gatekeeper.log");
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
if [ "$1" = "remote" ]; then exit 0; fi
if [ "$1" = "ls-remote" ]; then exit 0; fi
if [ "$1" = "push" ]; then exit 0; fi
if [ "$1" = "fetch" ]; then exit 0; fi
if [ "$1" = "rebase" ]; then exit 0; fi
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
printf 'no-mistakes %s\\n' "$*" >> "$GATEKEEPER_LOG"
if [ "$1" = "daemon" ] && [ "$2" = "start" ]; then exit 1; fi
if [ "$1" = "status" ]; then
  printf '  daemon:  running\\n'
  exit 0
fi
if [ "$1" = "axi" ]; then exit 0; fi
exit 0
`,
    );
    chmodSync(fakeNoMistakes, 0o755);

    const runnerPath = join(dir, "runner.sh");
    writeFileSync(
      runnerPath,
      buildRunnerScript({
        combo: { ...combo, worktree },
        coderCommand: "true",
        gatekeeperCommand: renderedDefaultGatekeeperCommand,
        gatekeeperMirrorIntent: Buffer.from("Implement issue 7", "utf8").toString("base64"),
        emit: shellQuote(fakeEmit),
        activateCoder: ":",
        activateReviewer: ":",
      }),
    );
    chmodSync(runnerPath, 0o755);

    const result = spawnSync("sh", [runnerPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        EVENTS_LOG: eventsPath,
        GATEKEEPER_LOG: gatekeeperLog,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      },
    });

    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0,
      stdout: "",
      stderr: "",
    });
    const gatekeeperOutput = readFileSync(gatekeeperLog, "utf8");
    expect(gatekeeperOutput).toContain("no-mistakes daemon start");
    expect(gatekeeperOutput).toContain("no-mistakes status");
    expect(gatekeeperOutput).toContain("no-mistakes axi run");
  });

  it("copies local no-mistakes config before the mirror-triggered axi run consumes it", () => {
    const dir = mkdtempSync(join(tmpdir(), "combo-chen-runner-"));
    const worktree = join(dir, "worktree");
    const bin = join(dir, "bin");
    const dataDir = join(dir, "no-mistakes-data");
    const runId = "01TESTCONFIGCOPY";
    const otherRunId = "01WRONGBRANCH";
    const gatePath = join(dataDir, "repos", "dd1c02626404.git");
    const daemonWorktree = join(dataDir, "worktrees", "dd1c02626404", runId);
    mkdirSync(worktree, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(worktree, ".no-mistakes.yaml"), "commands:\n  test: pnpm test\n");

    const eventsPath = join(dir, "events.log");
    const gatekeeperLog = join(dir, "gatekeeper.log");
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
  printf 'git %s\\n' "$*" >> "$GATEKEEPER_LOG"
  exit 0
fi
if [ "$1" = "ls-remote" ]; then
  printf 'git %s\\n' "$*" >> "$GATEKEEPER_LOG"
  exit 0
fi
if [ "$1" = "push" ]; then
  mkdir -p "$NO_MISTAKES_RUN_DIR"
  printf 'git %s\\n' "$*" >> "$GATEKEEPER_LOG"
  exit 0
fi
if [ "$1" = "fetch" ]; then exit 0; fi
if [ "$1" = "rebase" ]; then exit 0; fi
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
printf 'no-mistakes %s\\n' "$*" >> "$GATEKEEPER_LOG"
if [ "$1" = "axi" ] && [ "$2" = "status" ]; then
  printf 'run:\\n'
  printf '  id: %s\\n' "$NO_MISTAKES_RUN_ID"
  printf '  branch: combo/issue-7\\n'
  printf '  status: running\\n'
  exit 0
fi
if [ "$1" = "axi" ]; then
  test -f "$NO_MISTAKES_RUN_DIR/.no-mistakes.yaml"
  test ! -f "$NO_MISTAKES_OTHER_RUN_DIR/.no-mistakes.yaml"
  exit 0
fi
if [ "$1" = "status" ]; then
  if [ -d "$NO_MISTAKES_RUN_DIR" ]; then
    printf '    repo:  /repo\\n'
    printf '    gate:  %s\\n' "$NO_MISTAKES_GATE"
    printf '\\n  Active run\\n'
    printf '       id:  %s\\n' "$NO_MISTAKES_OTHER_RUN_ID"
    printf '   branch:  combo/other\\n'
  fi
fi
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
        coderCommand: "true",
        gatekeeperCommand: renderedDefaultGatekeeperCommand,
        gatekeeperMirrorIntent: Buffer.from("Implement issue 7", "utf8").toString("base64"),
        emit: shellQuote(fakeEmit),
        activateCoder: ":",
        activateReviewer: ":",
      }),
    );
    chmodSync(runnerPath, 0o755);

    const result = spawnSync("sh", [runnerPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        EVENTS_LOG: eventsPath,
        GATEKEEPER_LOG: gatekeeperLog,
        NO_MISTAKES_GATE: gatePath,
        NO_MISTAKES_RUN_ID: runId,
        NO_MISTAKES_OTHER_RUN_ID: otherRunId,
        NO_MISTAKES_RUN_DIR: daemonWorktree,
        NO_MISTAKES_OTHER_RUN_DIR: join(dataDir, "worktrees", "dd1c02626404", otherRunId),
        COMBO_CHEN_NO_MISTAKES_CONFIG_COPY_ATTEMPTS: "5",
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      },
    });

    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0,
      stdout: "",
      stderr: "",
    });
    const daemonConfig = join(daemonWorktree, ".no-mistakes.yaml");
    expect(existsSync(daemonConfig)).toBe(true);
    expect(readFileSync(daemonConfig, "utf8")).toBe("commands:\n  test: pnpm test\n");
    const gatekeeperOutput = readFileSync(gatekeeperLog, "utf8");
    expect(gatekeeperOutput).toContain("no-mistakes axi run");
    expect(gatekeeperOutput).toContain("copied .no-mistakes.yaml");
  });

  it("exits the gate subshell when the mirror push fails, preventing the gatekeeper command from running", () => {
    const dir = mkdtempSync(join(tmpdir(), "combo-chen-runner-"));
    const worktree = join(dir, "worktree");
    const bin = join(dir, "bin");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(bin, { recursive: true });

    const eventsPath = join(dir, "events.log");
    const gatekeeperLog = join(dir, "gatekeeper.log");
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
  exit 0
fi
if [ "$1" = "ls-remote" ]; then
  printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\trefs/heads/combo/issue-7\\n'
  exit 0
fi
if [ "$1" = "push" ]; then
  exit 128
fi
if [ "$1" = "fetch" ]; then exit 0; fi
if [ "$1" = "rebase" ]; then exit 0; fi
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
printf 'no-mistakes %s\\n' "$*" >> "$GATEKEEPER_LOG"
`,
    );
    chmodSync(fakeNoMistakes, 0o755);

    const mirrorIntent = Buffer.from("Test intent", "utf8").toString("base64");

    const runnerPath = join(dir, "runner.sh");
    writeFileSync(
      runnerPath,
      buildRunnerScript({
        combo: { ...combo, worktree },
        coderCommand: "true",
        gatekeeperCommand: `${shellQuote(fakeNoMistakes)} axi run --intent test`,
        gatekeeperMirrorIntent: mirrorIntent,
        emit: shellQuote(fakeEmit),
        activateCoder: ":",
        activateReviewer: ":",
      }),
    );
    chmodSync(runnerPath, 0o755);

    const result = spawnSync("sh", [runnerPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        EVENTS_LOG: eventsPath,
        GATEKEEPER_LOG: gatekeeperLog,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      },
    });

    expect(result.status).toBe(1);
    const events = readFileSync(eventsPath, "utf8").trim().split("\n");
    expect(events.filter((l) => l.startsWith("gate_failed"))).toHaveLength(1);
    const gatekeeperOutput = readFileSync(gatekeeperLog, "utf8");
    expect(gatekeeperOutput).not.toContain("no-mistakes axi run");
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
if [ "$1" = "fetch" ]; then exit 0; fi
if [ "$1" = "rebase" ]; then exit 0; fi
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
        coderCommand: "true",
        gatekeeperCommand: `${shellQuote(fakeNoMistakes)} axi run --intent ${shellQuote("Implement issue 24")}`,
        emit: shellQuote(fakeEmit),
        activateCoder: ":",
        activateReviewer: ":",
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
      "coder_started",
      "coder_done",
      "gate_started",
      `gate_status --field state=fix_inflight --field head_sha=${headSha}`,
      `gate_status --field state=awaiting_approval --field head_sha=${headSha}`,
      "needs_human --field reason=gate_waiting",
    ]);
    expect(readFileSync(join(dir, "gatekeeper.log"), "utf8")).toBe(gateToon);
  });

  it("emits coder_failed with branch-vs-base commit evidence when a coder commits then exits nonzero", () => {
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
    const origin = join(dir, "origin.git");
    for (const args of [
      ["init", "--bare", origin],
      ["branch", "-M", "main"],
      ["remote", "add", "origin", origin],
      ["push", "-u", "origin", "main"],
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

    const fakeCoder = join(bin, "fake-coder");
    writeFileSync(
      fakeCoder,
      `#!/bin/sh
printf 'coder change\\n' > coder.txt
git add coder.txt
git commit -m 'coder change'
exit 130
`,
    );
    chmodSync(fakeCoder, 0o755);

    const runnerPath = join(dir, "runner.sh");
    writeFileSync(
      runnerPath,
      buildRunnerScript({
        combo: { ...combo, worktree },
        coderCommand: shellQuote(fakeCoder),
        gatekeeperCommand: "true",
        emit: shellQuote(fakeEmit),
        activateCoder: ":",
        activateReviewer: ":",
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

    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 130,
      stderr: "",
    });
    expect(result.stdout).toContain("coder change");
    expect(result.stdout).toContain("1 file changed");
    expect(readFileSync(eventsPath, "utf8").trim().split("\n")).toEqual([
      "coder_started",
      [
        "coder_failed",
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

  it("does not use the obsolete pr_ready needs_human handoff after opening a PR", () => {
    const autoclose = script.indexOf("ensure-pr-autoclose");
    const autocloseLog = script.indexOf("autoclose_log");
    const prReady = script.indexOf("reason=pr_ready");
    const prMissing = script.indexOf("reason=pr_missing");
    const prUrlBranch = script.indexOf('if [ -n "${pr_url:-}" ]');
    const prMissingElse = script.lastIndexOf("else");
    const coder = script.indexOf("activate-coder");
    const reviewer = script.indexOf("activate-reviewer -n o-r-7");
    expect(prReady).toBe(-1);
    expect(prMissing).toBeGreaterThan(-1);
    // pr_missing is the true blocked handoff; PR discovery itself starts the
    // reviewer workers and remains REVIEWING until ready_for_merge.
    expect(prUrlBranch).toBeGreaterThan(-1);
    expect(autocloseLog).toBeGreaterThan(-1);
    expect(autoclose).toBeGreaterThan(prUrlBranch);
    expect(autoclose).toBeLessThan(coder);
    expect(prMissing).toBeGreaterThan(prMissingElse);
    expect(coder).toBeGreaterThan(prUrlBranch);
    expect(coder).toBeLessThan(prMissingElse);
    expect(reviewer).toBeGreaterThan(coder);
    expect(reviewer).toBeLessThan(prMissingElse);
  });

  it("blocks the handoff when the PR autoclose guard fails", () => {
    expect(script).toContain('autoclose_log="$(dirname "$0")/autoclose.log"');
    expect(script).toContain('> "$autoclose_log" 2>&1; then');
    expect(script).toContain('autoclose_code=$?');
    expect(script).toContain('pr_autoclose_failed --field exit_code="$autoclose_code" --field url="$pr_url"');
    expect(script).toContain('exit "$autoclose_code"');
    expect(script).not.toContain("autoclose guard skipped");
  });

  it("activates the reviewer after journaling the opened PR", () => {
    const prOpened = script.indexOf('pr_opened --field url="$pr_url"');
    const activateReviewer = script.indexOf("activate-reviewer -n o-r-7");
    const prMissingElse = script.lastIndexOf("else");
    expect(prOpened).toBeGreaterThan(-1);
    expect(activateReviewer).toBeGreaterThan(prOpened);
    expect(activateReviewer).toBeLessThan(prMissingElse);
  });

  it("single-quotes derived values so paths with spaces or metacharacters stay literal", () => {
    const spaced = buildRunnerScript({
      combo: { ...combo, worktree: "/repos/my repo/.worktrees/issue-7", branch: "combo/it's-7" },
      coderCommand: "gnhf",
      gatekeeperCommand: "no-mistakes axi run",
      emit: "emit",
      activateCoder: "activate-coder",
      activateReviewer: "activate-reviewer -n o-r-7",
    });
    expect(spaced).toContain("cd '/repos/my repo/.worktrees/issue-7'");
    expect(spaced).toContain("--head 'combo/it'\\''s-7'");
  });
});
// -/ 2/2
