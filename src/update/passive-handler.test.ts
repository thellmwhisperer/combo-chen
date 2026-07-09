/**
 * @overview Passive update application handler integration tests.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at the describe blocks  <- command contracts and their effects.
 *
 *   MAIN FLOW
 *   ---------
 *   shared fakeDeps -> createProgram -> extracted handler -> recorded effects
 *
 *   PUBLIC API
 *   ----------
 *   None (test file).
 *
 *   INTERNALS
 *   ---------
 *   Command-specific fixtures live inside their describe block.
 *
 * @exports none
 * @deps ../cli/main.test-harness
 */

import {
  ISSUE,
  PASSIVE_UPDATE_CACHE_FILE,
  PASSIVE_UPDATE_DISABLE_ENV,
  appendEvent,
  describe,
  exec,
  existsSync,
  expect,
  fakeDeps,
  home,
  it,
  join,
  runDirFor,
  writeCombo,
} from "../cli/main.test-harness.js";

// -- 1/1 CORE · command contracts <- START HERE --
describe("passive update handler", () => {
  it("runs passive update checks before public commands without polluting JSONL output", async () => {
    const root = home();
    const runDir = runDirFor(root, "o-r-7");
    writeCombo(runDir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repo",
      worktree: "/worktree",
      branch: "combo/issue-7",
      tmuxSession: "combo-7",
      createdAt: "2026-06-25T12:00:00.000Z",
    });
    const event = appendEvent(runDir, "combo_created", { issue_url: ISSUE });
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: root, [PASSIVE_UPDATE_DISABLE_ENV]: "0" },
      gh: (args) => {
        calls.push(["gh", ...args]);
        if (args[0] === "api" && args[1] === "repos/thellmwhisperer/combo-chen/releases?per_page=100") {
          return {
            status: 0,
            stdout: JSON.stringify([{ tag_name: "v0.0.1", prerelease: false, draft: false, assets: [] }]),
            stderr: "",
          };
        }
        return { status: 1, stdout: "", stderr: `unexpected gh call: ${args.join(" ")}` };
      },
    });

    await exec(deps, ["events", "-n", "o-r-7"]);

    expect(out).toEqual([JSON.stringify(event)]);
    expect(calls).toContainEqual(["gh", "api", "repos/thellmwhisperer/combo-chen/releases?per_page=100"]);
    expect(existsSync(join(root, PASSIVE_UPDATE_CACHE_FILE))).toBe(true);
  });

  it("does not let passive release lookup failures break public commands", async () => {
    const root = home();
    const runDir = runDirFor(root, "o-r-7");
    writeCombo(runDir, {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repo",
      worktree: "/worktree",
      branch: "combo/issue-7",
      tmuxSession: "combo-7",
      createdAt: "2026-06-25T12:00:00.000Z",
    });
    const event = appendEvent(runDir, "combo_created", { issue_url: ISSUE });
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: root, [PASSIVE_UPDATE_DISABLE_ENV]: "0" },
      gh: (args) => {
        calls.push(["gh", ...args]);
        return { status: 1, stdout: "", stderr: "offline" };
      },
    });

    await exec(deps, ["events", "-n", "o-r-7"]);

    expect(out).toEqual([JSON.stringify(event)]);
    expect(calls).toContainEqual(["gh", "api", "repos/thellmwhisperer/combo-chen/releases?per_page=100"]);
    expect(existsSync(join(root, PASSIVE_UPDATE_CACHE_FILE))).toBe(false);
  });
});
// -/ 1/1
