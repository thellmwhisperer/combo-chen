/**
 * @overview Tests for canonical work-plan normalization. ~140 lines, no exports.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at normalizeMarkdownWorkPlan tests <- plan-file contract.
 *   2. Then normalizeGitHubIssueWorkPlan       <- issue compatibility shape.
 *   3. Finish with renderWorkPlanMarkdown      <- persisted artifact shape.
 *
 *   MAIN FLOW
 *   ---------
 *   markdown or issue facts -> normalize work plan -> render stable artifact
 *
 *   PUBLIC API
 *   ----------
 *   none
 *
 *   INTERNALS
 *   ---------
 *   none
 *
 * @exports none
 * @deps vitest, ./work-plan
 */
import { describe, expect, it } from "vitest";

import {
  normalizeGitHubIssueWorkPlan,
  normalizeMarkdownWorkPlan,
  renderWorkPlanMarkdown,
} from "./work-plan.js";

// -- 1/1 CORE · canonical work-plan contract <- START HERE --
describe("work-plan normalization", () => {
  it("normalizes a local markdown plan into canonical fields", () => {
    const plan = normalizeMarkdownWorkPlan({
      markdown: [
        "# Let plans launch combos",
        "",
        "## Problem",
        "GitHub issues are currently the only work item carrier.",
        "",
        "## Scope Boundaries",
        "- Accept a local markdown plan.",
        "- Keep GitHub issue support.",
        "",
        "## Acceptance Criteria",
        "- `combo-chen run --plan plan.md --repo .` launches without an issue.",
        "- The run records a normalized plan artifact.",
        "",
        "## Validation Commands",
        "- `pnpm test`",
        "- `pnpm typecheck`",
        "",
        "## Non-goals",
        "- Do not require TOML frontmatter.",
        "",
        "## Human Intent Decisions",
        "- Do not invent missing acceptance criteria.",
      ].join("\n"),
      source: { type: "local_file", reference: "plans/issue-134.md" },
    });

    expect(plan).toMatchObject({
      title: "Let plans launch combos",
      source: { type: "local_file", reference: "plans/issue-134.md" },
      problem: "GitHub issues are currently the only work item carrier.",
      scope: "- Accept a local markdown plan.\n- Keep GitHub issue support.",
      acceptanceCriteria:
        "- `combo-chen run --plan plan.md --repo .` launches without an issue.\n" +
        "- The run records a normalized plan artifact.",
      validation: "- `pnpm test`\n- `pnpm typecheck`",
      outOfScope: "- Do not require TOML frontmatter.",
      intentDecisions: "- Do not invent missing acceptance criteria.",
    });
  });

  it("fails fast when a generic markdown plan lacks acceptance criteria", () => {
    expect(() =>
      normalizeMarkdownWorkPlan({
        markdown: [
          "# Ambiguous plan",
          "",
          "## Problem",
          "There is work to do, but no bounded done signal.",
        ].join("\n"),
        source: { type: "local_file", reference: "plan.md" },
      }),
    ).toThrow(/acceptance criteria/i);
  });

  it("extracts canonical sections nested below wrapper headings", () => {
    const plan = normalizeMarkdownWorkPlan({
      markdown: [
        "# Nested plan",
        "",
        "## Planning Notes",
        "These notes are just a wrapper.",
        "",
        "### Acceptance Criteria",
        "- Nested canonical headings still count.",
        "",
        "### Validation Commands",
        "- `pnpm test`",
      ].join("\n"),
      source: { type: "local_file", reference: "plans/nested.md" },
    });

    expect(plan.acceptanceCriteria).toBe("- Nested canonical headings still count.");
    expect(plan.validation).toBe("- `pnpm test`");
  });

  it("normalizes GitHub issue facts without requiring a new issue-specific consumer", () => {
    const plan = normalizeGitHubIssueWorkPlan({
      issueUrl: "https://github.com/o/r/issues/134",
      title: "Accept generic plans",
      body: "## Problem\nIssue bodies are one plan carrier.\n\n## Acceptance Criteria\n- Issue runs still work.",
    });

    expect(plan.title).toBe("Accept generic plans");
    expect(plan.source).toEqual({
      type: "github_issue",
      reference: "https://github.com/o/r/issues/134",
    });
    expect(plan.problem).toBe("Issue bodies are one plan carrier.");
    expect(plan.acceptanceCriteria).toBe("- Issue runs still work.");
  });

  it("renders a stable work-plan artifact from normalized fields", () => {
    const plan = normalizeGitHubIssueWorkPlan({
      issueUrl: "https://github.com/o/r/issues/134",
      title: "Accept generic plans",
      body: "## Acceptance Criteria\n- Issue runs still work.",
    });

    const artifact = renderWorkPlanMarkdown(plan);
    expect(artifact).toContain("# Accept generic plans\n\nSource: github_issue https://github.com/o/r/issues/134");
    expect(artifact).toContain("## Problem / Context\n_Not specified._");
    expect(artifact).toContain("## Acceptance Criteria\n- Issue runs still work.");
    expect(artifact).toContain("## Human Intent Decisions\n_Not specified._");
  });
});
// -/ 1/1
