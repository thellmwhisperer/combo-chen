/**
 * @overview Gatekeeper adapter: invokes no-mistakes' blocking agent
 *   interface. Expands {placeholders} in commands, prepares push-safe
 *   base64 intent, and reads TOON outcomes tolerantly. ~390 lines, 8 exports.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at buildGatekeeperInvocation ← the command the runner executes
 *   2. buildIssuePrIntent / buildWorkPlanPrIntent ← PR intent shape
 *   3. buildNoMistakesPushIntent           ← base64 intent for git push options
 *   4. ensureIssueAutocloseInPrBody        ← injects "Fixes #N" into PR body
 *   5. parseAxiOutcome                     ← read no-mistakes outcome line
 *   6. visiblePrBodyMarkdown               ← HTML/Markdown visibility parser
 *
 *   MAIN FLOW
 *   ─────────
 *   cli/main.ts → buildGatekeeperInvocation({gatekeeperCommand, combo, issueTitle, issueBody}) or buildGatekeeperInvocation({gatekeeperCommand, combo, workPlan})
 *     → buildIssuePrIntent → shellQuote placeholders
 *     → runner.sh executes the command
 *     → no-mistakes axi run → TOON outcome → parseAxiOutcome
 *
 *   ┌─ PUBLIC API ──────────────────────────────────────────────────────────┐
 *   │ GatekeeperInput            Gatekeeper command + combo/workPlan vars    │
 *   │ buildGatekeeperInvocation  Expand {placeholders} in gatekeeper command │
 *   │ buildIssuePrIntent         Format issue facts + PR autoclose contract  │
 *   │ buildWorkPlanPrIntent      Format generic work-plan PR intent          │
 *   │ buildNoMistakesPushIntent  Base64 encode intent for git push option    │
 *   │ ensureIssueAutocloseInPrBody Inject "Fixes #N" if missing from PR body │
 *   │ hasIssueAutocloseInPrBody  Check if PR body already autocloses issue   │
 *   │ parseAxiOutcome            Extract TOON "outcome:" line from raw text  │
 *   ├─ INTERNALS ───────────────────────────────────────────────────────────┤
 *   │ visiblePrBodyMarkdown, escapeRegExp, shell command segment helpers,    │
 *   │ isEscaped, replaceGatekeeperPlaceholders, PLACEHOLDER,                 │
 *   │ KNOWN_GATEKEEPER_PLACEHOLDERS, MAX_INTENT_BODY_LENGTH,                 │
 *   │ MAX_PUSH_INTENT_INPUT, AUTOCLOSE_KEYWORDS                              │
 *   └────────────────────────────────────────────────────────────────────────┘
 *
 * @exports GatekeeperInput, buildIssuePrIntent, buildWorkPlanPrIntent, buildNoMistakesPushIntent, hasIssueAutocloseInPrBody, ensureIssueAutocloseInPrBody, buildGatekeeperInvocation, parseAxiOutcome
 * @deps ../core/state, ../core/combo, ../core/work-plan, ../infra/config
 */
import type { ComboRecord } from "../core/state.js";
import { parseIssueUrl } from "../core/state.js";
import { shellQuote } from "../core/combo.js";
import { renderWorkPlanMarkdown, type WorkPlan } from "../core/work-plan.js";
import { ComboConfigError } from "../infra/config.js";

// -- 1/3 CORE · GatekeeperInput + constants + buildIssuePrIntent --
export interface GatekeeperInput {
  gatekeeperCommand: string;
  combo?: Pick<ComboRecord, "branch" | "issueUrl">;
  issueTitle?: string;
  issueBody?: string;
  workPlan?: WorkPlan;
}

const PLACEHOLDER = /(?<!\$)\{([a-z_]+)\}/g;
const KNOWN_GATEKEEPER_PLACEHOLDERS = new Set([
  "issue_url",
  "issue_title",
  "issue_body",
  "issue_pr_intent",
  "branch",
]);

const MAX_INTENT_BODY_LENGTH = 8000;
const MAX_PUSH_INTENT_INPUT = 4000;
const AUTOCLOSE_KEYWORDS = "(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)";
const NO_MISTAKES_AXI_RUN_AT_START = /^no-mistakes\s+axi\s+run\b/;
const GATEKEEPER_INTENT_ENV = "COMBO_CHEN_GATEKEEPER_INTENT_B64";
const DECODE_GATEKEEPER_INTENT_JS =
  `process.stdout.write(Buffer.from(process.env.${GATEKEEPER_INTENT_ENV} || "", "base64").toString("utf8"))`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type PlaceholderQuoteContext = "single" | "double" | "unquoted";

function isBackslashEscaped(value: string, index: number): boolean {
  let count = 0;
  for (let i = index - 1; i >= 0 && value[i] === "\\"; i -= 1) count += 1;
  return count % 2 === 1;
}

function placeholderQuoteContext(template: string, index: number): PlaceholderQuoteContext {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < index; i += 1) {
    const char = template[i];
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (char === '"' && !inSingle && !isBackslashEscaped(template, i)) {
      inDouble = !inDouble;
    }
  }
  if (inSingle) return "single";
  if (inDouble) return "double";
  return "unquoted";
}

function shellDecodedIntentSubstitution(intent: string): string {
  const encoded = Buffer.from(intent, "utf8").toString("base64");
  return `$(${GATEKEEPER_INTENT_ENV}=${shellQuote(encoded)} node -e ${shellQuote(DECODE_GATEKEEPER_INTENT_JS)})`;
}

function quotePlaceholderValue(template: string, index: number, name: string, value: string): string {
  const context = placeholderQuoteContext(template, index);
  if (name === "issue_pr_intent") {
    const substitution = shellDecodedIntentSubstitution(value);
    if (context === "double") return substitution;
    if (context === "single") return `'"${substitution}"'`;
    return `"${substitution}"`;
  }
  if (context === "single") return value.replace(/'/g, "'\\''");
  if (context === "double") return value.replace(/["\\$`]/g, "\\$&");
  return shellQuote(value);
}

function replaceGatekeeperPlaceholders(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(PLACEHOLDER, (_match, name: string, offset: number) => {
    const value = vars[name];
    if (value === undefined) {
      throw new ComboConfigError(`Gatekeeper placeholder {${name}} is not available`);
    }
    return quotePlaceholderValue(template, offset, name, value);
  });
}

// Single source of truth for the gate's `{issue_pr_intent}`. The `intent` CLI
// command prints this verbatim for inspection and forensics, so its output
// stays identical to what the gate actually pushes.
export function buildIssuePrIntent(input: {
  combo: Pick<ComboRecord, "issueUrl">;
  issueTitle: string;
  issueBody: string;
}): string {
  const issue = parseIssueUrl(input.combo.issueUrl);
  const autocloseLine = `Fixes #${issue.number}`;
  const intent = [
    `Implement GitHub issue ${input.combo.issueUrl}.`,
    "",
    `Title: ${input.issueTitle}`,
    "",
    "Pull request body requirement:",
    "Include this exact visible line verbatim in the PR body, outside comments, code blocks, or collapsed details:",
    autocloseLine,
  ];
  const body = input.issueBody.trim();
  if (body !== "") {
    const truncated = body.length > MAX_INTENT_BODY_LENGTH
      ? `${body.slice(0, MAX_INTENT_BODY_LENGTH)}\n...`
      : body;
    intent.push("", "Issue body:", truncated);
  }
  return intent.join("\n");
}

export function buildWorkPlanPrIntent(plan: WorkPlan): string {
  return [
    `Implement work plan ${plan.title}.`,
    "",
    `Source: ${plan.source.type} ${plan.source.reference}`,
    "",
    "Pull request body requirement:",
    "Describe the work-plan source and completed acceptance criteria; never include GitHub autoclose keywords (for example Fixes/Closes/Resolves `#N` or owner/repo#N) for plan-backed PRs. If the plan asks to close an issue, call that out for a human instead.",
    "",
    "Work plan:",
    renderWorkPlanMarkdown(plan).trim(),
  ].join("\n");
}

export function buildNoMistakesPushIntent(intent: string): string {
  const capped = intent.length > MAX_PUSH_INTENT_INPUT
    ? `${intent.slice(0, MAX_PUSH_INTENT_INPUT - 3)}...`
    : intent;
  return Buffer.from(capped, "utf8").toString("base64");
}
// -/ 1/3

function stripShellQuotes(value: string): string {
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function skipValueHasCi(value: string): boolean {
  return stripShellQuotes(value).split(",").some((item) => item.trim() === "ci");
}

function appendCiToSkipValue(value: string): string {
  if (skipValueHasCi(value)) return value;
  if (value.startsWith("'") && value.endsWith("'")) {
    return `'${value.slice(1, -1)},ci'`;
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return `"${value.slice(1, -1)},ci"`;
  }
  return `${value},ci`;
}

function isEscaped(value: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && value[i] === "\\"; i--) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function isRunnableNoMistakesTokenStart(command: string, index: number): boolean {
  if (index === 0) return true;
  const previous = command[index - 1]!;
  return /\s/.test(previous) || previous === "/" || previous === ";" || previous === "&" || previous === "|";
}

function findShellSegmentEnd(command: string, start: number): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = start; i < command.length; i++) {
    const c = command[i];
    if (c === "'" && !inDouble && !isEscaped(command, i)) { inSingle = !inSingle; continue; }
    if (c === '"' && !inSingle && !isEscaped(command, i)) { inDouble = !inDouble; continue; }
    if (inSingle || inDouble) continue;
    if (c === ";" || c === "\n" || c === "|") return i;
    if (c === "&" && command[i + 1] === "&") return i;
  }
  return command.length;
}

function findNoMistakesAxiRunSegment(command: string): { start: number; end: number } | null {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'" && !inDouble && !isEscaped(command, i)) { inSingle = !inSingle; continue; }
    if (c === '"' && !inSingle && !isEscaped(command, i)) { inDouble = !inDouble; continue; }
    if (inSingle || inDouble) continue;
    if (!isRunnableNoMistakesTokenStart(command, i)) continue;
    if (!NO_MISTAKES_AXI_RUN_AT_START.test(command.slice(i))) continue;
    return { start: i, end: findShellSegmentEnd(command, i) };
  }
  return null;
}

function findSkipFlag(command: string): { fullStart: number; prefix: string; value: string; fullLength: number } | null {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'" && !inDouble && !isEscaped(command, i)) { inSingle = !inSingle; continue; }
    if (c === '"' && !inSingle && !isEscaped(command, i)) { inDouble = !inDouble; continue; }
    if (inSingle || inDouble) continue;
    if (i > 0 && !/\s/.test(command.charAt(i - 1))) continue;

    const rest = command.slice(i);
    const eq = /^--skip=("[^"]*"|'[^']*'|[^\s]+)/.exec(rest);
    if (eq) {
      const fullStart = i === 0 ? 0 : i - 1;
      const fullLength = eq[0].length + (i === 0 ? 0 : 1);
      return { fullStart, prefix: "--skip=", value: eq[1]!, fullLength };
    }
    const sp = /^--skip\s+("[^"]*"|'[^']*'|[^\s]+)/.exec(rest);
    if (sp) {
      const fullStart = i === 0 ? 0 : i - 1;
      const fullLength = sp[0].length + (i === 0 ? 0 : 1);
      return { fullStart, prefix: "--skip ", value: sp[1]!, fullLength };
    }
  }
  return null;
}

function forceNoMistakesPublishOnly(command: string): string {
  const segmentRange = findNoMistakesAxiRunSegment(command);
  if (segmentRange === null) return command;

  const segment = command.slice(segmentRange.start, segmentRange.end);
  const flag = findSkipFlag(segment);
  let rewrittenSegment: string;
  if (flag !== null) {
    const beforeFlag = segment.slice(0, flag.fullStart);
    const afterFlag = segment.slice(flag.fullStart + flag.fullLength);
    const ws = flag.fullStart === 0 ? "" : segment[flag.fullStart];
    rewrittenSegment = beforeFlag + ws + flag.prefix + appendCiToSkipValue(flag.value) + afterFlag;
  } else {
    const trailingWhitespace = /\s*$/.exec(segment)?.[0] ?? "";
    const body = segment.slice(0, segment.length - trailingWhitespace.length);
    rewrittenSegment = `${body} --skip=ci${trailingWhitespace}`;
  }

  return command.slice(0, segmentRange.start) + rewrittenSegment + command.slice(segmentRange.end);
}

// -- 2/3 HELPER · PR body visibility + autoclose --
function visiblePrBodyMarkdown(body: string): string {
  const visible: string[] = [];
  let inFence = false;
  let detailsDepth = 0;
  let inHtmlComment = false;

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    let remaining = line;
    while (inHtmlComment) {
      const close = remaining.indexOf("-->");
      if (close === -1) {
        remaining = "";
        break;
      }
      remaining = remaining.slice(close + 3);
      inHtmlComment = false;
    }

    let withoutComments = "";
    while (remaining !== "") {
      const open = remaining.indexOf("<!--");
      if (open === -1) {
        withoutComments += remaining;
        break;
      }
      withoutComments += remaining.slice(0, open);
      const afterOpen = remaining.slice(open + 4);
      const close = afterOpen.indexOf("-->");
      if (close === -1) {
        inHtmlComment = true;
        break;
      }
      remaining = afterOpen.slice(close + 3);
    }

    const withoutInlineCode = withoutComments.replace(/`[^`]*`/g, "");

    const opensDetails = /<details\b/i.test(withoutInlineCode);
    const closesDetails = /<\/details>/i.test(withoutInlineCode);
    if (opensDetails) detailsDepth += 1;

    if (detailsDepth === 0) visible.push(withoutInlineCode);

    if (closesDetails && detailsDepth > 0) detailsDepth -= 1;
  }

  return visible.join("\n");
}

export function hasIssueAutocloseInPrBody(
  body: string,
  combo: Pick<ComboRecord, "issueUrl">,
): boolean {
  if (combo.issueUrl.trim() === "") return false;
  const issue = parseIssueUrl(combo.issueUrl);
  const visible = visiblePrBodyMarkdown(body);
  const sameRepo = escapeRegExp(`${issue.owner}/${issue.repo}`);
  const issueRef = `(?:#${issue.number}|${sameRepo}#${issue.number})`;
  return new RegExp(`\\b${AUTOCLOSE_KEYWORDS}\\s+${issueRef}\\b`, "i").test(visible);
}

export function ensureIssueAutocloseInPrBody(
  body: string,
  combo: Pick<ComboRecord, "issueUrl">,
): string {
  if (combo.issueUrl.trim() === "") return body;
  if (hasIssueAutocloseInPrBody(body, combo)) return body;
  const issue = parseIssueUrl(combo.issueUrl);
  const line = `Fixes #${issue.number}`;
  return body.trim() === "" ? `${line}\n` : `${line}\n\n${body}`;
}
// -/ 2/3

// -- 3/3 CORE · buildGatekeeperInvocation + parseAxiOutcome ← START HERE --
export function buildGatekeeperInvocation(input: GatekeeperInput): string {
  let hasPlaceholders = false;
  for (const [, name] of input.gatekeeperCommand.matchAll(PLACEHOLDER)) {
    if (name === undefined) continue;
    hasPlaceholders = true;
    if (!KNOWN_GATEKEEPER_PLACEHOLDERS.has(name)) {
      throw new ComboConfigError(`Unknown gatekeeper placeholder {${name}} in command template`);
    }
  }
  if (!hasPlaceholders) return forceNoMistakesPublishOnly(input.gatekeeperCommand);
  if (input.combo === undefined) {
    throw new ComboConfigError("Gatekeeper command placeholders require work item facts (issue or work plan) during runner generation");
  }
  if (input.workPlan !== undefined) {
    const vars: Record<string, string | undefined> = {
      issue_pr_intent: buildWorkPlanPrIntent(input.workPlan),
      branch: input.combo.branch,
    };
    return forceNoMistakesPublishOnly(replaceGatekeeperPlaceholders(input.gatekeeperCommand, vars));
  }
  if (input.issueTitle === undefined || input.issueBody === undefined) {
    throw new ComboConfigError("Gatekeeper command placeholders require work item facts (issue or work plan) during runner generation");
  }
  const vars: Record<string, string> = {
    issue_url: input.combo.issueUrl,
    issue_title: input.issueTitle,
    issue_body: input.issueBody,
    issue_pr_intent: buildIssuePrIntent({
      combo: input.combo,
      issueTitle: input.issueTitle,
      issueBody: input.issueBody,
    }),
    branch: input.combo.branch,
  };
  return forceNoMistakesPublishOnly(replaceGatekeeperPlaceholders(input.gatekeeperCommand, vars));
}

const OUTCOME = /^outcome:\s*(.+)\s*$/m;

export function parseAxiOutcome(raw: string): string | undefined {
  const match = OUTCOME.exec(raw);
  return match?.[1]?.trim();
}
// -/ 3/3
