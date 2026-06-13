import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXAMPLE_CONFIG = join(REPO_ROOT, "combo-chen.example.toml");
const PUBLIC_DOCS = ["README.md", "docs/spec.md", "AGENTS.md"].map((path) => join(REPO_ROOT, path));
const OLD_ROLE_TERMS = /\b(rower|hodor|gordon)\b|\bthread[-_ ]sitter\b|\bactivate-(judge|thread-sitter)\b/i;

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

  it("stays loadable by the config cascade", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-example-"));
    copyFileSync(EXAMPLE_CONFIG, join(repoDir, "combo-chen.toml"));

    const config = loadConfig({ repoDir, userConfigPath: join(repoDir, "missing.toml") });

    expect(config.roles.coder).toBe("codex");
    expect(config.roles.gatekeeper).toBe("no-mistakes");
    expect(config.roles.reviewer).toEqual(["claude", "coderabbit"]);
    expect(config.threadSitterWindowName).toBe("coder-responding");
    expect(config.threadSitterWatchWindowName).toBe("comment-watch");
    expect(config.reviewNudgePrompt).toContain("gatekeeper push semaphore");
    expect(config.reviewerAgent).toBe("claude");
  });
});
