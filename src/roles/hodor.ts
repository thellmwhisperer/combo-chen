/**
 * The hodor adapter: he holds the door. v0 invokes no-mistakes' blocking
 * agent interface and reads its TOON outcome tolerantly — we never parse
 * more of another product's output than we need.
 */
export interface HodorInput {
  hodorCommand: string;
}

export function buildHodorInvocation(input: HodorInput): string {
  return input.hodorCommand;
}

const OUTCOME = /^outcome:\s*(.+)\s*$/m;

export function parseAxiOutcome(raw: string): string | undefined {
  const match = OUTCOME.exec(raw);
  return match?.[1]?.trim();
}
