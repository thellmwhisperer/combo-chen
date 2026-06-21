/**
 * @overview Deterministic post-merge closure for one combo. ~155 lines,
 *   GitHub-confirmed merged teardown and terminal journaling.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at closeMergedCombo       <- public command helper.
 *   2. Then readPrViewForClosure       <- GitHub PR fact guardrails.
 *
 *   MAIN FLOW
 *   ---------
 *   combo id -> latest pr_opened -> gh pr view MERGED -> merged event -> teardown -> tmux kill -> combo_closed
 *
 *   PUBLIC API
 *   ----------
 *   ClosureDeps       Dependencies used by the closure command.
 *   closeMergedCombo  Converge one merged combo's local resources.
 *
 *   INTERNALS
 *   ---------
 *   readPrViewForClosure, report
 *
 * @exports ClosureDeps, closeMergedCombo
 * @deps ../core/{events,state}, ../infra/config-snapshot, ./github, ./lifecycle, ./reviewer, ./sessions
 */
import { appendEvent, readEvents } from "../core/events.js";
import { readCombo, runDirFor, type ComboRecord } from "../core/state.js";
import { loadRuntimeConfig } from "../infra/config-snapshot.js";
import type { TmuxResult } from "../infra/tmux.js";
import { parsePrView, type GhResult, type PrView } from "./github.js";
import { teardownMergedCombo } from "./lifecycle.js";
import { hasMergedEvent, latestOpenedPrUrl, terminalReviewerEvent } from "./reviewer.js";
import { killComboSession } from "./sessions.js";

// -- 1/3 HELPER · Dependency contract --
export interface ClosureDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  tmux: (args: string[]) => TmuxResult;
  git: (args: string[], cwd: string) => { status: number; stdout: string; stderr: string };
  gh: (args: string[]) => GhResult;
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

  const prUrl = latestOpenedPrUrl(runDir);
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

  const config = loadRuntimeConfig(runDir, { repoDir: combo.repoDir, env: input.deps.env });
  await teardownMergedCombo({
    deps: input.deps,
    combo,
    mergeSha,
    baseRefName,
    retries: config.limits.teardownGitRetries,
    backoffSeconds: config.limits.teardownGitBackoffSeconds,
  });
  killComboSession(input.deps, combo);
  appendEvent(runDir, "combo_closed", { source: "closure" });
  input.deps.out(`closure: ${combo.id} closed merged PR ${mergeSha} by ${by}; teardown complete`);
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

function report(deps: Pick<ClosureDeps, "out">, line: string): void {
  deps.out(line);
}
// -/ 3/3
