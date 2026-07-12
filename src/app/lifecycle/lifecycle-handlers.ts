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
 *   DECISION_VERBS, attachCombo, closeCombo, reconcileComboState, resumePersistedCombo, parkPersistedCombo,
 *   stopCombo, printComboEvents, emitComboEvent, decideComboEscalation
 *
 *   INTERNALS
 *   ---------
 *   none.
 *
 * @exports DECISION_VERBS, attachCombo, closeCombo, reconcileComboState, resumePersistedCombo, parkPersistedCombo, stopCombo, printComboEvents, emitComboEvent, decideComboEscalation
 * @deps ../../core/events, ../../core/runtime-ledger, ../../core/state, ../../infra/config-snapshot, ../../infra/tmux, ../../roles/coder-invocation, ../deps, ../director/watchers, ../gate/gate, ../runtime/sessions, ./closure, ./event-fields, ./park, ./reconcile, ./resume
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
import { persistCoderThreadArtifact } from "../../roles/coder-invocation.js";
import { parseEventFields } from "./event-fields.js";
import { closeMergedCombo } from "./closure.js";
import { GATEKEEPER_WINDOW, refreshGatekeeperWindow } from "../gate/gate.js";
import { parkCombo } from "./park.js";
import { reconcileCombos } from "./reconcile.js";
import { resumeCombo } from "./resume.js";
import {
  CODER_WINDOW,
  DIRECTOR_WINDOW,
  DIRECTOR_WATCH_WINDOW,
  JOURNAL_WINDOW,
  REVIEWER_WINDOW,
  ensureComboSession,
  ensureJournalPane,
  resolveAttachCombo,
} from "../runtime/sessions.js";
import { attachSessionArgs, killSessionArgs } from "../../infra/tmux.js";
import { resolvePollMs } from "../director/watchers.js";
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
  const payload = parseEventFields(options.field);
  appendEvent(runDir, event as EventName, payload);
  const coderJsonlPath = payload["gnhf_iteration_jsonl"];
  if (canonicalEvent === "coder_done" && typeof coderJsonlPath === "string" && coderJsonlPath.trim() !== "") {
    const combo = readCombo(runDir);
    try {
      persistCoderThreadArtifact({ runDir, worktree: combo.worktree, jsonlPath: coderJsonlPath });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        "combo-chen: coder_done artifact persistence failed for " + options.name + ": " + detail + "\n",
      );
    }
  }
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

// -- 2/3 CORE · Resume, closure, reconcile, decide, and park --
/**
 * The four decision verbs. The single source of truth: the `decide` handler
 * validates against this list, and the TUI decision-card fold imports it so
 * the read and write paths can never drift.
 */
export const DECISION_VERBS = ["retry", "skip", "take_over", "ignore"] as const;

/**
 * Answer a pending needs_human escalation with a decision journal event
 * (PRD s7). A needs_human is pending while no decision carries its journal
 * timestamp as needs_human_ref; the latest pending one is answered unless an
 * explicit --ref targets an earlier escalation.
 */
export function decideComboEscalation(
  deps: Pick<AppDeps, "env" | "out">,
  options: { name: string; verb: string; note?: string; ref?: string; by?: string },
): void {
  const runDir = runDirFor(comboHome(deps.env), options.name);
  const verb = options.verb.replace(/-/g, "_");
  if (!(DECISION_VERBS as readonly string[]).includes(verb)) {
    throw new Error(`unknown decision verb "${options.verb}"; expected one of: ${DECISION_VERBS.join(", ")}`);
  }
  const events = readEvents(runDir);
  const decidedRefs = new Set(
    events.filter((event) => event.event === "decision").map((event) => String(event["needs_human_ref"])),
  );
  const pending = events.filter((event) => event.event === "needs_human" && !decidedRefs.has(event.t));
  const target =
    options.ref === undefined ? pending.at(-1) : pending.find((event) => event.t === options.ref);
  if (target === undefined) {
    throw new Error(
      options.ref === undefined
        ? `no pending needs_human escalation for ${options.name}`
        : `no pending needs_human escalation at ${options.ref} for ${options.name}`,
    );
  }
  appendEvent(runDir, "decision", {
    needs_human_ref: target.t,
    verb,
    ...(options.note === undefined ? {} : { note: options.note }),
    by: options.by ?? "human",
  });
  const reason = typeof target["reason"] === "string" ? ` (${target["reason"]})` : "";
  deps.out(`decision recorded for ${options.name}: ${verb} -> needs_human@${target.t}${reason}`);
}
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
