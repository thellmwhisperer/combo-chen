import { shellQuote } from "../core/combo.js";

/** Poll cadence cascade: COMBO_CHEN_POLL_MS env -> core's in-code fallback. */
export function resolvePollMs(env: Record<string, string | undefined>): number | undefined {
  const raw = env["COMBO_CHEN_POLL_MS"];
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function buildReviewerWatchCommand(input: {
  cli: string;
  comboHome: string;
  comboId: string;
  pollSeconds: number;
}): string {
  const env = `COMBO_CHEN_HOME=${shellQuote(input.comboHome)}`;
  return [
    "while :; do",
    `  output=$(${env} ${input.cli} reviewer-tick -n ${shellQuote(input.comboId)} 2>&1)`,
    "  rc=$?",
    '  printf "%s\\n" "$output"',
    `  printf "%s\\n" "$output" | grep -Eq ${shellQuote("reviewer: (merged|closed|already terminal)")} && exit 0`,
    '  [ "$rc" -eq 0 ] || exit "$rc"',
    `  sleep ${input.pollSeconds}`,
    "done",
  ].join("\n");
}
