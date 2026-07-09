/**
 * @overview Application handlers for persisted combo lifecycle and runner-facing events.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at emitComboEvent       <- journal append plus required side effects.
 *   2. Then resumePersistedCombo     <- recovery entry point.
 *   3. Read attach/stop/events       <- operator lifecycle endpoints.
 *
 *   MAIN FLOW
 *   ---------
 *   CLI options -> persisted combo -> lifecycle service -> journal/tmux/output
 *
 *   PUBLIC API
 *   ----------
 *   attachCombo, closeCombo, reconcileComboState, resumePersistedCombo, parkPersistedCombo,
 *   stopCombo, printComboEvents, emitComboEvent
 *
 *   INTERNALS
 *   ---------
 *   None.
 *
 * @exports attachCombo, closeCombo, reconcileComboState, resumePersistedCombo, parkPersistedCombo, stopCombo, printComboEvents, emitComboEvent
 * @deps ../../core/{events,runtime-ledger,state}, ../../infra/{config-snapshot,tmux}, ../../roles/coder, ../../cli/{args,closure,gate,park,reconcile,resume,sessions,watchers}
 */
import {
  appendEvent,
  canonicalEventName,
  followEvents,
  readEvents,
  type EventName,
} from "../../core/events.js";
import { updateRuntimeLedger } from "../../core/runtime-ledger.js";
import { comboHome, readCombo, runDirFor } from "../../core/state.js";
import { loadRuntimeConfig } from "../../infra/config-snapshot.js";
import { persistCoderThreadArtifact } from "../../roles/coder.js";
import { parseEventFields } from "../../cli/args.js";
import { closeMergedCombo } from "../../cli/closure.js";
import { GATEKEEPER_WINDOW, refreshGatekeeperWindow } from "../../cli/gate.js";
import { parkCombo } from "../../cli/park.js";
import { reconcileCombos } from "../../cli/reconcile.js";
import { resumeCombo } from "../../cli/resume.js";
import {
  CODER_WINDOW,
  DIRECTOR_WINDOW,
  DIRECTOR_WATCH_WINDOW,
  JOURNAL_WINDOW,
  REVIEWER_WINDOW,
  ensureComboSession,
  ensureJournalPane,
  resolveAttachCombo,
} from "../../cli/sessions.js";
import { attachSessionArgs, killSessionArgs } from "../../infra/tmux.js";
import { resolvePollMs } from "../../cli/watchers.js";
import type { AppDeps } from "../deps.js";

// -- 1/3 CORE · emitComboEvent <- START HERE --
export function emitComboEvent(
  deps: AppDeps,
  event: string,
  options: { name: string; field: string[]; skipGateWindowRecovery: boolean },
  cli: string,
): void {
  const home = comboHome(deps.env);
  const runDir = runDirFor(home, options.name);
  const canonicalEvent = canonicalEventName(event);
  if (canonicalEvent === "coder_done") {
    const combo = readCombo(runDir);
    persistCoderThreadArtifact({ runDir, worktree: combo.worktree });
  }
  const payload = parseEventFields(options.field);
  appendEvent(runDir, event as EventName, payload);
  if (canonicalEvent === "pr_opened" && typeof payload["url"] === "string") {
    updateRuntimeLedger(runDir, {
      cli,
      prUrl: payload["url"],
      roleWindows: {
        journal: JOURNAL_WINDOW,
        director: DIRECTOR_WINDOW,
        coder: CODER_WINDOW,
        gatekeeper: GATEKEEPER_WINDOW,
        reviewer: REVIEWER_WINDOW,
        directorWatch: DIRECTOR_WATCH_WINDOW,
      },
    });
  }
  if (canonicalEvent === "gate_started" && !options.skipGateWindowRecovery) {
    try {
      const combo = readCombo(runDir);
      const config = loadRuntimeConfig(runDir, { repoDir: combo.repoDir, env: deps.env });
      ensureComboSession({ deps, combo, home, cli });
      refreshGatekeeperWindow(deps, combo, {
        timeoutSeconds: config.gatekeeperAttachTimeoutSeconds,
        retryIntervalSeconds: config.gatekeeperAttachRetryIntervalSeconds,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        "combo-chen: gatekeeper window recovery failed for " + options.name + ": " + detail + "\n",
      );
    }
  }
}
// -/ 1/3

// -- 2/3 CORE · Resume, closure, reconcile, and park --
export async function closeCombo(deps: AppDeps, comboId: string): Promise<void> {
  await closeMergedCombo({
    deps,
    home: comboHome(deps.env),
    comboId,
  });
}

export async function reconcileComboState(
  deps: AppDeps,
  options: { apply: boolean; name?: string },
): Promise<void> {
  await reconcileCombos({
    deps,
    home: comboHome(deps.env),
    apply: options.apply,
    comboId: options.name,
  });
}

export async function resumePersistedCombo(deps: AppDeps, comboId: string, cli: string): Promise<void> {
  await resumeCombo({
    deps,
    home: comboHome(deps.env),
    comboId,
    cli,
  });
}

export function parkPersistedCombo(deps: AppDeps, options: { name: string; by: string }, cli: string): void {
  parkCombo({
    deps,
    home: comboHome(deps.env),
    comboId: options.name,
    cli,
    by: options.by,
  });
}
// -/ 2/3

// -- 3/3 HELPER · Attach, stop, and event output --
export function attachCombo(deps: AppDeps, comboId: string | undefined, cli: string): void {
  const combo = resolveAttachCombo(deps, comboHome(deps.env), comboId);
  ensureJournalPane(deps, combo, cli);
  const attached = deps.tmux(attachSessionArgs(combo.tmuxSession));
  if (attached.status !== 0) {
    const detail = attached.stderr.trim();
    throw new Error(
      'tmux attach failed for "' +
        combo.tmuxSession +
        '" (the tmux error was sent to your terminal above)' +
        (detail ? ": " + detail : ""),
    );
  }
}

export function stopCombo(deps: AppDeps, options: { name: string; by: string }): void {
  const runDir = runDirFor(comboHome(deps.env), options.name);
  const combo = readCombo(runDir);
  const killed = deps.tmux(killSessionArgs(combo.tmuxSession));
  if (killed.status !== 0) {
    throw new Error(
      'tmux kill-session failed for "' +
        combo.tmuxSession +
        '": ' +
        (killed.stderr.trim() || "unknown error"),
    );
  }
  appendEvent(runDir, "stopped", { by: options.by });
  deps.out("stopped " + combo.id + " (tmux session " + combo.tmuxSession + " killed, journal kept)");
}

export async function printComboEvents(
  deps: Pick<AppDeps, "env" | "out">,
  options: { name: string; follow: boolean },
): Promise<void> {
  const runDir = runDirFor(comboHome(deps.env), options.name);
  if (!options.follow) {
    for (const event of readEvents(runDir)) deps.out(JSON.stringify(event));
    return;
  }
  const pollMs = resolvePollMs(deps.env);
  for await (const event of followEvents(runDir, pollMs === undefined ? {} : { pollMs })) {
    deps.out(JSON.stringify(event));
  }
}
// -/ 3/3
