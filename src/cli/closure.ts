/**
 * @overview Deterministic post-merge closure for one combo. ~190 lines,
 *   GitHub-confirmed merged teardown and terminal journaling.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at closeMergedCombo       <- public command helper.
 *   2. Then readPrViewForClosure       <- GitHub PR fact guardrails.
 *
 *   MAIN FLOW
 *   ---------
 *   combo id -> runtime ledger PR URL -> gh pr view MERGED -> merged event -> no-mistakes idle -> teardown -> tmux kill -> combo_closed
 *
 *   PUBLIC API
 *   ----------
 *   ClosureDeps       Dependencies used by the closure command.
 *   closeMergedCombo  Converge one merged combo's local resources.
 *
 *   INTERNALS
 *   ---------
 *   readPrViewForClosure, activeNoMistakesConflict, closureCompletion, report
 *
 * @exports ClosureDeps, closeMergedCombo
 * @deps ../core/{events,runtime-ledger,state}, ../infra/config-snapshot, ./github, ./lifecycle, ./reviewer, ./sessions, ./status
 */
import { appendEvent, readEvents } from "../core/events.js";
import { readRuntimeLedger } from "../core/runtime-ledger.js";
import { readCombo, runDirFor, type ComboRecord } from "../core/state.js";
import { loadRuntimeConfig } from "../infra/config-snapshot.js";
import type { TmuxResult } from "../infra/tmux.js";
import { parsePrView, type GhResult, type PrView } from "./github.js";
import { teardownMergedCombo, type TeardownMergedComboResult } from "./lifecycle.js";
import { hasMergedEvent, terminalReviewerEvent } from "./reviewer.js";
import { killComboSession, type KillComboSessionResult } from "./sessions.js";
import { deepNoMistakesStatus, type CommandResult } from "./status.js";

// -- 1/3 HELPER · Dependency contract --
export interface ClosureDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  tmux: (args: string[]) => TmuxResult;
  git: (args: string[], cwd: string) => { status: number; stdout: string; stderr: string };
  gh: (args: string[]) => GhResult;
  noMistakes: (args: string[], cwd: string) => CommandResult;
  sleep: (ms: number) => Promise<void>;
}

const PR_VIEW_FIELDS = "headRefOid,state,mergedAt,mergedBy,baseRefName,mergeCommit";
// -/ 1/3

// -- 2/3 CORE · closeMergedCombo <- START HERE --
export async function closeMergedCombo(input: {
  deps: ClosureDeps;
  home: string;
  comboId: string;
}): Promise<void> {
  const runDir = runDirFor(input.home, input.comboId);
  const combo = readCombo(runDir);
  const events = readEvents(runDir);

  if (terminalReviewerEvent(events)) {
    input.deps.out(`closure: ${combo.id} already closed`);
    return;
  }

  const prUrl = readRuntimeLedger(runDir).prUrl;
  if (!prUrl) {
    input.deps.out(`closure: ${combo.id} refused: no pr_opened event`);
    return;
  }

  const prView = readPrViewForClosure(input.deps, combo, prUrl);
  if (!prView) return;

  if (prView.state !== "MERGED") {
    input.deps.out(`closure: ${combo.id} refused: GitHub PR state is ${prView.state} (expected MERGED)`);
    return;
  }

  const mergeSha = prView.mergeSha;
  if (!mergeSha) {
    input.deps.out(`closure: ${combo.id} refused: merged PR did not report mergeCommit.oid`);
    return;
  }
  const baseRefName = prView.baseRefName;
  if (!baseRefName) {
    input.deps.out(`closure: ${combo.id} refused: merged PR did not report baseRefName`);
    return;
  }

  const by = prView.mergedBy ?? "unknown";
  if (!hasMergedEvent(events, [mergeSha, prView.headSha])) {
    appendEvent(runDir, "merged", {
      sha: mergeSha,
      by,
      ...(prView.mergedAt !== undefined ? { mergedAt: prView.mergedAt } : {}),
      source: "closure",
    });
  }

  const noMistakesConflict = activeNoMistakesConflict(input.deps, combo);
  if (noMistakesConflict !== undefined) {
    input.deps.out(
      `closure: ${combo.id} refused: no-mistakes active run remains for ${combo.branch} (${noMistakesConflict})`,
    );
    return;
  }

  let teardown: TeardownMergedComboResult;
  try {
    const config = loadRuntimeConfig(runDir, { repoDir: combo.repoDir, env: input.deps.env });
    teardown = await teardownMergedCombo({
      deps: input.deps,
      combo,
      mergeSha,
      baseRefName,
      retries: config.limits.teardownGitRetries,
      backoffSeconds: config.limits.teardownGitBackoffSeconds,
    });
  } catch (error) {
    input.deps.out(
      `closure: ${combo.id} teardown pending: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  let session: KillComboSessionResult;
  try {
    session = killComboSession(input.deps, combo);
  } catch (error) {
    input.deps.out(
      `closure: ${combo.id} session kill failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    session = "already_missing";
  }

  appendEvent(runDir, "combo_closed", { source: "closure" });
  input.deps.out(
    `closure: ${combo.id} closed merged PR ${mergeSha} by ${by}; ` +
      `${closureCompletion(teardown, session)}`,
  );
}
// -/ 2/3

// -- 3/3 HELPER · GitHub PR facts --
function readPrViewForClosure(deps: ClosureDeps, combo: ComboRecord, prUrl: string): PrView | undefined {
  const result = deps.gh(["pr", "view", prUrl, "--json", PR_VIEW_FIELDS]);
  if (result.status !== 0) {
    report(
      deps,
      `closure: ${combo.id} refused: gh pr view failed (status ${result.status}): ` +
        `${result.stderr.trim() || "unknown error"}`,
    );
    return undefined;
  }

  try {
    return parsePrView(result.stdout);
  } catch (error) {
    report(
      deps,
      `closure: ${combo.id} refused: failed to parse PR data: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function activeNoMistakesConflict(deps: ClosureDeps, combo: ComboRecord): string | undefined {
  try {
    const status = deepNoMistakesStatus(combo, deps.noMistakes);
    if (status === undefined || status.startsWith("no-mistakes unavailable:")) return undefined;
    return status;
  } catch {
    return undefined;
  }
}

function closureCompletion(
  teardown: TeardownMergedComboResult,
  session: KillComboSessionResult,
): string {
  const alreadyConverged = [
    teardown.worktree === "already_removed" ? "worktree already removed" : undefined,
    teardown.branch === "already_deleted" ? "branch already deleted" : undefined,
    session === "already_missing" ? "tmux session already gone" : undefined,
  ].filter((entry): entry is string => entry !== undefined);

  if (alreadyConverged.length === 0) return "teardown complete";
  return `already converged: ${alreadyConverged.join(", ")}`;
}

function report(deps: Pick<ClosureDeps, "out">, line: string): void {
  deps.out(line);
}
// -/ 3/3
