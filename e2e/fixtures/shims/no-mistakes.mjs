#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const statePath = process.env.E2E_NO_MISTAKES_STATE || join(process.cwd(), ".tmp", "no-mistakes-state.json");

function load() {
  return existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : { active: process.env.E2E_NO_MISTAKES_ACTIVE === "1" };
}

function save(state) {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function branch() {
  const result = spawnSync("git", ["branch", "--show-current"], { cwd: process.cwd(), encoding: "utf8" });
  return (result.stdout || "main").trim() || "main";
}

function head() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" });
  return (result.stdout || "").trim();
}

function runId() {
  return process.env.E2E_NO_MISTAKES_QUOTE_RUN_ID === "1" ? "\"e2e-run\"" : "e2e-run";
}

function unquotedRunId() {
  return runId().replace(/^"/, "").replace(/"$/, "");
}

function gatePath() {
  return process.env.E2E_NO_MISTAKES_GATE || join(process.cwd(), ".tmp", "no-mistakes", "repos", "e2e.git");
}

function ensureRunDir() {
  const gate = gatePath();
  const dataDir = dirname(dirname(gate));
  const repoId = basename(gate, ".git");
  const runDir = join(dataDir, "worktrees", repoId, unquotedRunId());
  mkdirSync(runDir, { recursive: true });
  return { gate, runDir };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isLive(run) {
  return ["active", "in_progress", "pending", "running"].includes(run?.status);
}

function activeRunForCurrentBranch(state) {
  const currentBranch = branch();
  if (Array.isArray(state.runs)) {
    return state.runs.find((run) => run.branch === currentBranch && isLive(run)) || null;
  }
  if (!state.active) return null;
  const legacyBranch = state.branch || currentBranch;
  return legacyBranch === currentBranch
    ? { id: unquotedRunId(), branch: legacyBranch, head: state.head || head(), status: "active" }
    : null;
}

function setCurrentBranchRun(state, run) {
  if (!Array.isArray(state.runs)) state.runs = [];
  const currentBranch = branch();
  state.runs = state.runs.filter((existing) => !(existing.branch === currentBranch && isLive(existing)));
  state.runs.unshift(run);
  state.active = true;
  state.branch = run.branch;
  state.head = run.head;
}

function markCurrentBranchRun(state, status) {
  if (!Array.isArray(state.runs)) return;
  const currentBranch = branch();
  state.runs = state.runs.map((run) =>
    run.branch === currentBranch && isLive(run) ? { ...run, status } : run,
  );
}

function logCall() {
  if (!process.env.E2E_NO_MISTAKES_LOG) return;
  appendFileSync(
    process.env.E2E_NO_MISTAKES_LOG,
    `${JSON.stringify({ args, cwd: process.cwd(), branch: branch(), head: head() })}\n`,
  );
}

logCall();

if (args[0] === "daemon" && args[1] === "start") process.exit(0);
if (args[0] === "daemon" && args[1] === "stop") process.exit(0);

if (args[0] === "status") {
  const state = load();
  if (activeRunForCurrentBranch(state)) {
    const paths = ensureRunDir();
    process.stdout.write(`daemon: running\ngate: ${paths.gate}\n`);
  } else {
    process.stdout.write("daemon: running\n");
  }
  process.exit(0);
}

if (args[0] === "axi" && args[1] === "status") {
  const state = load();
  const activeRun = activeRunForCurrentBranch(state);
  if (activeRun) {
    ensureRunDir();
    process.stdout.write(`id: ${activeRun.id || runId()}\nbranch: ${activeRun.branch}\nhead: ${activeRun.head || head()}\nstatus: ${activeRun.status || "active"}\n`);
    process.exit(0);
  }
  process.stdout.write("No active run.\n");
  process.exit(1);
}

if (args[0] === "axi" && args[1] === "abort") {
  const state = load();
  const activeRun = activeRunForCurrentBranch(state);
  if (!activeRun) process.exit(1);
  if (Array.isArray(state.runs)) {
    const currentBranch = branch();
    state.runs = state.runs.map((run) =>
      run.branch === currentBranch && isLive(run) ? { ...run, status: "cancelled" } : run,
    );
  }
  state.active = false;
  save(state);
  process.stdout.write(`aborted ${activeRun.id || unquotedRunId()}\n`);
  process.exit(0);
}

if (args[0] === "axi" && args[1] === "run") {
  if (process.env.E2E_NO_MISTAKES_ACTIVATE_ON_AXI_RUN === "1") {
    const state = load();
    setCurrentBranchRun(state, {
      id: unquotedRunId(),
      branch: branch(),
      head: head(),
      status: "active",
    });
    save(state);
    ensureRunDir();
  }
  const delay = Number.parseInt(process.env.E2E_NO_MISTAKES_RUN_DELAY_MS || "250", 10);
  if (Number.isFinite(delay) && delay > 0) sleep(delay);
  if (process.env.E2E_NO_MISTAKES_FAIL_AXI_RUN === "1") {
    const state = load();
    markCurrentBranchRun(state, "failed");
    state.active = false;
    save(state);
    process.stdout.write("run: failed\n  review: failed\n");
    process.stdout.write('error: "step review failed: agent review: acp:opencode output parse: JSON output findings[1].action must match one of the allowed values"\n');
    process.exit(1);
  }
  if (process.env.E2E_NO_MISTAKES_CONTEXT_CANCELED_AFTER_CHECKS_PASSED === "1") {
    const state = load();
    state.active = false;
    save(state);
    process.stdout.write("outcome: checks-passed\n");
    process.stdout.write("ci.log: context canceled\n");
    process.exit(1);
  }
  process.stdout.write("outcome: checks-passed\n");
  process.exit(0);
}

if (args[0] === "attach" && args[1] === "--run") {
  const requested = args[2] || "";
  if (process.env.E2E_NO_MISTAKES_ATTACH_FAIL === "1" || /^".*"$/.test(requested)) {
    process.stderr.write(`get run: run not found: ${JSON.stringify(requested)}\n`);
    process.exit(1);
  }
  process.stdout.write(`attached ${requested}\n`);
  process.exit(0);
}

process.exit(0);
