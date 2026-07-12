/**
 * @overview Application handlers for persisted combo lifecycle endpoints.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at decideComboEscalation <- answer a pending needs_human.
 *   2. Then resumePersistedCombo      <- recovery entry point.
 *   3. Read emit/attach/stop/events   <- operator lifecycle endpoints.
 *
 *   MAIN FLOW
 *   ---------
 *   CLI options -> persisted combo -> lifecycle service -> journal/tmux/output
 *
 *   PUBLIC API
 *   ----------
 *   DECISION_VERBS, recordObservedComboEvent, attachCombo, closeCombo, reconcileComboState,
 *   resumePersistedCombo, parkPersistedCombo, stopCombo, printComboEvents, decideComboEscalation
 *
 *   INTERNALS
 *   ---------
 *   none.
 *
 * @exports DECISION_VERBS, recordObservedComboEvent, attachCombo, closeCombo, reconcileComboState, resumePersistedCombo, parkPersistedCombo, stopCombo, printComboEvents, decideComboEscalation
 * @deps ../../core/events, ../../core/state, ../../infra/tmux, ../deps, ../runtime/sessions, ./closure, ./park, ./reconcile, ./resume
 */
import { appendEvent, followEvents, readEvents } from "../../core/events.js";
import { comboHome, readCombo, runDirFor } from "../../core/state.js";
import { closeMergedCombo } from "./closure.js";
import { parkCombo } from "./park.js";
import { reconcileCombos } from "./reconcile.js";
import { resumeCombo } from "./resume.js";
import { ensureJournalPane, resolveAttachCombo } from "../runtime/sessions.js";
import { attachSessionArgs, killSessionArgs } from "../../infra/tmux.js";
import type { AppDeps } from "../deps.js";

// -- 1/2 CORE · Resume, closure, reconcile, decide, and park <- START HERE --
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

export function recordObservedComboEvent(
  deps: Pick<AppDeps, "env" | "gh" | "out">,
  options: { name: string; event: string; url: string },
): void {
  if (options.event !== "pr_opened") {
    throw new Error(
      `emit only supports pr_opened: this operator verb is fact-recording only; ` +
        `decision/phase events would corrupt the journal fold (received "${options.event}")`,
    );
  }

  const runDir = runDirFor(comboHome(deps.env), options.name);
  const combo = readCombo(runDir);
  if (combo.id !== options.name) {
    throw new Error(`combo record at ${runDir} has mismatched id "${combo.id}"`);
  }
  const existing = readEvents(runDir).find((event) => event.event === "pr_opened");
  if (existing !== undefined) {
    const existingUrl = typeof existing["url"] === "string" ? existing["url"] : options.url;
    deps.out(`emit: pr_opened already recorded for ${combo.id} (${existingUrl})`);
    return;
  }

  const viewed = deps.gh(["pr", "view", options.url, "--json", "url,state,headRefName"]);
  if (viewed.status !== 0) {
    throw new Error(
      `cannot verify PR ${options.url} (gh status ${viewed.status}): ${viewed.stderr.trim() || "unknown error"}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(viewed.stdout);
  } catch {
    throw new Error(`cannot verify PR ${options.url}: gh returned invalid JSON`);
  }
  if (value === null || typeof value !== "object") {
    throw new Error(`cannot verify PR ${options.url}: gh returned invalid PR data`);
  }
  const pr = value as Record<string, unknown>;
  if (pr["url"] !== options.url) {
    throw new Error(`cannot verify PR ${options.url}: GitHub returned URL ${String(pr["url"])}`);
  }
  if (pr["state"] !== "OPEN" && pr["state"] !== "MERGED") {
    throw new Error(`cannot emit pr_opened for ${options.url}: GitHub PR state is ${String(pr["state"])}`);
  }
  if (pr["headRefName"] !== combo.branch) {
    throw new Error(
      `cannot emit pr_opened for ${options.url}: PR head branch is ${String(pr["headRefName"])}; ` +
        `expected ${combo.branch}`,
    );
  }

  appendEvent(runDir, "pr_opened", { url: options.url });
  deps.out(`emit: recorded pr_opened for ${combo.id} (${options.url})`);
}
// -/ 1/2

// -- 2/2 HELPER · Attach, stop, and event output --
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
  const rawMs = deps.env["COMBO_CHEN_POLL_MS"];
  const pollMs =
    rawMs !== undefined && Number.isFinite(Number(rawMs)) && Number(rawMs) > 0 ? Number(rawMs) : undefined;
  for await (const event of followEvents(runDir, pollMs === undefined ? {} : { pollMs })) {
    deps.out(JSON.stringify(event));
  }
}
// -/ 2/2
