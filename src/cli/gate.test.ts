/**
 * @overview Unit tests for gatekeeper CLI helpers. ~760 lines, attach, config artifact, mirror sync, and runtime snapshot use.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at gatekeeper attach window helpers <- tmux command rendering.
 *   2. Then syncNoMistakesMirror                 <- missing mirror no-op.
 *   3. propagateNoMistakesConfig                 <- local config artifact copy.
 *   4. gatekeeper runtime gates                  <- snapshot-backed commands.
 *   5. remoteShaForRef/sync helpers              <- exact refs and safe pushes.
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
 * @deps vitest, node:{child_process,fs,os,path}, ../core/{combo,events,state}, ../infra/{config,config-snapshot}, ./gate
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
  buildPostAddressGateScript,
  buildGatekeeperAttachCommand,
  ensureGatekeeperWindow,
  GATEKEEPER_WINDOW,
  propagateNoMistakesConfig,
  remoteShaForRef,
  runPostAddressGateIfNeeded,
  startInitialGateRetry,
  syncNoMistakesMirror,
} from "./gate.js";
import { shellQuote } from "../core/combo.js";
import { appendEvent } from "../core/events.js";
import type { ComboRecord } from "../core/state.js";
import { loadConfig } from "../infra/config.js";
import { writeConfigSnapshot } from "../infra/config-snapshot.js";

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

  it("builds the polling attach command with shell-quoted worktree paths", () => {
    expect(
      buildGatekeeperAttachCommand(combo({ worktree: "/tmp/o'hara worktree" }), {
        timeoutSeconds: 45,
        retryIntervalSeconds: 15,
      }),
    ).toBe(
      [
        "cd '/tmp/o'\\''hara worktree'",
        "expected_branch='combo/issue-7'",
        "expected_head=$(git rev-parse --short=7 HEAD 2>/dev/null || true)",
        "attempt=0",
        "while :; do",
        "  no_mistakes_status=$(no-mistakes axi status 2>/dev/null || true)",
        "  no_mistakes_run_id=$(printf '%s\\n' \"$no_mistakes_status\" | sed -n 's/^[[:space:]]*id:[[:space:]]*//p' | sed -n '1p')",
        "  no_mistakes_run_id=$(printf '%s' \"$no_mistakes_run_id\" | sed 's/^\"//; s/\"$//')",
        '  if [ -n "$no_mistakes_run_id" ] && [ -n "$expected_head" ] && printf \'%s\\n\' "$no_mistakes_status" | grep -F "branch: $expected_branch" >/dev/null && printf \'%s\\n\' "$no_mistakes_status" | grep -F "head: $expected_head" >/dev/null && printf \'%s\\n\' "$no_mistakes_status" | grep -Eq \'^[[:space:]]*status:[[:space:]]*(active|in_progress|running)[[:space:]]*$\'; then',
        '    exec no-mistakes attach --run "$no_mistakes_run_id"',
        "  fi",
        "  attempt=$((attempt + 1))",
        '  if [ "$attempt" -gt 3 ]; then',
        '    echo "gatekeeper-attach: timed out after 45 seconds" >&2',
        "    exit 1",
        "  fi",
        '  echo "gatekeeper-attach: waiting for gatekeeper on $expected_branch@$expected_head (attempt $attempt/3)..." >&2',
        "  sleep 15",
        "done",
      ].join("\n"),
    );
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

// -- 4/5 CORE · gatekeeper runtime gates use frozen config snapshots --
describe("gatekeeper runtime config snapshots", () => {
  it("uses the launch gatekeeper command for initial gate retries after repo TOML changes", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const runDir = mkdtempSync(join(tmpdir(), "combo-chen-run-"));
    const record = combo({ repoDir, worktree: join(repoDir, ".worktrees", "issue-7") });
    const calls: string[][] = [];

    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      '[gatekeeper]\ncommand = "printf launch-gate && no-mistakes axi run --intent fixed"\n',
    );
    writeConfigSnapshot(runDir, loadConfig({ repoDir, env: {} }));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      '[gatekeeper]\ncommand = "printf drifted-gate && no-mistakes axi run --intent fixed"\n',
    );

    const result = startInitialGateRetry({
      deps: {
        env: {},
        out: () => undefined,
        gh: () => ({ status: 0, stdout: '{"title":"Issue","body":"Body"}', stderr: "" }),
        git: (args) => {
          if (args.join(" ") === "rev-parse HEAD") {
            return { status: 0, stdout: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", stderr: "" };
          }
          if (args.join(" ") === "status --porcelain") {
            return { status: 0, stdout: "", stderr: "" };
          }
          return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
        },
        tmux: (args) => {
          calls.push(args);
          if (args.join(" ") === "list-windows -t combo-chen-o-r-7 -F #{window_name}") {
            return { status: 0, stdout: "journal\ngatekeeper\ngate-runner\n", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      combo: record,
      runDir,
      cli: "node /repo/dist/cli.mjs",
    });

    expect(result).toEqual({ started: true, headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
    expect(calls).toContainEqual(["kill-window", "-t", "combo-chen-o-r-7:gate-runner"]);
    expect(calls).not.toContainEqual(["kill-window", "-t", "combo-chen-o-r-7:gatekeeper"]);
    expect(calls.some((call) => call[0] === "new-window" && call.includes(GATEKEEPER_WINDOW))).toBe(false);
    expect(calls).toContainEqual(["send-keys", "-t", "combo-chen-o-r-7:gatekeeper", "C-c"]);
    expect(calls).toContainEqual(["send-keys", "-t", "combo-chen-o-r-7:gatekeeper", "C-m"]);
    const script = readFileSync(join(runDir, "gatekeeper-initial-bbbbbbbbbbbb.sh"), "utf8");
    expect(script).toContain("printf launch-gate");
    expect(script).not.toContain("printf drifted-gate");
    expect(script).toContain('pr_opened --field url="$pr_url"');
    expect(script).not.toContain("reason=pr_ready");
    expect(script).toContain("reason=pr_missing");
    expect(script).toContain("gate-lease acquire -n 'o-r-7'");
    expect(script.indexOf("gate-lease acquire")).toBeLessThan(script.indexOf("no-mistakes axi run"));
    const gatekeeperWindowCommand = calls.find((call) => call[0] === "set-buffer")?.at(-1) ?? "";
    expect(gatekeeperWindowCommand).toContain("no-mistakes attach --run");
    expect(gatekeeperWindowCommand).toContain(
      "gatekeeper-attach: gate script finished before attach became available",
    );
    expect(gatekeeperWindowCommand).toContain("[combo-chen] gatekeeper final attach probe for current run.");
    expect(gatekeeperWindowCommand).toContain(
      "no_mistakes_status=$(no-mistakes axi status 2>/dev/null || true)",
    );
    expect(gatekeeperWindowCommand).toContain(
      "[combo-chen] gatekeeper idle; waiting for the next current-head run.",
    );
    expect(gatekeeperWindowCommand).toContain('if [ "${COMBO_CHEN_GATEKEEPER_WINDOW_HOLD:-1}" = "0" ]; then');
    expect(gatekeeperWindowCommand).toContain('exit "$combo_chen_gate_script_code"');
    expect(gatekeeperWindowCommand).not.toContain("window retained for inspection");
    expect(gatekeeperWindowCommand).toContain(
      `sh '${join(runDir, "gatekeeper-initial-bbbbbbbbbbbb.sh")}' > "$combo_chen_gate_script_window_log" 2>&1`,
    );
    expect(gatekeeperWindowCommand).toContain(
      `combo_chen_gate_script_done='${join(runDir, "gatekeeper-initial-bbbbbbbbbbbb.sh.window.log.done")}'`,
    );
    expect(gatekeeperWindowCommand).toContain('wait "$combo_chen_gate_script_pid"');
    expect(gatekeeperWindowCommand).toContain("combo_chen_idle=1");
    expect(gatekeeperWindowCommand).toContain("trap 'combo_chen_idle=0' INT");
    expect(gatekeeperWindowCommand).toContain('while [ "$combo_chen_idle" = 1 ]; do');
    expect(gatekeeperWindowCommand).toContain('exec "${SHELL:-/bin/sh}"');
  });

  it("passes initial gate retry intent without embedding shell-interpretable issue text", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const runDir = mkdtempSync(join(tmpdir(), "combo-chen-run-"));
    const record = combo({ repoDir, worktree: join(repoDir, ".worktrees", "issue-7") });
    const issueBody = [
      "Backtick: `printf raw-backtick`",
      "Dollar command: $(printf raw-dollar)",
      'Double quote: "quoted"',
      "Single quote: 'quoted'",
      "Final newline boundary.",
    ].join("\n");

    writeConfigSnapshot(runDir, loadConfig({ repoDir, env: {} }));

    startInitialGateRetry({
      deps: {
        env: {},
        out: () => undefined,
        gh: () => ({
          status: 0,
          stdout: JSON.stringify({ title: "Shell-sensitive intent", body: issueBody }),
          stderr: "",
        }),
        git: (args) => {
          if (args.join(" ") === "rev-parse HEAD") {
            return { status: 0, stdout: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", stderr: "" };
          }
          if (args.join(" ") === "status --porcelain") {
            return { status: 0, stdout: "", stderr: "" };
          }
          return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
        },
        tmux: () => ({ status: 0, stdout: "", stderr: "" }),
      },
      combo: record,
      runDir,
      cli: "node /repo/dist/cli.mjs",
    });

    const script = readFileSync(join(runDir, "gatekeeper-initial-bbbbbbbbbbbb.sh"), "utf8");

    expect(script).toContain("COMBO_CHEN_GATEKEEPER_INTENT_B64=");
    expect(script).toContain(
      'node -e \'process.stdout.write(Buffer.from(process.env.COMBO_CHEN_GATEKEEPER_INTENT_B64 || "", "base64").toString("utf8"))\'',
    );
    expect(script).toContain('--intent "$(COMBO_CHEN_GATEKEEPER_INTENT_B64=');
    expect(script).not.toContain("`printf raw-backtick`");
    expect(script).not.toContain("$(printf raw-dollar)");
    expect(script).not.toContain('Double quote: "quoted"');
    expect(script).not.toContain("Single quote: 'quoted'");
    expect(script).not.toContain("Final newline boundary.");

    const encoded = /COMBO_CHEN_GATEKEEPER_INTENT_B64='([^']+)'/.exec(script)?.[1];
    expect(encoded).toBeDefined();
    const decoded = Buffer.from(encoded!, "base64").toString("utf8");
    expect(decoded).toContain("Backtick: `printf raw-backtick`");
    expect(decoded).toContain("Dollar command: $(printf raw-dollar)");
    expect(decoded).toContain('Double quote: "quoted"');
    expect(decoded).toContain("Single quote: 'quoted'");
    expect(decoded).toContain("Final newline boundary.");
  });

  it("uses the launch gatekeeper command for post-address gates after repo TOML changes", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const runDir = mkdtempSync(join(tmpdir(), "combo-chen-run-"));
    const record = combo({ repoDir, worktree: join(repoDir, ".worktrees", "issue-7") });
    const calls: string[][] = [];
    const oldSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      '[gatekeeper]\ncommand = "printf launch-post && no-mistakes axi run --intent fixed"\n',
    );
    writeConfigSnapshot(runDir, loadConfig({ repoDir, env: {} }));
    writeFileSync(
      join(repoDir, "combo-chen.toml"),
      '[gatekeeper]\ncommand = "printf drifted-post && no-mistakes axi run --intent fixed"\n',
    );
    appendEvent(runDir, "gate_validated", { sha: oldSha });
    appendEvent(runDir, "review_comment", {
      url: "https://github.com/o/r/pull/7#discussion_r1",
      author: "reviewer",
      kind: "thread",
      head_sha: oldSha,
    });
    appendEvent(runDir, "address_done", { head_sha: headSha });

    runPostAddressGateIfNeeded({
      deps: {
        env: {},
        out: () => undefined,
        gh: () => ({ status: 0, stdout: '{"title":"Issue","body":"Body"}', stderr: "" }),
        git: (args) => {
          if (args.join(" ") === "rev-parse HEAD") {
            return { status: 0, stdout: `${headSha}\n`, stderr: "" };
          }
          if (args.join(" ") === "status --porcelain") {
            return { status: 0, stdout: "", stderr: "" };
          }
          if (args.join(" ") === `merge-base --is-ancestor ${oldSha} ${headSha}`) {
            return { status: 0, stdout: "", stderr: "" };
          }
          return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
        },
        tmux: (args) => {
          calls.push(args);
          if (args.join(" ") === "list-windows -t combo-chen-o-r-7 -F #{window_name}") {
            return {
              status: 0,
              stdout: "journal\ndirector\ncoder\ngatekeeper\nreviewer\ndirector-watch\n",
              stderr: "",
            };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      combo: record,
      runDir,
      prUrl: "https://github.com/o/r/pull/7",
      cli: "node /repo/dist/cli.mjs",
    });

    expect(calls).toContainEqual(["send-keys", "-t", "combo-chen-o-r-7:gatekeeper", "C-c"]);
    expect(calls).toContainEqual(["send-keys", "-t", "combo-chen-o-r-7:gatekeeper", "C-m"]);
    expect(calls.some((call) => call[0] === "new-window" && call.includes(GATEKEEPER_WINDOW))).toBe(false);
    const script = readFileSync(join(runDir, "gatekeeper-post-bbbbbbbbbbbb.sh"), "utf8");
    expect(script).toContain("printf launch-post");
    expect(script).not.toContain("printf drifted-post");
    const gatekeeperCommand = calls.find((call) => call[0] === "set-buffer")?.at(-1) ?? "";
    expect(gatekeeperCommand).toContain("combo_chen_idle=1");
    expect(gatekeeperCommand).toContain("trap 'combo_chen_idle=0' INT");
    expect(gatekeeperCommand).toContain('while [ "$combo_chen_idle" = 1 ]; do');
    expect(gatekeeperCommand).toContain('exec "${SHELL:-/bin/sh}"');
  });

  it("starts a post-address gate when a published gate was superseded at the current head", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const runDir = mkdtempSync(join(tmpdir(), "combo-chen-run-"));
    const record = combo({ repoDir, worktree: join(repoDir, ".worktrees", "issue-7") });
    const calls: string[][] = [];
    const oldSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    writeConfigSnapshot(runDir, loadConfig({ repoDir, env: {} }));
    appendEvent(runDir, "gate_validated", { sha: oldSha });
    appendEvent(runDir, "gate_stale", { old_sha: oldSha, new_sha: headSha });
    appendEvent(runDir, "gate_status", { state: "failed", head_sha: oldSha });

    const result = runPostAddressGateIfNeeded({
      deps: {
        env: {},
        out: () => undefined,
        gh: () => ({ status: 0, stdout: '{"title":"Issue","body":"Body"}', stderr: "" }),
        git: (args) => {
          calls.push(["git", ...args]);
          if (args.join(" ") === "rev-parse HEAD") {
            return { status: 0, stdout: `${headSha}\n`, stderr: "" };
          }
          if (args.join(" ") === "status --porcelain") {
            return { status: 0, stdout: "", stderr: "" };
          }
          return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
        },
        tmux: (args) => {
          calls.push(["tmux", ...args]);
          if (args.join(" ") === "list-windows -t combo-chen-o-r-7 -F #{window_name}") {
            return {
              status: 0,
              stdout: "journal\ndirector\ncoder\ngatekeeper\nreviewer\ndirector-watch\n",
              stderr: "",
            };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      combo: record,
      runDir,
      prUrl: "https://github.com/o/r/pull/7",
      cli: "node /repo/dist/cli.mjs",
    });

    expect(result).toEqual({ status: "started", headSha });
    expect(calls).not.toContainEqual(["git", "merge-base", "--is-ancestor", oldSha, headSha]);
    expect(calls).toContainEqual(["tmux", "send-keys", "-t", "combo-chen-o-r-7:gatekeeper", "C-c"]);
    const journal = readFileSync(join(runDir, "journal.jsonl"), "utf8");
    expect(journal).toContain('"event":"address_done"');
    expect(journal).toContain(`"head_sha":"${headSha}"`);
  });

  it("starts a post-address gate after address_done records the current head", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const runDir = mkdtempSync(join(tmpdir(), "combo-chen-run-"));
    const record = combo({ repoDir, worktree: join(repoDir, ".worktrees", "issue-7") });
    const calls: string[][] = [];
    const oldSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    writeConfigSnapshot(runDir, loadConfig({ repoDir, env: {} }));
    appendEvent(runDir, "gate_validated", { sha: oldSha });
    appendEvent(runDir, "review_comment", {
      url: "https://github.com/o/r/pull/7#discussion_r1",
      author: "reviewer",
      kind: "thread",
      head_sha: oldSha,
    });
    appendEvent(runDir, "address_done", { head_sha: headSha });

    const result = runPostAddressGateIfNeeded({
      deps: {
        env: {},
        out: () => undefined,
        gh: () => ({ status: 0, stdout: '{"title":"Issue","body":"Body"}', stderr: "" }),
        git: (args) => {
          calls.push(["git", ...args]);
          if (args.join(" ") === "rev-parse HEAD") {
            return { status: 0, stdout: `${headSha}\n`, stderr: "" };
          }
          if (args.join(" ") === "status --porcelain") {
            return { status: 0, stdout: "", stderr: "" };
          }
          if (args.join(" ") === `merge-base --is-ancestor ${oldSha} ${headSha}`) {
            return { status: 0, stdout: "", stderr: "" };
          }
          return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
        },
        tmux: (args) => {
          calls.push(["tmux", ...args]);
          if (args.join(" ") === "list-windows -t combo-chen-o-r-7 -F #{window_name}") {
            return {
              status: 0,
              stdout: "journal\ndirector\ncoder\ngatekeeper\nreviewer\ndirector-watch\n",
              stderr: "",
            };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      combo: record,
      runDir,
      prUrl: "https://github.com/o/r/pull/7",
      cli: "node /repo/dist/cli.mjs",
    });

    expect(result).toEqual({ status: "started", headSha });
    expect(calls).toContainEqual(["git", "merge-base", "--is-ancestor", oldSha, headSha]);
    expect(calls).toContainEqual(["tmux", "send-keys", "-t", "combo-chen-o-r-7:gatekeeper", "C-c"]);
    const journal = readFileSync(join(runDir, "journal.jsonl"), "utf8");
    expect(journal.match(/"event":"address_done"/g)).toHaveLength(1);
    expect(journal).toContain('"event":"gate_stale"');
    expect(journal).toContain(`"new_sha":"${headSha}"`);
  });

  it("waits when the latest local recovery does not match the worktree head", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-repo-"));
    const runDir = mkdtempSync(join(tmpdir(), "combo-chen-run-"));
    const record = combo({ repoDir, worktree: join(repoDir, ".worktrees", "issue-7") });
    const calls: string[][] = [];
    const oldSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const recoveredSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const headSha = "cccccccccccccccccccccccccccccccccccccccc";

    appendEvent(runDir, "gate_validated", { sha: oldSha });
    appendEvent(runDir, "review_comment", {
      url: "https://github.com/o/r/pull/7#discussion_r1",
      author: "reviewer",
      kind: "thread",
      head_sha: oldSha,
    });
    appendEvent(runDir, "address_done", { head_sha: recoveredSha });

    const result = runPostAddressGateIfNeeded({
      deps: {
        env: {},
        out: () => undefined,
        gh: () => ({ status: 0, stdout: '{"title":"Issue","body":"Body"}', stderr: "" }),
        git: (args) => {
          calls.push(["git", ...args]);
          if (args.join(" ") === "rev-parse HEAD") {
            return { status: 0, stdout: `${headSha}\n`, stderr: "" };
          }
          return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
        },
        tmux: (args) => {
          calls.push(["tmux", ...args]);
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      combo: record,
      runDir,
      prUrl: "https://github.com/o/r/pull/7",
      cli: "node /repo/dist/cli.mjs",
    });

    expect(result).toEqual({ status: "idle", reason: "no_coder_head_change", headSha });
    expect(calls.some((call) => call[0] === "tmux")).toBe(false);
  });
});
// -/ 4/5

// -- 5/5 CORE · syncNoMistakesMirror and post-address push safety --
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
  it("normalizes checks-passed plus context-canceled no-mistakes exits as validated", () => {
    const dir = mkdtempSync(join(tmpdir(), "combo-chen-post-gate-"));
    const worktree = join(dir, "worktree");
    const bin = join(dir, "bin");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(bin, { recursive: true });

    const localHead = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const prHead = "cccccccccccccccccccccccccccccccccccccccc";
    const eventsPath = join(dir, "events.log");
    const fakeEmit = join(bin, "emit");
    writeFileSync(
      fakeEmit,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$EVENTS_LOG"
`,
    );
    chmodSync(fakeEmit, 0o755);

    const fakeGatekeeper = join(bin, "fake-no-mistakes");
    writeFileSync(
      fakeGatekeeper,
      `#!/bin/sh
printf '%s\\n' 'outcome: checks-passed'
printf '%s\\n' 'ci.log: context canceled'
exit 42
`,
    );
    chmodSync(fakeGatekeeper, 0o755);

    const fakeGit = join(bin, "git");
    writeFileSync(
      fakeGit,
      `#!/bin/sh
if [ "$1 $2" = "rev-parse HEAD" ]; then printf '%s\\n' "$LOCAL_HEAD"; exit 0; fi
if [ "$1 $2 $3" = "remote get-url no-mistakes" ]; then exit 1; fi
printf 'unexpected git %s\\n' "$*" >&2
exit 1
`,
    );
    chmodSync(fakeGit, 0o755);

    const fakeGh = join(bin, "gh");
    writeFileSync(
      fakeGh,
      `#!/bin/sh
if [ "$1 $2" = "pr list" ]; then printf '%s\\n' 'https://github.com/o/r/pull/7'; exit 0; fi
if [ "$1 $2" = "pr view" ]; then printf '%s\\n' "$PR_HEAD"; exit 0; fi
printf 'unexpected gh %s\\n' "$*" >&2
exit 1
`,
    );
    chmodSync(fakeGh, 0o755);

    const scriptPath = join(dir, "post-address.sh");
    writeFileSync(
      scriptPath,
      buildPostAddressGateScript({
        combo: combo({ worktree }),
        runDir: dir,
        gatekeeperCommand: shellQuote(fakeGatekeeper),
        gatekeeperMirrorIntent: "SW1wbGVtZW50IGlzc3VlIDc=",
        headSha: localHead,
        prUrl: "https://github.com/o/r/pull/7",
        emit: shellQuote(fakeEmit),
      }),
    );
    chmodSync(scriptPath, 0o755);

    const result = spawnSync("sh", [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        EVENTS_LOG: eventsPath,
        LOCAL_HEAD: localHead,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        PR_HEAD: prHead,
      },
    });

    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0,
      stdout:
        "post-address gate for o-r-7 at bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\noutcome: checks-passed\nci.log: context canceled\n",
      stderr: "",
    });
    expect(readFileSync(eventsPath, "utf8").trim().split("\n")).toEqual([
      "gate_started",
      `gate_status --field state=fix_inflight --field head_sha=${localHead}`,
      `gate_status --field state=idle --field head_sha=${prHead} --field recovery=checks_passed_context_canceled`,
      `gate_validated --field sha=${prHead}`,
    ]);
  });

  it("publishes rewritten local HEAD to an existing mirror branch with force-with-lease", () => {
    const script = buildPostAddressGateScript({
      combo: combo(),
      runDir: mkdtempSync(join(tmpdir(), "combo-chen-run-")),
      gatekeeperCommand: "no-mistakes axi run --intent 'post-address gate'",
      gatekeeperMirrorIntent: "SW1wbGVtZW50IGlzc3VlIDc=",
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      prUrl: "https://github.com/o/r/pull/7",
      emit: "combo-chen emit -n o-r-7",
      ensurePrAutoclose: "combo-chen ensure-pr-autoclose -n o-r-7 --pr-url",
    });

    expect(script).toContain("mirror_intent='no-mistakes.intent=SW1wbGVtZW50IGlzc3VlIDc='");
    expect(script).toContain(
      'git push -o "$mirror_intent" no-mistakes --force-with-lease="$mirror_ref:$mirror_sha" "HEAD:$mirror_ref"',
    );
    expect(script).toContain('git push -o "$mirror_intent" no-mistakes "HEAD:$mirror_ref"');
    expect(script).not.toContain("git push no-mistakes HEAD");
    expect(script).toContain('no-mistakes axi status > "$status_probe_log" 2>&1');
    expect(script).toContain("gatekeeper_run_id=$(sed -n");
    expect(script).toContain('exec no-mistakes attach --run "$gatekeeper_run_id"');
    expect(script).toContain("branch: combo/issue-7");
    expect(script).toContain("gatekeeper_failure_reason=gate_failed");
    expect(script).toContain("gatekeeper_failure_reason=daemon_dead");
    expect(script).toContain(
      'gate_failed --field exit_code="$gatekeeper_code" --field reason="$gatekeeper_failure_reason"',
    );
    expect(script).toContain('pr_head_sha=$(gh pr view "$pr_url" --json headRefOid --jq');
    expect(script).toContain('gatekeeper_head_sha="$pr_head_sha"');
    expect(script).toContain('gate_validated --field sha="$gatekeeper_head_sha"');
    expect(script).toContain('pr_autoclose_failed --field exit_code="$autoclose_code" --field url="$pr_url"');
    expect(script).toContain('exit "$autoclose_code"');
    expect(script).not.toContain("autoclose guard skipped");
  });

  it("can acquire and release a shared lease around the post-address no-mistakes run", () => {
    const script = buildPostAddressGateScript({
      combo: combo(),
      runDir: mkdtempSync(join(tmpdir(), "combo-chen-run-")),
      gatekeeperCommand: "no-mistakes axi run --intent 'post-address gate'",
      gatekeeperMirrorIntent: "SW1wbGVtZW50IGlzc3VlIDc=",
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      prUrl: "https://github.com/o/r/pull/7",
      emit: "combo-chen emit -n o-r-7",
      gateLeaseAcquire: "combo-chen gate-lease acquire -n o-r-7",
      gateLeaseRelease: "combo-chen gate-lease release -n o-r-7",
      ensurePrAutoclose: "combo-chen ensure-pr-autoclose -n o-r-7 --pr-url",
    });

    expect(script.indexOf("gate-lease acquire")).toBeLessThan(
      script.indexOf("gate_status --field state=fix_inflight"),
    );
    expect(script.indexOf("gate_status --field state=fix_inflight")).toBeLessThan(
      script.indexOf("no-mistakes axi run"),
    );
    expect(script).toContain('if [ "$gate_lease_code" -eq 75 ]; then exit 0; fi');
    expect(script).toContain("gate-lease release -n o-r-7");
  });
});
// -/ 5/5
