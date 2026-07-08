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
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("journals tick output verbatim in watch events, apostrophes included", () => {
    const dir = mkdtempSync(join(tmpdir(), "combo-chen-watchers-"));
    const emitLog = join(dir, "emit.log");
    const fakeCli = join(dir, "fake-cli");
    writeFileSync(
      fakeCli,
      `#!/bin/sh
if [ "$1" = "director-tick" ]; then
  printf "%s\\n" "it's broken"
  exit 1
fi
if [ "$1" = "emit" ]; then
  shift
  for arg in "$@"; do printf "%s\\n" "$arg" >> ${JSON.stringify(emitLog)}; done
fi
exit 0
`,
    );
    chmodSync(fakeCli, 0o755);

    const command = buildDirectorWatchCommand({
      cli: fakeCli,
      comboHome: dir,
      comboId: "owner-repo-7",
      pollSeconds: 0,
      watchFailureLimit: 1,
      watchBackoffMaxSeconds: 1,
    });
    const result = spawnSync("sh", ["-c", command], { encoding: "utf8", timeout: 10_000 });

    expect(result.status).toBe(1);
    const emitted = readFileSync(emitLog, "utf8");
    expect(emitted).toContain("stderr=it's broken");
    expect(emitted).not.toContain("\\''");
  });
});
// -/ 2/2
