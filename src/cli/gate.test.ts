/**
 * @overview Unit tests for gatekeeper CLI helpers. ~145 lines, attach window and mirror sync.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at gatekeeper attach window helpers <- tmux command rendering.
 *   2. Then syncNoMistakesMirror                 <- missing mirror no-op.
 *   3. remoteShaForRef                           <- exact ref parser.
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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildGatekeeperAttachCommand,
  ensureGatekeeperWindow,
  remoteShaForRef,
  syncNoMistakesMirror,
} from "./gate.js";
import type { ComboRecord } from "../core/state.js";

// -- 1/3 HELPER · combo and remoteShaForRef tests --
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
// -/ 1/3

// -- 2/3 CORE · gatekeeper attach window helpers <- START HERE --
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
// -/ 2/3

// -- 3/3 CORE · syncNoMistakesMirror tests --
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
// -/ 3/3
