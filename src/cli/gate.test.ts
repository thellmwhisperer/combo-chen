/**
 * @overview Unit tests for gatekeeper CLI helpers. ~205 lines, attach, config artifact, and mirror sync.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at gatekeeper attach window helpers <- tmux command rendering.
 *   2. Then syncNoMistakesMirror                 <- missing mirror no-op.
 *   3. propagateNoMistakesConfig                 <- local config artifact copy.
 *   4. remoteShaForRef/sync helpers              <- exact refs and safe pushes.
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
 * @deps vitest, node:{fs,os,path}, ../core/state, ./gate
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildPostAddressGateScript,
  buildGatekeeperAttachCommand,
  ensureGatekeeperWindow,
  propagateNoMistakesConfig,
  remoteShaForRef,
  syncNoMistakesMirror,
} from "./gate.js";
import type { ComboRecord } from "../core/state.js";

// -- 1/4 HELPER · combo and remoteShaForRef tests --
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
// -/ 1/4

// -- 2/4 CORE · gatekeeper attach window helpers <- START HERE --
describe("gatekeeper attach window helpers", () => {
  it("builds the polling attach command with shell-quoted worktree paths", () => {
    expect(
      buildGatekeeperAttachCommand(
        combo({ worktree: "/tmp/o'hara worktree" }),
        { timeoutSeconds: 45, retryIntervalSeconds: 15 },
      ),
    ).toBe(
      [
        "cd '/tmp/o'\\''hara worktree'",
        "attempt=0",
        "while :; do",
        "  if no-mistakes axi status 2>/dev/null | grep -Eq '^[[:space:]]*status:[[:space:]]*running[[:space:]]*$'; then",
        "    exec no-mistakes attach",
        "  fi",
        "  attempt=$((attempt + 1))",
        '  if [ "$attempt" -gt 3 ]; then',
        '    echo "gatekeeper-attach: timed out after 45 seconds" >&2',
        "    exit 1",
        "  fi",
        '  echo "gatekeeper-attach: waiting for gatekeeper (attempt $attempt/3)..." >&2',
        "  sleep 15",
        "done",
      ].join("\n"),
    );
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
      { timeoutSeconds: 30, retryIntervalSeconds: 10 },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(["list-windows", "-t", "combo-chen-o-r-7", "-F", "#{window_name}"]);
    expect(calls[1]?.slice(0, 5)).toEqual([
      "new-window",
      "-t",
      "combo-chen-o-r-7",
      "-n",
      "gatekeeper",
    ]);
  });
});
// -/ 2/4

// -- 3/4 CORE · no-mistakes config artifact propagation --
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
// -/ 3/4

// -- 4/4 CORE · syncNoMistakesMirror and post-address push safety --
describe("syncNoMistakesMirror", () => {
  it("treats a missing no-mistakes remote as a no-op", () => {
    const calls: string[][] = [];
    const out: string[] = [];
    const record = combo();

    expect(
      syncNoMistakesMirror(
        {
          out: (line) => out.push(line),
          git: (args, cwd) => {
            calls.push([cwd, ...args]);
            return { status: 2, stdout: "", stderr: "No such remote 'no-mistakes'" };
          },
        },
        record,
        mkdtempSync(join(tmpdir(), "combo-chen-run-")),
      ),
    ).toBe(false);

    expect(out).toEqual([]);
    expect(calls).toEqual([[record.worktree, "remote", "get-url", "no-mistakes"]]);
  });
});

describe("buildPostAddressGateScript", () => {
  it("publishes rewritten local HEAD to an existing mirror branch with force-with-lease", () => {
    const script = buildPostAddressGateScript({
      combo: combo(),
      runDir: mkdtempSync(join(tmpdir(), "combo-chen-run-")),
      gatekeeperCommand: "no-mistakes axi run --intent 'post-address gate'",
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      prUrl: "https://github.com/o/r/pull/7",
      emit: "combo-chen emit -n o-r-7",
      ensurePrAutoclose: "combo-chen ensure-pr-autoclose -n o-r-7 --pr-url",
    });

    expect(script).toContain('git push no-mistakes --force-with-lease="$mirror_ref:$mirror_sha" "HEAD:$mirror_ref"');
    expect(script).toContain('git push no-mistakes "HEAD:$mirror_ref"');
    expect(script).not.toContain("git push no-mistakes HEAD");
  });
});
// -/ 4/4
