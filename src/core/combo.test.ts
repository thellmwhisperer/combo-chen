import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
    const status = deriveStatus([ev("rower_started"), ev("rower_failed", { exit_code: 1 })]);
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
      "needs_human --field reason=pr_missing",
    ]);
    expect(readFileSync(join(dir, "rower.log"), "utf8")).toBe(
      "fake rower completed\nfake rower stderr\n",
    );
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
