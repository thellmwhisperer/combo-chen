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

    expect(config.roles.rower).toBe("codex");
    expect(config.roles.hodor).toBe("no-mistakes");
    expect(config.roles.gordon).toEqual(["claude", "coderabbit"]);
    expect(config.roles.merge).toBe("human");
    expect(config.limits.babysitPollSeconds).toBe(120);
    expect(config.limits.rowerTimeoutMinutes).toBe(180);
    // No quotes around {prompt}: renderCommand substitutes values as
    // already-quoted shell tokens.
    expect(config.rowerCommand).toBe("npx -y gnhf --agent codex --current-branch {prompt}");
    expect(config.rowerResumeCommand).toBe("codex resume {thread_id}");
    expect(config.reviewNudgePrompt).toContain("{url}");
    expect(config.reviewNudgePrompt).toContain("two-bucket contract");
    expect(config.threadSitterWindowName).toBe("thread-sitter");
    expect(config.threadSitterWatchWindowName).toBe("thread-sitter-watch");
  });

  it("lets the user config override defaults", () => {
    const userDir = tempDir();
    const userConfig = writeToml(
      userDir,
      "config.toml",
      '[roles]\nrower = "hermes:deepseek"\n\n[rower."hermes:deepseek"]\ncommand = "hermes -z \\"{prompt}\\""\nresume_command = "hermes --resume {thread_id}"\n\n[thread_sitter]\nreview_nudge_prompt = "Please inspect {url}"\nwindow_name = "sitter"\nwatch_window_name = "sitter-watch"\n',
    );

    const config = loadConfig({ repoDir: tempDir(), userConfigPath: userConfig });

    expect(config.roles.rower).toBe("hermes:deepseek");
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

    expect(config.roles.rower).toBe("codex");
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
