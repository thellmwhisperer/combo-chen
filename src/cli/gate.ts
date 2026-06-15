import { readEvents } from "../core/events.js";
import type { ComboRecord } from "../core/state.js";

export interface GateDeps {
  out: (line: string) => void;
  git: (args: string[], cwd: string) => { status: number; stdout: string; stderr: string };
}

export function remoteShaForRef(stdout: string, ref: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const [sha, candidate] = line.trim().split(/\s+/, 2);
    if (candidate === ref && sha !== undefined && sha !== "") return sha;
  }
  return undefined;
}

function requireComboGit(
  deps: GateDeps,
  combo: ComboRecord,
  args: string[],
  description: string,
): { stdout: string } {
  const result = deps.git(args, combo.worktree);
  if (result.status !== 0) {
    throw new Error(
      `${description} failed for ${combo.id}: ${result.stderr.trim() || "unknown error"}`,
    );
  }
  return { stdout: result.stdout };
}

export function syncNoMistakesMirror(deps: GateDeps, combo: ComboRecord, runDir: string): boolean {
  const remote = deps.git(["remote", "get-url", "no-mistakes"], combo.worktree);
  if (remote.status !== 0) {
    // git exits 2 when the named remote is absent; that is expected for combos
    // whose repo has no no-mistakes mirror configured.
    if (remote.status !== 2) {
      deps.out(
        `mirror sync: git remote get-url no-mistakes failed for ${combo.id}: ${remote.stderr.trim() || `exit code ${remote.status}`}`,
      );
    }
    return false;
  }

  const originRef = `refs/remotes/origin/${combo.branch}`;
  const mirrorRef = `refs/heads/${combo.branch}`;
  requireComboGit(
    deps,
    combo,
    ["fetch", "origin", `+${combo.branch}:${originRef}`],
    "git fetch origin branch",
  );
  const origin = requireComboGit(
    deps,
    combo,
    ["rev-parse", originRef],
    "git rev-parse origin branch",
  ).stdout.trim();
  const mirrorSha = remoteShaForRef(
    requireComboGit(
      deps,
      combo,
      ["ls-remote", "--heads", "no-mistakes", combo.branch],
      "git ls-remote no-mistakes branch",
    ).stdout,
    mirrorRef,
  );

  if (origin === mirrorSha) return false;

  const events = readEvents(runDir);
  const lastGatekeeperStatus = [...events].reverse().find((e) => e.event === "gate_status");
  if (lastGatekeeperStatus?.state === "fix_inflight") {
    deps.out(`mirror sync: gatekeeper fix in flight, skipping push for ${combo.id}`);
    return false;
  }

  const pushArgs = ["push", "no-mistakes"];
  if (mirrorSha !== undefined) {
    pushArgs.push(`--force-with-lease=${mirrorRef}:${mirrorSha}`);
  }
  pushArgs.push(`${originRef}:${mirrorRef}`);
  requireComboGit(deps, combo, pushArgs, "git push no-mistakes mirror");
  return true;
}
