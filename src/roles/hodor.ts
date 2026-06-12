/**
 * The hodor adapter: he holds the door. v0 invokes no-mistakes' blocking
 * agent interface and reads its TOON outcome tolerantly — we never parse
 * more of another product's output than we need.
 *
 * Hodor commands may contain {placeholders} (issue_url, issue_title,
 * issue_body, issue_pr_intent, branch) that are expanded with safely
 * quoted values at runner generation time. Commands without placeholders
 * are passed through byte-identically.
 */
import type { ComboRecord } from "../core/state.js";
import { parseIssueUrl } from "../core/state.js";
import { shellQuote } from "../core/combo.js";
import { ComboConfigError } from "../infra/config.js";

export interface HodorInput {
  hodorCommand: string;
  combo?: Pick<ComboRecord, "branch" | "issueUrl">;
  issueTitle?: string;
  issueBody?: string;
}

const PLACEHOLDER = /(?<!\$)\{([a-z_]+)\}/g;
const KNOWN_HODOR_PLACEHOLDERS = new Set([
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

export function buildHodorInvocation(input: HodorInput): string {
  let hasPlaceholders = false;
  for (const [, name] of input.hodorCommand.matchAll(PLACEHOLDER)) {
    if (name === undefined) continue;
    hasPlaceholders = true;
    if (!KNOWN_HODOR_PLACEHOLDERS.has(name)) {
      throw new ComboConfigError(`Unknown hodor placeholder {${name}} in command template`);
    }
  }
  if (!hasPlaceholders) return input.hodorCommand;
  if (input.combo === undefined || input.issueTitle === undefined || input.issueBody === undefined) {
    throw new ComboConfigError("Hodor command placeholders require issue facts during runner generation");
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
  return input.hodorCommand.replace(PLACEHOLDER, (_match, name: string) => shellQuote(vars[name]!));
}

const OUTCOME = /^outcome:\s*(.+)\s*$/m;

export function parseAxiOutcome(raw: string): string | undefined {
  const match = OUTCOME.exec(raw);
  return match?.[1]?.trim();
}
