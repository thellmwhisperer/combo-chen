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
    expect(config.rowerCommand).toContain("gnhf");
    expect(config.rowerCommand).toContain("{prompt}");
  });

  it("lets the user config override defaults", () => {
    const userDir = tempDir();
    const userConfig = writeToml(
      userDir,
      "config.toml",
      '[roles]\nrower = "hermes:deepseek"\n\n[rower."hermes:deepseek"]\ncommand = "hermes -z \\"{prompt}\\""\n',
    );

    const config = loadConfig({ repoDir: tempDir(), userConfigPath: userConfig });

    expect(config.roles.rower).toBe("hermes:deepseek");
    expect(config.rowerCommand).toBe('hermes -z "{prompt}"');
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
});

describe("renderCommand", () => {
  it("interpolates the documented placeholders", () => {
    const rendered = renderCommand("gnhf --x {issue_url} in {worktree} for {repo} on {branch}: {prompt}", {
      issue_url: "https://github.com/o/r/issues/7",
      worktree: "/tmp/wt",
      repo: "o/r",
      branch: "combo/issue-7",
      prompt: "do it",
    });

    expect(rendered).toBe("gnhf --x https://github.com/o/r/issues/7 in /tmp/wt for o/r on combo/issue-7: do it");
  });

  it("throws on unknown placeholders so typos never reach a shell", () => {
    expect(() => renderCommand("gnhf {isue_url}", { issue_url: "x" })).toThrow(/isue_url/);
  });
});
