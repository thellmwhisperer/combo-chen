/**
 * @overview Permanent exit summary: every closed combo leaves a summary in the
 *   run dir AND on stdout at closure. Pure fold over journal events + verdict
 *   files (PRD s5). Renders: merged what, rounds, findings fixed and by whom,
 *   duration, PR url.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at renderExitSummary   <- pure fold over events + verdicts.
 *   2. ExitSummaryInput             <- required input facts.
 *
 *   MAIN FLOW
 *   ---------
 *   closure.ts -> readEvents + readVerdictFiles -> renderExitSummary -> writeFile + stdout
 *
 *   PUBLIC API
 *   ----------
 *   EXIT_SUMMARY_FILENAME    Well-known filename in the run dir.
 *   exitSummaryPath          Well-known run-dir location.
 *   ExitSummaryInput         Input data for the summary renderer.
 *   renderExitSummary        Pure fold: events + verdicts + combo facts -> markdown.
 *
 *   INTERNALS
 *   ---------
 *   verdictRounds, durationHuman, findingsSummary, roundLine
 *
 * @exports EXIT_SUMMARY_FILENAME, exitSummaryPath, ExitSummaryInput, renderExitSummary
 */
import { join } from "node:path";

import type { ComboEvent } from "./events.js";
import { readVerdictFile, type VerdictFile } from "./verdict.js";

// -- 1/2 CORE · naming --
export const EXIT_SUMMARY_FILENAME = "exit-summary.md";

export function exitSummaryPath(runDir: string): string {
  return join(runDir, EXIT_SUMMARY_FILENAME);
}
// -/ 1/2

// -- 2/2 CORE · exit summary renderer <- START HERE --
export interface ExitSummaryInput {
  comboId: string;
  issueUrl?: string;
  prUrl: string;
  mergedSha: string;
  mergedBy: string;
  mergedAt?: string;
  createdAt: string;
  runDir: string;
  events: ComboEvent[];
}

function durationHuman(createdAt: string, mergedAt?: string): string {
  let end: number;
  if (mergedAt !== undefined) {
    const parsed = Date.parse(mergedAt);
    end = Number.isNaN(parsed) ? Date.now() : parsed;
  } else {
    end = Date.now();
  }
  const start = Date.parse(createdAt);
  const ms = Number.isNaN(start) ? 0 : end - start;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${totalSeconds % 60}s`;
  return `${totalSeconds}s`;
}

function verdictRounds(runDir: string): VerdictFile[] {
  const rounds: VerdictFile[] = [];
  let round = 1;
  while (true) {
    try {
      const verdict = readVerdictFile(runDir, round);
      rounds.push(verdict);
      round += 1;
    } catch {
      break;
    }
  }
  return rounds;
}

function roundLine(verdict: VerdictFile): string {
  return (
    `- Round ${verdict.round}: code ${verdict.code}, ` +
    `reviewed by ${verdict.identity.model}, ` +
    `${verdict.findings.length} finding${verdict.findings.length === 1 ? "" : "s"}`
  );
}

function findingsSummary(verdicts: VerdictFile[]): {
  totalFindings: number;
  localReviewerFindings: number;
} {
  let totalFindings = 0;
  for (const v of verdicts) {
    totalFindings += v.findings.length;
  }
  // All findings in local verdict files come from the local reviewer.
  // External review (CodeRabbit) findings are tracked separately by the
  // post-publish loop and are not yet reflected in verdict files in v1.
  return {
    totalFindings,
    localReviewerFindings: totalFindings,
  };
}

export function renderExitSummary(input: ExitSummaryInput): string {
  const verdicts = verdictRounds(input.runDir);
  const findings = findingsSummary(verdicts);
  const duration = durationHuman(input.createdAt, input.mergedAt);

  const lines: string[] = [`# Combo closed: ${input.comboId}`, "", `- **PR**: ${input.prUrl}`];

  if (input.issueUrl !== undefined && input.issueUrl.trim() !== "") {
    lines.push(`- **Issue**: ${input.issueUrl}`);
  }

  lines.push(
    `- **Merged**: ${input.mergedSha.slice(0, 12)} by ${input.mergedBy}` +
      (input.mergedAt !== undefined ? ` at ${input.mergedAt}` : ""),
    `- **Duration**: ${duration}`,
    "",
    "## Rounds",
    "",
  );

  if (verdicts.length === 0) {
    lines.push("No local review rounds recorded.", "");
  } else {
    for (const verdict of verdicts) {
      lines.push(roundLine(verdict));
    }
    lines.push("");
  }

  lines.push(
    "## Summary",
    "",
    `- Total rounds: ${verdicts.length}`,
    `- Total findings: ${findings.totalFindings}`,
    `  - Local reviewer: ${findings.localReviewerFindings}`,
  );

  return `${lines.join("\n")}\n`;
}
// -/ 2/2
