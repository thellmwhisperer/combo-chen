/**
 * @overview Unit tests for the shipped example config and doc vocabulary.
 *   ~56 lines, testing that combo-chen.example.toml and public docs use
 *   only OSS-friendly role names (no legacy rower/hodor/gordon terms) and
 *   that the example config stays loadable by the config cascade.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at describe("combo-chen.example.toml")   ← single describe block
 *
 *   ┌─ TEST AREAS ────────────────────────────────────────────┐
 *   │ combo-chen.example.toml  Vocabulary check + loadability  │
 *   └──────────────────────────────────────────────────────────┘
 *
 * @exports none (test file)
 * @deps vitest, node:{fs,os,path,url}, ./config
 */
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXAMPLE_CONFIG = join(REPO_ROOT, "combo-chen.example.toml");
const PUBLIC_DOCS = ["README.md", "docs/spec.md", "AGENTS.md"].map((path) => join(REPO_ROOT, path));
const OLD_ROLE_TERMS =
  /\b(rower|hodor|gordon)\b|\brower_timeout_minutes\b|\bthread[-_ ]sitter\b|\bactivate-(judge|thread-sitter)\b|\bjudge-tick\b/i;
const OLD_PHASE_TERMS = /\b(ROWING|JUDGING)\b/;

// -- 1/1 CORE · Example config validation ← START HERE --
describe("combo-chen.example.toml", () => {
  it("uses the public OSS-friendly role vocabulary", () => {
    const body = readFileSync(EXAMPLE_CONFIG, "utf8");

    expect(body).not.toMatch(OLD_ROLE_TERMS);
  });

  it("keeps shipped docs on the public OSS-friendly role vocabulary", () => {
    for (const doc of PUBLIC_DOCS) {
      const body = readFileSync(doc, "utf8");

      expect(body).not.toMatch(OLD_ROLE_TERMS);
    }
  });

  it("keeps shipped docs on the canonical phase vocabulary", () => {
    for (const doc of PUBLIC_DOCS) {
      const body = readFileSync(doc, "utf8");

      expect(body).not.toMatch(OLD_PHASE_TERMS);
    }
  });

  it("stays loadable by the config cascade", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-example-"));
    copyFileSync(EXAMPLE_CONFIG, join(repoDir, "combo-chen.toml"));

    const config = loadConfig({ repoDir, userConfigPath: join(repoDir, "missing.toml") });

    expect(config.roles.coder).toBe("codex");
    expect(config.roles.gatekeeper).toBe("no-mistakes");
    expect(config.roles.reviewer).toEqual(["claude", "coderabbit"]);
    expect(config.coderRespondingWindowName).toBe("coder-responding");
    expect(config).not.toHaveProperty("threadSitterWindowName");
    expect(config).not.toHaveProperty("threadSitterWatchWindowName");
    expect(config.reviewNudgePrompt).toContain("Do not push");
    expect(config.reviewNudgePrompt).toContain("gatekeeper/no-mistakes");
    expect(config.reviewerAgent).toBe("claude");
    expect(config.limits.coderTimeoutMinutes).toBe(180);
  });
});
// -/ 1/1
