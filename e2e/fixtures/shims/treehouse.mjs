#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);

if (process.env.E2E_TREEHOUSE_LOG) {
  appendFileSync(process.env.E2E_TREEHOUSE_LOG, `${JSON.stringify({ cwd: process.cwd(), args })}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function git(argv) {
  const result = spawnSync("git", argv, { cwd: process.cwd(), encoding: "utf8" });
  if ((result.status ?? 1) !== 0) fail((result.stderr || result.stdout || "git failed").trim());
  return result;
}

function safe(value) {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-");
}

if (args[0] === "status") {
  process.stdout.write("treehouse ok\n");
  process.exit(0);
}

if (args[0] === "get" && args.includes("--lease")) {
  const holderIndex = args.indexOf("--lease-holder");
  const holder = holderIndex >= 0 ? args[holderIndex + 1] : "default";
  const root = process.env.E2E_TREEHOUSE_ROOT || join(process.cwd(), ".worktrees");
  mkdirSync(root, { recursive: true });
  const worktree = join(root, safe(holder || "default"));
  if (!existsSync(worktree)) git(["worktree", "add", "--detach", worktree, "HEAD"]);
  process.stdout.write(`${worktree}\n`);
  process.exit(0);
}

if (args[0] === "return") {
  if (process.env.E2E_TREEHOUSE_UNAVAILABLE_ON_RETURN === "1") {
    process.stderr.write("spawnSync treehouse ENOENT\n");
    process.exit(1);
  }
  const worktree = args[args.length - 1];
  if (!worktree || worktree === "return" || worktree === "--force") fail("missing worktree path");
  git(["worktree", "remove", "--force", worktree]);
  process.exit(0);
}

fail(`unsupported treehouse command: ${args.join(" ")}`);
