/**
 * @overview Unit tests for production team identity resolution. ~115 lines,
 *   pins no-mistakes gatekeeper config parsing before overture consumes it.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at no-mistakes gatekeeper resolver tests.
 *
 * @exports none
 * @deps vitest, node:{fs,os,path}, ./team-identity
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ComboConfig } from "../infra/config.js";
import { resolveConfiguredTeamIdentity } from "./team-identity.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "combo-chen-team-"));
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
    gatekeeperAttachTimeoutSeconds: 1800,
    gatekeeperAttachRetryIntervalSeconds: 10,
    gatekeeperInitialGateRetryAttempts: 2,
    gatekeeperInitialGateRetryBackoffSeconds: 10,
    reviewNudgePrompt: "{url}",
    coderRespondingWindowName: "coder",
    reviewerAgent: "claude",
    reviewerCommand: "claude {prompt}",
    reviewerPrompt: "",
    reviewerLogins: [],
    externalCommentAgents: [],
    externalReviewCommands: [],
    readyRequiredChecks: [],
    prLabelGreenCheckNames: [],
    workerStallTicks: 3,
    workerRecoveryAttempts: 2,
    workerPermissionPromptPatterns: [],
    workerPermissionPromptPolicy: "escalate",
    coderGnhfProgressMaxAgeMs: 60000,
    sourceBranch: "main",
  };
}

describe("production team identity resolver", () => {
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

  it("resolves the no-mistakes gatekeeper agent and model from its global config", () => {
    const home = tempHome();
    mkdirSync(join(home, ".no-mistakes"), { recursive: true });
    writeFileSync(
      join(home, ".no-mistakes", "config.yaml"),
      [
        "agent: claude",
        "",
        "agent_args_override:",
        "  claude:",
        "    - --model",
        "    - opus",
      ].join("\n"),
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
