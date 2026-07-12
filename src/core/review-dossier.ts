/**
 * @overview Tier-2 review dossier: review-<round>-<sha12>.md rendered
 *   deterministically from the tier-1 verdict artifact, so every fact lives in
 *   exactly one place (the verdict JSON) and the markdown is pure projection
 *   (PRD s5). Attack table and checklist rows reference findings by id, never
 *   restate them; clean rows cost zero visible lines; the summary is
 *   exceptions-only.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at renderReviewDossier    <- the whole style contract.
 *   2. reviewDossierFileName pins the round + short-sha attribution.
 *
 *   MAIN FLOW
 *   ---------
 *   capsule readVerdictFile -> renderReviewDossier -> review-<round>-<sha12>.md
 *
 *   PUBLIC API
 *   ----------
 *   reviewDossierFileName   review-<round>-<sha12>.md naming.
 *   reviewDossierPath       Well-known run-dir location.
 *   renderReviewDossier     Verdict JSON -> human dossier markdown.
 *
 *   INTERNALS
 *   ---------
 *   findingLine, checklistSection, attackSection
 *
 * @exports reviewDossierFileName, reviewDossierPath, renderReviewDossier
 * @deps node:path, ./verdict
 */
import { join } from "node:path";

import type { VerdictFile, VerdictFinding } from "./verdict.js";

// -- 1/2 HELPER · naming --
export function reviewDossierFileName(round: number, sha: string): string {
  return `review-${round}-${sha.slice(0, 12)}.md`;
}

export function reviewDossierPath(runDir: string, round: number, sha: string): string {
  return join(runDir, reviewDossierFileName(round, sha));
}
// -/ 1/2

// -- 2/2 CORE · renderReviewDossier <- START HERE --
function plural(count: number, singular: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${singular}s`;
}

function findingLine(finding: VerdictFinding): string[] {
  const location = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
  const surface =
    finding.criticalSurface === undefined ? "" : ` (critical surface: ${finding.criticalSurface})`;
  return [
    `- **${finding.id}** [${finding.severity}] ${location}${surface} — ${finding.title}`,
    `  ${finding.body}`,
  ];
}

function checklistSection(verdict: VerdictFile): string[] {
  const exceptions = verdict.checklist.filter((item) => item.status !== "pass");
  const passed = verdict.checklist.length - exceptions.length;
  const lines = exceptions.map(
    (item) => `- ${item.id}: ${item.status}${item.note === undefined ? "" : ` — ${item.note}`}`,
  );
  if (passed > 0) lines.push(`- ${plural(passed, "checklist item")} passed.`);
  return lines;
}

function attackSection(verdict: VerdictFile): string[] {
  const rows = verdict.attackTable ?? [];
  const exceptions = rows.filter((row) => row.result !== "clean");
  const clean = rows.length - exceptions.length;
  const lines = exceptions.map((row) => {
    const reference = row.findingId === undefined ? "" : ` — see ${row.findingId}`;
    const note = row.note === undefined ? "" : ` — ${row.note}`;
    return `- ${row.attack}: ${row.result}${reference}${note}`;
  });
  if (clean > 0) lines.push(`- ${plural(clean, "attack")} clean.`);
  return lines;
}

export function renderReviewDossier(verdict: VerdictFile): string {
  const lines: string[] = [
    `# Review round ${verdict.round} @ ${verdict.reviewed.sha}`,
    "",
    `Summary: round ${verdict.round}, verdict code ${verdict.code}, ` +
      `reviewed by ${verdict.identity.model} (${verdict.identity.runtime}).`,
    verdict.findings.length === 0
      ? "No findings."
      : `${plural(verdict.findings.length, "finding")}, exceptions below.`,
  ];
  if (verdict.findings.length > 0) {
    lines.push("", "## Findings", "");
    for (const finding of verdict.findings) lines.push(...findingLine(finding));
  }
  const attacks = attackSection(verdict);
  if (attacks.length > 0) lines.push("", "## Attack table", "", ...attacks);
  const checklist = checklistSection(verdict);
  if (checklist.length > 0) lines.push("", "## Checklist", "", ...checklist);
  if (verdict.followUps.length > 0) {
    lines.push("", "## Follow-ups", "");
    for (const followUp of verdict.followUps) {
      const reference = followUp.findingId === undefined ? "" : ` — see ${followUp.findingId}`;
      const body = followUp.body === undefined ? "" : ` — ${followUp.body}`;
      lines.push(`- ${followUp.title}${reference}${body}`);
    }
  }
  const notVerified = verdict.notVerified ?? [];
  if (notVerified.length > 0) {
    lines.push("", "## Not verified", "");
    for (const item of notVerified) lines.push(`- ${item}`);
  }
  return `${lines.join("\n")}\n`;
}
// -/ 2/2
