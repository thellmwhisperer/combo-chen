/**
 * @overview PR body dossier projection: pure function that renders one
 *   collapsed &lt;details&gt; block per review round (newest first, dossier
 *   markdown inside). Older rounds compact to their verdict line as the
 *   65,536-char GitHub body limit approaches. Re-running on an
 *   already-projected body is idempotent: a marker-delimited section is
 *   replaced wholesale. Human-authored text and the autoclose footer
 *   outside the markers survive.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at projectDossierPrBody   <- the pure projection function.
 *   2. Then renderFullRound            <- dossier content is sanitized.
 *   3. Then parseMarkerSection         <- marker extraction for idempotence.
 *
 *   MAIN FLOW
 *   ---------
 *   capsule local verdicts -> DossierRound[] -> projectDossierPrBody -> GitHub body text
 *
 *   PUBLIC API
 *   ----------
 *   GITHUB_PR_BODY_CHAR_LIMIT   Default GitHub PR body character limit.
 *   DOSSIER_SECTION_START       Opening marker for the dossier section.
 *   DOSSIER_SECTION_END         Closing marker for the dossier section.
 *   DossierRound                One review round for projection.
 *   projectDossierPrBody        Pure fold: rounds + existing body + limit -> PR body.
 *   compactRoundLine            Compact one round to a one-line verdict summary.
 *
 *   INTERNALS
 *   ---------
 *   sanitizeDossierContent, renderFullRound, renderSection, parseMarkerSection
 *
 * @exports GITHUB_PR_BODY_CHAR_LIMIT, DOSSIER_SECTION_START, DOSSIER_SECTION_END, DossierRound, projectDossierPrBody, compactRoundLine
 */
import type { VerdictCode } from "./verdict.js";

// -- 1/4 CORE · constants --
/** GitHub PR body character limit (65,536). */
export const GITHUB_PR_BODY_CHAR_LIMIT = 65536;

export const DOSSIER_SECTION_START = "<!-- combo-chen-review-dossier -->";
export const DOSSIER_SECTION_END = "<!-- /combo-chen-review-dossier -->";
// -/ 1/4

// -- 2/4 CORE · types --
export interface DossierRound {
  round: number;
  sha: string;
  code: VerdictCode;
  model: string;
  runtime: string;
  /** Pre-rendered tier-2 dossier markdown (renderReviewDossier output). */
  dossierMarkdown: string;
}

interface ProjectedRound {
  round: number;
  full: boolean;
  markdown: string;
}
// -/ 2/4

// -- 3/4 CORE · content sanitization --
/**
 * Neutralizes HTML markers inside the embedded dossier content so the
 * outer <details> block and the dossier section markers stay intact.
 * Round-trip idempotence: re-projecting a previously projected body must
 * converge byte-identical on the second pass even when the dossier
 * markdown contains literal "</details>" or the section end marker.
 */
function sanitizeDossierContent(content: string): string {
  return content
    .replaceAll("<details>", "&lt;details&gt;")
    .replaceAll("<DETAILS>", "&lt;DETAILS&gt;")
    .replaceAll("</details>", "&lt;/details&gt;")
    .replaceAll("</DETAILS>", "&lt;/DETAILS&gt;")
    .replaceAll(DOSSIER_SECTION_START, "&lt;!-- combo-chen-review-dossier --&gt;")
    .replaceAll(DOSSIER_SECTION_END, "&lt;!-- /combo-chen-review-dossier --&gt;");
}
// -/ 3/4

// -- 4/4 CORE · projection + compaction <- START HERE --

function renderFullRound(round: DossierRound): string {
  const sha12 = round.sha.slice(0, 12);
  const lines = [
    `<details>`,
    `<summary>Round ${round.round} — code ${round.code}, reviewed by ${round.model} @ ${sha12}</summary>`,
    "",
    sanitizeDossierContent(round.dossierMarkdown.trimEnd()),
    "",
    `</details>`,
  ];
  return lines.join("\n");
}

export function compactRoundLine(round: DossierRound): string {
  const sha12 = round.sha.slice(0, 12);
  return `- Round ${round.round} @ ${sha12}: code ${round.code}, reviewed by ${round.model} (${round.runtime})`;
}

interface MarkerParts {
  before: string;
  after: string;
}

function parseMarkerSection(body: string): MarkerParts {
  const startIdx = body.indexOf(DOSSIER_SECTION_START);
  if (startIdx === -1) {
    return { before: body, after: "" };
  }
  const beforeStart = body.slice(0, startIdx);
  const afterStart = body.slice(startIdx + DOSSIER_SECTION_START.length);
  const endIdx = afterStart.indexOf(DOSSIER_SECTION_END);
  if (endIdx === -1) {
    return { before: body, after: "" };
  }
  return {
    before: beforeStart,
    after: afterStart.slice(endIdx + DOSSIER_SECTION_END.length),
  };
}

function renderSection(rounds: DossierRound[], limit: number, overhead: number): string {
  const available = limit - overhead;
  const projected: ProjectedRound[] = rounds.map((r) => ({
    round: r.round,
    full: true,
    markdown: renderFullRound(r),
  }));

  const compute = (): string => {
    const lines: string[] = [];
    for (const p of projected) {
      lines.push(
        p.full ? p.markdown : compactRoundLine(rounds[rounds.findIndex((r) => r.round === p.round)]!),
      );
    }
    return lines.join("\n\n");
  };

  if (available >= compute().length) return compute();

  for (let i = projected.length - 1; i >= 0; i -= 1) {
    projected[i]!.full = false;
    if (available >= compute().length) return compute();
  }

  return compute();
}

export function projectDossierPrBody(options: {
  rounds: DossierRound[];
  existingBody: string;
  charLimit?: number;
}): string {
  const limit = options.charLimit ?? GITHUB_PR_BODY_CHAR_LIMIT;
  const { before, after } = parseMarkerSection(options.existingBody);

  if (options.rounds.length === 0) {
    if (options.existingBody.includes(DOSSIER_SECTION_START)) {
      const reconstructed = [before.trimEnd(), after.trimStart()].filter(Boolean).join("\n\n");
      return reconstructed === "" ? "" : `${reconstructed}\n`;
    }
    return options.existingBody;
  }

  // Sort newest first (descending round) so callers don't have to.
  const sorted = [...options.rounds].sort((a, b) => b.round - a.round);

  const sectionOverhead = DOSSIER_SECTION_START.length + 1 + 1 + DOSSIER_SECTION_END.length;
  const beforeClean = before.trimEnd();
  const afterClean = after.trimStart();
  const overhead =
    beforeClean.length +
    (beforeClean.length > 0 ? 2 : 0) + // \n\n separator
    sectionOverhead +
    (afterClean.length > 0 ? 2 : 0); // \n\n separator

  const section = renderSection(sorted, limit, overhead);

  const parts: string[] = [];
  if (beforeClean.length > 0) {
    parts.push(beforeClean, ""); // blank line before markers
  }
  parts.push(DOSSIER_SECTION_START);
  parts.push(section);
  parts.push(DOSSIER_SECTION_END);
  if (afterClean.length > 0) {
    parts.push("", afterClean); // blank line after markers
  }

  return `${parts.join("\n")}\n`;
}
// -/ 4/4
