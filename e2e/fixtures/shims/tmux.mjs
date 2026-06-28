#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const statePath = process.env.E2E_TMUX_STATE;

if (!statePath) {
  process.stderr.write("E2E_TMUX_STATE missing\n");
  process.exit(1);
}

if (process.env.E2E_TMUX_LOG) {
  appendFileSync(process.env.E2E_TMUX_LOG, `${JSON.stringify({ args })}\n`);
}

function load() {
  return existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { sessions: {}, buffers: {} };
}

function save(state) {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function valueAfter(flag) {
  const i = args.indexOf(flag);
  return i < 0 ? "" : (args[i + 1] || "");
}

function splitTarget(target) {
  const i = target.indexOf(":");
  return i < 0 ? { session: target, window: "" } : { session: target.slice(0, i), window: target.slice(i + 1) };
}

function missing(session) {
  process.stderr.write(`can't find session: ${session}\n`);
  process.exit(1);
}

const cmd = args[0];
const state = load();

if (cmd === "has-session") {
  const session = valueAfter("-t");
  process.exit(state.sessions[session] ? 0 : 1);
}

function windowWithCommand(command = "") {
  return { panes: 1, visibleText: command };
}

function commandIsJournalFollower(command) {
  return /\bevents\s+--follow\b/.test(command);
}

function commandIsIdleRoleWindow(command) {
  return /\[combo-chen\] \S+ window idle; waiting for combo-chen to prompt it\./.test(command) &&
    /\bsleep 3600\b/.test(command);
}

function runCommandSynchronously(command) {
  const result = spawnSync("sh", ["-c", command], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

function requireWindow(target) {
  const session = state.sessions[target.session];
  if (!session) missing(target.session);
  const window = session.windows[target.window];
  if (!window) {
    process.stderr.write(`can't find window: ${target.window}\n`);
    process.exit(1);
  }
  return window;
}

if (cmd === "new-session") {
  const session = valueAfter("-s");
  const name = valueAfter("-n") || "0";
  const command = args[args.length - 1] || ":";
  state.sessions[session] = { windows: { [name]: windowWithCommand(command) } };
  save(state);
  if (process.env.E2E_TMUX_RUN_NEW_SESSION === "1" && !commandIsJournalFollower(command)) {
    runCommandSynchronously(command);
  }
  process.exit(0);
}

if (cmd === "new-window") {
  const session = valueAfter("-t");
  const name = valueAfter("-n") || "window";
  if (!state.sessions[session]) missing(session);
  const command = args[args.length - 1] || ":";
  state.sessions[session].windows[name] = windowWithCommand(command);
  save(state);
  if (name === "coder" && process.env.E2E_TMUX_RUN_NEW_SESSION === "1" && !commandIsIdleRoleWindow(command)) {
    runCommandSynchronously(command);
  }
  if (name === "gatekeeper" && process.env.E2E_TMUX_RUN_GATEKEEPER_WINDOW === "1") {
    runCommandSynchronously(command);
  }
  process.exit(0);
}

if (cmd === "list-windows") {
  const session = valueAfter("-t");
  if (!state.sessions[session]) missing(session);
  process.stdout.write(`${Object.keys(state.sessions[session].windows).join("\n")}\n`);
  process.exit(0);
}

if (cmd === "list-panes") {
  const target = splitTarget(valueAfter("-t"));
  const window = requireWindow(target);
  for (let i = 0; i < window.panes; i += 1) process.stdout.write(`${i}\n`);
  process.exit(0);
}

if (cmd === "split-window") {
  const target = splitTarget(valueAfter("-t"));
  const window = requireWindow(target);
  window.panes += 1;
  save(state);
  process.exit(0);
}

if (cmd === "kill-session") {
  const session = valueAfter("-t");
  if (!state.sessions[session]) missing(session);
  delete state.sessions[session];
  save(state);
  process.exit(0);
}

if (cmd === "kill-window") {
  const target = splitTarget(valueAfter("-t"));
  const session = state.sessions[target.session];
  if (!session) missing(target.session);
  delete session.windows[target.window];
  save(state);
  process.exit(0);
}

if (cmd === "capture-pane") {
  const target = splitTarget(valueAfter("-t"));
  const envName = `E2E_TMUX_CAPTURE_${target.window.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const output = process.env[envName] ?? process.env.E2E_TMUX_CAPTURE_PANE;
  if (output) {
    process.stdout.write(output);
    process.exit(0);
  }
  const window = requireWindow(target);
  if (window.visibleText) process.stdout.write(window.visibleText);
  process.exit(0);
}
if (cmd === "rename-window") process.exit(0);
if (cmd === "set-buffer") {
  const bufferName = valueAfter("-b") || "buffer";
  state.buffers = state.buffers || {};
  state.buffers[bufferName] = args[args.length - 1] || "";
  save(state);
  process.exit(0);
}
if (cmd === "paste-buffer") {
  const target = splitTarget(valueAfter("-t"));
  const window = requireWindow(target);
  const bufferName = valueAfter("-b");
  window.pendingCommand = state.buffers?.[bufferName] || "";
  window.visibleText = `${window.visibleText || ""}${window.pendingCommand}`;
  if (args.includes("-d") && state.buffers) delete state.buffers[bufferName];
  save(state);
  process.exit(0);
}
if (cmd === "send-keys") {
  const target = splitTarget(valueAfter("-t"));
  const window = requireWindow(target);
  if (args.includes("C-c")) {
    window.visibleText = `${window.visibleText || ""}\n^C\n`;
    save(state);
  }
  const shouldRun =
    target.window === "gatekeeper" &&
    process.env.E2E_TMUX_RUN_GATEKEEPER_WINDOW === "1" &&
    args.includes("C-m") &&
    typeof window.pendingCommand === "string" &&
    window.pendingCommand.length > 0;
  if (!shouldRun) process.exit(0);

  const command = window.pendingCommand;
  delete window.pendingCommand;
  window.visibleText = `${command}\n`;
  save(state);
  const result = spawnSync("sh", ["-c", command], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const nextState = load();
  const nextWindow = nextState.sessions?.[target.session]?.windows?.[target.window];
  if (nextWindow) {
    nextWindow.visibleText = `${command}\n${result.stdout || ""}${result.stderr || ""}`;
    save(nextState);
  }
  process.exit(result.status ?? 1);
}

process.stderr.write(`unsupported tmux command: ${args.join(" ")}\n`);
process.exit(1);
