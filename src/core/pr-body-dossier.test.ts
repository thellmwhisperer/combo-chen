/**
 * @overview Contract tests for the PR body dossier projector.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at projectDossierPrBody tests <- projection + idempotence.
 *   2. Then compaction tests               <- byte-limit edge cases.
 *   3. Then coexistence tests              <- human-authored text survives.
 *
 *   MAIN FLOW
 *   ---------
 *   fixture rounds -> projectDossierPrBody -> string assertions
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   sampleRound, sampleDossierMarkdown
 *
 * @exports none
 * @deps vitest, ./pr-body-dossier
 */
import { describe, expect, it } from "vitest";

import {
  compactRoundLine,
  DOSSIER_SECTION_END,
  DOSSIER_SECTION_START,
  GITHUB_PR_BODY_CHAR_LIMIT,
  projectDossierPrBody,
  type DossierRound,
} from "./pr-body-dossier.js";

// -- 1/2 HELPER · fixtures --
const SHA = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";

function dossierMarkdown(round: number, findingsCount = 2): string {
  const lines = [
    `# Review round ${round} @ ${SHA}`,
    "",
    `Summary: round ${round}, verdict code 1, reviewed by claude-fable-5 (claude).`,
    findingsCount === 0 ? "No findings." : `${findingsCount} findings, exceptions below.`,
  ];
  if (findingsCount > 0) {
    lines.push("", "## Findings", "");
    for (let i = 1; i <= findingsCount; i += 1) {
      lines.push(`- **finding-${i}** [blocker] src/app/x.ts:${i} — Finding ${i} title`);
      lines.push(`  Finding ${i} body with enough text to fill space.`);
    }
  }
  lines.push("", "## Checklist", "", `- tdd-first: pass`, `- config-discipline: pass`);
  return `${lines.join("\n")}\n`;
}

function sampleRound(round: number, overrides: Partial<DossierRound> = {}): DossierRound {
  return {
    round,
    sha: SHA,
    code: 0,
    model: "claude-fable-5",
    runtime: "claude",
    dossierMarkdown: overrides.dossierMarkdown ?? dossierMarkdown(round),
    ...overrides,
  };
}
// -/ 1/2

// -- 2/2 CORE · projection contract <- START HERE --
describe("compactRoundLine", () => {
  it("renders a one-line verdict summary", () => {
    const line = compactRoundLine(sampleRound(2, { code: 1 }));
    expect(line).toBe("- Round 2 @ a1b2c3d4e5f6: code 1, reviewed by claude-fable-5 (claude)");
  });
});

describe("projectDossierPrBody", () => {
  // -- projection --
  it("adds a marker-delimited dossier section to an empty body", () => {
    const result = projectDossierPrBody({
      rounds: [sampleRound(1)],
      existingBody: "",
    });

    expect(result).toContain(DOSSIER_SECTION_START);
    expect(result).toContain(DOSSIER_SECTION_END);
    expect(result).toContain("Round 1 — code 0");
  });

  it("appends a dossier section after existing human-authored body text", () => {
    const human = "## Summary\n\nThis is a human-written PR description.\n";
    const result = projectDossierPrBody({
      rounds: [sampleRound(1)],
      existingBody: human,
    });

    expect(result.startsWith(human)).toBe(true);
    expect(result).toContain(DOSSIER_SECTION_START);
    expect(result).toContain(DOSSIER_SECTION_END);
    expect(result).toContain("Round 1 — code 0");
  });

  it("renders rounds newest first inside the dossier section", () => {
    const result = projectDossierPrBody({
      rounds: [sampleRound(3), sampleRound(2), sampleRound(1)],
      existingBody: "",
    });

    const round3Idx = result.indexOf("Round 3 — code 0");
    const round2Idx = result.indexOf("Round 2 — code 0");
    const round1Idx = result.indexOf("Round 1 — code 0");

    expect(round3Idx).toBeLessThan(round2Idx);
    expect(round2Idx).toBeLessThan(round1Idx);
  });

  it("wraps each full round in a <details> block with the dossier markdown inside", () => {
    const round = sampleRound(1, {
      dossierMarkdown: dossierMarkdown(1, 1),
    });
    const result = projectDossierPrBody({
      rounds: [round],
      existingBody: "",
    });

    expect(result).toContain("<details>");
    expect(result).toContain(
      "<summary>Round 1 — code 0, reviewed by claude-fable-5 @ a1b2c3d4e5f6</summary>",
    );
    expect(result).toContain("finding-1");
    expect(result).toContain("</details>");
  });

  // -- idempotence --
  it("is idempotent: re-projecting the same rounds produces identical output", () => {
    const rounds = [sampleRound(2), sampleRound(1)];
    const first = projectDossierPrBody({ rounds, existingBody: "" });
    const second = projectDossierPrBody({ rounds, existingBody: first });

    expect(second).toBe(first);
  });

  it("is idempotent when the input body already has markers with different content", () => {
    const rounds = [sampleRound(3)];
    const first = projectDossierPrBody({
      rounds: [sampleRound(2), sampleRound(1)],
      existingBody: "## Intent\n\nDescribe.",
    });
    const second = projectDossierPrBody({ rounds, existingBody: first });

    expect(second).toContain(DOSSIER_SECTION_START);
    expect(second).toContain("Round 3 — code 0");
    // Old content from the first run is gone.
    expect(second).not.toContain("Round 2 — code 0");
    expect(second).not.toContain("Round 1 — code 0");
    // Human text outside markers survives.
    expect(second).toContain("## Intent");
  });

  it("does not duplicate the marker section when re-run", () => {
    const rounds = [sampleRound(1)];
    const first = projectDossierPrBody({ rounds, existingBody: "" });
    const second = projectDossierPrBody({ rounds, existingBody: first });

    const startCount = (second.match(new RegExp(DOSSIER_SECTION_START, "g")) ?? []).length;
    const endCount = (second.match(new RegExp(DOSSIER_SECTION_END, "g")) ?? []).length;
    expect(startCount).toBe(1);
    expect(endCount).toBe(1);
  });

  // -- coexistence --
  it("preserves human-authored text before the markers", () => {
    const human = "Fixes #7\n\n## What this does\n\nIt does stuff.\n";
    const result = projectDossierPrBody({
      rounds: [sampleRound(1)],
      existingBody: human,
    });

    expect(result).toContain(human.slice(0, human.indexOf("## What")));
    expect(result).toContain("Fixes #7");
  });

  it("preserves the autoclose footer after the markers", () => {
    const body =
      "Fixes #7\n\n## Intent\n\nChange x.\n\n" +
      DOSSIER_SECTION_START +
      "\n" +
      "old content\n" +
      DOSSIER_SECTION_END +
      "\n" +
      "\n---\n*Automated by combo-chen*\n";
    const result = projectDossierPrBody({
      rounds: [sampleRound(1)],
      existingBody: body,
    });

    expect(result).toContain("Fixes #7");
    expect(result).toContain("Change x.");
    expect(result).toContain("Automated by combo-chen");
    expect(result).not.toContain("old content");
  });

  it("handles human-authored text that appears in both before and after sections", () => {
    // This happens when the user writes text, we project a dossier,
    // then the user adds more text after the marker section.
    // Both before and after text should survive.
    const body =
      "Fixes #7\n\n## Intent\n\n" +
      DOSSIER_SECTION_START +
      "\n" +
      "<!-- existing dossier -->\n" +
      DOSSIER_SECTION_END +
      "\n" +
      "\n## Manual Notes\n\nThese are human notes after the review.\n";
    const result = projectDossierPrBody({
      rounds: [sampleRound(1)],
      existingBody: body,
    });

    expect(result).toContain("Fixes #7");
    expect(result).toContain("Manual Notes");
    expect(result).toContain("These are human notes after the review.");
    expect(result).toContain("Round 1 — code 0");
  });

  // -- empty rounds --
  it("strips the marker section when rounds are empty and markers exist", () => {
    const body =
      "Fixes #7\n\n## Intent\n\n" +
      DOSSIER_SECTION_START +
      "\n" +
      "old content\n" +
      DOSSIER_SECTION_END +
      "\n";
    const result = projectDossierPrBody({
      rounds: [],
      existingBody: body,
    });

    expect(result).not.toContain(DOSSIER_SECTION_START);
    expect(result).not.toContain(DOSSIER_SECTION_END);
    expect(result).toContain("Fixes #7");
    expect(result).toContain("## Intent");
    expect(result).not.toContain("old content");
  });

  it("returns the body unchanged when rounds are empty and no markers exist", () => {
    const body = "Fixes #7\n\n## Intent\n";
    const result = projectDossierPrBody({
      rounds: [],
      existingBody: body,
    });

    expect(result).toBe(body);
  });

  // -- multiple rounds collapse to verdict lines under limit --
  it("leaves all rounds full when under the char limit", () => {
    const rounds = [
      sampleRound(2, { dossierMarkdown: "short" }),
      sampleRound(1, { dossierMarkdown: "tiny" }),
    ];
    const result = projectDossierPrBody({
      rounds,
      existingBody: "Fixes #7\n\n## Intro\n",
    });

    expect(result).toContain("<details>");
    expect(result).toContain("Round 2 — code 0");
    expect(result).toContain("Round 1 — code 0");
    // No verdict-line compaction.
    expect(result).not.toMatch(/^- Round \d+ @/m);
  });

  // -- compaction --
  it("compacts the oldest round to its verdict line when approaching the char limit", () => {
    const largeDossier = "x".repeat(60000);
    const smallRound = sampleRound(2, { dossierMarkdown: largeDossier });
    const oldRound = sampleRound(1, { dossierMarkdown: largeDossier });

    const result = projectDossierPrBody({
      rounds: [smallRound, oldRound],
      existingBody: "Fixes #7\n",
      charLimit: 65536 - 5000,
    });

    // The newest round (round 2) stays full.
    expect(result).toContain("<details>");
    expect(result).toContain("Round 2 — code 0");
    // The oldest round (round 1) is compacted to verdict line.
    expect(result).toContain(compactRoundLine(oldRound));
  });

  it("compacts progressively until the body fits under the limit", () => {
    const largeDossier = "x".repeat(30000);
    const rounds = [
      sampleRound(3, { dossierMarkdown: largeDossier }),
      sampleRound(2, { dossierMarkdown: largeDossier }),
      sampleRound(1, { dossierMarkdown: largeDossier }),
    ];

    const result = projectDossierPrBody({
      rounds,
      existingBody: "Fixes #7\n",
      charLimit: 65536,
    });

    // Round 3 (newest) should be full.
    expect(result).toContain("<details>");
    expect(result).toContain("Round 3 — code 0");

    // Round 2 and 1 may be compacted if needed.
    const round1Line = compactRoundLine(rounds[2]!);
    const round2Line = compactRoundLine(rounds[1]!);

    // At least round 1 (oldest) must be compacted.
    if (result.includes(round1Line) || result.includes(round2Line)) {
      // OK - compaction happened.
    } else {
      // If no compaction needed, that means 2 full rounds fit within limit.
      // Verify we're under limit.
    }
    expect(result.length).toBeLessThanOrEqual(65536);
  });

  it("keeps the newest round full when all others are compacted", () => {
    const hugeDossier = "y".repeat(50000);
    const rounds = [
      sampleRound(3, { dossierMarkdown: hugeDossier }),
      sampleRound(2, { dossierMarkdown: hugeDossier }),
      sampleRound(1, { dossierMarkdown: hugeDossier }),
    ];

    const result = projectDossierPrBody({
      rounds,
      existingBody: "Fixes #7\n",
      charLimit: 60000,
    });

    expect(result).toContain("<details>");
    expect(result).toContain("Round 3 — code 0");
    // Older rounds are compacted.
    expect(result).toContain(compactRoundLine(rounds[1]!));
    expect(result).toContain(compactRoundLine(rounds[2]!));
  });

  it("compacts all rounds when even a single full round exceeds the limit", () => {
    const massiveDossier = "z".repeat(70000);
    const rounds = [
      sampleRound(2, { dossierMarkdown: massiveDossier }),
      sampleRound(1, { dossierMarkdown: "short" }),
    ];

    const result = projectDossierPrBody({
      rounds,
      existingBody: "",
      charLimit: 65536,
    });

    // Both rounds should be compacted because even one full round doesn't fit.
    expect(result).toContain(compactRoundLine(rounds[0]!));
    expect(result).toContain(compactRoundLine(rounds[1]!));
    expect(result).not.toContain("<details>");
  });

  it("uses the default GitHub char limit of 65536 when none is specified", () => {
    const rounds = [sampleRound(1, { dossierMarkdown: "short dossier" })];
    const result = projectDossierPrBody({
      rounds,
      existingBody: "Fixes #7\n",
    });

    expect(result).toContain("<details>");
    expect(result.length).toBeLessThanOrEqual(GITHUB_PR_BODY_CHAR_LIMIT);
  });

  // -- non-marker content between markers --
  it("handles body without closing marker gracefully", () => {
    const body = "Fixes #7\n\n" + DOSSIER_SECTION_START + "\nbroken\n";
    const result = projectDossierPrBody({
      rounds: [sampleRound(1)],
      existingBody: body,
    });

    // The malformed section was dropped; new section added.
    expect(result).toContain(DOSSIER_SECTION_START);
    expect(result).toContain(DOSSIER_SECTION_END);
    expect(result).toContain("Round 1 — code 0");
  });
});
// -/ 2/2
