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
  if (body !== "") intent.push("", "Issue body:", body);
  intent.push("", `Fixes #${issue.number}`);
  return intent.join("\n");
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
