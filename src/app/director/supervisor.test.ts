/**
 * @overview Contract tests for the in-process event-driven capsule supervisor.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at the terminal-exit tests   <- journal combo_closed replaces stdout regex.
 *   2. Then retry/backoff tests           <- watch_error/watch_dead parity with the shell loop.
 *   3. Finish at waitForJournalWake       <- fs.watch wake with poll fallback.
 *
 *   MAIN FLOW
 *   ---------
 *   persisted run fixture -> superviseCapsuleCombo(injected tick/wake) -> journal assertions
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   fixture, fakeDirectorDeps
 *
 * @exports none
 * @deps node:{fs,os,path}, vitest, ../../core/{events,state}, ../../infra/{config,config-snapshot}, ./supervisor, ./director
 */
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { appendEvent, journalPath, readEvents } from "../../core/events.js";
import { runDirFor, writeCombo } from "../../core/state.js";
import { loadConfig } from "../../infra/config.js";
import { writeConfigSnapshot } from "../../infra/config-snapshot.js";
import { superviseCapsuleCombo, waitForJournalWake } from "./supervisor.js";
import type { DirectorDeps } from "./director.js";

// -- 1/2 HELPER · persisted fixture and fake deps --
function fixture(env: Record<string, string> = {}): { home: string; runDir: string } {
  const home = mkdtempSync(join(tmpdir(), "combo-chen-supervisor-"));
  const runDir = runDirFor(home, "o-r-7");
  const repoDir = join(home, "repo");
  mkdirSync(repoDir, { recursive: true });
  writeCombo(runDir, {
    id: "o-r-7",
    issueUrl: "https://github.com/o/r/issues/7",
    repoDir,
    worktree: join(repoDir, ".worktrees", "issue-7"),
    branch: "combo/issue-7",
    tmuxSession: "combo-chen-o-r-7",
    createdAt: new Date(0).toISOString(),
  });
  writeConfigSnapshot(runDir, loadConfig({ repoDir, env }));
  appendEvent(runDir, "combo_created", { issue_url: "https://github.com/o/r/issues/7" });
  return { home, runDir };
}

function fakeDirectorDeps(): { deps: DirectorDeps; out: string[]; sleeps: number[] } {
  const out: string[] = [];
  const sleeps: number[] = [];
  const deps: DirectorDeps = {
    env: {},
    out: (line) => out.push(line),
    tmux: () => ({ status: 0, stdout: "", stderr: "" }),
    git: () => ({ status: 0, stdout: "", stderr: "" }),
    treehouse: () => ({ status: 0, stdout: "", stderr: "" }),
    gh: () => ({ status: 0, stdout: "[]", stderr: "" }),
    noMistakes: () => ({ status: 0, stdout: "", stderr: "" }),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { deps, out, sleeps };
}
// -/ 1/2

// -- 2/2 CORE · superviseCapsuleCombo contracts <- START HERE --
describe("superviseCapsuleCombo", () => {
  it("ticks until the journal reaches combo_closed and exits clean", async () => {
    const f = fixture();
    const h = fakeDirectorDeps();
    let ticks = 0;
    const wakes: number[] = [];

    const code = await superviseCapsuleCombo({
      deps: h.deps,
      home: f.home,
      comboId: "o-r-7",
      cli: "combo-chen",
      tick: async () => {
        ticks += 1;
        if (ticks === 2) appendEvent(f.runDir, "combo_closed", {});
      },
      waitForWake: async (input) => {
        wakes.push(input.timeoutMs);
      },
    });

    expect(code).toBe(0);
    expect(ticks).toBe(2);
    expect(wakes).toEqual([120_000]);
    expect(h.out.at(-1)).toContain("combo_closed");
  });

  it("exits immediately without ticking when the journal is already terminal", async () => {
    const f = fixture();
    appendEvent(f.runDir, "combo_closed", {});
    const h = fakeDirectorDeps();
    const tick = vi.fn();

    const code = await superviseCapsuleCombo({
      deps: h.deps,
      home: f.home,
      comboId: "o-r-7",
      cli: "combo-chen",
      tick,
      waitForWake: async () => {},
    });

    expect(code).toBe(0);
    expect(tick).not.toHaveBeenCalled();
  });

  it("journals watch_error per failed tick and watch_dead at the failure limit", async () => {
    const f = fixture({
      COMBO_CHEN_WATCH_FAILURE_LIMIT: "2",
      COMBO_CHEN_WATCH_BACKOFF_MAX_SECONDS: "4",
    });
    const h = fakeDirectorDeps();

    const code = await superviseCapsuleCombo({
      deps: h.deps,
      home: f.home,
      comboId: "o-r-7",
      cli: "combo-chen",
      tick: async () => {
        throw new Error("boom");
      },
      waitForWake: async () => {},
    });

    expect(code).toBe(1);
    const events = readEvents(f.runDir).map(({ t: _t, ...event }) => event);
    expect(events.slice(1)).toEqual([
      { event: "watch_error", exit_code: 1, stderr: "boom", consecutive_failures: 1, watcher: "director" },
      { event: "watch_error", exit_code: 1, stderr: "boom", consecutive_failures: 2, watcher: "director" },
      { event: "watch_dead", exit_code: 1, stderr: "boom", consecutive_failures: 2, watcher: "director" },
    ]);
    expect(h.sleeps).toEqual([4000]);
  });

  it("resets the failure count after a successful tick", async () => {
    const f = fixture({
      COMBO_CHEN_WATCH_FAILURE_LIMIT: "2",
      COMBO_CHEN_WATCH_BACKOFF_MAX_SECONDS: "4",
    });
    const h = fakeDirectorDeps();
    let ticks = 0;

    const code = await superviseCapsuleCombo({
      deps: h.deps,
      home: f.home,
      comboId: "o-r-7",
      cli: "combo-chen",
      tick: async () => {
        ticks += 1;
        if (ticks % 2 === 1) throw new Error("flaky");
        if (ticks === 4) appendEvent(f.runDir, "combo_closed", {});
      },
      waitForWake: async () => {},
    });

    expect(code).toBe(0);
    const names = readEvents(f.runDir).map((event) => event.event);
    expect(names.filter((name) => name === "watch_error")).toHaveLength(2);
    expect(names).not.toContain("watch_dead");
  });
});

describe("waitForJournalWake", () => {
  it("wakes when the journal file grows", async () => {
    const root = mkdtempSync(join(tmpdir(), "combo-chen-wake-"));
    writeFileSync(journalPath(root), "");
    const started = Date.now();
    const wake = waitForJournalWake({ runDir: root, timeoutMs: 5000, pollMs: 20 });
    setTimeout(() => appendFileSync(journalPath(root), "{}\n"), 25);

    await wake;
    expect(Date.now() - started).toBeLessThan(4500);
  });

  it("wakes on the sampling timeout when nothing changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "combo-chen-wake-"));
    writeFileSync(journalPath(root), "");

    await expect(waitForJournalWake({ runDir: root, timeoutMs: 30, pollMs: 10 })).resolves.toBeUndefined();
  });

  it("falls back to polling when the journal file does not exist yet", async () => {
    const root = mkdtempSync(join(tmpdir(), "combo-chen-wake-"));
    const started = Date.now();
    const wake = waitForJournalWake({ runDir: root, timeoutMs: 5000, pollMs: 10 });
    setTimeout(() => writeFileSync(journalPath(root), "{}\n"), 25);

    await wake;
    expect(Date.now() - started).toBeLessThan(4500);
  });
});
// -/ 2/2
