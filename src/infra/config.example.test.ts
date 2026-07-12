/**
 * @overview Unit tests for the shipped example config and doc vocabulary.
 *   ~190 lines, testing that combo-chen.example.toml and public docs use
 *   only OSS-friendly role names, document the tracked no-mistakes and Codex
 *   resume policies, and keep the example config loadable by the config
 *   cascade.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at describe("combo-chen.example.toml")   ← single describe block
 *
 *   ┌─ TEST AREAS ────────────────────────────────────────────┐
 *   │ combo-chen.example.toml  Vocabulary, policy, loadability │
 *   └──────────────────────────────────────────────────────────┘
 *
 * @exports none (test file)
 * @deps vitest, node:{fs,os,path,url}, ../app/launch/overture, ./config
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
const SPEC = join(REPO_ROOT, "docs", "spec.md");
const GITIGNORE = join(REPO_ROOT, ".gitignore");
const LAUNCH_SKILL = join(REPO_ROOT, "skills", "launch-combo", "SKILL.md");
const OVERTURE_SOURCE = join(REPO_ROOT, "src", "app", "launch", "overture.ts");
const OLD_ROLE_TERMS =
  /\b(rower|hodor|gordon)\b|\brower_timeout_minutes\b|\bthread[-_ ]sitter\b|\bactivate-(judge|thread-sitter)\b|\bjudge-tick\b/i;
const OLD_PHASE_TERMS = /\b(ROWING|JUDGING)\b/;
const LOCAL_REPO_PATH = /\/local\/developer\/workspace\/combo-chen\//;
const FORBIDDEN_TMP_WORKTREE_PATH = /\/external-disk\/tmp\//;

function normalizeDoc(body: string): string {
  return body.replace(/\s+/g, " ");
}

// -- 1/1 CORE · Example config validation ← START HERE --
describe("combo-chen.example.toml", () => {
  it("uses the public OSS-friendly role vocabulary", () => {
    const body = readFileSync(EXAMPLE_CONFIG, "utf8");

    expect(body).not.toMatch(OLD_ROLE_TERMS);
  });

  it("does not pin commodity provider versions in the shipped example", () => {
    const body = readFileSync(EXAMPLE_CONFIG, "utf8");

    expect(body).not.toMatch(/\bgnhf@\d/);
  });

  it("documents the recommended Codex resume policy", () => {
    const body = readFileSync(EXAMPLE_CONFIG, "utf8");

    expect(body).toContain(
      "codex --ask-for-approval never --sandbox workspace-write exec resume {thread_id}",
    );
  });

  it("documents allowlist convergence as the role permission envelope", () => {
    const body = readFileSync(EXAMPLE_CONFIG, "utf8");
    const spec = readFileSync(SPEC, "utf8");

    expect(body).toContain("allowed_tools");
    expect(body).toContain("Prompts are captured as learning signals");
    expect(spec).toContain("permission_prompt_detected");
    expect(spec).toContain("never left blocking a pane");
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

  it("documents the tracked repo-level no-mistakes policy", () => {
    const gitignore = readFileSync(GITIGNORE, "utf8");
    const docs = PUBLIC_DOCS.map((doc) => readFileSync(doc, "utf8")).join("\n");

    expect(gitignore).not.toMatch(/^\.no-mistakes\.yaml$/m);
    expect(gitignore).toContain(".no-mistakes.yaml is intentionally tracked");
    expect(docs).toContain("repo-level `.no-mistakes.yaml`");
    expect(docs).toContain("tracked on purpose");
    expect(docs).not.toMatch(
      /ignored local `\.no-mistakes\.yaml`|Do not stage or commit `\.no-mistakes\.yaml`/,
    );
  });

  it("documents the parallelize-first operating protocol", () => {
    const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
    const spec = readFileSync(SPEC, "utf8");
    const docs = normalizeDoc(`${readme}\n${spec}`);
    const lowerDocs = docs.toLowerCase();

    expect(readme).toContain("## Parallelize-First Operating Protocol");
    expect(docs).toContain("Start with 2 live capsules, then 3, then 4 to 6");
    expect(docs).toContain(
      "each capsule keeps one branch, one worktree, one tmux session, and one runtime ledger",
    );
    expect(lowerDocs).toContain(
      "branch-scoped gate leases keep no-mistakes publication exclusive only per branch",
    );
    expect(lowerDocs).toContain("parked combos");
    expect(lowerDocs).toContain("pre-pr coder dead");
    expect(lowerDocs).toContain("reviewer auth failures");
    expect(lowerDocs).toContain("gate lease contention");
    expect(lowerDocs).toContain("post-merge closure");
    expect(docs).toContain("parallel capsule dashboard");
    expect(docs).toContain("postmortem metadata");
  });

  it("stays loadable by the config cascade", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "combo-chen-example-"));
    copyFileSync(EXAMPLE_CONFIG, join(repoDir, "combo-chen.toml"));

    const config = loadConfig({ repoDir, userConfigPath: join(repoDir, "missing.toml") });

    expect(config.roles.coder).toBe("codex");
    expect(config.roles.gatekeeper).toBe("no-mistakes");
    expect(config.roles.reviewer).toEqual(["claude"]);
    expect(config.externalCommentAgents).toEqual(["coderabbitai"]);
    expect(config.readyRequiredChecks).toEqual(["CodeRabbit"]);
    expect(config.workerPermissionPromptPolicy).toBe("escalate");
    expect(config.coderResumeCommand).toBe(
      "codex --ask-for-approval never --sandbox workspace-write exec resume {thread_id}",
    );
    expect(config.workerRecoveryAttempts).toBe(2);
    expect(config).not.toHaveProperty("threadSitterWindowName");
    expect(config).not.toHaveProperty("threadSitterWatchWindowName");
    expect(config.reviewerAgent).toBe("claude");
    expect(config.directorCommand).toBe("claude --permission-mode auto {prompt}");
    expect(config.roleToolAllowlists.director).toContain("tmux");
    expect(config.limits.coderTimeoutMinutes).toBe(180);
  });

  it("keeps the launch skill portable across workstations and project tmp policy", () => {
    const body = readFileSync(LAUNCH_SKILL, "utf8");

    expect(body).not.toMatch(LOCAL_REPO_PATH);
    expect(body).not.toMatch(FORBIDDEN_TMP_WORKTREE_PATH);
  });

  it("documents scoped post-merge cleanup in the launch skill", () => {
    const body = readFileSync(LAUNCH_SKILL, "utf8");

    expect(body).toContain("combo-chen closure -n <comboId>");
    expect(body).toContain("PR `MERGED`");
    expect(body).toContain("no tmux session remains");
    expect(body).toContain("no combo worktree remains");
    expect(body).toContain("local branch is gone");
    expect(body).toContain("journal contains `merged` and `combo_closed`");
    expect(body).toContain("NEVER write the journal by hand");
  });

  it("documents overture artifact persistence as conditional on the run dir", () => {
    const spec = normalizeDoc(readFileSync(SPEC, "utf8"));

    expect(spec).toContain("run_dir_free");
    expect(spec).toContain("overture.json");
  });

  it("documents both issue and plan direct overture commands in the launch skill", () => {
    const body = readFileSync(LAUNCH_SKILL, "utf8");

    expect(body).toContain("combo-chen overture --issue <url> --repo <dir>");
    expect(body).toContain("combo-chen overture --plan <file> --repo <dir>");
  });

  it("documents the overture base/baseRef compatibility alias", () => {
    const body = readFileSync(OVERTURE_SOURCE, "utf8");

    expect(body).toContain("Canonical launch base ref recorded in overture.json");
    expect(body).toContain("Compatibility alias kept for earlier overture consumers; same value as base");
  });
});
// -/ 1/1
