/**
 * @overview Reconcile local combo journals against GitHub PR truth. ~300 lines,
 *   2 exports, terminal PR repair for merged/closed combos.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at reconcileCombos       <- walks persisted runs and reports changes.
 *   2. Then reconcileCombo            <- single-run GitHub comparison + repair.
 *   3. Bottom helpers                 <- PR view fetch/parse guardrails.
 *
 *   MAIN FLOW
 *   ---------
 *   list/select combo -> runtime ledger PR URL -> gh pr view -> append terminal events -> cleanup
 *
 *   PUBLIC API
 *   ----------
 *   ReconcileDeps      Dependencies used by the reconcile command.
 *   reconcileCombos    Reconcile every persisted combo under a home dir.
 *
 *   INTERNALS
 *   ---------
 *   reconcileCombo, hasPrClosedNeedsHuman, readPrViewForReconcile, report
 *
 * @exports ReconcileDeps, reconcileCombos
 * @deps ../core/{events,runtime-ledger,state}, ../infra/{config-snapshot,tmux}, ./github, ./lifecycle, ./reviewer, ./sessions
 */
import { appendEvent, readEvents } from "../core/events.js";
import { listCombos, readCombo, runDirFor, type ComboRecord } from "../core/state.js";
import { loadRuntimeConfig } from "../infra/config-snapshot.js";
import type { TmuxResult } from "../infra/tmux.js";
import { parsePrView, type GhResult, type PrView } from "./github.js";
import { teardownMergedCombo } from "./lifecycle.js";
import { hasMergedEvent, terminalReviewerEvent } from "./reviewer.js";
import { readRuntimeLedger } from "../core/runtime-ledger.js";
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

const PR_VIEW_FIELDS = "headRefOid,state,mergedAt,mergedBy,baseRefName,mergeCommit";
// -/ 1/3

// -- 2/3 CORE · reconcileCombos <- START HERE --
export async function reconcileCombos(input: {
  deps: ReconcileDeps;
  home: string;
  apply: boolean;
  quiet?: boolean;
  comboId?: string;
  mergedTeardown?: boolean;
}): Promise<void> {
  let changed = false;
  let reported = false;
  const combos =
    input.comboId === undefined
      ? listCombos(input.home)
      : [readCombo(runDirFor(input.home, input.comboId))];
  for (const combo of combos) {
    const outcome = await reconcileCombo({
      deps: input.deps,
      apply: input.apply,
      quiet: input.quiet === true,
      mergedTeardown: input.mergedTeardown !== false,
      combo,
      runDir: runDirFor(input.home, combo.id),
    });
    changed = changed || outcome.changed;
    reported = reported || outcome.reported;
  }

  if (!changed && !reported && input.quiet !== true) {
    input.deps.out("reconcile: no changes");
  }
}
// -/ 2/3

// -- 3/3 HELPER · Single combo reconciliation --
async function reconcileCombo(input: {
  deps: ReconcileDeps;
  apply: boolean;
  quiet: boolean;
  mergedTeardown: boolean;
  combo: ComboRecord;
  runDir: string;
}): Promise<ReconcileOutcome> {
  const { deps, apply, quiet, mergedTeardown, combo, runDir } = input;
  const events = readEvents(runDir);
  if (terminalReviewerEvent(events)) {
    return { changed: false, reported: false };
  }

  const prUrl = readRuntimeLedger(runDir).prUrl;
  if (!prUrl) {
    return { changed: false, reported: false };
  }

  const prView = readPrViewForReconcile(deps, quiet, combo, prUrl);
  if (!prView) {
    return { changed: false, reported: !quiet };
  }

  if (prView.state === "CLOSED") {
    if (!apply) {
      return report(
        deps,
        quiet,
        `reconcile: ${combo.id} would append needs_human pr_closed and close combo`,
      );
    }

    let changed = false;
    if (!hasPrClosedNeedsHuman(events)) {
      appendEvent(runDir, "needs_human", { reason: "pr_closed", source: "reconcile" });
      changed = true;
    }
    appendEvent(runDir, "combo_closed", { source: "reconcile" });
    changed = true;
    try {
      killComboSession(deps, combo);
    } catch (error) {
      report(
        deps,
        false,
        `reconcile: ${combo.id} session kill failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const reported = report(deps, quiet, `reconcile: ${combo.id} closed PR; combo closed`).reported;
    return { changed, reported };
  }

  if (prView.state !== "MERGED") {
    return { changed: false, reported: false };
  }

  const by = prView.mergedBy ?? "unknown";
  const mergeSha = prView.mergeSha;
  if (!mergeSha) {
    return report(deps, false, `reconcile: ${combo.id} skipped: merged PR did not report mergeCommit.oid`);
  }
  const baseRefName = prView.baseRefName;
  if (!baseRefName) {
    return report(deps, false, `reconcile: ${combo.id} skipped: merged PR did not report baseRefName`);
  }

  const hasMerged = hasMergedEvent(events, [mergeSha, prView.headSha]);
  const parked = events.at(-1)?.event === "parked";
  if (!mergedTeardown) {
    if (!apply) {
      return report(
        deps,
        quiet,
        hasMerged
          ? `reconcile: ${combo.id} would report closure pending for ${mergeSha}`
          : `reconcile: ${combo.id} would append merged ${mergeSha} by ${by} and report closure pending`,
      );
    }

    let changed = false;
    if (!hasMerged) {
      appendEvent(runDir, "merged", {
        sha: mergeSha,
        by,
        ...(prView.mergedAt !== undefined ? { mergedAt: prView.mergedAt } : {}),
        source: "reconcile",
      });
      changed = true;
    }
    const reported = report(
      deps,
      quiet,
      `reconcile: ${combo.id} merged ${mergeSha} by ${by}; closure pending: combo-chen closure -n ${combo.id}`,
    ).reported;
    return { changed, reported };
  }

  if (!apply) {
    return report(
      deps,
      quiet,
      parked
        ? (hasMerged
            ? `reconcile: ${combo.id} would skip pending teardown for ${mergeSha} (parked)`
            : `reconcile: ${combo.id} would append merged ${mergeSha} by ${by} and skip teardown (parked)`)
        : (hasMerged
            ? `reconcile: ${combo.id} would run pending teardown for ${mergeSha}`
            : `reconcile: ${combo.id} would append merged ${mergeSha} by ${by} and tear down`),
    );
  }

  let changed = false;
  if (!hasMerged) {
    appendEvent(runDir, "merged", {
      sha: mergeSha,
      by,
      ...(prView.mergedAt !== undefined ? { mergedAt: prView.mergedAt } : {}),
      source: "reconcile",
    });
    changed = true;
  }

  if (!parked) {
    try {
      const config = loadRuntimeConfig(runDir, { repoDir: combo.repoDir, env: deps.env });
      await teardownMergedCombo({
        deps,
        combo,
        mergeSha,
        baseRefName,
        retries: config.limits.teardownGitRetries,
        backoffSeconds: config.limits.teardownGitBackoffSeconds,
      });
    } catch (error) {
      report(
        deps,
        false,
        `reconcile: ${combo.id} teardown pending: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return { changed, reported: true };
    }
  }

  appendEvent(runDir, "combo_closed", { source: "reconcile" });
  try {
    killComboSession(deps, combo);
  } catch (error) {
    report(
      deps,
      false,
      `reconcile: ${combo.id} session kill failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const reported = report(
    deps,
    quiet,
    parked
      ? `reconcile: ${combo.id} merged ${mergeSha} by ${by}; teardown skipped (parked)`
      : `reconcile: ${combo.id} merged ${mergeSha} by ${by}; teardown complete`,
  ).reported;
  return { changed: true, reported };
}

function hasPrClosedNeedsHuman(events: Array<{ event: string; reason?: unknown }>): boolean {
  return events.some((event) => event.event === "needs_human" && event.reason === "pr_closed");
}

function report(
  deps: Pick<ReconcileDeps, "out">,
  quiet: boolean,
  line: string,
): ReconcileOutcome {
  if (!quiet) deps.out(line);
  return { changed: false, reported: !quiet };
}

function readPrViewForReconcile(
  deps: ReconcileDeps,
  quiet: boolean,
  combo: ComboRecord,
  prUrl: string,
): PrView | undefined {
  const result = deps.gh(["pr", "view", prUrl, "--json", PR_VIEW_FIELDS]);
  if (result.status !== 0) {
    report(
      deps,
      quiet,
      `reconcile: ${combo.id} skipped: gh pr view failed (status ${result.status}): ` +
        `${result.stderr.trim() || "unknown error"}`,
    );
    return undefined;
  }

  try {
    return parsePrView(result.stdout);
  } catch (error) {
    report(
      deps,
      quiet,
      `reconcile: ${combo.id} skipped: failed to parse PR data: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}
// -/ 3/3
