/**
 * @overview Sherpa: navigable code comment standard. Core logic for
 *   generating LLM prompts and auditing existing annotations.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at buildSherpaPrompt     ← generates the LLM prompt
 *   2. auditSherpa                    ← validates existing Sherpa docs
 *
 * @exports buildSherpaPrompt, auditSherpa, SherpaAuditResult, SherpaIssue
 */

export interface SherpaAuditResult {
  valid: boolean;
  issues: SherpaIssue[];
}

export interface SherpaIssue {
  kind: "missing_header" | "broken_exports" | "misnumbered" | "stale_sections" | "missing_core_marker" | "missing_start_here";
  detail: string;
}

const SHERPA_SPEC = `## Sherpa — navigable code comment standard

A commenting discipline for the agent era. Every source file gets two layers:

**Layer 1 — JSDoc header at the top of the file**

\`\`\`typescript
/**
 * @overview One-line summary. ~N lines, M exports, key responsibility.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at buildRunnerScript    ← why this one first (REAL name, not placeholder)
 *   2. deriveStatus                  ← secondary entry point
 *   3. Everything else is helpers    ← read on demand
 *
 *   MAIN FLOW
 *   ─────────
 *   main() → createProgram → parseAsync → dispatcher to .command()
 *
 *   ┌─ PUBLIC API ────────────────────────────────────────┐
 *   │ createProgram()   Builds the commander CLI           │
 *   │ defaultDeps()     Wires real OS dependencies         │
 *   ├─ INTERNALS ─────────────────────────────────────────┤
 *   │ coerce, parseFields, cliInvocation, remoteSlug, ...  │
 *   └──────────────────────────────────────────────────────┘
 *
 * @exports createProgram, defaultDeps, resolvePollMs
 * @deps commander, ../core/combo, ../infra/tmux
 */
\`\`\`

Rules:
- Always in English. NEVER use angle brackets, curly braces, or placeholder text like "helperOne" or "functionName()" — use REAL symbol names.
- READING GUIDE tells the reading order. First item is the CORE entry point.
- MAIN FLOW chains real functions: realName() → realName() → outcome.
- PUBLIC API table lists EVERY exported/public function with a one-line description.
- INTERNALS lists private helpers grouped by purpose. Use real names.
- @exports lists ONLY actually exported symbols. No parentheses, no private functions.
- @deps lists imports grouped by source.

**Layer 2 — Inline section markers**

\`\`\`
// -- N/M ROLE · Section name --

  ... code ...

// -/ N/M
\`\`\`

Rules:
- \`// -- N/M ROLE · Section name --\` opens a section.
- \`// -/ N/M\` closes it.
- ROLE is \`CORE\` (primary logic) or \`HELPER\` (supporting).
- The CORE section gets \`← START HERE\` appended.
- Keep sections roughly balanced. Aim for 3-7 sections.
- Section descriptions use real function names (Cmd+Clickable).
- Never apply to files under 80 lines.
- Never apply to generated files, config files, or test files.`;

// -- 1/2 CORE · Prompt generation ← START HERE --

export function buildSherpaPrompt(fileContent: string, filePath: string): string {
  return `You are an expert code documenter. Your task is to annotate the following source file with the Sherpa navigable comment standard.

${SHERPA_SPEC}

RULES FOR THIS FILE:
1. Add the JSDoc header at the very top of the file (after the shebang if present).
   REPLACE every example name in the template with REAL function names from this file.
   Do NOT copy "helperOne", "functionName()", "buildRunnerScript", "createProgram",
   or any other name that does not exist in THIS file.
2. Add inline section markers before each logical section. Format is EXACTLY:
   // -- N/M CORE · Description ← START HERE --
   // -/ N/M
   Replace N with the section number (1, 2, 3...).
   Replace M with the TOTAL section count (same on every marker, e.g. 7).
   CORE sections get "← START HERE" (exactly one section).
   HELPER sections do NOT get "← START HERE".
3. Replace any large existing JSDoc blocks on individual functions with short // purpose comments.
4. Keep existing inline comments that explain business logic.
5. Do NOT change ANY code. Not a single character. Only add/modify comments.
   If the code has import { join } from "node:path", do not remove it.
   If a function uses backtick template strings, do not change the syntax.
   Copy the code CHARACTER BY CHARACTER.
6. The line count of the file will increase by 40-80 lines (the header + markers).
7. @exports must list ONLY symbols with the \`export\` keyword in THIS file.
   No parentheses. No private/internal functions.
8. Return the COMPLETE annotated file. No explanations. No diff format.

FILE PATH: ${filePath}

FILE CONTENT:
${fileContent}

Return ONLY the annotated file content, no explanations.`;
}
// -/ 1/2

// -- 2/2 HELPER · Audit --

export function auditSherpa(fileContent: string): SherpaAuditResult {
  const issues: SherpaIssue[] = [];

  const hasHeader = /\/\*\*\s*\n\s*\*\s*@overview/.test(fileContent);
  if (!hasHeader) {
    issues.push({ kind: "missing_header", detail: "No JSDoc @overview header found" });
    return { valid: issues.length === 0, issues };
  }

  const exportMatch = fileContent.match(/@exports\s+([\s\S]*?)(?:\n\s*\*|$)/);
  if (exportMatch) {
    const listed = exportMatch[1]!.trim();
    const actualExports = [...fileContent.matchAll(/^export (?:async )?(?:function|const|class|interface|type) (\w+)/gm)]
      .map((m) => m[1]!);
    const missing = actualExports.filter((e) => !listed.includes(e));
    const extra = listed.split(/,\s*/).filter((e) => !actualExports.includes(e));
    if (missing.length > 0) {
      issues.push({ kind: "broken_exports", detail: `Missing from @exports: ${missing.join(", ")}` });
    }
    if (extra.length > 0 && extra[0] !== "") {
      issues.push({ kind: "broken_exports", detail: `Extra in @exports (not actual exports): ${extra.join(", ")}` });
    }
  }

  const markers = [...fileContent.matchAll(/\/\/ -- (\d+)\/(\d+)/g)];
  if (markers.length > 0) {
    const expected = markers.length;
    for (let i = 0; i < markers.length; i++) {
      const num = parseInt(markers[i]![1]!, 10);
      const total = parseInt(markers[i]![2]!, 10);
      if (num !== i + 1 || total !== expected) {
        issues.push({
          kind: "misnumbered",
          detail: `Marker "${markers[i]![0]}" should be "${i + 1}/${expected}"`,
        });
      }
    }
  }

  const hasStartHere = /← START HERE/.test(fileContent);
  if (!hasStartHere) {
    issues.push({ kind: "missing_start_here", detail: 'No "← START HERE" marker on CORE section' });
  }

  const hasCoreMarker = /\/\/ -- \d+\/\d+ CORE ·/.test(fileContent);
  if (!hasCoreMarker) {
    issues.push({ kind: "missing_core_marker", detail: "No CORE section marker found" });
  }

  return { valid: issues.length === 0, issues };
}
// -/ 2/2
