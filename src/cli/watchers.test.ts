/**
 * @overview Unit tests for watcher command helpers. ~65 lines, poll cadence and shell loop shape.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at buildDirectorWatchCommand tests <- director-watch retry/backoff shell.
 *   2. resolvePollMs tests                      <- optional env override.
 *
 *   MAIN FLOW
 *   ---------
 *   env/config input -> watcher helper -> shell command assertions
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   none
 *
 * @exports none
 * @deps vitest, ./watchers
 */
import { describe, expect, it } from "vitest";

import { buildDirectorWatchCommand, resolvePollMs } from "./watchers.js";

// -- 1/2 HELPER · resolvePollMs tests --
describe("resolvePollMs", () => {
  it("uses a positive COMBO_CHEN_POLL_MS value when present", () => {
    expect(resolvePollMs({ COMBO_CHEN_POLL_MS: "250" })).toBe(250);
    expect(resolvePollMs({ COMBO_CHEN_POLL_MS: "nonsense" })).toBeUndefined();
    expect(resolvePollMs({})).toBeUndefined();
  });
});
// -/ 1/2

// -- 2/2 CORE · buildDirectorWatchCommand tests <- START HERE --
describe("buildDirectorWatchCommand", () => {
  it("polls director-tick until terminal reviewer output appears", () => {
    const command = buildDirectorWatchCommand({
      cli: `node "/repo/dist/cli.mjs"`,
      comboHome: "/tmp/combo home",
      comboId: "owner-repo-7",
      pollSeconds: 12,
      watchFailureLimit: 3,
      watchBackoffMaxSeconds: 3600,
    });

    expect(command).toContain("failures=0");
    expect(command).toContain("backoff=12");
    expect(command).toContain(
      `output=$(COMBO_CHEN_HOME='/tmp/combo home' node "/repo/dist/cli.mjs" director-tick -n 'owner-repo-7' 2>&1)`,
    );
    expect(command).toContain("reviewer: transient_failure:");
    expect(command).toContain("watch_error");
    expect(command).toContain("watch_dead");
    expect(command).toContain("watcher=director");
    expect(command).not.toContain("watcher=reviewer");
    expect(command).toContain('[ "$failures" -ge 3 ]');
    expect(command).toContain('sleep "$backoff"');
  });
});
// -/ 2/2
