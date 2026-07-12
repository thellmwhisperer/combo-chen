/**
 * @overview Contract test for the external director skill and its documented CLI surface.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at the describe block  <- skill existence and command registration contract.
 *
 *   MAIN FLOW
 *   ---------
 *   read skill markdown -> extract combo-chen commands -> compare with createProgram
 *
 *   PUBLIC API
 *   ----------
 *   None (test file).
 *
 *   INTERNALS
 *   ---------
 *   DIRECT_COMBOS_SKILL locates the shipped skill from this test module.
 *
 * @exports none
 * @deps ./main, ../testing/cli-harness, node:{path,url}
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createProgram, describe, expect, fakeDeps, it, readFileSync } from "../testing/cli-harness.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIRECT_COMBOS_SKILL = join(REPO_ROOT, "skills", "direct-combos", "SKILL.md");

// -- 1/1 CORE · Director skill command contract <- START HERE --
describe("direct-combos skill", () => {
  it("documents launch identity from the overture output", () => {
    const markdown = readFileSync(DIRECT_COMBOS_SKILL, "utf8");

    expect(markdown).toContain("## 3. Launch and identify the capsule");
    expect(markdown).toContain("`overture <combo-id>`");
    expect(markdown).toContain("`artifact <run-dir>/overture.json`");
  });

  it("documents journal-first supervision and the captain wake signals", () => {
    const markdown = readFileSync(DIRECT_COMBOS_SKILL, "utf8");

    expect(markdown).toContain("## 4. Supervise from the journal");
    for (const command of [
      "combo-chen status",
      "combo-chen status --deep",
      "combo-chen recap",
      "combo-chen events --follow -n <combo-id>",
    ]) {
      expect(markdown).toContain(`\`${command}\``);
    }
    for (const signal of ["needs_human", "pr_opened", "ready_for_merge", "merged", "failed"]) {
      expect(markdown).toContain(`\`${signal}\``);
    }
    expect(markdown).toContain("prints nothing");
  });

  it("documents durable routing for every needs_human decision verb", () => {
    const markdown = readFileSync(DIRECT_COMBOS_SKILL, "utf8");

    expect(markdown).toContain("## 5. Route decisions durably");
    expect(markdown).toContain("`combo-chen decide -n <combo-id> <verb>`");
    for (const verb of ["retry", "skip", "take_over", "ignore"]) {
      expect(markdown).toContain(`\`${verb}\``);
    }
    expect(markdown).toContain("`decision`");
    expect(markdown).toContain("`needs_human_ref`");
  });

  it("documents lifecycle handoff, resumption, closure, and director prohibitions", () => {
    const markdown = readFileSync(DIRECT_COMBOS_SKILL, "utf8");

    expect(markdown).toContain("## 6. Map the capsule lifecycle");
    for (const command of [
      "combo-chen park -n <combo-id>",
      "combo-chen resume -n <combo-id>",
      "combo-chen closure -n <combo-id>",
    ]) {
      expect(markdown).toContain(`\`${command}\``);
    }
    expect(markdown).toContain("park-handoff.md");
    expect(markdown).toContain("GitHub reports the PR as MERGED");
    for (const prohibition of [
      "edit the combo worktree",
      "write to the PR conversation",
      "bypass the gate",
    ]) {
      expect(markdown).toContain(prohibition);
    }
  });

  it("documents independent fleet ownership, gate leases, wave scaling, and fleet views", () => {
    const markdown = readFileSync(DIRECT_COMBOS_SKILL, "utf8");

    expect(markdown).toContain("## 7. Scale a multi-combo fleet in waves");
    for (const ownershipUnit of ["one branch", "one worktree", "one tmux session", "one runtime ledger"]) {
      expect(markdown).toContain(ownershipUnit);
    }
    expect(markdown).toContain("Branch-scoped gate leases");
    expect(markdown).toContain("2 live capsules");
    expect(markdown).toContain("3 live capsules");
    expect(markdown).toContain("4 to 6 live capsules");
    expect(markdown).toContain("`combo-chen status --all`");
    expect(markdown).toContain("Bare `combo-chen` on a TTY");
  });

  it("mentions only registered combo-chen subcommands", () => {
    const markdown = readFileSync(DIRECT_COMBOS_SKILL, "utf8");
    const mentionedCommands = Array.from(
      markdown.matchAll(/(?:^|`)combo-chen\s+([a-z][a-z0-9-]*)\b/gm),
      (match) => match[1]!,
    );
    const { deps } = fakeDeps();
    const registeredCommands = new Set(createProgram(deps).commands.map((command) => command.name()));

    expect(mentionedCommands.length).toBeGreaterThan(0);
    expect([...new Set(mentionedCommands)].filter((name) => !registeredCommands.has(name))).toEqual([]);
  });
});
// -/ 1/1
