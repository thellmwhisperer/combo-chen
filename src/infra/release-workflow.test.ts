/**
 * @overview Contract tests for the GitHub release asset workflow.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at describe("release workflow") <- workflow trigger and upload contract.
 *   2. The helper only loads the checked-in workflow text.
 *
 *   MAIN FLOW
 *   ---------
 *   release event -> build/test/release:assets -> GitHub release upload
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   readReleaseWorkflow.
 *
 * @exports none
 * @deps vitest, node:fs
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// -- 1/2 HELPER · workflow fixture --
function readReleaseWorkflow(): string {
  return readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
}
// -/ 1/2

// -- 2/2 CORE · release workflow <- START HERE --
describe("release workflow", () => {
  it("builds and uploads release assets for published releases and prereleases", () => {
    const workflow = readReleaseWorkflow();

    expect(workflow).toContain("name: release-assets");
    expect(workflow).toContain("release:");
    expect(workflow).toContain("types: [published, prereleased]");
    expect(workflow).toContain("ref: ${{ github.event.release.tag_name }}");
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("COMBO_CHEN_COMMIT: ${{ github.sha }}");
    expect(workflow).toContain("COMBO_CHEN_BUILD_DATE: ${{ github.event.release.created_at }}");
    expect(workflow).toContain("pnpm install --frozen-lockfile");
    expect(workflow).toContain("pnpm typecheck");
    expect(workflow).toContain("pnpm test");
    expect(workflow).toContain("pnpm release:assets");
    expect(workflow).toContain("dist/release/*.tar.gz");
    expect(workflow).toContain("dist/release/checksums.txt");
    expect(workflow).toContain('gh release upload "${{ github.event.release.tag_name }}"');
  });
});
// -/ 2/2
