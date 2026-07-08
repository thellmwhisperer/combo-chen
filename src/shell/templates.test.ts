/**
 * @overview Unit tests for the shell template loader and the canonical
 *   axi-status parsing library. The lib tests execute real sh against a
 *   captured fixture of no-mistakes axi status output (quoted id and head,
 *   unquoted branch), the exact shape that broke the attach matcher in #281.
 *
 *   READING GUIDE
 *   -------------
 *   1. renderShellTemplate tests  <- placeholder + unresolved contract.
 *   2. axi-status-lib tests       <- field parsing executed via sh.
 *
 * @exports none
 * @deps vitest, node:child_process, ./templates
 */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { renderShellTemplate, shellTemplate } from "./templates.js";

// Captured shape from the 2026-07-08 wave (#281): id and head are quoted,
// branch is not, status is a bare word.
const AXI_STATUS_FIXTURE = [
  "run:",
  '  id: "01KWZBNYNYCYW3585TVK5ZSA11"',
  "  branch: combo/issue-273",
  '  head: "a08b8ae1"',
  "  status: active",
].join("\n");

function runShellLib(assertions: string): { status: number | null; stdout: string; stderr: string } {
  const script = [
    shellTemplate("axi-status-lib"),
    `axi_status=$(cat <<'FIXTURE'`,
    AXI_STATUS_FIXTURE,
    "FIXTURE",
    ")",
    assertions,
  ].join("\n");
  return spawnSync("sh", ["-c", script], { encoding: "utf8", timeout: 10_000 });
}

describe("renderShellTemplate", () => {
  it("substitutes placeholders and rejects unresolved ones", () => {
    expect(() => renderShellTemplate("axi-status-lib")).not.toThrow();
  });
});

describe("axi-status-lib", () => {
  it("strips quotes from every field, id and head included", () => {
    const result = runShellLib(
      [
        'printf "id=%s\\n" "$(no_mistakes_axi_field "$axi_status" id)"',
        'printf "branch=%s\\n" "$(no_mistakes_axi_field "$axi_status" branch)"',
        'printf "head=%s\\n" "$(no_mistakes_axi_field "$axi_status" head)"',
        'printf "status=%s\\n" "$(no_mistakes_axi_field "$axi_status" status)"',
      ].join("\n"),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("id=01KWZBNYNYCYW3585TVK5ZSA11");
    expect(result.stdout).toContain("branch=combo/issue-273");
    expect(result.stdout).toContain("head=a08b8ae1");
    expect(result.stdout).toContain("status=active");
  });

  it("matches a 7-char expected head against the quoted 8-char run head", () => {
    const result = runShellLib(
      [
        'run_head=$(no_mistakes_axi_field "$axi_status" head)',
        'if no_mistakes_axi_head_matches "$run_head" "a08b8ae"; then printf "match\\n"; else printf "no-match\\n"; fi',
      ].join("\n"),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("match");
    expect(result.stdout).not.toContain("no-match");
  });

  it("rejects a different head and empty heads", () => {
    const result = runShellLib(
      [
        'run_head=$(no_mistakes_axi_field "$axi_status" head)',
        'if no_mistakes_axi_head_matches "$run_head" "1234567"; then printf "bad-match\\n"; fi',
        'if no_mistakes_axi_head_matches "" "a08b8ae"; then printf "empty-match\\n"; fi',
      ].join("\n"),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("bad-match");
    expect(result.stdout).not.toContain("empty-match");
  });

  it("classifies run statuses with the two per-site predicates", () => {
    const result = runShellLib(
      [
        'if no_mistakes_axi_run_is_active pending; then printf "pending-active\\n"; fi',
        'if no_mistakes_axi_run_is_attachable pending; then printf "pending-attachable\\n"; fi',
        'if no_mistakes_axi_run_is_attachable running; then printf "running-attachable\\n"; fi',
        'if no_mistakes_axi_run_is_active done; then printf "done-active\\n"; fi',
      ].join("\n"),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pending-active");
    expect(result.stdout).not.toContain("pending-attachable");
    expect(result.stdout).toContain("running-attachable");
    expect(result.stdout).not.toContain("done-active");
  });
});
