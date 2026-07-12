/**
 * @overview Unit tests for production team identity resolution. ~150 lines,
 *   pins Codex/gnhf and no-mistakes config parsing before overture consumes it.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at codex/gnhf resolver tests.
 *   2. Then no-mistakes gatekeeper resolver tests.
 *
 * @exports none
 * @deps ./config, ./team-identity, node:fs, node:os, node:path, vitest
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ComboConfig } from "./config.js";
import { resolveConfiguredTeamIdentity } from "./team-identity.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "combo-chen-team-"));
}

function fakeOpencodeBin(configJson: string): string {
  const bin = join(tempHome(), "bin");
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, "opencode");
  writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${configJson}'\n`);
  chmodSync(executable, 0o755);
  return bin;
}

function config(): ComboConfig {
  return {
    roles: {
      coder: "codex",
      gatekeeper: "no-mistakes",
      reviewer: ["claude"],
      merge: "human",
    },
    limits: {
      babysitPollSeconds: 120,
      coderTimeoutMinutes: 180,
      teardownGitRetries: 2,
      teardownGitBackoffSeconds: 2,
      watchFailureLimit: 5,
      watchBackoffMaxSeconds: 3600,
    },
    coderCommand: "npx -y gnhf --agent codex --current-branch {prompt}",
    coderResumeCommand: "codex resume {thread_id}",
    gatekeeperCommand: "no-mistakes axi run --intent {issue_pr_intent}",
    directorCommand: "claude {prompt}",
    gatekeeperInitialGateRetryAttempts: 2,
    gatekeeperInitialGateRetryBackoffSeconds: 10,
    reviewerAgent: "claude",
    reviewerCommand: "claude {prompt}",
    reviewerPrompt: "",
    reviewMaxRounds: 3,
    reviewerTurnTimeoutMinutes: 60,
    fixTurnTimeoutMinutes: 120,
    reviewVerdictWaitMs: 5000,
    externalCommentAgents: [],
    readyRequiredChecks: [],
    workerStallTicks: 3,
    workerRecoveryAttempts: 2,
    workerPermissionPromptPatterns: [],
    workerPermissionPromptPolicy: "escalate",
    coderGnhfProgressMaxAgeMs: 60000,
    gatekeeperStatusTimeoutMs: 5000,
    sourceBranch: "main",
    runEngine: "v0",
  };
}

describe("production team identity resolver", () => {
  it("resolves a direct codex model from the selected profile config", () => {
    const codexHome = tempHome();
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5"\n');
    writeFileSync(join(codexHome, "sitter.config.toml"), 'model = "gpt-5.5"\n');

    const resolved = resolveConfiguredTeamIdentity("director", {
      config: {
        ...config(),
        directorCommand: "codex --profile sitter exec {prompt}",
      },
      declared: { binary: "codex", agent: "codex", model: "gpt-5.5" },
      repoDir: codexHome,
      env: { CODEX_HOME: codexHome },
    });

    expect(resolved).toEqual({
      role: "director",
      identity: { binary: "codex", agent: "codex", model: "gpt-5.5" },
    });
  });

  it("resolves the gnhf-wrapped codex coder model from gnhf agent args", () => {
    const home = tempHome();
    const codexHome = tempHome();
    mkdirSync(join(home, ".gnhf"), { recursive: true });
    writeFileSync(
      join(home, ".gnhf", "config.yml"),
      ["agentArgsOverride:", "  codex:", "    - -m", "    - gpt-5.4"].join("\n"),
    );
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5"\n');

    const resolved = resolveConfiguredTeamIdentity("coder", {
      config: config(),
      declared: { binary: "npx", agent: "gnhf/codex", model: "gpt-5.4" },
      repoDir: home,
      env: { HOME: home, CODEX_HOME: codexHome },
    });

    expect(resolved).toEqual({
      role: "coder",
      identity: { binary: "npx", agent: "gnhf/codex", model: "gpt-5.4" },
    });
  });

  it("resolves a direct claude director model from the command line", () => {
    const resolved = resolveConfiguredTeamIdentity("director", {
      config: {
        ...config(),
        directorCommand: "claude --model opus {prompt}",
      },
      declared: { binary: "claude", agent: "claude", model: "opus" },
      repoDir: "/repo",
      env: {},
    });

    expect(resolved).toEqual({
      role: "director",
      identity: { binary: "claude", agent: "claude", model: "opus" },
    });
  });

  it("resolves an unpinned direct claude reviewer as fable", () => {
    const resolved = resolveConfiguredTeamIdentity("reviewer", {
      config: config(),
      declared: { binary: "claude", agent: "claude", model: "fable" },
      repoDir: "/repo",
      env: {},
    });

    expect(resolved).toEqual({
      role: "reviewer",
      identity: { binary: "claude", agent: "claude", model: "fable" },
    });
  });

  it("resolves a direct opencode reviewer model from opencode resolved config", () => {
    const bin = fakeOpencodeBin(JSON.stringify({ model: "claude/opus" }));
    const repoDir = tempHome();

    const resolved = resolveConfiguredTeamIdentity("reviewer", {
      config: {
        ...config(),
        reviewerCommand: "opencode run {prompt}",
      },
      declared: { binary: "opencode", agent: "claude", model: "opus" },
      repoDir,
      env: { PATH: bin },
    });

    expect(resolved).toEqual({
      role: "reviewer",
      identity: { binary: "opencode", agent: "claude", model: "opus" },
    });
  });

  it("resolves an opencode agent-specific model when the command pins --agent", () => {
    const bin = fakeOpencodeBin(
      JSON.stringify({ model: "claude/sonnet", agent: { reviewer: { model: "claude/opus" } } }),
    );
    const repoDir = tempHome();

    const resolved = resolveConfiguredTeamIdentity("reviewer", {
      config: {
        ...config(),
        reviewerCommand: "opencode run --agent reviewer {prompt}",
      },
      declared: { binary: "opencode", agent: "claude", model: "opus" },
      repoDir,
      env: { PATH: bin },
    });

    expect(resolved).toEqual({
      role: "reviewer",
      identity: { binary: "opencode", agent: "claude", model: "opus" },
    });
  });

  it("resolves the no-mistakes gatekeeper agent and model from its global config", () => {
    const home = tempHome();
    mkdirSync(join(home, ".no-mistakes"), { recursive: true });
    writeFileSync(
      join(home, ".no-mistakes", "config.yaml"),
      ["agent: claude", "", "agent_args_override:", "  claude:", "    - --model", "    - opus"].join("\n"),
    );

    const resolved = resolveConfiguredTeamIdentity("gatekeeper", {
      config: config(),
      declared: { binary: "no-mistakes", agent: "claude", model: "opus" },
      repoDir: home,
      env: { HOME: home },
    });

    expect(resolved).toEqual({
      role: "gatekeeper",
      identity: { binary: "no-mistakes", agent: "claude", model: "opus" },
    });
  });

  it("resolves an ACP gatekeeper model from no-mistakes registry overrides", () => {
    const home = tempHome();
    mkdirSync(join(home, ".no-mistakes"), { recursive: true });
    writeFileSync(
      join(home, ".no-mistakes", "config.yaml"),
      [
        "agent: acp:hermes-deepseek",
        "",
        "acp_registry_overrides:",
        "  hermes-deepseek: hermes --provider deepseek --model deepseek-ai/deepseek-v4-pro acp",
      ].join("\n"),
    );

    const resolved = resolveConfiguredTeamIdentity("gatekeeper", {
      config: config(),
      declared: { binary: "no-mistakes", agent: "acp:hermes-deepseek", model: "deepseek-ai/deepseek-v4-pro" },
      repoDir: home,
      env: { HOME: home },
    });

    expect(resolved).toEqual({
      role: "gatekeeper",
      identity: {
        binary: "no-mistakes",
        agent: "acp:hermes-deepseek",
        model: "deepseek-ai/deepseek-v4-pro",
      },
    });
  });
});
