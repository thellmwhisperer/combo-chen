/**
 * @overview Combo forensics report model and renderers. ~455 lines, pure analysis only.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at analyzeForensicsCombo <- derives facts and incidents.
 *   2. Then renderForensicsMarkdown   <- human-readable report surface.
 *   3. Use renderForensicsOutcomeMarkdown for GitHub issue outcome comments.
 *   4. Helpers at the bottom          <- journal timestamps and formatting.
 *
 *   MAIN FLOW
 *   ---------
 *   ComboRecord + journal events + optional probes -> analyzeForensicsCombo -> markdown/json-ready data
 *
 *   PUBLIC API
 *   ----------
 *   ForensicsComboInput, ForensicsComboReport, ForensicsIncident
 *   analyzeForensicsCombo       Build one combo report from local and probe facts.
 *   renderForensicsMarkdown           Render combo reports as concise markdown.
 *   renderForensicsOutcomeMarkdown    Render one compact outcome comment body.
 *
 *   INTERNALS
 *   ---------
 *   durationBetween, latestEvent, formatDuration, incident, shortSha
 *
 * @exports ForensicsSignalState, ForensicsGithubPrFacts, ForensicsGithubIssueFacts, ForensicsTmuxFacts, ForensicsComboInput, ForensicsIncident, ForensicsComboReport, analyzeForensicsCombo, renderForensicsMarkdown, renderForensicsOutcomeMarkdown
 * @deps ../../core/combo, ../../core/events, ../../core/state, ../director/reviewer, ../gate/gate, ./display
 */
import { deriveStatus, type Phase } from "../../core/combo.js";
import { latestPrUrlFromEvents, type ComboEvent } from "../../core/events.js";
import { describeWorkItem, type ComboRecord, type WorkItemDescriptor } from "../../core/state.js";
import { yesNo } from "./display.js";
import { latestGateStatus, latestPublishedGateSha, shaMatchesHead } from "../gate/gate.js";
import { livePinnedLgtmSha } from "../director/reviewer.js";

// -- 1/3 HELPER · Public report types --
export type ForensicsSignalState = "success" | "failure" | "pending" | "unknown";

export interface ForensicsGithubPrFacts {
  url: string;
  headSha?: string;
  reviewerPinnedSha?: string | null;
  state?: string;
  mergedAt?: string;
  ci?: ForensicsSignalState;
  readyRequiredChecks?: ForensicsSignalState;
  ambientReviewer?: ForensicsSignalState;
  mergeState?: string;
  branchBehind?: boolean;
}

export interface ForensicsGithubIssueFacts {
  state?: string;
  closedAt?: string;
}

export interface ForensicsTmuxFacts {
  sessionExists?: boolean;
  windows?: string[];
}

export interface ForensicsComboInput {
  combo: ComboRecord;
  events: ComboEvent[];
  local?: {
    worktreeHeadSha?: string;
  };
  github?: {
    pr?: ForensicsGithubPrFacts;
    issue?: ForensicsGithubIssueFacts;
  };
  tmux?: ForensicsTmuxFacts;
}

export interface ForensicsIncident {
  id:
    | "missing_reviewer_verdict"
    | "stale_lgtm_after_push"
    | "process_without_github_gate"
    | "merged_pr_open_issue"
    | "local_status_stale"
    | "pr_head_local_drift";
  severity: "info" | "warning" | "critical";
  message: string;
}

export interface ForensicsComboReport {
  id: string;
  workItem: WorkItemDescriptor;
  issueUrl: string;
  prUrl?: string;
  phase: Phase;
  timeline: {
    createdAt?: string;
    coderStartedAt?: string;
    coderDoneAt?: string;
    gateStartedAt?: string;
    prOpenedAt?: string;
    firstLgtmAt?: string;
    finalLgtmAt?: string;
    mergedAt?: string;
    closedAt?: string;
  };
  timings: {
    coderMs?: number;
    timeToPrMs?: number;
    timeToFirstLgtmMs?: number;
    timeToFinalLgtmMs?: number;
    timeToMergeMs?: number;
  };
  gates: {
    ci: ForensicsSignalState;
    readyRequiredChecks: ForensicsSignalState;
    ambientReviewer?: ForensicsSignalState;
    mergeState?: string;
    branchBehind?: boolean;
    gatekeeper: {
      current: boolean;
      publishedSha?: string;
      latestState?: string;
    };
    reviewer: {
      current: boolean;
      livePinnedSha?: string;
      headSha?: string;
    };
    localWorktreeHeadSha?: string;
    issueClosed: boolean | "unknown";
  };
  processes: {
    sessionExists: boolean | "unknown";
    reviewerWindow: boolean;
    gatekeeperWindow: boolean;
    coderWindow: boolean;
  };
  incidents: ForensicsIncident[];
}
// -/ 1/3

// -- 2/3 CORE · analyzeForensicsCombo <- START HERE --
export function analyzeForensicsCombo(input: ForensicsComboInput): ForensicsComboReport {
  const { combo, events } = input;
  const status = deriveStatus(events);
  const prUrl = input.github?.pr?.url ?? latestPrUrlFromEvents(events);
  const headSha = input.github?.pr?.headSha;
  const localHeadSha = input.local?.worktreeHeadSha;
  const probedReviewerSha = input.github?.pr?.reviewerPinnedSha;
  const liveReviewerSha =
    probedReviewerSha === null ? undefined : (probedReviewerSha ?? livePinnedLgtmSha(events));
  const publishedGateSha = latestPublishedGateSha(events);
  const gateStatus = latestGateStatus(events);
  const latestStaleLgtm = latestEvent(events, "lgtm_stale");

  const createdAt = latestEvent(events, "combo_created")?.t ?? combo.createdAt;
  const coderStartedAt = latestEvent(events, "coder_started")?.t;
  const coderDoneAt = latestEvent(events, "coder_done")?.t;
  const gateStartedAt = latestEvent(events, "gate_started")?.t;
  const prOpenedAt = latestEvent(events, "pr_opened")?.t;
  const lgtmEvents = events.filter((event) => event.event === "lgtm");
  const firstLgtmAt = lgtmEvents[0]?.t;
  const finalLgtmAt = lgtmEvents.at(-1)?.t;
  const mergedAt = input.github?.pr?.mergedAt ?? latestEvent(events, "merged")?.t;
  const closedAt = input.github?.issue?.closedAt ?? latestEvent(events, "combo_closed")?.t;

  const reviewerCurrent = headSha !== undefined && liveReviewerSha === headSha;
  const gatekeeperCurrent = headSha !== undefined && publishedGateSha === headSha;
  const windows = new Set(input.tmux?.windows ?? []);
  const issueState = upper(input.github?.issue?.state);
  const prState = upper(input.github?.pr?.state);

  const report: ForensicsComboReport = {
    id: combo.id,
    workItem: describeWorkItem(combo),
    issueUrl: combo.issueUrl,
    ...(prUrl !== undefined ? { prUrl } : {}),
    phase: status.phase,
    timeline: {
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(coderStartedAt !== undefined ? { coderStartedAt } : {}),
      ...(coderDoneAt !== undefined ? { coderDoneAt } : {}),
      ...(gateStartedAt !== undefined ? { gateStartedAt } : {}),
      ...(prOpenedAt !== undefined ? { prOpenedAt } : {}),
      ...(firstLgtmAt !== undefined ? { firstLgtmAt } : {}),
      ...(finalLgtmAt !== undefined ? { finalLgtmAt } : {}),
      ...(mergedAt !== undefined ? { mergedAt } : {}),
      ...(closedAt !== undefined ? { closedAt } : {}),
    },
    timings: {
      ...durationField("coderMs", coderStartedAt, coderDoneAt),
      ...durationField("timeToPrMs", createdAt, prOpenedAt),
      ...durationField("timeToFirstLgtmMs", createdAt, firstLgtmAt),
      ...durationField("timeToFinalLgtmMs", createdAt, finalLgtmAt),
      ...durationField("timeToMergeMs", createdAt, mergedAt),
    },
    gates: {
      ci: input.github?.pr?.ci ?? "unknown",
      readyRequiredChecks: input.github?.pr?.readyRequiredChecks ?? "unknown",
      ambientReviewer: input.github?.pr?.ambientReviewer,
      ...(input.github?.pr?.mergeState !== undefined ? { mergeState: input.github.pr.mergeState } : {}),
      ...(input.github?.pr?.branchBehind !== undefined ? { branchBehind: input.github.pr.branchBehind } : {}),
      gatekeeper: {
        current: gatekeeperCurrent,
        ...(publishedGateSha !== undefined ? { publishedSha: publishedGateSha } : {}),
        ...(gateStatus?.state !== undefined ? { latestState: gateStatus.state } : {}),
      },
      reviewer: {
        current: reviewerCurrent,
        ...(liveReviewerSha !== undefined ? { livePinnedSha: liveReviewerSha } : {}),
        ...(headSha !== undefined ? { headSha } : {}),
      },
      ...(localHeadSha !== undefined ? { localWorktreeHeadSha: localHeadSha } : {}),
      issueClosed: issueState === undefined ? "unknown" : issueState === "CLOSED",
    },
    processes: {
      sessionExists: input.tmux?.sessionExists ?? "unknown",
      reviewerWindow: windows.has("reviewer"),
      gatekeeperWindow: windows.has("gatekeeper"),
      coderWindow: windows.has("coder"),
    },
    incidents: [],
  };

  if (prState === "OPEN" && report.gates.ci === "success" && headSha !== undefined && !reviewerCurrent) {
    report.incidents.push(
      incident(
        "missing_reviewer_verdict",
        "critical",
        `CI is green at ${headSha}, but no current reviewer lgtm is visible for that head.`,
      ),
    );
  }

  if (
    prState === "OPEN" &&
    localHeadSha !== undefined &&
    headSha !== undefined &&
    !shaMatchesHead(localHeadSha, headSha)
  ) {
    report.incidents.push(
      incident(
        "pr_head_local_drift",
        "warning",
        `PR head ${shortSha(headSha)} differs from local worktree ${shortSha(localHeadSha)}; fetch PR head for review or sync combo worktree.`,
      ),
    );
  }

  if (latestStaleLgtm !== undefined && (headSha === undefined || latestStaleLgtm["new_sha"] === headSha)) {
    report.incidents.push(
      incident(
        "stale_lgtm_after_push",
        "warning",
        `Reviewer LGTM ${String(latestStaleLgtm["old_sha"])} was stale after ${String(latestStaleLgtm["new_sha"])}.`,
      ),
    );
  }

  if (report.processes.reviewerWindow && !reviewerCurrent) {
    report.incidents.push(
      incident(
        "process_without_github_gate",
        "warning",
        "A reviewer tmux window exists, but the GitHub-visible reviewer gate is not satisfied.",
      ),
    );
  }

  if (prState === "MERGED" && issueState === "OPEN") {
    report.incidents.push(
      incident("merged_pr_open_issue", "critical", "The PR is merged, but the source issue is still open."),
    );
  }

  if ((prState === "MERGED" || prState === "CLOSED") && status.phase !== "STOPPED") {
    report.incidents.push(
      incident(
        "local_status_stale",
        "warning",
        `Local combo phase is ${status.phase}, but GitHub reports the PR as ${prState}.`,
      ),
    );
  }

  return report;
}
// -/ 2/3

// -- 3/3 HELPER · rendering and small predicates --
export function renderForensicsMarkdown(reports: ForensicsComboReport[]): string {
  const lines = ["# combo-chen forensics", ""];
  for (const report of reports) {
    lines.push(`## ${report.id}`);
    lines.push(`- Work item: ${report.workItem.label}`);
    if (report.issueUrl.trim() !== "") lines.push(`- GitHub issue: ${report.issueUrl}`);
    lines.push(`- PR: ${report.prUrl ?? "unknown"}`);
    lines.push(`- Phase: ${report.phase}`);
    lines.push("- Outcome:");
    lines.push(`  - PR link: ${report.prUrl ?? "unknown"}`);
    lines.push(`  - Head SHA: ${report.gates.reviewer.headSha ?? "unknown"}`);
    if (report.gates.localWorktreeHeadSha !== undefined) {
      lines.push(`  - Local worktree HEAD: ${shortSha(report.gates.localWorktreeHeadSha)}`);
    }
    lines.push(`  - Review/check state: ${reviewCheckState(report)}`);
    lines.push(`  - Failures found: ${failuresFound(report)}`);
    lines.push(`  - Follow-up bugs: ${followUpBugs(report)}`);
    lines.push(
      [
        "- Timings:",
        `Coder: ${formatDuration(report.timings.coderMs)}`,
        `Time to PR: ${formatDuration(report.timings.timeToPrMs)}`,
        `First LGTM: ${formatDuration(report.timings.timeToFirstLgtmMs)}`,
        `Final LGTM: ${formatDuration(report.timings.timeToFinalLgtmMs)}`,
        `Merge: ${formatDuration(report.timings.timeToMergeMs)}`,
      ].join(" "),
    );
    lines.push(
      [
        "- Gates:",
        `CI: ${report.gates.ci}`,
        `required READY checks: ${report.gates.readyRequiredChecks}`,
        `reviewer current verdict: ${yesNo(report.gates.reviewer.current)}`,
        `gatekeeper current: ${yesNo(report.gates.gatekeeper.current)}`,
        `issue closed: ${report.gates.issueClosed}`,
      ].join(" · "),
    );
    lines.push(
      [
        "- Processes:",
        `session exists: ${report.processes.sessionExists}`,
        `reviewer window exists: ${yesNo(report.processes.reviewerWindow)}`,
        `gatekeeper window exists: ${yesNo(report.processes.gatekeeperWindow)}`,
        `coder window exists: ${yesNo(report.processes.coderWindow)}`,
      ].join(" · "),
    );
    lines.push("- Incidents:");
    if (report.incidents.length === 0) {
      lines.push("  - none");
    } else {
      for (const item of report.incidents) {
        lines.push(`  - ${item.id} (${item.severity}): ${item.message}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function renderForensicsOutcomeMarkdown(report: ForensicsComboReport): string {
  const lines = [
    `<!-- combo-chen:forensics-outcome ${report.id} -->`,
    `🤖 Codex — combo-chen forensics outcome for \`${report.id}\``,
    "",
    `- Work item: ${report.workItem.label}`,
  ];
  if (report.issueUrl.trim() !== "") lines.push(`- GitHub issue: ${report.issueUrl}`);
  lines.push(`- PR link: ${report.prUrl ?? "unknown"}`);
  lines.push(`- Head SHA: ${report.gates.reviewer.headSha ?? "unknown"}`);
  lines.push(`- Review/check state: ${reviewCheckState(report)}`);
  lines.push(`- Failures found: ${failuresFound(report)}`);
  lines.push(`- Follow-up bugs: ${followUpBugs(report)}`);
  return lines.join("\n");
}

function reviewCheckState(report: ForensicsComboReport): string {
  return [
    `reviewer=${currentSignal(report.gates.reviewer.current, report.gates.reviewer.headSha)}`,
    `gatekeeper=${currentSignal(report.gates.gatekeeper.current, report.gates.reviewer.headSha)}`,
    `required READY checks=${report.gates.readyRequiredChecks}`,
    `CI=${report.gates.ci}`,
  ].join(" · ");
}

function currentSignal(current: boolean, headSha: string | undefined): "current" | "not current" | "unknown" {
  if (headSha === undefined) return "unknown";
  return current ? "current" : "not current";
}

function failuresFound(report: ForensicsComboReport): string {
  if (report.incidents.length === 0) return "none";
  return report.incidents.map((item) => `${item.id} (${item.severity})`).join("; ");
}

function followUpBugs(report: ForensicsComboReport): string {
  return report.incidents.length === 0 ? "none recorded" : "not recorded; inspect failures above";
}

function latestEvent<T extends ComboEvent["event"]>(events: ComboEvent[], name: T): ComboEvent | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.event === name) return event;
  }
  return undefined;
}

function durationField<K extends string>(
  key: K,
  start: string | undefined,
  end: string | undefined,
): Partial<Record<K, number>> {
  const ms = durationBetween(start, end);
  return ms === undefined ? {} : ({ [key]: ms } as Partial<Record<K, number>>);
}

function durationBetween(start: string | undefined, end: string | undefined): number | undefined {
  if (start === undefined || end === undefined) return undefined;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) return undefined;
  return endMs - startMs;
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "unknown";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

function shortSha(sha: string): string {
  return sha.trim().slice(0, 7);
}

function upper(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.toUpperCase();
}

function incident(
  id: ForensicsIncident["id"],
  severity: ForensicsIncident["severity"],
  message: string,
): ForensicsIncident {
  return { id, severity, message };
}
// -/ 3/3
