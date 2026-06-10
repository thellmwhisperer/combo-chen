import { describe, expect, it } from "vitest";

import type { ComboEvent } from "./events.js";
import { buildRunnerScript, deriveStatus } from "./combo.js";

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
  });

  it("runs inside the worktree", () => {
    expect(script).toContain("cd '/repos/r/.worktrees/issue-7'");
  });

  it("sequences rower, hodor, pr detection, and the final handoff to humans", () => {
    const rower = script.indexOf("gnhf");
    const hodor = script.indexOf("no-mistakes axi run");
    const pr = script.indexOf("gh pr list");
    const handoff = script.indexOf("pr_ready");
    expect(rower).toBeGreaterThan(-1);
    expect(hodor).toBeGreaterThan(rower);
    expect(pr).toBeGreaterThan(hodor);
    expect(handoff).toBeGreaterThan(pr);
  });

  it("emits lifecycle events with captured exit codes on failure", () => {
    expect(script).toContain("emit -n o-r-7 rower_started");
    expect(script).toContain("emit -n o-r-7 rower_done");
    expect(script).toContain("rower_failed");
    expect(script).toContain("hodor_failed");
    expect(script).toContain("exit_code=$code");
  });

  it("detects the PR by branch", () => {
    expect(script).toContain("--head 'combo/issue-7'");
  });

  it("hands off as pr_ready only when a PR exists, pr_missing otherwise", () => {
    const prReady = script.indexOf("reason=pr_ready");
    const prMissing = script.indexOf("reason=pr_missing");
    expect(prReady).toBeGreaterThan(-1);
    expect(prMissing).toBeGreaterThan(-1);
    // pr_ready lives inside the if-branch that saw a URL; pr_missing in the
    // final else (lastIndexOf: earlier elses belong to rower/hodor failure).
    expect(script.indexOf('if [ -n "${pr_url:-}" ]')).toBeLessThan(prReady);
    expect(prReady).toBeLessThan(script.lastIndexOf("else"));
    expect(prMissing).toBeGreaterThan(script.lastIndexOf("else"));
  });

  it("single-quotes derived values so paths with spaces or metacharacters stay literal", () => {
    const spaced = buildRunnerScript({
      combo: { ...combo, worktree: "/repos/my repo/.worktrees/issue-7", branch: "combo/it's-7" },
      rowerCommand: "gnhf",
      hodorCommand: "no-mistakes axi run",
      emit: "emit",
    });
    expect(spaced).toContain("cd '/repos/my repo/.worktrees/issue-7'");
    expect(spaced).toContain("--head 'combo/it'\\''s-7'");
  });
});
