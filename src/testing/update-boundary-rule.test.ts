/**
 * @overview Contract test for the ast-grep boundary around the update subsystem.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at scanUpdateBoundary    <- runs the real rule over an isolated TypeScript fixture.
 *   2. Read the describe block        <- pins internal rejection and entry-point allowance.
 *
 *   MAIN FLOW
 *   ---------
 *   fixture source -> ast-grep update boundary -> parsed diagnostics -> expectation
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   scanUpdateBoundary.
 *
 * @exports none
 * @deps vitest, node:{child_process,fs,path,url}
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const rulePath = join(repoRoot, ".slop", "rules", "update-boundary.yml");
const astGrepPath = join(repoRoot, "node_modules", ".bin", "sg");

// -- 1/2 HELPER · scanUpdateBoundary --
function scanUpdateBoundary(source: string): unknown[] {
  const fixtureDir = mkdtempSync(join(tmpdir(), "boundary-rule-fixture-"));
  const srcDir = join(fixtureDir, "src");
  const fixturePath = join(srcDir, "fixture.ts");
  try {
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(fixturePath, source);
    const result = spawnSync(
      astGrepPath,
      ["scan", "--rule", rulePath, "--json=compact", "src/fixture.ts"],
      { cwd: fixtureDir, encoding: "utf8" },
    );
    if (result.stdout.trim().length === 0) {
      throw new Error(`update boundary scan failed: ${result.stderr.trim()}`);
    }
    return JSON.parse(result.stdout) as unknown[];
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}
// -/ 1/2

// -- 2/2 CORE · update boundary contract <- START HERE --
describe("update module boundary rule", () => {
  it("rejects an outside internal import and permits the declared entry point", () => {
    expect(scanUpdateBoundary('import { runUpdateCommand } from "../update/command.js";')).toHaveLength(1);
    expect(scanUpdateBoundary('import { runUpdateCommand } from "../update/index.js";')).toHaveLength(0);
  });
});
// -/ 2/2
