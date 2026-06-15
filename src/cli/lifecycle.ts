import type { ComboRecord } from "../core/state.js";

export interface LifecycleDeps {
  git: (args: string[], cwd: string) => { status: number; stdout: string; stderr: string };
  sleep: (ms: number) => Promise<void>;
}

async function requireGit(
  deps: LifecycleDeps,
  args: string[],
  cwd: string,
  description: string,
  options: { retries: number; backoffSeconds: number },
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    const result = deps.git(args, cwd);
    if (result.status === 0) return;
    if (attempt >= options.retries) {
      throw new Error(`${description} failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`);
    }
    await deps.sleep(options.backoffSeconds * 1000 * (attempt + 1));
  }
}

export async function teardownMergedCombo(input: {
  deps: LifecycleDeps;
  combo: ComboRecord;
  mergeSha: string;
  baseRefName: string;
  retries: number;
  backoffSeconds: number;
}): Promise<void> {
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
  await requireGit(
    input.deps,
    ["worktree", "remove", "--force", input.combo.worktree],
    input.combo.repoDir,
    `git worktree remove ${input.combo.worktree}`,
    retryOptions,
  );
  await requireGit(
    input.deps,
    ["branch", "-D", input.combo.branch],
    input.combo.repoDir,
    `git branch delete ${input.combo.branch}`,
    retryOptions,
  );
}
