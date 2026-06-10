import { mkdtempSync } from "node:fs";
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

describe("issue identity", () => {
  it("parses a GitHub issue URL", () => {
    expect(parseIssueUrl("https://github.com/thellmwhisperer/roca-madre/issues/128")).toEqual({
      owner: "thellmwhisperer",
      repo: "roca-madre",
      number: 128,
    });
  });

  it("rejects anything that is not a GitHub issue URL", () => {
    expect(() => parseIssueUrl("https://github.com/o/r/pull/3")).toThrow(ComboStateError);
    expect(() => parseIssueUrl("not a url")).toThrow(ComboStateError);
  });

  it("derives a filesystem-safe combo id", () => {
    expect(comboIdFromIssueUrl("https://github.com/thellmwhisperer/roca-madre/issues/128")).toBe(
      "thellmwhisperer-roca-madre-128",
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
});
