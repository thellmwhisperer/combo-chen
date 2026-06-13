import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ComboConfigError, loadConfig, renderCommand } from "./config.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "combo-chen-test-"));
}

function writeToml(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

describe("loadConfig", () => {
  it("returns the documented defaults when no config exists", () => {
    const config = loadConfig({ repoDir: tempDir(), userConfigPath: join(tempDir(), "missing.toml") });

    expect(config.roles.coder).toBe("codex");
    expect(config.roles.gatekeeper).toBe("no-mistakes");
    expect(config.roles.reviewer).toEqual(["claude", "coderabbit"]);
    expect(config.roles.merge).toBe("human");
    expect(config.roles).not.toHaveProperty("rower");
    expect(config.roles).not.toHaveProperty("hodor");
    expect(config.roles).not.toHaveProperty("gordon");
    expect(config.limits.babysitPollSeconds).toBe(120);
    expect(config.limits.coderTimeoutMinutes).toBe(180);
    expect(config.hodorAttachTimeoutSeconds).toBe(1800);
    expect(config.hodorAttachRetryIntervalSeconds).toBe(10);
    expect(config.limits.teardownGitRetries).toBe(2);
    expect(config.limits.teardownGitBackoffSeconds).toBe(2);
    // No quotes around {prompt}: renderCommand substitutes values as
    // already-quoted shell tokens.
    expect(config.rowerCommand).toBe("npx -y gnhf --agent codex --current-branch {prompt}");
    expect(config.rowerResumeCommand).toBe("codex resume {thread_id}");
    expect(config.reviewNudgePrompt).toContain("coder responding mode");
    expect(config.reviewNudgePrompt).toContain("two-bucket contract");
    expect(config.reviewNudgePrompt).toContain("gatekeeper push semaphore");
    expect(config.threadSitterWindowName).toBe("coder-responding");
    expect(config.threadSitterWatchWindowName).toBe("comment-watch");
    expect(config.reviewerAgent).toBe("claude");
    expect(config.reviewerCommand).toBe("claude {prompt}");
    expect(config.reviewerProtocol).toContain("7989");
  });

  it("lets the user config override defaults", () => {
    const userDir = tempDir();
    const userConfig = writeToml(
      userDir,
      "config.toml",
      '[roles]\nrower = "hermes:deepseek"\n\n[rower."hermes:deepseek"]\ncommand = "hermes -z \\"{prompt}\\""\nresume_command = "hermes --resume {thread_id}"\n\n[thread_sitter]\nreview_nudge_prompt = "Please inspect {url}"\nwindow_name = "sitter"\nwatch_window_name = "sitter-watch"\n',
    );

    const config = loadConfig({ repoDir: tempDir(), userConfigPath: userConfig });

    expect(config.roles.coder).toBe("hermes:deepseek");
    expect(config.rowerCommand).toBe('hermes -z "{prompt}"');
    expect(config.rowerResumeCommand).toBe("hermes --resume {thread_id}");
    expect(config.reviewNudgePrompt).toBe("Please inspect {url}");
    expect(config.threadSitterWindowName).toBe("sitter");
    expect(config.threadSitterWatchWindowName).toBe("sitter-watch");
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
    expect(repoConfig.hodorAttachTimeoutSeconds).toBe(600);
    expect(repoConfig.hodorAttachRetryIntervalSeconds).toBe(20);

    const envConfig = loadConfig({
      repoDir,
      userConfigPath: userConfig,
      env: {
        COMBO_CHEN_HODOR_ATTACH_TIMEOUT_SECONDS: "75",
        COMBO_CHEN_HODOR_ATTACH_RETRY_INTERVAL_SECONDS: "15",
      },
    });
    expect(envConfig.hodorAttachTimeoutSeconds).toBe(75);
    expect(envConfig.hodorAttachRetryIntervalSeconds).toBe(15);

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
    expect(newEnvConfig.hodorAttachTimeoutSeconds).toBe(45);
    expect(newEnvConfig.hodorAttachRetryIntervalSeconds).toBe(9);
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
        'watch_window_name = "comment-watch-local"',
        "",
      ].join("\n"),
    );

    const config = loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") });

    expect(config.roles.coder).toBe("hermes:deepseek");
    expect(config.roles.gatekeeper).toBe("no-mistakes");
    expect(config.roles.reviewer).toEqual(["coderabbit", "hermes:gemini"]);
    expect(config.roles).not.toHaveProperty("rower");
    expect(config.roles).not.toHaveProperty("hodor");
    expect(config.roles).not.toHaveProperty("gordon");
    expect(config.rowerCommand).toBe("hermes -z {prompt}");
    expect(config.rowerResumeCommand).toBe("hermes --resume {thread_id}");
    expect(config.hodorCommand).toBe("gate --intent {issue_pr_intent}");
    expect(config.hodorAttachTimeoutSeconds).toBe(42);
    expect(config.hodorAttachRetryIntervalSeconds).toBe(6);
    expect(config.reviewerAgent).toBe("hermes:gemini");
    expect(config.reviewerCommand).toBe("hermes review {pr_url} {prompt}");
    expect(config.reviewerProtocol).toBe("project review protocol 1234");
    expect(config.reviewNudgePrompt).toBe("Please review {url}");
    expect(config.threadSitterWindowName).toBe("coder-reply");
    expect(config.threadSitterWatchWindowName).toBe("comment-watch-local");
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
});

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
