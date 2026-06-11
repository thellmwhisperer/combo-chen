/**
 * The rower adapter: turns config + combo facts into the command that rows.
 * v0 ships a gnhf default; anything else is a config template away.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

import { renderCommand } from "../infra/config.js";
import type { ComboRecord } from "../core/state.js";

export const ROWER_THREAD_ARTIFACT = "rower-thread.json";

export interface RowerThreadArtifact {
  agent: "codex";
  thread_id: string;
  source: string;
}

export function defaultPrompt(issueUrl: string): string {
  return (
    `Implement GitHub issue ${issueUrl}. ` +
    `Read it first with: gh issue view ${issueUrl}. ` +
    `Work test-first: red test, minimal code to green, refactor. ` +
    `Stay strictly within the issue's scope.`
  );
}

export interface RowerInput {
  rowerCommand: string;
  combo: ComboRecord;
  prompt?: string;
}

export function buildRowerInvocation(input: RowerInput): string {
  const prompt = input.prompt ?? defaultPrompt(input.combo.issueUrl);
  return renderCommand(input.rowerCommand, {
    issue_url: input.combo.issueUrl,
    worktree: input.combo.worktree,
    repo: input.combo.repoDir,
    branch: input.combo.branch,
    prompt,
  });
}

export function extractCodexThreadIdFromJsonl(jsonlPath: string): string | undefined {
  let latestThreadId: string | undefined;
  for (const line of readFileSync(jsonlPath, "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      event !== null &&
      typeof event === "object" &&
      "type" in event &&
      "thread_id" in event &&
      event.type === "thread.started" &&
      typeof event.thread_id === "string" &&
      event.thread_id.trim() !== ""
    ) {
      latestThreadId = event.thread_id;
    }
  }
  return latestThreadId;
}

export function persistRowerThreadArtifact(input: {
  runDir: string;
  worktree: string;
}): RowerThreadArtifact {
  const jsonlPath = latestGnhfIterationJsonl(input.worktree);
  if (jsonlPath === undefined) {
    throw new Error(
      `No gnhf JSONL found in ${input.worktree}/.gnhf/runs`,
    );
  }
  const threadId = extractCodexThreadIdFromJsonl(jsonlPath);
  if (threadId === undefined) {
    throw new Error(`No thread.started event found in ${jsonlPath}`);
  }

  const artifact: RowerThreadArtifact = {
    agent: "codex",
    thread_id: threadId,
    source: relative(input.worktree, jsonlPath).split(sep).join("/"),
  };
  mkdirSync(input.runDir, { recursive: true });
  writeFileSync(join(input.runDir, ROWER_THREAD_ARTIFACT), `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}

function latestGnhfIterationJsonl(worktree: string): string | undefined {
  const runsDir = join(worktree, ".gnhf", "runs");
  if (!existsSync(runsDir)) return undefined;

  let latest: { path: string; mtimeMs: number } | undefined;
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(runsDir, entry.name, "iteration-1.jsonl");
    if (!existsSync(candidate)) continue;
    const mtimeMs = statSync(candidate).mtimeMs;
    if (latest === undefined || mtimeMs > latest.mtimeMs) {
      latest = { path: candidate, mtimeMs };
    }
  }
  return latest?.path;
}
