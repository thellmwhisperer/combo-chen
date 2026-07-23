/**
 * @overview Mechanical contract tests for the Bash v1 journal spine.
 *
 *   READING GUIDE
 *   -------------
 *   1. Validation + dedup       <- cb-emit product surface.
 *   2. Contention + torn lines  <- append/read integrity.
 *   3. Golden folds             <- specification §7 outcomes.
 *
 * @exports none
 * @deps vitest, node:child_process, node:fs, node:os, node:path
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const BIN = join(ROOT, "bin");
const FIXTURES = join(ROOT, "test/fixtures/journal-v1");
const homes: string[] = [];

function makeRun(run = "issue-311-a1f2") {
  const home = mkdtempSync(join(tmpdir(), "cb-journal-"));
  homes.push(home);
  const runs = join(home, "runs");
  const runDir = join(runs, run);
  mkdirSync(runDir, { recursive: true });
  return { env: { ...process.env, CB_RUNS_DIR: runs }, run, runDir };
}

function command(script: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync("sh", [join(BIN, script), ...args], { encoding: "utf8", env, timeout: 10_000 });
}

function emitArgs(run: string, agent: string, code: string, event: string, payload: object) {
  return [
    "--run",
    run,
    "--agent",
    agent,
    "--code",
    code,
    "--event",
    event,
    "--payload",
    JSON.stringify(payload),
  ];
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("cb-emit", () => {
  it.each([
    ["bogus", "0", "run_created", { work_item: "#311", repo: "/repo" }],
    ["chain", "7", "run_created", { work_item: "#311", repo: "/repo" }],
    ["chain", "0", "event_zoo", {}],
    ["chain", "0", "run_created", { work_item: "#311" }],
  ])("rejects an invalid enum, code, event, or required payload", (agent, code, event, payload) => {
    const run = makeRun();
    const result = command("cb-emit.sh", emitArgs(run.run, agent, code, event, payload), run.env);
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(run.runDir, "journal.jsonl"), { encoding: "utf8", flag: "a+" })).toBe("");
  });

  it("deduplicates repeated emissions by the specified identity key", () => {
    const run = makeRun();
    const args = emitArgs(run.run, "reviewer", "0", "member_result", {
      member: "model",
      round: 1,
      sha: "a".repeat(40),
    });
    const first = command("cb-emit.sh", args, run.env);
    const second = command("cb-emit.sh", args, run.env);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    expect(readFileSync(join(run.runDir, "journal.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("derives coder facts and verifies Reviewer claims mechanically", () => {
    const run = makeRun();
    const worktree = join(run.runDir, "worktree");
    mkdirSync(worktree);
    const git = (...args: string[]) => spawnSync("git", ["-C", worktree, ...args], { encoding: "utf8" });
    expect(git("init", "-b", "main").status).toBe(0);
    expect(git("config", "user.name", "Combo Test").status).toBe(0);
    expect(git("config", "user.email", "combo@example.test").status).toBe(0);
    writeFileSync(join(worktree, "file.txt"), "base\n");
    expect(git("add", ".").status).toBe(0);
    expect(git("commit", "-m", "base").status).toBe(0);
    const base = git("rev-parse", "HEAD").stdout.trim();
    expect(
      command(
        "cb-emit.sh",
        emitArgs(run.run, "launcher", "0", "launch_ready", {
          worktree,
          branch: "combo/test",
          base_sha: base,
          runway_kind: "treehouse",
          lease_id: "lease-test",
        }),
        run.env,
      ).status,
    ).toBe(0);
    writeFileSync(join(worktree, "file.txt"), "candidate\n");
    expect(git("add", ".").status).toBe(0);
    expect(git("commit", "-m", "candidate").status).toBe(0);
    const head = git("rev-parse", "HEAD").stdout.trim();

    const ready = command("cb-emit.sh", emitArgs(run.run, "coder", "0", "coder_ready", {}), run.env);
    expect(ready.status).toBe(0);
    expect(JSON.parse(ready.stdout).payload).toEqual({ sha: head, branch: "main" });
    const lgtm = command(
      "cb-emit.sh",
      emitArgs(run.run, "reviewer", "0", "lgtm", { sha: head, round: 1, members: ["model"] }),
      run.env,
    );
    expect(lgtm.status).toBe(0);
    const badLgtm = command(
      "cb-emit.sh",
      emitArgs(run.run, "reviewer", "0", "lgtm", { sha: "f".repeat(40), round: 2, members: ["model"] }),
      run.env,
    );
    expect(badLgtm.status).not.toBe(0);
    const missingFindings = command(
      "cb-emit.sh",
      emitArgs(run.run, "reviewer", "1", "needs_change", {
        sha: head,
        round: 1,
        member: "model",
        artifact: "artifacts/missing.md",
      }),
      run.env,
    );
    expect(missingFindings.status).not.toBe(0);
  });

  it("serializes concurrent appenders without interleaving or duplicate sequence numbers", async () => {
    const run = makeRun();
    const children = Array.from({ length: 24 }, (_, index) => {
      const args = emitArgs(run.run, "reviewer", "0", "member_result", {
        member: `member-${index}`,
        round: 1,
        sha: "b".repeat(40),
      });
      return new Promise<number | null>((resolveExit) => {
        const child = spawn("sh", [join(BIN, "cb-emit.sh"), ...args], { env: run.env, stdio: "ignore" });
        child.on("exit", resolveExit);
      });
    });
    expect(await Promise.all(children)).toEqual(Array(24).fill(0));
    const lines = readFileSync(join(run.runDir, "journal.jsonl"), "utf8").trim().split("\n");
    const events = lines.map((line) => JSON.parse(line) as { seq: number });
    expect(events).toHaveLength(24);
    expect(events.map(({ seq }) => seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 24 }, (_, index) => index + 1),
    );
  });
});

describe("torn final line tolerance", () => {
  it("warns, ignores the torn record, and permits a safe next append", () => {
    const run = makeRun();
    const journal = join(run.runDir, "journal.jsonl");
    writeFileSync(
      journal,
      '{"seq":1,"ts":"2026-07-23T10:00:00Z","run":"issue-311-a1f2","agent":"chain","code":0,"event":"run_created","payload":{"work_item":"#311","repo":"/repo"}}\n{"seq":2',
    );
    const result = command(
      "cb-emit.sh",
      emitArgs(run.run, "launcher", "0", "launch_ready", {
        worktree: "/worktree",
        branch: "combo/issue-311-a1f2",
        base_sha: "0".repeat(40),
        runway_kind: "treehouse",
        lease_id: "lease-1",
      }),
      run.env,
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/warning.*malformed journal line/i);

    const state = command("cb-run-state.sh", [run.run], run.env);
    expect(state.status).toBe(0);
    expect(state.stdout.trim()).toBe("coding");
    expect(state.stderr).toMatch(/warning.*malformed journal line/i);

    const waited = command(
      "cb-wait.sh",
      [run.run, "--agent", "launcher", "--events", "launch_ready", "--after-seq", "1", "--timeout", "1"],
      { ...run.env, CB_WAIT_POLL_SECONDS: "0.01" },
    );
    expect(waited.status).toBe(0);
    expect(JSON.parse(waited.stdout).seq).toBe(2);
    expect(waited.stderr).toMatch(/warning.*malformed journal line/i);
  });
});

describe("cb-run-state fixture folds", () => {
  it("replays by sequence rather than physical line order", () => {
    const run = makeRun("out-of-order");
    const lines = readFileSync(join(FIXTURES, "happy-path.jsonl"), "utf8").trim().split("\n").reverse();
    writeFileSync(join(run.runDir, "journal.jsonl"), lines.join("\n") + "\n");
    expect(command("cb-run-state.sh", [run.run], run.env).stdout.trim()).toBe("done");
  });

  it("never lets forensic events route the phase", () => {
    const run = makeRun("forensic-only");
    const journal = join(run.runDir, "journal.jsonl");
    const product = readFileSync(join(FIXTURES, "gate-failure.jsonl"), "utf8").trim();
    const forensic = JSON.stringify({
      seq: 8,
      ts: "2026-07-23T10:03:08Z",
      run: "forensic-only",
      agent: "gate",
      code: 1,
      event: "gate_progress",
      payload: { state: "late-forensic-record" },
    });
    writeFileSync(journal, `${product}\n${forensic}\n`);
    expect(command("cb-run-state.sh", [run.run], run.env).stdout.trim()).toBe(
      "failed(gate, pipeline_failed)",
    );
  });

  it.each([
    ["happy-path.jsonl", "done"],
    ["needs-change-loop.jsonl", "done"],
    ["launcher-failure.jsonl", "failed(chain, launch_not_ready)"],
    ["gate-failure.jsonl", "failed(gate, pipeline_failed)"],
    ["cleaner-failure.jsonl", "failed(cleaner, clean_failed)"],
  ])("folds %s to %s", (fixture, expected) => {
    const run = makeRun(fixture.replace(".jsonl", ""));
    const journal = join(run.runDir, "journal.jsonl");
    mkdirSync(dirname(journal), { recursive: true });
    writeFileSync(journal, readFileSync(join(FIXTURES, fixture)));
    const result = command("cb-run-state.sh", [run.run], run.env);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(expected);
  });
});
