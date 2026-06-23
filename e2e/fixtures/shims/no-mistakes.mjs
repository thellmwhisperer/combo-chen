#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function gatePath() {
  return process.env.E2E_NO_MISTAKES_GATE || join(process.cwd(), ".tmp", "no-mistakes", "repos", "e2e.git");
}

function ensureRunDir() {
  const gate = gatePath();
  const dataDir = dirname(dirname(gate));
  const repoId = basename(gate, ".git");
  const runDir = join(dataDir, "worktrees", repoId, "e2e-run");
  mkdirSync(runDir, { recursive: true });
  return { gate, runDir };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

if (args[0] === "daemon" && args[1] === "start") process.exit(0);
if (args[0] === "daemon" && args[1] === "stop") process.exit(0);

if (args[0] === "status") {
  const state = load();
  if (state.active) {
    const paths = ensureRunDir();
    process.stdout.write(`daemon: running\ngate: ${paths.gate}\n`);
  } else {
    process.stdout.write("daemon: running\n");
  }
  process.exit(0);
}

if (args[0] === "axi" && args[1] === "status") {
  const state = load();
  if (state.active) {
    ensureRunDir();
    process.stdout.write(`id: ${runId()}\nbranch: ${state.branch || branch()}\nhead: ${state.head || head()}\nstatus: active\n`);
    process.exit(0);
  }
  process.stdout.write("No active run.\n");
  process.exit(1);
}

if (args[0] === "axi" && args[1] === "run") {
  if (process.env.E2E_NO_MISTAKES_ACTIVATE_ON_AXI_RUN === "1") {
    const state = load();
    state.active = true;
    state.branch = branch();
    state.head = head();
    save(state);
    ensureRunDir();
  }
  const delay = Number.parseInt(process.env.E2E_NO_MISTAKES_RUN_DELAY_MS || "250", 10);
  if (Number.isFinite(delay) && delay > 0) sleep(delay);
  process.stdout.write("outcome: checks-passed\n");
  process.exit(0);
}

process.exit(0);
