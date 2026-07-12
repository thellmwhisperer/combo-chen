/**
 * @overview Thin CLI adapter integration tests.
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
 * @deps ./main.test-harness
 */

import {
  appendEvent,
  createProgram,
  defaultDeps,
  describe,
  exec,
  expect,
  fakeDeps,
  formatReleaseMetadata,
  isDirectRun,
  it,
  join,
  loadConfig,
  mkdirSync,
  mkdtempSync,
  pathToFileURL,
  releaseMetadata,
  rmSync,
  runDirFor,
  symlinkSync,
  tmpdir,
  writeCombo,
  writeConfigSnapshot,
  writeFileSync,
} from "../testing/cli-harness.js";

// -- 1/1 CORE · command contracts <- START HERE --
describe("resolvePollMs", () => {
  it("reads COMBO_CHEN_POLL_MS and falls back to undefined (core default applies)", async () => {
    const { resolvePollMs } = await import("./main.js");
    expect(resolvePollMs({ COMBO_CHEN_POLL_MS: "250" })).toBe(250);
    expect(resolvePollMs({ COMBO_CHEN_POLL_MS: "nonsense" })).toBeUndefined();
    expect(resolvePollMs({})).toBeUndefined();
  });
});

describe("command surface", () => {
  it("wires the production team identity resolver into default deps", () => {
    expect(defaultDeps().resolveTeamIdentity).toEqual(expect.any(Function));
  });

  it("detects direct source execution when argv[1] needs file URL escaping", () => {
    const script = "/repo/combo#chen/src/cli/main.ts";

    expect(isDirectRun(pathToFileURL(script).href, script)).toBe(true);
  });

  it("detects direct execution when argv[1] reaches the module through a symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "combo-chen-direct-run-"));
    const target = join(dir, "combo-chen-real");
    const link = join(dir, "combo-chen");
    writeFileSync(target, "");
    symlinkSync(target, link);

    expect(isDirectRun(pathToFileURL(target).href, link)).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it("exposes release build metadata through the version flag", () => {
    const { deps } = fakeDeps();

    expect(createProgram(deps).version()).toBe(formatReleaseMetadata(releaseMetadata));
  });

  it("exposes the configured command surface", () => {
    const { deps } = fakeDeps();
    const names = createProgram(deps)
      .commands.map((c) => c.name())
      .sort();
    expect(names).toEqual(
      [
        "activate-coder",
        "activate-reviewer",
        "attach",
        "capsule",
        "closure",
        "decide",
        "director-prompt",
        "director-tick",
        "director-watch",
        "emit",
        "ensure-pr-autoclose",
        "events",
        "forensics",
        "gate-lease",
        "gate-restart",
        "intent",
        "needs-human-report",
        "reviewer-tick",
        "nudge-review-comments",
        "overture",
        "park",
        "reconcile",
        "recap",
        "resume",
        "run",
        "status",
        "stop",
        "update",
      ].sort(),
    );
  });

  it("declines to re-run a capsule whose journal is already combo_closed", async () => {
    const home = mkdtempSync(join(tmpdir(), "combo-chen-cli-"));
    const runDir = runDirFor(home, "o-r-7");
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    mkdirSync(join(repoDir, ".worktrees", "issue-7"), { recursive: true });
    writeCombo(runDir, {
      id: "o-r-7",
      issueUrl: "https://github.com/o/r/issues/7",
      repoDir,
      worktree: join(repoDir, ".worktrees", "issue-7"),
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date(0).toISOString(),
    });
    writeConfigSnapshot(runDir, loadConfig({ repoDir, env: {} }));
    appendEvent(runDir, "combo_closed", {});
    const { deps, calls, out } = fakeDeps({ env: { COMBO_CHEN_HOME: home } });

    await exec(deps, ["capsule", runDir]);

    expect(out.join("\n")).toContain("already combo_closed");
    expect(calls.some((call) => call[0] === "git")).toBe(false);
  });

  it("describes status as the parallel capsule dashboard", () => {
    const { deps } = fakeDeps();
    const program = createProgram(deps);
    const status = program.commands.find((command) => command.name() === "status");

    expect(program.description()).toContain("parallel capsule");
    expect(status?.description()).toContain("parallel capsule dashboard");
    expect(status?.helpInformation()).toContain("Probe downstream no-mistakes/GitHub recovery state");
  });
});
// -/ 1/1
