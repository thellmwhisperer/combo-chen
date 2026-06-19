/**
 * @overview Canonical work-plan model and markdown normalization helpers.
 *   ~245 lines, 6 exports, pure data shaping for issue and plan sources.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at normalizeMarkdownWorkPlan      <- generic plan-file contract.
 *   2. Then normalizeGitHubIssueWorkPlan       <- issue facts adapt to plans.
 *   3. Finish with renderWorkPlanMarkdown      <- persisted artifact shape.
 *
 *   MAIN FLOW
 *   ---------
 *   source markdown or issue facts -> parseMarkdownSections -> WorkPlan -> rendered artifact
 *
 *   PUBLIC API
 *   ----------
 *   normalizeMarkdownWorkPlan      Parse a markdown plan into canonical fields.
 *   normalizeGitHubIssueWorkPlan   Adapt GitHub issue title/body into a WorkPlan.
 *   renderWorkPlanMarkdown         Render a stable markdown work-plan artifact.
 *   WorkPlanSourceType             Supported work item source type names.
 *   WorkPlanSource                 Source metadata stored with a WorkPlan.
 *   WorkPlan                       Canonical implementation plan contract.
 *
 *   INTERNALS
 *   ---------
 *   parseMarkdownSections, titleFromMarkdown, section aliases, renderSection
 *
 * @exports WorkPlanSourceType, WorkPlanSource, WorkPlan, normalizeMarkdownWorkPlan, normalizeGitHubIssueWorkPlan, renderWorkPlanMarkdown
 * @deps none
 */

// -- 1/3 HELPER · Types + heading aliases --
export type WorkPlanSourceType = "github_issue" | "local_file" | "inline_text" | "roca_item";

export interface WorkPlanSource {
  type: WorkPlanSourceType;
  reference: string;
}

export interface WorkPlan {
  title: string;
  source: WorkPlanSource;
  problem: string;
  scope: string;
  acceptanceCriteria: string;
  validation: string;
  outOfScope: string;
  intentDecisions: string;
  rawMarkdown: string;
}

interface MarkdownSections {
  title: string;
  byAlias: Map<string, string>;
}

const PROBLEM_HEADINGS = new Set([
  "problem",
  "context",
  "problem context",
  "problem / context",
  "background",
  "goal",
  "objective",
]);
const SCOPE_HEADINGS = new Set(["scope", "scope boundaries", "constraints"]);
const ACCEPTANCE_HEADINGS = new Set([
  "acceptance criteria",
  "acceptance criterion",
  "criteria",
  "done",
  "definition of done",
]);
const VALIDATION_HEADINGS = new Set([
  "validation",
  "validation commands",
  "validation expectations",
  "tests",
  "test plan",
]);
const OUT_OF_SCOPE_HEADINGS = new Set([
  "out of scope",
  "out-of-scope",
  "non goals",
  "non-goals",
  "non goal",
  "non-goal",
]);
const INTENT_HEADINGS = new Set([
  "human intent decisions",
  "intent decisions",
  "product intent decisions",
  "must not change",
]);
const RENDER_SENTINEL = "_Not specified._";
// -/ 1/3

// -- 2/3 CORE · Normalization <- START HERE --
export function normalizeMarkdownWorkPlan(input: {
  markdown: string;
  source: WorkPlanSource;
  requireAcceptanceCriteria?: boolean;
}): WorkPlan {
  const parsed = parseMarkdownSections(input.markdown);
  const plan: WorkPlan = {
    title: parsed.title,
    source: input.source,
    problem: unsentinel(section(parsed, PROBLEM_HEADINGS)),
    scope: unsentinel(section(parsed, SCOPE_HEADINGS)),
    acceptanceCriteria: unsentinel(section(parsed, ACCEPTANCE_HEADINGS)),
    validation: unsentinel(section(parsed, VALIDATION_HEADINGS)),
    outOfScope: unsentinel(section(parsed, OUT_OF_SCOPE_HEADINGS)),
    intentDecisions: unsentinel(section(parsed, INTENT_HEADINGS)),
    rawMarkdown: input.markdown,
  };

  if (plan.title === "") {
    throw new Error("Work plan must include a title or first markdown heading");
  }
  if (input.requireAcceptanceCriteria !== false && plan.acceptanceCriteria === "") {
    throw new Error("Work plan must include acceptance criteria before agents can launch");
  }

  return plan;
}

export function normalizeGitHubIssueWorkPlan(input: {
  issueUrl: string;
  title: string;
  body: string;
}): WorkPlan {
  const markdown = input.body.trim() === "" ? `# ${input.title}` : `# ${input.title}\n\n${input.body}`;
  return normalizeMarkdownWorkPlan({
    markdown,
    source: { type: "github_issue", reference: input.issueUrl },
    requireAcceptanceCriteria: false,
  });
}
// -/ 2/3

// -- 3/3 HELPER · Markdown parsing + rendering --
function parseMarkdownSections(markdown: string): MarkdownSections {
  const lines = markdown.split(/\r?\n/);
  let title = "";
  let currentHeading = "";
  let currentLines: string[] = [];
  let currentLevel = 0;
  const byAlias = new Map<string, string>();

  const flush = (): void => {
    if (currentHeading === "") return;
    const body = currentLines.join("\n").trim();
    byAlias.set(normalizeHeading(currentHeading), body);
    currentHeading = "";
    currentLevel = 0;
  };

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      const level = heading[1]!.length;
      const text = stripMarkdownInline(heading[2] ?? "").trim();

      if (level === 1) {
        flush();
        if (title === "") title = text;
        continue;
      }

      if (level <= currentLevel) {
        flush();
      }

      if (currentHeading !== "" && level > currentLevel) {
        currentLines.push(line);
      } else {
        currentHeading = text;
        currentLevel = level;
        currentLines = [];
      }
      continue;
    }
    if (currentHeading !== "") currentLines.push(line);
  }
  flush();

  if (title === "") title = titleFromMarkdown(markdown);
  return { title, byAlias };
}

function titleFromMarkdown(markdown: string): string {
  for (const line of markdown.split(/\r?\n/)) {
    const stripped = stripMarkdownInline(line.replace(/^[-*]\s+/, "")).trim();
    if (stripped !== "") return stripped;
  }
  return "";
}

function normalizeHeading(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function stripMarkdownInline(value: string): string {
  return value.replace(/^#+\s*/, "").replace(/[*_`]/g, "");
}

function section(parsed: MarkdownSections, aliases: Set<string>): string {
  for (const [heading, body] of parsed.byAlias) {
    if (aliases.has(heading)) return body;
  }
  return "";
}

function renderSection(title: string, body: string): string[] {
  return [`## ${title}`, body.trim() === "" ? RENDER_SENTINEL : body.trim()];
}

function unsentinel(value: string): string {
  return value === RENDER_SENTINEL ? "" : value;
}

export function renderWorkPlanMarkdown(plan: WorkPlan): string {
  return [
    `# ${plan.title}`,
    "",
    `Source: ${plan.source.type} ${plan.source.reference}`,
    "",
    ...renderSection("Problem / Context", plan.problem),
    "",
    ...renderSection("Scope Boundaries", plan.scope),
    "",
    ...renderSection("Acceptance Criteria", plan.acceptanceCriteria),
    "",
    ...renderSection("Validation", plan.validation),
    "",
    ...renderSection("Out Of Scope", plan.outOfScope),
    "",
    ...renderSection("Human Intent Decisions", plan.intentDecisions),
    "",
  ].join("\n");
}
// -/ 3/3
