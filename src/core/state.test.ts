/**
 * @overview Unit tests for combo state persistence. ~75 lines, testing
 *   GitHub issue URL parsing and combo-id derivation, combo home directory
 *   resolution, and combo record read/write/list round-trips.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at describe("combo records")   ← read/write/list round-trip
 *   2. Then describe("issue identity")      ← URL parsing contract
 *
 *   ┌─ TEST AREAS ──────────────────────────────────┐
 *   │ issue identity  parseIssueUrl + comboIdFromUrl │
 *   │ combo home      COMBO_CHEN_HOME resolution    │
 *   │ combo records   write/read/list round-trip    │
 *   └────────────────────────────────────────────────┘
 *
 * @exports none (test file)
 * @deps vitest, node:{fs,os,path}, ./state
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ComboStateError,
  comboHome,
  comboIdFromIssueUrl,
  listCombos,
  parseIssueUrl,
  readCombo,
  runDirFor,
  writeCombo,
} from "./state.js";

function home(): string {
  return mkdtempSync(join(tmpdir(), "combo-chen-home-"));
}

// -- 1/2 HELPER · Issue identity + combo home --
describe("issue identity", () => {
  it("parses a GitHub issue URL", () => {
    expect(parseIssueUrl("https://github.com/example-org/example-repo/issues/128")).toEqual({
      owner: "example-org",
      repo: "example-repo",
      number: 128,
  });
});
// -/ 2/2

  it("rejects anything that is not a GitHub issue URL", () => {
    expect(() => parseIssueUrl("https://github.com/o/r/pull/3")).toThrow(ComboStateError);
    expect(() => parseIssueUrl("not a url")).toThrow(ComboStateError);
  });

  it("derives a filesystem-safe combo id", () => {
    expect(comboIdFromIssueUrl("https://github.com/example-org/example-repo/issues/128")).toBe(
      "example-org-example-repo-128",
    );
  });
});

describe("combo home", () => {
  it("honors COMBO_CHEN_HOME over the default", () => {
    expect(comboHome({ COMBO_CHEN_HOME: "/x/y" })).toBe("/x/y");
  });

  it("defaults under the user home", () => {
    expect(comboHome({})).toContain(".combo-chen");
  });
});

// -/ 1/2

// -- 2/2 CORE · Combo records: read, write, list ← START HERE --
describe("combo records", () => {
  it("round-trips a combo record and lists it", () => {
    const base = home();
    const combo = {
      id: "o-r-7",
      issueUrl: "https://github.com/o/r/issues/7",
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    };

    const dir = runDirFor(base, combo.id);
    writeCombo(dir, combo);

    expect(readCombo(dir)).toEqual(combo);
    expect(listCombos(base).map((c) => c.id)).toEqual(["o-r-7"]);
  });

  it("lists nothing when the home does not exist yet", () => {
    expect(listCombos(join(home(), "nope"))).toEqual([]);
  });

  it("throws on a corrupted combo record by default", () => {
    const base = home();
    const dir = runDirFor(base, "bad-combo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "combo.json"), "{not json\n");

    expect(() => listCombos(base)).toThrow();
  });

  it("treats schema-invalid combo records as corrupt", () => {
    const base = home();
    const dir = runDirFor(base, "no-created-at");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "combo.json"), `${JSON.stringify({ id: "no-created-at" })}\n`);

    expect(() => listCombos(base)).toThrow(ComboStateError);

    const skipped: string[] = [];
    expect(listCombos(base, (id) => skipped.push(id))).toEqual([]);
    expect(skipped).toEqual(["no-created-at"]);
  });

  it("skips corrupted combo records when onCorrupt is provided", () => {
    const base = home();
    const combo = {
      id: "o-r-7",
      issueUrl: "https://github.com/o/r/issues/7",
      repoDir: "/repos/r",
      worktree: "/repos/r/.worktrees/issue-7",
      branch: "combo/issue-7",
      tmuxSession: "combo-chen-o-r-7",
      createdAt: new Date().toISOString(),
    };
    writeCombo(runDirFor(base, combo.id), combo);
    const badDir = runDirFor(base, "bad-combo");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "combo.json"), "{not json\n");

    const skipped: string[] = [];
    const combos = listCombos(base, (id) => skipped.push(id));

    expect(combos.map((c) => c.id)).toEqual(["o-r-7"]);
    expect(skipped).toEqual(["bad-combo"]);
  });
});
