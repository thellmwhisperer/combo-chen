/**
 * @overview Contract tests for ast-grep boundaries between source domains.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at scanBoundaryRule      <- runs a real rule over an isolated TypeScript fixture.
 *   2. Read the describe blocks       <- pin each rejected and allowed dependency direction.
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
 * @deps vitest, node:{child_process,fs,os,path,url}
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const astGrepPath = join(repoRoot, "node_modules", ".bin", "sg");

// -- 1/3 HELPER · scanBoundaryRule --
function scanBoundaryRule(ruleName: string, fixturePath: string, source: string): unknown[] {
  const fixtureDir = mkdtempSync(join(tmpdir(), "boundary-rule-fixture-"));
  const absoluteFixturePath = join(fixtureDir, fixturePath);
  try {
    mkdirSync(join(absoluteFixturePath, ".."), { recursive: true });
    writeFileSync(absoluteFixturePath, source);
    const rulePath = join(repoRoot, ".slop", "rules", ruleName);
    const result = spawnSync(astGrepPath, ["scan", "--rule", rulePath, "--json=compact", fixturePath], {
      cwd: fixtureDir,
      encoding: "utf8",
    });
    if (result.stdout.trim().length === 0) {
      throw new Error(
        `boundary scan failed: ${result.error?.message || result.stderr.trim() || "unknown error"}`,
      );
    }
    return JSON.parse(result.stdout) as unknown[];
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}
// -/ 1/3

// -- 2/3 CORE · update boundary contract <- START HERE --
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
// -/ 2/3

// -- 3/3 CORE · GitHub domain boundary contract --
describe("GitHub domain boundary rule", () => {
  it("rejects director imports while permitting lower-level core imports", () => {
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
        'import { appendEvent } from "../../core/events.js";',
      ),
    ).toHaveLength(0);
  });
});
// -/ 3/3
