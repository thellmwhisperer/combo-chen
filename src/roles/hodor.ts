/**
 * The hodor adapter: he holds the door. v0 invokes no-mistakes' blocking
 * agent interface and reads its TOON outcome tolerantly — we never parse
 * more of another product's output than we need.
 */
import type { ComboRecord } from "../core/state.js";
import { ComboConfigError, renderCommand } from "../infra/config.js";

export interface HodorInput {
  hodorCommand: string;
  combo?: Pick<ComboRecord, "branch" | "issueUrl">;
  issueTitle?: string;
  issueBody?: string;
}

const PLACEHOLDER = /\{([a-z_]+)\}/g;
const KNOWN_HODOR_PLACEHOLDERS = new Set(["issue_url", "issue_title", "issue_body", "branch"]);

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
  return renderCommand(input.hodorCommand, {
    issue_url: input.combo.issueUrl,
    issue_title: input.issueTitle,
    issue_body: input.issueBody,
    branch: input.combo.branch,
  });
}

const OUTCOME = /^outcome:\s*(.+)\s*$/m;

export function parseAxiOutcome(raw: string): string | undefined {
  const match = OUTCOME.exec(raw);
  return match?.[1]?.trim();
}
