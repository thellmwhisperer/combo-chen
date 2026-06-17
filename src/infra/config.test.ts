/**
 * @overview Unit tests for config loading and command rendering. ~540 lines,
 *   testing the env → repo → user → fallback cascade, legacy role alias
 *   mapping, validation rejections, and the renderCommand placeholder engine.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at describe("loadConfig")   ← config cascade contract
 *   2. Then describe("unsafeCoderInvocationReasons") <- runner safety policy
 *   3. Then describe("renderCommand")    ← shell-safe placeholder interpolation
 *
 *   ┌─ TEST AREAS ──────────────────────────────────────────────┐
 *   │ loadConfig      Defaults, cascade, legacy aliases,        │
 *   │                 validation rejections                      │
 *   │ safety guard    Unsafe gnhf invocation detection           │
 *   │ renderCommand   Placeholder interpolation, shell quoting   │
 *   └────────────────────────────────────────────────────────────┘
 *
 * @exports none (test file)
 * @deps vitest, node:{fs,os,path}, ./config
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ComboConfigError, loadConfig, renderCommand, unsafeCoderInvocationReasons } from "./config.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "combo-chen-test-"));
}

function writeToml(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

// -- 1/3 CORE · Config loading cascade tests ← START HERE --


describe("loadConfig", () => {
  it("returns the documented defaults when no config exists", () => {
    const config = loadConfig({ repoDir: tempDir(), userConfigPath: join(tempDir(), "missing.toml") });

    expect(config.roles.coder).toBe("codex");
    expect(config.roles.gatekeeper).toBe("no-mistakes");
    expect(config.roles.reviewer).toEqual(["claude"]);
    expect(config.ambientReviewerAgents).toEqual(["coderabbit"]);
    expect(config.roles.merge).toBe("human");
    expect(config.roles).not.toHaveProperty("rower");
    expect(config.roles).not.toHaveProperty("hodor");
    expect(config.roles).not.toHaveProperty("gordon");
    expect(config.limits.babysitPollSeconds).toBe(120);
    expect(config.limits.coderTimeoutMinutes).toBe(180);
    expect(config.gatekeeperAttachTimeoutSeconds).toBe(1800);
    expect(config.gatekeeperAttachRetryIntervalSeconds).toBe(10);
    expect(config.limits.teardownGitRetries).toBe(2);
    expect(config.limits.teardownGitBackoffSeconds).toBe(2);
    expect(config.limits.watchFailureLimit).toBe(5);
    expect(config.limits.watchBackoffMaxSeconds).toBe(3600);
    // No quotes around {prompt}: renderCommand substitutes values as
    // already-quoted shell tokens.
    expect(config.coderCommand).toContain("npx -y gnhf@0.1.41");
    expect(config.coderCommand).toContain("--max-iterations 12");
    expect(config.coderCommand).toContain("--stop-when");
    expect(config.coderCommand).toContain("--prevent-sleep on");
    expect(config.coderCommand).toContain("--meteor-frequency 0");
    expect(config.coderCommand).toContain("--current-branch {prompt}");
    expect(config.coderResumeCommand).toBe("codex resume {thread_id}");
    expect(config.gatekeeperCommand).toContain("no-mistakes daemon start");
    expect(config.gatekeeperCommand).toContain("no-mistakes axi run --intent {issue_pr_intent}");
    expect(config.gatekeeperCommand).toContain("--skip=ci");
    expect(config.gatekeeperCommand.indexOf("no-mistakes daemon start")).toBeLessThan(
      config.gatekeeperCommand.indexOf("no-mistakes axi run"),
    );
    expect(config.gatekeeperCommand).not.toContain("git push no-mistakes");
    expect(config).not.toHaveProperty("rowerCommand");
    expect(config).not.toHaveProperty("rowerResumeCommand");
    expect(config).not.toHaveProperty("hodorCommand");
    expect(config).not.toHaveProperty("hodorAttachTimeoutSeconds");
    expect(config).not.toHaveProperty("hodorAttachRetryIntervalSeconds");
    expect(config.reviewNudgePrompt).toContain("coder responding mode");
    expect(config.reviewNudgePrompt).toContain("two-bucket contract");
    expect(config.reviewNudgePrompt).toContain("Do not push");
    expect(config.reviewNudgePrompt).toContain("Leave committed local changes");
    expect(config.reviewNudgePrompt).toContain("gatekeeper/no-mistakes");
    expect(config.coderRespondingWindowName).toBe("coder-responding");
    expect(config).not.toHaveProperty("threadSitterWindowName");
    expect(config).not.toHaveProperty("threadSitterWatchWindowName");
    expect(config.reviewerAgent).toBe("claude");
    expect(config.reviewerCommand).toBe("claude {prompt}");
    expect(config.reviewerProtocol).toBe("repository review protocol + project overlay");
  });

  it("lets the user config override defaults", () => {
    const userDir = tempDir();
    const userConfig = writeToml(
      userDir,
      "config.toml",
      '[roles]\nrower = "hermes:deepseek"\n\n[rower."hermes:deepseek"]\ncommand = "hermes -z \\"{prompt}\\""\nresume_command = "hermes --resume {thread_id}"\n\n[thread_sitter]\nreview_nudge_prompt = "Please inspect {url}"\nwindow_name = "sitter"\n',
    );

    const config = loadConfig({ repoDir: tempDir(), userConfigPath: userConfig });

    expect(config.roles.coder).toBe("hermes:deepseek");
    expect(config.coderCommand).toBe('hermes -z "{prompt}"');
    expect(config.coderResumeCommand).toBe("hermes --resume {thread_id}");
    expect(config.reviewNudgePrompt).toBe("Please inspect {url}");
    expect(config.coderRespondingWindowName).toBe("sitter");
  });

  it("lets reviewer ambient checks stay configurable outside the active reviewer command", () => {
    const repoDir = tempDir();
    writeToml(
      repoDir,
      "combo-chen.toml",
      [
        "[roles]",
        'reviewer = ["claude"]',
        "",
        "[reviewer]",
        'ambient = ["reviewdog"]',
        "",
        "[reviewer.claude]",
        'command = "claude {prompt}"',
      ].join("\n"),
    );

    const config = loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") });

    expect(config.reviewerAgent).toBe("claude");
    expect(config.ambientReviewerAgents).toEqual(["reviewdog"]);
  });

  it("keeps configured ambient reviewer agents out of coder and active reviewer roles", () => {
    const repoDir = tempDir();
    writeToml(
      repoDir,
      "combo-chen.toml",
      [
        "[roles]",
        'coder = "codex"',
        'reviewer = ["claude"]',
        "",
        "[reviewer]",
        'ambient = ["codex", "claude", "reviewdog", "reviewdog"]',
        "",
        "[reviewer.claude]",
        'command = "claude {prompt}"',
      ].join("\n"),
    );

    const config = loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") });

    expect(config.reviewerAgent).toBe("claude");
    expect(config.ambientReviewerAgents).toEqual(["reviewdog"]);
  });

  it("repo config wins over user config (repo owns policy)", () => {
    const userDir = tempDir();
    const userConfig = writeToml(userDir, "config.toml", '[roles]\nrower = "hermes:deepseek"\n\n[rower."hermes:deepseek"]\ncommand = "hermes"\n');
    const repoDir = tempDir();
    writeToml(repoDir, "combo-chen.toml", '[roles]\nrower = "codex"\n');

    const config = loadConfig({ repoDir, userConfigPath: userConfig });

    expect(config.roles.coder).toBe("codex");
  });

  it("loads gatekeeper attach retry settings through env, repo, user, fallback order", () => {
    const userDir = tempDir();
    const userConfig = writeToml(
      userDir,
      "config.toml",
      "[hodor]\nattach_timeout_seconds = 900\nattach_retry_interval_seconds = 30\n",
    );
    const repoDir = tempDir();
    writeToml(
      repoDir,
      "combo-chen.toml",
      "[hodor]\nattach_timeout_seconds = 600\nattach_retry_interval_seconds = 20\n",
    );

    const repoConfig = loadConfig({ repoDir, userConfigPath: userConfig, env: {} });
    expect(repoConfig.gatekeeperAttachTimeoutSeconds).toBe(600);
    expect(repoConfig.gatekeeperAttachRetryIntervalSeconds).toBe(20);

    const envConfig = loadConfig({
      repoDir,
      userConfigPath: userConfig,
      env: {
        COMBO_CHEN_HODOR_ATTACH_TIMEOUT_SECONDS: "75",
        COMBO_CHEN_HODOR_ATTACH_RETRY_INTERVAL_SECONDS: "15",
      },
    });
    expect(envConfig.gatekeeperAttachTimeoutSeconds).toBe(75);
    expect(envConfig.gatekeeperAttachRetryIntervalSeconds).toBe(15);

    const newEnvConfig = loadConfig({
      repoDir,
      userConfigPath: userConfig,
      env: {
        COMBO_CHEN_HODOR_ATTACH_TIMEOUT_SECONDS: "75",
        COMBO_CHEN_HODOR_ATTACH_RETRY_INTERVAL_SECONDS: "15",
        COMBO_CHEN_GATEKEEPER_ATTACH_TIMEOUT_SECONDS: "45",
        COMBO_CHEN_GATEKEEPER_ATTACH_RETRY_INTERVAL_SECONDS: "9",
      },
    });
    expect(newEnvConfig.gatekeeperAttachTimeoutSeconds).toBe(45);
    expect(newEnvConfig.gatekeeperAttachRetryIntervalSeconds).toBe(9);
  });

  it("loads teardown retry limits from the standard limits cascade", () => {
    const userDir = tempDir();
    const userConfig = writeToml(
      userDir,
      "config.toml",
      "[limits]\nteardown_git_retries = 4\nteardown_git_backoff_seconds = 3\n",
    );
    const repoDir = tempDir();
    writeToml(repoDir, "combo-chen.toml", "[limits]\nteardown_git_retries = 1\n");

    const config = loadConfig({ repoDir, userConfigPath: userConfig });

    expect(config.limits.teardownGitRetries).toBe(1);
    expect(config.limits.teardownGitBackoffSeconds).toBe(3);
  });

  it("loads the watcher failure limit from repo config or env", () => {
    const repoDir = tempDir();
    writeToml(repoDir, "combo-chen.toml", "[limits]\nwatch_failure_limit = 3\n");

    const repoConfig = loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml"), env: {} });
    expect(repoConfig.limits.watchFailureLimit).toBe(3);

    const envConfig = loadConfig({
      repoDir,
      userConfigPath: join(tempDir(), "missing.toml"),
      env: { COMBO_CHEN_WATCH_FAILURE_LIMIT: "2" },
    });
    expect(envConfig.limits.watchFailureLimit).toBe(2);

    for (const value of ["0", "-1", "1.5", '"nope"']) {
      const invalidRepoDir = tempDir();
      writeToml(invalidRepoDir, "combo-chen.toml", `[limits]\nwatch_failure_limit = ${value}\n`);
      expect(() =>
        loadConfig({ repoDir: invalidRepoDir, userConfigPath: join(tempDir(), "missing.toml"), env: {} }),
      ).toThrow(/watch_failure_limit/);
    }

    for (const value of ["0", "-1", "1.5", "nope"]) {
      expect(() =>
        loadConfig({
          repoDir,
          userConfigPath: join(tempDir(), "missing.toml"),
          env: { COMBO_CHEN_WATCH_FAILURE_LIMIT: value },
        }),
      ).toThrow(/watch_failure_limit/);
    }
  });

  it("loads the watcher max backoff from repo config or env", () => {
    const repoDir = tempDir();
    writeToml(repoDir, "combo-chen.toml", "[limits]\nwatch_backoff_max_seconds = 30\n");

    const repoConfig = loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml"), env: {} });
    expect(repoConfig.limits.watchBackoffMaxSeconds).toBe(30);

    const envConfig = loadConfig({
      repoDir,
      userConfigPath: join(tempDir(), "missing.toml"),
      env: { COMBO_CHEN_WATCH_BACKOFF_MAX_SECONDS: "45" },
    });
    expect(envConfig.limits.watchBackoffMaxSeconds).toBe(45);
  });

  it("loads canonical coder timeout while preserving the legacy rower timeout alias", () => {
    const userDir = tempDir();
    const userConfig = writeToml(userDir, "config.toml", "[limits]\nrower_timeout_minutes = 111\n");

    const legacyConfig = loadConfig({ repoDir: tempDir(), userConfigPath: userConfig });
    expect(legacyConfig.limits.coderTimeoutMinutes).toBe(111);

    const repoDir = tempDir();
    writeToml(repoDir, "combo-chen.toml", "[limits]\ncoder_timeout_minutes = 222\n");

    const config = loadConfig({ repoDir, userConfigPath: userConfig });

    expect(config.limits.coderTimeoutMinutes).toBe(222);
  });

  it("loads OSS-friendly role and section names while preserving old role aliases", () => {
    const repoDir = tempDir();
    writeToml(
      repoDir,
      "combo-chen.toml",
      [
        "[roles]",
        'coder = "hermes:deepseek"',
        'gatekeeper = "no-mistakes"',
        'reviewer = ["coderabbit", "hermes:gemini"]',
        "",
        '[coder."hermes:deepseek"]',
        'command = "hermes -z {prompt}"',
        'resume_command = "hermes --resume {thread_id}"',
        "",
        "[gatekeeper]",
        'command = "gate --intent {issue_pr_intent}"',
        "attach_timeout_seconds = 42",
        "attach_retry_interval_seconds = 6",
        "",
        "[reviewer]",
        'protocol = "project review protocol 1234"',
        "",
        '[reviewer."hermes:gemini"]',
        'command = "hermes review {pr_url} {prompt}"',
        "",
        "[coder_responding]",
        'review_nudge_prompt = "Please review {url}"',
        'window_name = "coder-reply"',
        "",
      ].join("\n"),
    );

    const config = loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") });

    expect(config.roles.coder).toBe("hermes:deepseek");
    expect(config.roles.gatekeeper).toBe("no-mistakes");
    expect(config.roles.reviewer).toEqual(["coderabbit", "hermes:gemini"]);
    expect(config.ambientReviewerAgents).toEqual(["coderabbit"]);
    expect(config.roles).not.toHaveProperty("rower");
    expect(config.roles).not.toHaveProperty("hodor");
    expect(config.roles).not.toHaveProperty("gordon");
    expect(config.coderCommand).toBe("hermes -z {prompt}");
    expect(config.coderResumeCommand).toBe("hermes --resume {thread_id}");
    expect(config).not.toHaveProperty("rowerCommand");
    expect(config).not.toHaveProperty("rowerResumeCommand");
    expect(config.gatekeeperCommand).toBe("gate --intent {issue_pr_intent}");
    expect(config.gatekeeperAttachTimeoutSeconds).toBe(42);
    expect(config.gatekeeperAttachRetryIntervalSeconds).toBe(6);
    expect(config).not.toHaveProperty("hodorCommand");
    expect(config).not.toHaveProperty("hodorAttachTimeoutSeconds");
    expect(config).not.toHaveProperty("hodorAttachRetryIntervalSeconds");
    expect(config.reviewerAgent).toBe("hermes:gemini");
    expect(config.reviewerCommand).toBe("hermes review {pr_url} {prompt}");
    expect(config.reviewerProtocol).toBe("project review protocol 1234");
    expect(config.reviewNudgePrompt).toBe("Please review {url}");
    expect(config.coderRespondingWindowName).toBe("coder-reply");
    expect(config).not.toHaveProperty("threadSitterWindowName");
    expect(config).not.toHaveProperty("threadSitterWatchWindowName");
  });

  it("refuses to launch when gordon would judge their own cooking", () => {
    const repoDir = tempDir();
    writeToml(repoDir, "combo-chen.toml", '[roles]\nrower = "claude"\ngordon = ["claude"]\n\n[rower.claude]\ncommand = "claude -p \\"{prompt}\\""\n');

    expect(() => loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") })).toThrow(ComboConfigError);
    expect(() => loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") })).toThrow(/gordon/);
  });

  it("rejects an empty gordon (it would silently disable judgment)", () => {
    const repoDir = tempDir();
    writeToml(repoDir, "combo-chen.toml", "[roles]\ngordon = []\n");

    expect(() => loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") })).toThrow(ComboConfigError);
    expect(() => loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") })).toThrow(/gordon/);
  });

  it("accepts gordon as a single string and still validates against the rower", () => {
    const repoDir = tempDir();
    writeToml(repoDir, "combo-chen.toml", '[roles]\nrower = "codex"\ngordon = "codex"\n');

    expect(() => loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") })).toThrow(ComboConfigError);
  });

  it("rejects unknown role names instead of ignoring typos", () => {
    const repoDir = tempDir();
    writeToml(repoDir, "combo-chen.toml", '[roles]\nrooer = "codex"\n');

    expect(() => loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") })).toThrow(/rooer/);
  });

  it("requires a command template for a custom rower", () => {
    const repoDir = tempDir();
    writeToml(repoDir, "combo-chen.toml", '[roles]\nrower = "my-exotic-agent"\n');

    expect(() => loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") })).toThrow(/my-exotic-agent/);
  });

  it("rejects a non-string rower command template during config load", () => {
    const repoDir = tempDir();
    writeToml(
      repoDir,
      "combo-chen.toml",
      '[rower.codex]\ncommand = 123\nresume_command = "codex resume {thread_id}"\n',
    );

    expect(() => loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") })).toThrow(ComboConfigError);
    expect(() => loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") })).toThrow(/command template/);
  });

  it("requires a resume command template for a custom rower", () => {
    const repoDir = tempDir();
    writeToml(
      repoDir,
      "combo-chen.toml",
      '[roles]\nrower = "my-exotic-agent"\n\n[rower."my-exotic-agent"]\ncommand = "agent run {prompt}"\n',
    );

    expect(() => loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") })).toThrow(/resume/i);
  });

  it("rejects a non-string rower resume command template during config load", () => {
    const repoDir = tempDir();
    writeToml(
      repoDir,
      "combo-chen.toml",
      '[rower.codex]\ncommand = "codex run {prompt}"\nresume_command = 123\n',
    );

    expect(() => loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") })).toThrow(ComboConfigError);
    expect(() => loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") })).toThrow(/resume command template/);
  });

  it("rejects a non-string gatekeeper command template during config load", () => {
    const repoDir = tempDir();
    writeToml(repoDir, "combo-chen.toml", "[gatekeeper]\ncommand = 123\n");

    expect(() => loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") })).toThrow(ComboConfigError);
    expect(() => loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") })).toThrow(/command template/);
  });

  it("rejects non-string coder responding templates during config load", () => {
    const repoDir = tempDir();
    writeToml(repoDir, "combo-chen.toml", "[coder_responding]\nwindow_name = 123\n");

    expect(() => loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") })).toThrow(ComboConfigError);
    expect(() => loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") })).toThrow(/coder_responding.window_name/);
  });

  it("resolves the first configured gordon command and protocol", () => {
    const repoDir = tempDir();
    writeToml(
      repoDir,
      "combo-chen.toml",
      [
        "[roles]",
        'gordon = ["coderabbit", "hermes:gemini"]',
        "",
        "[gordon]",
        'protocol = "project review protocol 1234"',
        "",
        '[gordon."hermes:gemini"]',
        'command = "hermes judge {pr_url} {prompt}"',
        "",
      ].join("\n"),
    );

    const config = loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") });

    expect(config.reviewerAgent).toBe("hermes:gemini");
    expect(config.reviewerCommand).toBe("hermes judge {pr_url} {prompt}");
    expect(config.reviewerProtocol).toBe("project review protocol 1234");
  });

  it("requires at least one configured gordon command", () => {
    const repoDir = tempDir();
    writeToml(repoDir, "combo-chen.toml", '[roles]\ngordon = ["coderabbit"]\n');

    expect(() => loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") })).toThrow(/gordon/i);
    expect(() => loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") })).toThrow(/command/i);
  });

  it("rejects a non-string reviewer command template during config load", () => {
    const repoDir = tempDir();
    writeToml(
      repoDir,
      "combo-chen.toml",
      '[roles]\nreviewer = ["local"]\n\n[reviewer.local]\ncommand = 123\n',
    );

    expect(() => loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") })).toThrow(ComboConfigError);
    expect(() => loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") })).toThrow(/command template/);
  });
});
// -/ 1/3

// -- 2/3 HELPER · Coder safety guard tests --
describe("unsafeCoderInvocationReasons", () => {
  it("treats codex coder commands without gnhf as unsafe while leaving explicit wrappers configurable", () => {
    expect(unsafeCoderInvocationReasons("codex run {prompt}", { requireGnhf: true })).toEqual(["gnhf command"]);
    expect(unsafeCoderInvocationReasons("hermes -z {prompt}", { requireGnhf: false })).toEqual([]);
  });

  it("treats path-based gnhf invocations as gnhf commands that require safeguards", () => {
    expect(
      unsafeCoderInvocationReasons(
        "/usr/local/bin/gnhf@1.2.3 --max-iterations 12 --stop-when done --prevent-sleep on --meteor-frequency 0",
      ),
    ).toEqual([]);
    expect(unsafeCoderInvocationReasons("./gnhf --max-iterations 12")).toEqual([
      "pinned gnhf package version",
      "--stop-when",
      "--prevent-sleep on",
      "telemetry off (--meteor-frequency 0)",
    ]);
  });
});
// -/ 2/3

// -- 3/3 HELPER · Command rendering tests --
describe("renderCommand", () => {
  it("interpolates the documented placeholders as single-quoted shell tokens", () => {
    const rendered = renderCommand("gnhf --x {issue_url} in {worktree} for {repo} on {branch}: {prompt}", {
      issue_url: "https://github.com/o/r/issues/7",
      worktree: "/tmp/wt",
      repo: "o/r",
      branch: "combo/issue-7",
      prompt: "do it",
    });

    expect(rendered).toBe(
      "gnhf --x 'https://github.com/o/r/issues/7' in '/tmp/wt' for 'o/r' on 'combo/issue-7': 'do it'",
    );
  });

  it("keeps a prompt with a double-quote and a semicolon one single literal token", () => {
    const rendered = renderCommand("npx -y gnhf --agent codex --current-branch {prompt}", {
      prompt: 'say "done"; echo extra',
    });

    expect(rendered).toBe(`npx -y gnhf --agent codex --current-branch 'say "done"; echo extra'`);
  });

  it("throws on unknown placeholders so typos never reach a shell", () => {
    expect(() => renderCommand("gnhf {isue_url}", { issue_url: "x" })).toThrow(/isue_url/);
  });
});
// -/ 3/3
