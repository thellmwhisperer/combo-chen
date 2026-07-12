/**
 * @overview Unit tests for gatekeeper CLI helpers: attach, config artifact propagation.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at gatekeeper attach window helpers <- tmux command rendering.
 *   2. Then remoteShaForRef                      <- exact ref output parsing.
 *   3. propagateNoMistakesConfig                 <- local config artifact copy.
 *
 *   MAIN FLOW
 *   ---------
 *   fake combo -> gate helper -> tmux/git argv contracts
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   combo
 *
 * @exports none
 * @deps ../../core/state, ./gate, node:fs, node:os, node:path, vitest
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildGatekeeperAttachCommand,
  ensureGatekeeperWindow,
  propagateNoMistakesConfig,
  remoteShaForRef,
} from "./gate.js";
import type { ComboRecord } from "../../core/state.js";

// -- 1/5 HELPER · combo and remoteShaForRef tests --
function combo(overrides: Partial<ComboRecord> = {}): ComboRecord {
  return {
    id: "o-r-7",
    issueUrl: "https://github.com/o/r/issues/7",
    repoDir: join(tmpdir(), "combo-chen-repo"),
    worktree: join(tmpdir(), "combo-chen-worktree"),
    branch: "combo/issue-7",
    tmuxSession: "combo-chen-o-r-7",
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("remoteShaForRef", () => {
  it("returns only the SHA for the exact ref", () => {
    expect(
      remoteShaForRef(
        [
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/aaa/combo/issue-7",
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/heads/combo/issue-7",
        ].join("\n"),
        "refs/heads/combo/issue-7",
      ),
    ).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });
});
// -/ 1/5

// -- 2/5 CORE · gatekeeper attach window helpers <- START HERE --
describe("gatekeeper attach window helpers", () => {
  it("builds a stateless cd + no-mistakes attach command", () => {
    const command = buildGatekeeperAttachCommand(combo());
    expect(command).toContain("cd ");
    expect(command).toContain("&& no-mistakes attach");
  });

  it("quotes hostile worktree paths", () => {
    const command = buildGatekeeperAttachCommand(combo({ worktree: "/tmp/o'hara worktree" }));
    expect(command).toContain("cd '/tmp/o'\\''hara worktree'");
    expect(command).toContain("no-mistakes attach");
  });

  it("starts the gatekeeper window only when it is absent", () => {
    const calls: string[][] = [];
    const record = combo();

    ensureGatekeeperWindow(
      {
        tmux: (args) => {
          calls.push(args);
          return { status: 0, stdout: "coder\nreviewer\n", stderr: "" };
        },
      },
      record,
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(["list-windows", "-t", "combo-chen-o-r-7", "-F", "#{window_name}"]);
    expect(calls[1]?.slice(0, 5)).toEqual(["new-window", "-t", "combo-chen-o-r-7", "-n", "gatekeeper"]);
    const gatekeeperCommand = calls[1]?.at(-1) ?? "";
    expect(gatekeeperCommand).toContain("combo_chen_idle=1");
    expect(gatekeeperCommand).toContain("trap 'combo_chen_idle=0' INT");
    expect(gatekeeperCommand).toContain('while [ "$combo_chen_idle" = 1 ]; do');
    expect(gatekeeperCommand).toContain('exec "${SHELL:-/bin/sh}"');
  });
});
// -/ 2/5

// -- 3/5 CORE · no-mistakes config artifact propagation --
describe("propagateNoMistakesConfig", () => {
  it("copies the source local config into the worktree preserving content and mode", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = mkdtempSync(join(tmpdir(), "combo-chen-worktree-"));
    const source = join(repoDir, ".no-mistakes.yaml");
    const target = join(worktree, ".no-mistakes.yaml");
    writeFileSync(source, "commands:\n  test: pnpm test\n");
    chmodSync(source, 0o640);

    expect(propagateNoMistakesConfig(repoDir, worktree)).toBe(true);

    expect(readFileSync(target, "utf8")).toBe("commands:\n  test: pnpm test\n");
    expect(statSync(target).mode & 0o777).toBe(0o640);
  });

  it("does not overwrite an existing worktree config", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = mkdtempSync(join(tmpdir(), "combo-chen-worktree-"));
    writeFileSync(join(repoDir, ".no-mistakes.yaml"), "commands:\n  test: pnpm test\n");
    writeFileSync(join(worktree, ".no-mistakes.yaml"), "commands:\n  test: custom\n");

    expect(propagateNoMistakesConfig(repoDir, worktree)).toBe(false);
    expect(readFileSync(join(worktree, ".no-mistakes.yaml"), "utf8")).toBe("commands:\n  test: custom\n");
  });

  it("is a no-op when the source local config is absent", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const worktree = mkdtempSync(join(tmpdir(), "combo-chen-worktree-"));

    expect(propagateNoMistakesConfig(repoDir, worktree)).toBe(false);
    expect(existsSync(join(worktree, ".no-mistakes.yaml"))).toBe(false);
  });
});
// -/ 3/5
