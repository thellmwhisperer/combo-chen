/**
 * @overview Reconcile local combo journals against GitHub PR truth. ~145 lines,
 *   2 exports, frozen merged journal repair.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at reconcileCombos       <- walks persisted runs and reports changes.
 *   2. Then reconcileCombo            <- single-run GitHub comparison + repair.
 *   3. Bottom helpers                 <- PR view fetch/parse guardrails.
 *
 *   MAIN FLOW
 *   ---------
 *   listCombos -> latest pr_opened -> gh pr view -> append reconcile events -> teardown
 *
 *   PUBLIC API
 *   ----------
 *   ReconcileDeps      Dependencies used by the reconcile command.
 *   reconcileCombos    Reconcile every persisted combo under a home dir.
 *
 *   INTERNALS
 *   ---------
 *   reconcileCombo, readPrViewForReconcile
 *
 * @exports ReconcileDeps, reconcileCombos
 * @deps ../core/{events,state}, ../infra/{config,tmux}, ./github, ./lifecycle, ./reviewer, ./sessions
 */
import { appendEvent, readEvents } from "../core/events.js";
import { listCombos, runDirFor, type ComboRecord } from "../core/state.js";
import { loadConfig } from "../infra/config.js";
import type { TmuxResult } from "../infra/tmux.js";
import { parsePrView, type GhResult, type PrView } from "./github.js";
import { teardownMergedCombo } from "./lifecycle.js";
import { hasMergedEvent, latestOpenedPrUrl, terminalReviewerEvent } from "./reviewer.js";
import { killComboSession } from "./sessions.js";

// -- 1/3 HELPER · Dependency contracts --
export interface ReconcileDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  tmux: (args: string[]) => TmuxResult;
  git: (args: string[], cwd: string) => { status: number; stdout: string; stderr: string };
  gh: (args: string[]) => GhResult;
  sleep: (ms: number) => Promise<void>;
}

interface ReconcileOutcome {
  changed: boolean;
  reported: boolean;
}

const PR_VIEW_FIELDS = "headRefOid,state,mergedBy,baseRefName,mergeCommit";
// -/ 1/3

// -- 2/3 CORE · reconcileCombos <- START HERE --
export async function reconcileCombos(input: {
  deps: ReconcileDeps;
  home: string;
  apply: boolean;
}): Promise<void> {
  let changed = false;
  let reported = false;
  for (const combo of listCombos(input.home)) {
    const outcome = await reconcileCombo({
      deps: input.deps,
      apply: input.apply,
      combo,
      runDir: runDirFor(input.home, combo.id),
    });
    changed = changed || outcome.changed;
    reported = reported || outcome.reported;
  }

  if (!changed && !reported) {
    input.deps.out("reconcile: no changes");
  }
}
// -/ 2/3

// -- 3/3 HELPER · Single combo reconciliation --
async function reconcileCombo(input: {
  deps: ReconcileDeps;
  apply: boolean;
  combo: ComboRecord;
  runDir: string;
}): Promise<ReconcileOutcome> {
  const { deps, apply, combo, runDir } = input;
  const events = readEvents(runDir);
  if (terminalReviewerEvent(events)) {
    return { changed: false, reported: false };
  }

  const prUrl = latestOpenedPrUrl(runDir);
  if (!prUrl) {
    return { changed: false, reported: false };
  }

  const prView = readPrViewForReconcile(deps, combo, prUrl);
  if (!prView) {
    return { changed: false, reported: true };
  }
  if (prView.state !== "MERGED") {
    return { changed: false, reported: false };
  }

  const by = prView.mergedBy ?? "unknown";
  const mergeSha = prView.mergeSha;
  if (!mergeSha) {
    deps.out(`reconcile: ${combo.id} skipped: merged PR did not report mergeCommit.oid`);
    return { changed: false, reported: true };
  }
  const baseRefName = prView.baseRefName;
  if (!baseRefName) {
    deps.out(`reconcile: ${combo.id} skipped: merged PR did not report baseRefName`);
    return { changed: false, reported: true };
  }

  const hasMerged = hasMergedEvent(events, [mergeSha, prView.headSha]);
  if (!apply) {
    deps.out(
      hasMerged
        ? `reconcile: ${combo.id} would run pending teardown for ${mergeSha}`
        : `reconcile: ${combo.id} would append merged ${mergeSha} by ${by} and tear down`,
    );
    return { changed: false, reported: true };
  }

  let changed = false;
  if (!hasMerged) {
    appendEvent(runDir, "merged", { sha: mergeSha, by, source: "reconcile" });
    changed = true;
  }

  try {
    const config = loadConfig({ repoDir: combo.repoDir, env: deps.env });
    await teardownMergedCombo({
      deps,
      combo,
      mergeSha,
      baseRefName,
      retries: config.limits.teardownGitRetries,
      backoffSeconds: config.limits.teardownGitBackoffSeconds,
    });
  } catch (error) {
    deps.out(
      `reconcile: ${combo.id} teardown pending: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return { changed, reported: true };
  }

  appendEvent(runDir, "combo_closed", { source: "reconcile" });
  try {
    killComboSession(deps, combo);
  } catch (error) {
    deps.out(
      `reconcile: ${combo.id} session kill failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  deps.out(`reconcile: ${combo.id} merged ${mergeSha} by ${by}; teardown complete`);
  return { changed: true, reported: true };
}

function readPrViewForReconcile(
  deps: ReconcileDeps,
  combo: ComboRecord,
  prUrl: string,
): PrView | undefined {
  const result = deps.gh(["pr", "view", prUrl, "--json", PR_VIEW_FIELDS]);
  if (result.status !== 0) {
    deps.out(
      `reconcile: ${combo.id} skipped: gh pr view failed (status ${result.status}): ` +
        `${result.stderr.trim() || "unknown error"}`,
    );
    return undefined;
  }

  try {
    return parsePrView(result.stdout);
  } catch (error) {
    deps.out(
      `reconcile: ${combo.id} skipped: failed to parse PR data: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}
// -/ 3/3
