/**
 * @overview Gatekeeper adapter: invokes no-mistakes' blocking agent
 *   interface. Expands {placeholders} in commands and reads TOON outcomes
 *   tolerantly. ~170 lines, 6 exports.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at buildGatekeeperInvocation ← the command the runner executes
 *   2. buildIssuePrIntent                  ← the intent payload for no-mistakes
 *   3. ensureIssueAutocloseInPrBody        ← injects "Fixes #N" into PR body
 *   4. parseAxiOutcome                     ← read no-mistakes outcome line
 *   5. visiblePrBodyMarkdown               ← HTML/Markdown visibility parser
 *
 *   MAIN FLOW
 *   ─────────
 *   cli/main.ts → buildGatekeeperInvocation({gatekeeperCommand, combo, issueTitle, issueBody})
 *     → buildIssuePrIntent → shellQuote placeholders
 *     → runner.sh executes the command
 *     → no-mistakes axi run → TOON outcome → parseAxiOutcome
 *
 *   ┌─ PUBLIC API ──────────────────────────────────────────────────────────┐
 *   │ buildGatekeeperInvocation  Expand {placeholders} in gatekeeper command │
 *   │ buildIssuePrIntent         Format issue facts for no-mistakes intent   │
 *   │ ensureIssueAutocloseInPrBody Inject "Fixes #N" if missing from PR body │
 *   │ hasIssueAutocloseInPrBody  Check if PR body already autocloses issue   │
 *   │ parseAxiOutcome            Extract TOON "outcome:" line from raw text  │
 *   ├─ INTERNALS ───────────────────────────────────────────────────────────┤
 *   │ GatekeeperInput, visiblePrBodyMarkdown, escapeRegExp,                │
 *   │ PLACEHOLDER, KNOWN_GATEKEEPER_PLACEHOLDERS,                           │
 *   │ MAX_INTENT_BODY_LENGTH, AUTOCLOSE_KEYWORDS                            │
 *   └────────────────────────────────────────────────────────────────────────┘
 *
 * @exports GatekeeperInput, buildIssuePrIntent, hasIssueAutocloseInPrBody, ensureIssueAutocloseInPrBody, buildGatekeeperInvocation, parseAxiOutcome
 * @deps ../core/state, ../core/combo, ../infra/config
 */
import type { ComboRecord } from "../core/state.js";
import { parseIssueUrl } from "../core/state.js";
import { shellQuote } from "../core/combo.js";
import { ComboConfigError } from "../infra/config.js";

// -- 1/3 HELPER · GatekeeperInput + constants + buildIssuePrIntent --
export interface GatekeeperInput {
  gatekeeperCommand: string;
  combo?: Pick<ComboRecord, "branch" | "issueUrl">;
  issueTitle?: string;
  issueBody?: string;
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
const AUTOCLOSE_KEYWORDS = "(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildIssuePrIntent(input: {
  combo: Pick<ComboRecord, "issueUrl">;
  issueTitle: string;
  issueBody: string;
}): string {
  const issue = parseIssueUrl(input.combo.issueUrl);
  const intent = [
    `Implement GitHub issue ${input.combo.issueUrl}.`,
    "",
    `Title: ${input.issueTitle}`,
  ];
  const body = input.issueBody.trim();
  if (body !== "") {
    const truncated = body.length > MAX_INTENT_BODY_LENGTH
      ? `${body.slice(0, MAX_INTENT_BODY_LENGTH)}\n...`
      : body;
    intent.push("", "Issue body:", truncated);
  }
  intent.push("", `Fixes #${issue.number}`);
  return intent.join("\n");
}
// -/ 1/3

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
  if (!hasPlaceholders) return input.gatekeeperCommand;
  if (input.combo === undefined || input.issueTitle === undefined || input.issueBody === undefined) {
    throw new ComboConfigError("Gatekeeper command placeholders require issue facts during runner generation");
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
  return input.gatekeeperCommand.replace(PLACEHOLDER, (_match, name: string) => shellQuote(vars[name]!));
}

const OUTCOME = /^outcome:\s*(.+)\s*$/m;

export function parseAxiOutcome(raw: string): string | undefined {
  const match = OUTCOME.exec(raw);
  return match?.[1]?.trim();
}
// -/ 3/3
