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
  createProgram,
  defaultDeps,
  describe,
  expect,
  fakeDeps,
  formatReleaseMetadata,
  isDirectRun,
  it,
  join,
  mkdtempSync,
  pathToFileURL,
  releaseMetadata,
  rmSync,
  symlinkSync,
  tmpdir,
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
        "closure",
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
