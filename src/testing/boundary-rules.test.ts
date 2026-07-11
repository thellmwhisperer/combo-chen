/**
 * @overview Contract tests for ast-grep boundaries between source domains.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at scanBoundaryRule      <- runs a real rule over an isolated TypeScript fixture.
 *   2. Read the describe blocks       <- pin error handling and each dependency direction.
 *
 *   MAIN FLOW
 *   ---------
 *   fixture source -> selected ast-grep boundary -> parsed diagnostics -> expectation
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   scanBoundaryRule.
 *
 * @exports none
 * @deps vitest, node:{child_process,fs,path,url}
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const astGrepPath = join(repoRoot, "node_modules", ".bin", "sg");
const fixtureRoot = join(repoRoot, ".tmp");

// -- 1/5 HELPER · scanBoundaryRule --
function scanBoundaryRule(
  ruleName: string,
  fixturePath: string,
  source: string,
  executablePath = astGrepPath,
): unknown[] {
  mkdirSync(fixtureRoot, { recursive: true });
  const fixtureDir = mkdtempSync(join(fixtureRoot, "boundary-rule-fixture-"));
  const absoluteFixturePath = join(fixtureDir, fixturePath);
  try {
    mkdirSync(join(absoluteFixturePath, ".."), { recursive: true });
    writeFileSync(absoluteFixturePath, source);
    const rulePath = join(repoRoot, ".slop", "rules", ruleName);
    const result = spawnSync(executablePath, ["scan", "--rule", rulePath, "--json=compact", fixturePath], {
      cwd: fixtureDir,
      encoding: "utf8",
    });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    if (stdout.trim().length === 0) {
      throw new Error(`boundary scan failed: ${result.error?.message || stderr.trim() || "unknown error"}`);
    }
    return JSON.parse(stdout) as unknown[];
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}
// -/ 1/5

// -- 2/5 CORE · scanBoundaryRule error contract <- START HERE --
describe("scanBoundaryRule error reporting", () => {
  it("surfaces spawn errors when stdout and stderr are unavailable", () => {
    expect(() =>
      scanBoundaryRule(
        "update-boundary.yml",
        "src/fixture.ts",
        'import "../update/command.js";',
        join(fixtureRoot, "missing-sg-for-error-test"),
      ),
    ).toThrow(/ENOENT/);
  });
});
// -/ 2/5

// -- 3/5 CORE · update boundary contract --
describe("update module boundary rule", () => {
  it("rejects an outside internal import and permits the declared entry point", () => {
    expect(
      scanBoundaryRule(
        "update-boundary.yml",
        "src/fixture.ts",
        'import { runUpdateCommand } from "../update/command.js";',
      ),
    ).toHaveLength(1);
    expect(
      scanBoundaryRule(
        "update-boundary.yml",
        "src/fixture.ts",
        'import { runUpdateCommand } from "../update/index.js";',
      ),
    ).toHaveLength(0);
    expect(
      scanBoundaryRule(
        "update-boundary.yml",
        "src/fixture.ts",
        'const runUpdateCommand = import("../update/command.js");',
      ),
    ).toHaveLength(1);
    expect(
      scanBoundaryRule(
        "update-boundary.yml",
        "src/fixture.ts",
        'const runUpdateCommand = import("../update/index.js");',
      ),
    ).toHaveLength(0);
  });
});
// -/ 3/5

// -- 4/5 CORE · GitHub domain boundary contract --
describe("GitHub domain boundary rule", () => {
  it("rejects static and dynamic director imports while permitting lower-level core imports", () => {
    expect(
      scanBoundaryRule(
        "github-no-director-import.yml",
        "src/app/github/fixture.ts",
        'import { tickDirector } from "../director/director.js";',
      ),
    ).toHaveLength(1);
    expect(
      scanBoundaryRule(
        "github-no-director-import.yml",
        "src/app/github/fixture.ts",
        'const director = import("../director/director.js");',
      ),
    ).toHaveLength(1);
    expect(
      scanBoundaryRule(
        "github-no-director-import.yml",
        "src/app/github/fixture.ts",
        'import { appendEvent } from "../../core/events.js";',
      ),
    ).toHaveLength(0);
    expect(
      scanBoundaryRule(
        "github-no-director-import.yml",
        "src/app/github/fixture.ts",
        'const events = import("../../core/events.js");',
      ),
    ).toHaveLength(0);
  });
});
// -/ 4/5

// -- 5/5 CORE · Gate domain boundary contract --
describe("Gate domain boundary rule", () => {
  it("rejects static and dynamic director imports while permitting lower-level GitHub imports", () => {
    expect(
      scanBoundaryRule(
        "gate-no-director-import.yml",
        "src/app/gate/fixture.ts",
        'import { tickDirector } from "../director/director.js";',
      ),
    ).toHaveLength(1);
    expect(
      scanBoundaryRule(
        "gate-no-director-import.yml",
        "src/app/gate/fixture.ts",
        'const director = import("../director/director.js");',
      ),
    ).toHaveLength(1);
    expect(
      scanBoundaryRule(
        "gate-no-director-import.yml",
        "src/app/gate/fixture.ts",
        'import { fetchIssueDetails } from "../github/github.js";',
      ),
    ).toHaveLength(0);
    expect(
      scanBoundaryRule(
        "gate-no-director-import.yml",
        "src/app/gate/fixture.ts",
        'const github = import("../github/github.js");',
      ),
    ).toHaveLength(0);
  });
});
// -/ 5/5
