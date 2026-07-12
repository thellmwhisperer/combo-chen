/**
 * @overview Director application handler integration tests: remaining command contracts.
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
 * @deps ../../testing/cli-harness
 */

import {
  ISSUE,
  buildRuntimeLedger,
  describe,
  exec,
  expect,
  fakeDeps,
  home,
  it,
  readEvents,
  runDirFor,
  writeCombo,
  writeRuntimeLedger,
} from "../../testing/cli-harness.js";

// -- 1/1 CORE · command contracts <- START HERE --
describe("director-prompt", () => {
  it("sends a director prompt command through tmux and journals it", async () => {
    const h = home();
    const dir = runDirFor(h, "o-r-7");
    const record = {
      id: "o-r-7",
      issueUrl: ISSUE,
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    };
    writeCombo(dir, record);
    writeRuntimeLedger(
      dir,
      buildRuntimeLedger({
        combo: record,
        runDir: dir,
        cli: "combo-chen",
        roleWindows: { director: "director" },
      }),
    );
    const { deps, calls, out } = fakeDeps({
      env: { COMBO_CHEN_HOME: h },
      tmux: (args) => {
        calls.push(["tmux", ...args]);
        if (args[0] === "list-windows") {
          return { status: 0, stdout: "coder\ndirector\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await exec(deps, [
      "director-prompt",
      "-n",
      "o-r-7",
      "--reason",
      "ambiguous_signal",
      "Inspect",
      "the",
      "gate",
      "signal",
    ]);

    expect(calls).toContainEqual([
      "tmux",
      "paste-buffer",
      "-d",
      "-b",
      "combo-chen-nudge-combo-chen-o-r-7-director",
      "-t",
      "combo-chen-o-r-7:director",
    ]);
    expect(readEvents(dir).at(-1)).toMatchObject({
      event: "director_prompted",
      reason: "ambiguous_signal",
      target: "combo-chen-o-r-7:director",
      prompt_preview: expect.stringContaining("Inspect the gate signal"),
    });
    expect(out).toEqual(["director-prompt: prompted combo-chen-o-r-7:director for o-r-7 (ambiguous_signal)"]);
  });
});
// -/ 1/1
