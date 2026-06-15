import { describe, expect, it } from "vitest";

import { buildReviewerWatchCommand, resolvePollMs } from "./watchers.js";

describe("resolvePollMs", () => {
  it("uses a positive COMBO_CHEN_POLL_MS value when present", () => {
    expect(resolvePollMs({ COMBO_CHEN_POLL_MS: "250" })).toBe(250);
    expect(resolvePollMs({ COMBO_CHEN_POLL_MS: "nonsense" })).toBeUndefined();
    expect(resolvePollMs({})).toBeUndefined();
  });
});

describe("buildReviewerWatchCommand", () => {
  it("polls reviewer-tick until terminal reviewer output appears", () => {
    const command = buildReviewerWatchCommand({
      cli: `node "/repo/dist/cli.mjs"`,
      comboHome: "/tmp/combo home",
      comboId: "owner-repo-7",
      pollSeconds: 12,
    });

    expect(command).toBe(
      [
        "while :; do",
        `  output=$(COMBO_CHEN_HOME='/tmp/combo home' node "/repo/dist/cli.mjs" reviewer-tick -n 'owner-repo-7' 2>&1)`,
        "  rc=$?",
        '  printf "%s\\n" "$output"',
        `  printf "%s\\n" "$output" | grep -Eq 'reviewer: (merged|closed|already terminal)' && exit 0`,
        '  [ "$rc" -eq 0 ] || exit "$rc"',
        "  sleep 12",
        "done",
      ].join("\n"),
    );
  });
});
