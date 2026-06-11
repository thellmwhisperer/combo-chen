/**
 * The hodor adapter: he holds the door. v0 invokes no-mistakes' blocking
 * agent interface and reads its TOON outcome tolerantly — we never parse
 * more of another product's output than we need.
 */
import { ComboConfigError } from "../infra/config.js";

export interface HodorInput {
  hodorCommand: string;
}

const PLACEHOLDER = /\{([a-z_]+)\}/g;
const KNOWN_HODOR_PLACEHOLDERS = new Set(["issue_url", "issue_title", "issue_body", "branch"]);

export function buildHodorInvocation(input: HodorInput): string {
  for (const [, name] of input.hodorCommand.matchAll(PLACEHOLDER)) {
    if (name === undefined) continue;
    if (!KNOWN_HODOR_PLACEHOLDERS.has(name)) {
      throw new ComboConfigError(`Unknown hodor placeholder {${name}} in command template`);
    }
  }
  return input.hodorCommand;
}

const OUTCOME = /^outcome:\s*(.+)\s*$/m;

export function parseAxiOutcome(raw: string): string | undefined {
  const match = OUTCOME.exec(raw);
  return match?.[1]?.trim();
}
