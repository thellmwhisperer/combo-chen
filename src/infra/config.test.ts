/**
 * @overview Unit tests for config loading and command rendering. ~925 lines,
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
    expect(config.externalCommentAgents).toEqual([]);
    expect(config.externalReviewCommands).toEqual([]);
    expect(config.readyRequiredChecks).toEqual([]);
    expect(config.prLabelGreenCheckNames).toEqual([]);
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
    expect(config.workerStallTicks).toBe(3);
    expect(config.workerRecoveryAttempts).toBe(2);
    expect(config.workerPermissionPromptPatterns).toEqual(
      expect.arrayContaining([
        "^\\s*Do you want to (?:proceed|continue)\\?\\s*(?:\\[[yn]/[yn]\\])?\\s*$",
      ]),
    );
    expect(config.workerPermissionPromptPolicy).toBe("escalate");
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
    expect(config.directorCommand).toBe("claude {prompt}");
    expect(config.gatekeeperInitialGateRetryAttempts).toBe(2);
    expect(config.gatekeeperInitialGateRetryBackoffSeconds).toBe(10);
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
    expect(config.reviewerPrompt).toBe("");
    expect(config.reviewerLogins).toEqual(["claude"]);
    expect(config.directorCommand).toBe("claude {prompt}");
    expect(config.sourceBranch).toBe("main");
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

  it("loads external comment agents outside the active reviewer command", () => {
    const repoDir = tempDir();
    writeToml(
      repoDir,
      "combo-chen.toml",
      [
        "[roles]",
        'reviewer = ["claude"]',
        "",
        "[external_comments]",
        'agents = ["reviewdog"]',
        "",
        "[reviewer.claude]",
        'command = "claude {prompt}"',
      ].join("\n"),
    );

    const config = loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") });

    expect(config.reviewerAgent).toBe("claude");
    expect(config.externalCommentAgents).toEqual(["reviewdog"]);
    expect(config).not.toHaveProperty("ambientReviewerAgents");
  });

  it("loads external review trigger commands separately from comment filters", () => {
    const repoDir = tempDir();
    writeToml(
      repoDir,
      "combo-chen.toml",
      [
        "[external_review]",
        'commands = ["@coderabbitai review"]',
        "",
        "[external_comments]",
        'agents = ["coderabbitai"]',
      ].join("\n"),
    );

    const config = loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") });

    expect(config.externalReviewCommands).toEqual(["@coderabbitai review"]);
    expect(config.externalCommentAgents).toEqual(["coderabbitai"]);
  });

  it("loads reviewer GitHub logins for trusted LGTM authors", () => {
    const repoDir = tempDir();
    writeToml(
      repoDir,
      "combo-chen.toml",
      [
        "[roles]",
        'reviewer = ["claude"]',
        "",
        "[reviewer]",
        'logins = ["Javi", "claude-reviewer"]',
        "",
        "[reviewer.claude]",
        'command = "claude {prompt}"',
      ].join("\n"),
    );

    const config = loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") });

    expect(config.reviewerLogins).toEqual(["Javi", "claude-reviewer"]);
  });

  it("lets repo and env config override the promptable director command", () => {
    const repoDir = tempDir();
    writeToml(repoDir, "combo-chen.toml", "[director]\ncommand = \"director-agent {prompt}\"\n");

    expect(loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") }).directorCommand).toBe(
      "director-agent {prompt}",
    );
    expect(
      loadConfig({
        repoDir,
        userConfigPath: join(tempDir(), "missing.toml"),
        env: { COMBO_CHEN_DIRECTOR_COMMAND: "env-director {prompt}" },
      }).directorCommand,
    ).toBe("env-director {prompt}");
  });

  it("lets env override reviewer GitHub logins", () => {
    const repoDir = tempDir();
    writeToml(
      repoDir,
      "combo-chen.toml",
      ["[reviewer]", 'logins = ["repo-reviewer"]'].join("\n"),
    );

    const config = loadConfig({
      repoDir,
      userConfigPath: join(tempDir(), "missing.toml"),
      env: { COMBO_CHEN_REVIEWER_LOGINS: "env-reviewer\nsecond-reviewer" },
    });

    expect(config.reviewerLogins).toEqual(["env-reviewer", "second-reviewer"]);
  });

  it("auto-includes non-active reviewer role entries as external comment agents", () => {
    const repoDir = tempDir();
    writeToml(
      repoDir,
      "combo-chen.toml",
      [
        "[roles]",
        'reviewer = ["claude", "reviewdog"]',
        "",
        "[reviewer.claude]",
        'command = "claude {prompt}"',
      ].join("\n"),
    );

    const config = loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") });

    expect(config.reviewerAgent).toBe("claude");
    expect(config.externalCommentAgents).toEqual(["reviewdog"]);
  });

  it("loads READY required checks separately from external comment filters", () => {
    const repoDir = tempDir();
    writeToml(
      repoDir,
      "combo-chen.toml",
      [
        "[ready]",
        'required_checks = ["ExternalReview", "ReviewDog"]',
        "",
        "[external_comments]",
        'agents = ["copilot"]',
        "",
        "[reviewer.claude]",
        'command = "claude {prompt}"',
      ].join("\n"),
    );

    const config = loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") });

    expect(config.readyRequiredChecks).toEqual(["ExternalReview", "ReviewDog"]);
    expect(config.externalCommentAgents).toEqual(["copilot"]);
  });

  it("lets repo config override the director command", () => {
    const repoDir = tempDir();
    writeToml(
      repoDir,
      "combo-chen.toml",
      ["[director]", 'command = "director-cli --stay-visible {prompt}"'].join("\n"),
    );

    const config = loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") });

    expect(config.directorCommand).toBe("director-cli --stay-visible {prompt}");
  });

  it("lets env override READY required checks", () => {
    const repoDir = tempDir();
    writeToml(
      repoDir,
      "combo-chen.toml",
      ["[ready]", 'required_checks = ["ExternalReview"]'].join("\n"),
    );

    const config = loadConfig({
      repoDir,
      userConfigPath: join(tempDir(), "missing.toml"),
      env: { COMBO_CHEN_READY_REQUIRED_CHECKS: '["ReviewDog","Copilot"]' },
    });

    expect(config.readyRequiredChecks).toEqual(["ReviewDog", "Copilot"]);
  });

  it("lets env override external comment agents", () => {
    const repoDir = tempDir();
    writeToml(
      repoDir,
      "combo-chen.toml",
      ["[external_comments]", 'agents = ["external-reviewer"]'].join("\n"),
    );

    const config = loadConfig({
      repoDir,
      userConfigPath: join(tempDir(), "missing.toml"),
      env: { COMBO_CHEN_EXTERNAL_COMMENT_AGENTS: "reviewdog\ncopilot" },
    });

    expect(config.externalCommentAgents).toEqual(["reviewdog", "copilot"]);
  });

  it("loads green PR label check names from PR label config and env", () => {
    const repoDir = tempDir();
    writeToml(
      repoDir,
      "combo-chen.toml",
      [
        "[pr_labels]",
        'green_check_names = ["ExternalReview Pro"]',
      ].join("\n"),
    );

    const repoConfig = loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") });
    expect(repoConfig.prLabelGreenCheckNames).toEqual(["ExternalReview Pro"]);

    const envConfig = loadConfig({
      repoDir,
      userConfigPath: join(tempDir(), "missing.toml"),
      env: { COMBO_CHEN_PR_LABEL_GREEN_CHECK_NAMES: "ExternalReview Enterprise\nExternalReview CI" },
    });
    expect(envConfig.prLabelGreenCheckNames).toEqual(["ExternalReview Enterprise", "ExternalReview CI"]);
  });

  it("keeps configured external comment agents out of coder and active reviewer roles", () => {
    const repoDir = tempDir();
    writeToml(
      repoDir,
      "combo-chen.toml",
      [
        "[roles]",
        'coder = "codex"',
        'reviewer = ["claude"]',
        "",
        "[external_comments]",
        'agents = ["codex", "claude", "reviewdog", "reviewdog"]',
        "",
        "[reviewer.claude]",
        'command = "claude {prompt}"',
      ].join("\n"),
    );

    const config = loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") });

    expect(config.reviewerAgent).toBe("claude");
    expect(config.externalCommentAgents).toEqual(["reviewdog"]);
  });

  it("accepts legacy reviewer.ambient as external comment agents", () => {
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
    expect(config.externalCommentAgents).toEqual(["reviewdog"]);
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

  it("loads initial gate retry settings through env, repo, user, fallback order", () => {
    const userDir = tempDir();
    const userConfig = writeToml(
      userDir,
      "config.toml",
      "[gatekeeper]\ninitial_gate_retry_attempts = 4\ninitial_gate_retry_backoff_seconds = 30\n",
    );
    const repoDir = tempDir();
    writeToml(
      repoDir,
      "combo-chen.toml",
      "[gatekeeper]\ninitial_gate_retry_attempts = 1\ninitial_gate_retry_backoff_seconds = 5\n",
    );

    const repoConfig = loadConfig({ repoDir, userConfigPath: userConfig, env: {} });
    expect(repoConfig.gatekeeperInitialGateRetryAttempts).toBe(1);
    expect(repoConfig.gatekeeperInitialGateRetryBackoffSeconds).toBe(5);

    const envConfig = loadConfig({
      repoDir,
      userConfigPath: userConfig,
      env: {
        COMBO_CHEN_GATEKEEPER_INITIAL_GATE_RETRY_ATTEMPTS: "3",
        COMBO_CHEN_GATEKEEPER_INITIAL_GATE_RETRY_BACKOFF_SECONDS: "0",
      },
    });
    expect(envConfig.gatekeeperInitialGateRetryAttempts).toBe(3);
    expect(envConfig.gatekeeperInitialGateRetryBackoffSeconds).toBe(0);

    for (const [key, value] of [
      ["initial_gate_retry_attempts", "-1"],
      ["initial_gate_retry_attempts", "1.5"],
      ["initial_gate_retry_attempts", '"nope"'],
      ["initial_gate_retry_backoff_seconds", "-1"],
      ["initial_gate_retry_backoff_seconds", "1.5"],
      ["initial_gate_retry_backoff_seconds", '"nope"'],
    ]) {
      const invalidRepoDir = tempDir();
      writeToml(invalidRepoDir, "combo-chen.toml", `[gatekeeper]\n${key} = ${value}\n`);
      expect(() =>
        loadConfig({ repoDir: invalidRepoDir, userConfigPath: join(tempDir(), "missing.toml"), env: {} }),
      ).toThrow(key);
    }
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

  it("loads the worker stall threshold from repo monitor config or env", () => {
    const repoDir = tempDir();
    writeToml(repoDir, "combo-chen.toml", "[monitor]\nworker_stall_ticks = 4\n");

    const repoConfig = loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml"), env: {} });
    expect(repoConfig.workerStallTicks).toBe(4);

    const envConfig = loadConfig({
      repoDir,
      userConfigPath: join(tempDir(), "missing.toml"),
      env: { COMBO_CHEN_WORKER_STALL_TICKS: "2" },
    });
    expect(envConfig.workerStallTicks).toBe(2);

    for (const value of ["0", "-1", "1.5", '"nope"']) {
      const invalidRepoDir = tempDir();
      writeToml(invalidRepoDir, "combo-chen.toml", `[monitor]\nworker_stall_ticks = ${value}\n`);
      expect(() =>
        loadConfig({ repoDir: invalidRepoDir, userConfigPath: join(tempDir(), "missing.toml"), env: {} }),
      ).toThrow(/worker_stall_ticks/);
    }
  });

  it("loads the worker stall recovery budget from repo monitor config or env", () => {
    const repoDir = tempDir();
    writeToml(repoDir, "combo-chen.toml", "[monitor]\nworker_recovery_attempts = 4\n");

    const repoConfig = loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml"), env: {} });
    expect(repoConfig.workerRecoveryAttempts).toBe(4);

    const envConfig = loadConfig({
      repoDir,
      userConfigPath: join(tempDir(), "missing.toml"),
      env: { COMBO_CHEN_WORKER_RECOVERY_ATTEMPTS: "0" },
    });
    expect(envConfig.workerRecoveryAttempts).toBe(0);

    for (const value of ["-1", "1.5", '"nope"']) {
      const invalidRepoDir = tempDir();
      writeToml(invalidRepoDir, "combo-chen.toml", `[monitor]\nworker_recovery_attempts = ${value}\n`);
      expect(() =>
        loadConfig({ repoDir: invalidRepoDir, userConfigPath: join(tempDir(), "missing.toml"), env: {} }),
      ).toThrow(/worker_recovery_attempts/);
    }
  });

  it("loads worker permission prompt patterns from repo monitor config or env", () => {
    const repoDir = tempDir();
    writeToml(
      repoDir,
      "combo-chen.toml",
      "[monitor]\npermission_prompt_patterns = ['^CUSTOM APPROVAL REQUIRED$']\n",
    );

    const repoConfig = loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml"), env: {} });
    expect(repoConfig.workerPermissionPromptPatterns).toEqual(["^CUSTOM APPROVAL REQUIRED$"]);

    const envConfig = loadConfig({
      repoDir,
      userConfigPath: join(tempDir(), "missing.toml"),
      env: { COMBO_CHEN_WORKER_PERMISSION_PROMPT_PATTERNS: '["^ALLOW TOOL$","^CONFIRM TOOL$"]' },
    });
    expect(envConfig.workerPermissionPromptPatterns).toEqual(["^ALLOW TOOL$", "^CONFIRM TOOL$"]);

    const invalidRepoDir = tempDir();
    writeToml(invalidRepoDir, "combo-chen.toml", '[monitor]\npermission_prompt_patterns = ["["]\n');
    expect(() =>
      loadConfig({ repoDir: invalidRepoDir, userConfigPath: join(tempDir(), "missing.toml"), env: {} }),
    ).toThrow(/permission_prompt_patterns/);

    const emptyRepoDir = tempDir();
    writeToml(emptyRepoDir, "combo-chen.toml", "[monitor]\npermission_prompt_patterns = []\n");
    expect(() =>
      loadConfig({ repoDir: emptyRepoDir, userConfigPath: join(tempDir(), "missing.toml"), env: {} }),
    ).toThrow(/permission_prompt_patterns/);
  });

  it("loads the worker permission prompt policy from repo monitor config or env", () => {
    const repoDir = tempDir();
    writeToml(repoDir, "combo-chen.toml", '[monitor]\npermission_prompt_policy = "recreate-non-interactive"\n');

    const repoConfig = loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml"), env: {} });
    expect(repoConfig.workerPermissionPromptPolicy).toBe("recreate-non-interactive");

    const envConfig = loadConfig({
      repoDir,
      userConfigPath: join(tempDir(), "missing.toml"),
      env: { COMBO_CHEN_WORKER_PERMISSION_PROMPT_POLICY: "auto-approve-known-safe" },
    });
    expect(envConfig.workerPermissionPromptPolicy).toBe("auto-approve-known-safe");

    const invalidRepoDir = tempDir();
    writeToml(invalidRepoDir, "combo-chen.toml", '[monitor]\npermission_prompt_policy = "approve-everything"\n');
    expect(() =>
      loadConfig({ repoDir: invalidRepoDir, userConfigPath: join(tempDir(), "missing.toml"), env: {} }),
    ).toThrow(/permission_prompt_policy/);

    expect(() =>
      loadConfig({
        repoDir,
        userConfigPath: join(tempDir(), "missing.toml"),
        env: { COMBO_CHEN_WORKER_PERMISSION_PROMPT_POLICY: "approve-everything" },
      }),
    ).toThrow(/permission_prompt_policy/);
  });

  it("loads the required run source branch from repo config or env", () => {
    const repoDir = tempDir();
    writeToml(repoDir, "combo-chen.toml", "[run]\nsource_branch = \"develop\"\n");

    const repoConfig = loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml"), env: {} });
    expect(repoConfig.sourceBranch).toBe("develop");

    const envConfig = loadConfig({
      repoDir,
      userConfigPath: join(tempDir(), "missing.toml"),
      env: { COMBO_CHEN_SOURCE_BRANCH: "release" },
    });
    expect(envConfig.sourceBranch).toBe("release");
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
        'reviewer = ["external-reviewer", "hermes:gemini"]',
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
        'prompt = "project reviewer instructions 1234"',
        "",
        "[external_comments]",
        'agents = ["external-reviewer"]',
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
    expect(config.roles.reviewer).toEqual(["external-reviewer", "hermes:gemini"]);
    expect(config.externalCommentAgents).toEqual(["external-reviewer"]);
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
    expect(config.reviewerPrompt).toBe("project reviewer instructions 1234");
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
      '[rower.codex]\ncommand = 123\nresume_command = "codex --profile sitter --no-alt-screen resume {thread_id}"\n',
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

  it("resolves the first configured gordon command and reviewer prompt", () => {
    const repoDir = tempDir();
    writeToml(
      repoDir,
      "combo-chen.toml",
      [
        "[roles]",
        'gordon = ["external-reviewer", "hermes:gemini"]',
        "",
        "[gordon]",
        'prompt = "project reviewer instructions 1234"',
        "",
        '[gordon."hermes:gemini"]',
        'command = "hermes judge {pr_url} {prompt}"',
        "",
      ].join("\n"),
    );

    const config = loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") });

    expect(config.reviewerAgent).toBe("hermes:gemini");
    expect(config.reviewerCommand).toBe("hermes judge {pr_url} {prompt}");
    expect(config.reviewerPrompt).toBe("project reviewer instructions 1234");
  });

  it("rejects a non-string reviewer prompt during config load", () => {
    const repoDir = tempDir();
    writeToml(repoDir, "combo-chen.toml", "[reviewer]\nprompt = 123\n");

    expect(() => loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") })).toThrow(ComboConfigError);
    expect(() => loadConfig({ repoDir, userConfigPath: join(tempDir(), "missing.toml") })).toThrow(/reviewer.prompt/);
  });

  it("requires at least one configured gordon command", () => {
    const repoDir = tempDir();
    writeToml(repoDir, "combo-chen.toml", '[roles]\ngordon = ["external-reviewer"]\n');

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
