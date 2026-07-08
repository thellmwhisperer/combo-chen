/**
 * @overview Merged-combo teardown helpers. ~145 lines, 3 exports, idempotent Treehouse cleanup.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at teardownMergedCombo   <- verifies merge reachability before cleanup.
 *   2. Then requireRetriedCommand     <- retry wrapper for git and Treehouse.
 *
 *   MAIN FLOW
 *   ---------
 *   teardownMergedCombo -> fetch base -> verify merge sha -> treehouse return -> delete/already-gone branch
 *
 *   PUBLIC API
 *   ----------
 *   LifecycleDeps          Git/Treehouse/sleep deps for teardown.
 *   TeardownMergedComboResult  Resource outcomes from teardown.
 *   teardownMergedCombo    Clean up local combo state after a merged PR.
 *
 *   INTERNALS
 *   ---------
 *   requireGit, requireTreehouse, requireRetriedCommand, commandFailureText, isAlreadyRemovedWorktree, isAlreadyDeletedBranch
 *
 * @exports LifecycleDeps, TeardownMergedComboResult, teardownMergedCombo
 * @deps ../core/state
 */
import type { ComboRecord } from "../core/state.js";

// -- 1/2 HELPER · LifecycleDeps and retry wrappers --
export interface LifecycleDeps {
  git: (args: string[], cwd: string) => { status: number; stdout: string; stderr: string };
  treehouse: (args: string[], cwd: string) => { status: number; stdout: string; stderr: string };
  sleep: (ms: number) => Promise<void>;
}

interface GitRetryOptions {
  retries: number;
  backoffSeconds: number;
  acceptsFailure?: (result: { stdout: string; stderr: string }) => boolean;
}

type GitOutcome = "ok" | "accepted_failure";

async function requireGit(
  deps: LifecycleDeps,
  args: string[],
  cwd: string,
  description: string,
  options: GitRetryOptions,
): Promise<GitOutcome> {
  return requireRetriedCommand(deps, deps.git, args, cwd, description, options);
}

async function requireTreehouse(
  deps: LifecycleDeps,
  args: string[],
  cwd: string,
  description: string,
  options: GitRetryOptions,
): Promise<GitOutcome> {
  return requireRetriedCommand(deps, deps.treehouse, args, cwd, description, options);
}

async function requireRetriedCommand(
  deps: LifecycleDeps,
  run: (args: string[], cwd: string) => { status: number; stdout: string; stderr: string },
  args: string[],
  cwd: string,
  description: string,
  options: GitRetryOptions,
): Promise<GitOutcome> {
  for (let attempt = 0; ; attempt += 1) {
    const result = run(args, cwd);
    if (result.status === 0) return "ok";
    if (options.acceptsFailure?.(result) === true) return "accepted_failure";
    if (attempt >= options.retries) {
      throw new Error(`${description} failed: ${commandFailureText(result, args, cwd)}`);
    }
    await deps.sleep(options.backoffSeconds * 1000 * (attempt + 1));
  }
}

function commandFailureText(
  result: { status: number; stdout: string; stderr: string },
  args: string[],
  cwd: string,
): string {
  const detail = result.stderr.trim() || result.stdout.trim() || "no output";
  return `${detail} (exit ${result.status}; cwd ${cwd}; command ${args.join(" ")})`;
}

function normalizedGitFailure(result: { stdout: string; stderr: string }): string {
  return `${result.stderr}\n${result.stdout}`.toLowerCase();
}

function isAlreadyRemovedWorktree(result: { stdout: string; stderr: string }): boolean {
  const text = normalizedGitFailure(result);
  return (
    text.includes("not a working tree") ||
    text.includes("no such file or directory") ||
    text.includes("not managed by treehouse") ||
    text.includes("is being destroyed")
  );
}

function isTreehouseUnavailable(result: { stdout: string; stderr: string }): boolean {
  const text = normalizedGitFailure(result);
  return (
    (text.includes("treehouse") && text.includes("command not found")) ||
    text.includes("spawnsync treehouse enoent") ||
    text.includes("spawn treehouse enoent")
  );
}

function isAlreadyDeletedBranch(result: { stdout: string; stderr: string }): boolean {
  const text = normalizedGitFailure(result);
  return text.includes("branch") && text.includes("not found");
}
// -/ 1/2

// -- 2/2 CORE · teardownMergedCombo <- START HERE --
export interface TeardownMergedComboResult {
  worktree: "removed" | "already_removed";
  branch: "deleted" | "already_deleted";
}

export async function teardownMergedCombo(input: {
  deps: LifecycleDeps;
  combo: ComboRecord;
  mergeSha: string;
  baseRefName: string;
  retries: number;
  backoffSeconds: number;
}): Promise<TeardownMergedComboResult> {
  const retryOptions = { retries: input.retries, backoffSeconds: input.backoffSeconds };
  const baseRef = `origin/${input.baseRefName}`;
  await requireGit(
    input.deps,
    ["fetch", "origin", input.baseRefName],
    input.combo.repoDir,
    "git fetch base branch",
    retryOptions,
  );
  await requireGit(
    input.deps,
    ["merge-base", "--is-ancestor", input.mergeSha, baseRef],
    input.combo.repoDir,
    `merge verification for ${input.mergeSha} in ${baseRef}`,
    retryOptions,
  );
  let treehouseUnavailable = false;
  const treehouseReturn = await requireTreehouse(
    input.deps,
    ["return", "--force", input.combo.worktree],
    input.combo.repoDir,
    `treehouse return ${input.combo.worktree}`,
    {
      ...retryOptions,
      acceptsFailure: (result) => {
        if (isAlreadyRemovedWorktree(result)) return true;
        if (isTreehouseUnavailable(result)) {
          treehouseUnavailable = true;
          return true;
        }
        return false;
      },
    },
  );
  const worktree = treehouseUnavailable
    ? await requireGit(
        input.deps,
        ["worktree", "remove", "--force", input.combo.worktree],
        input.combo.repoDir,
        `git worktree remove fallback ${input.combo.worktree}`,
        { ...retryOptions, acceptsFailure: isAlreadyRemovedWorktree },
      )
    : treehouseReturn;
  const branch = await requireGit(
    input.deps,
    ["branch", "-D", input.combo.branch],
    input.combo.repoDir,
    `git branch delete ${input.combo.branch}`,
    { ...retryOptions, acceptsFailure: isAlreadyDeletedBranch },
  );
  return {
    worktree: worktree === "accepted_failure" ? "already_removed" : "removed",
    branch: branch === "accepted_failure" ? "already_deleted" : "deleted",
  };
}
// -/ 2/2
