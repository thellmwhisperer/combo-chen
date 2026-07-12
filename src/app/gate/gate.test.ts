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
 * @deps ../../core/state, ./gate, node:child_process, node:fs, node:os, node:path, vitest
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
  it("rejects non-positive timeout and retry values", () => {
    expect(() =>
      buildGatekeeperAttachCommand(combo(), { timeoutSeconds: 0, retryIntervalSeconds: 15 }),
    ).toThrow("timeout");
    expect(() =>
      buildGatekeeperAttachCommand(combo(), { timeoutSeconds: 45, retryIntervalSeconds: 0 }),
    ).toThrow("retry interval");
    expect(() =>
      buildGatekeeperAttachCommand(combo(), { timeoutSeconds: Number.NaN, retryIntervalSeconds: 15 }),
    ).toThrow("timeout");
  });

  it("quotes hostile worktree paths and caps the retry loop from timeout/interval", () => {
    const command = buildGatekeeperAttachCommand(combo({ worktree: "/tmp/o'hara worktree" }), {
      timeoutSeconds: 45,
      retryIntervalSeconds: 15,
    });
    expect(command).toContain("cd '/tmp/o'\\''hara worktree'");
    expect(command).toContain("expected_branch='combo/issue-7'");
    expect(command).toContain("attach_max_attempts=3");
    expect(command).toContain("gatekeeper-attach: timed out after 45 seconds");
  });

  //    Contract for #281: run the generated attach script against a fake
  //    no-mistakes whose axi status flips to an active run with QUOTED id and
  //    head (the real output shape). The attach must happen within one retry
  //    interval, and a sibling branch must never attach (timeout unchanged).
  function attachHarness(): {
    worktree: string;
    binDir: string;
    fixtureFile: string;
    attachLog: string;
    headShort8: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), "combo-chen-attach-"));
    const worktree = join(dir, "worktree");
    mkdirSync(worktree);
    const git = (args: string[]) => spawnSync("git", args, { cwd: worktree, encoding: "utf8" });
    git(["init", "--quiet"]);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "seed", "--quiet"]);
    const headShort8 = git(["rev-parse", "--short=8", "HEAD"]).stdout.trim();

    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    const fixtureFile = join(binDir, "fixture");
    const attachLog = join(binDir, "attach-args");
    writeFileSync(
      join(binDir, "no-mistakes"),
      [
        "#!/bin/sh",
        'state_dir=$(dirname "$0")',
        'if [ "$1" = "axi" ] && [ "$2" = "status" ]; then',
        '  count_file="$state_dir/status-calls"',
        '  count=$(cat "$count_file" 2>/dev/null || printf 0)',
        "  count=$((count + 1))",
        '  printf %s "$count" > "$count_file"',
        '  if [ "$count" -lt 2 ]; then',
        "    printf 'run:\\n  status: done\\n'",
        "  else",
        '    cat "$state_dir/fixture"',
        "  fi",
        "  exit 0",
        "fi",
        'if [ "$1" = "attach" ]; then',
        '  printf "%s\\n" "$*" > "$state_dir/attach-args"',
        '  touch "$state_dir/attach-done"',
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
    );
    chmodSync(join(binDir, "no-mistakes"), 0o755);
    return { worktree, binDir, fixtureFile, attachLog, headShort8 };
  }

  function runAttach(input: {
    harness: ReturnType<typeof attachHarness>;
    branch: string;
    timeoutSeconds: number;
  }): { status: number | null; stderr: string } {
    const command = buildGatekeeperAttachCommand(
      combo({ worktree: input.harness.worktree, branch: "combo/issue-7" }),
      {
        timeoutSeconds: input.timeoutSeconds,
        retryIntervalSeconds: 1,
        replaceProcess: false,
        stopWhenFileExists: join(input.harness.binDir, "attach-done"),
      },
    );
    writeFileSync(
      input.harness.fixtureFile,
      [
        "run:",
        '  id: "01KWZBNYNYCYW3585TVK5ZSA11"',
        `  branch: ${input.branch}`,
        `  head: "${input.harness.headShort8}"`,
        "  status: active",
        "",
      ].join("\n"),
    );
    const result = spawnSync("sh", ["-c", command], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, PATH: `${input.harness.binDir}:${process.env["PATH"] ?? ""}` },
    });
    return { status: result.status, stderr: result.stderr };
  }

  // The rendered script gets a 20 s budget and one real retry-interval sleep;
  // the vitest default of 5 s flakes under parallel-suite subprocess load.
  it(
    "attaches within one retry interval when axi status flips to a matching quoted-field run",
    { timeout: 30_000 },
    () => {
      const harness = attachHarness();
      const result = runAttach({ harness, branch: "combo/issue-7", timeoutSeconds: 20 });

      expect(result.status).toBe(2);
      const attachArgs = readFileSync(harness.attachLog, "utf8");
      expect(attachArgs).toContain("attach --run 01KWZBNYNYCYW3585TVK5ZSA11");
      const statusCalls = readFileSync(join(harness.binDir, "status-calls"), "utf8");
      expect(statusCalls).toBe("2");
    },
  );

  it("never attaches to a sibling-branch run and keeps the timeout path", { timeout: 10000 }, () => {
    const harness = attachHarness();
    const result = runAttach({ harness, branch: "combo/issue-999", timeoutSeconds: 2 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("gatekeeper-attach: timed out after 2 seconds");
    expect(existsSync(harness.attachLog)).toBe(false);
  });

  it("can stop polling when the generated gate script has already finished", () => {
    const command = buildGatekeeperAttachCommand(combo({ worktree: "/tmp/o'hara worktree" }), {
      timeoutSeconds: 45,
      retryIntervalSeconds: 15,
      replaceProcess: false,
      stopWhenFileExists: "/tmp/o'hara gate.done",
    });

    expect(command).toContain("gatekeeper_done_file='/tmp/o'\\''hara gate.done'");
    expect(command).toContain('if [ -n "$gatekeeper_done_file" ] && [ -f "$gatekeeper_done_file" ]; then');
    expect(command).toContain("gatekeeper-attach: gate script finished before attach became available");
    expect(command).toContain("exit 2");
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
