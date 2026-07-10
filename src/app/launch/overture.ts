/**
 * @overview Deterministic launch runway for combo creation. ~480 lines,
 *   6 exports, checks launch inputs/resources before worker windows start.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at prepareOverture        <- derive resources and run checks.
 *   2. Then renderOvertureChecklist    <- user-facing checklist lines.
 *   3. Finish at assertOverturePassed  <- hard stop used by run.
 *
 *   MAIN FLOW
 *   ---------
 *   CLI input -> prepareOverture -> overture.json + checklist -> run may launch
 *
 *   PUBLIC API
 *   ----------
 *   OvertureDeps            Injected process adapters.
 *   TeamIdentityResolver    Resolve effective role identity for declared teams.
 *   OvertureCheck           One machine-readable check result.
 *   OverturePreparation     Full prepared launch context for run.
 *   prepareOverture         Resolve work item/config/resources and write artifact.
 *   renderOvertureChecklist Render the checklist for CLI output.
 *   assertOverturePassed    Throw on the first failed check.
 *
 *   INTERNALS
 *   ---------
 *   OVERTURE_ARTIFACT, OvertureBlockedError, readLocalMarkdownWorkPlan, localPlanSourceReference, checkSourceCheckout,
 *   checkBaseRef, checkTreehouseAvailable, checkBranchFree,
 *   checkNoMistakesRunway, checkTeamIdentity, runDirReusable, writeOvertureArtifact
 *
 * @exports OvertureDeps, TeamIdentityResolution, TeamIdentityResolver, OvertureCheck, OverturePreparation, prepareOverture, renderOvertureChecklist, assertOverturePassed
 * @deps ../../core/state, ../../core/work-plan, ../../infra/config, ../../infra/tmux, ../../roles/reviewer, ../github/github, ../reporting/status, node:crypto, node:fs, node:path
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  comboHome,
  comboIdFromIssueUrl,
  comboIdFromWorkPlanSource,
  parseIssueUrl,
  runDirFor,
  type ComboRecord,
  type IssueRef,
} from "../../core/state.js";
import {
  normalizeGitHubIssueWorkPlan,
  normalizeMarkdownWorkPlan,
  type WorkPlan,
} from "../../core/work-plan.js";
import {
  assertSafeCoderInvocation,
  loadConfig,
  type ComboConfig,
  type ComboTeam,
  type ComboTeamIdentity,
  type ComboTeamRole,
} from "../../infra/config.js";
import { hasSessionArgs, type TmuxResult } from "../../infra/tmux.js";
import { assertReviewerCommandSafe } from "../../roles/reviewer.js";
import { fetchIssueDetails, remoteSlug, type GhRunner, type IssueDetails } from "../github/github.js";
import { parseNoMistakesAxiStatus } from "../reporting/status.js";

// -- 1/3 HELPER · Types and local work-plan reading --
const OVERTURE_ARTIFACT = "overture.json";

type CommandResult = { status: number; stdout: string; stderr: string };

export interface TeamIdentityResolution {
  role: ComboTeamRole;
  identity: ComboTeamIdentity;
}

export type TeamIdentityResolver = (
  role: ComboTeamRole,
  input: {
    config: ComboConfig;
    declared: ComboTeamIdentity;
    repoDir: string;
    env: Record<string, string | undefined>;
  },
) => TeamIdentityResolution | undefined;

export interface OvertureDeps {
  env: Record<string, string | undefined>;
  git: (args: string[], cwd: string) => CommandResult;
  treehouse: (args: string[], cwd: string) => CommandResult;
  gh: GhRunner;
  noMistakes: (args: string[], cwd: string) => CommandResult;
  tmux: (args: string[]) => TmuxResult;
  issueExists?: (issueUrl: string) => boolean;
  resolveTeamIdentity?: TeamIdentityResolver;
}

export type OvertureCheckStatus = "ok" | "failed";

export interface OvertureCheck {
  id: string;
  status: OvertureCheckStatus;
  resource: string;
  detail?: string;
}

export interface OvertureResources {
  comboId: string;
  repo: string;
  branch: string;
  worktree: string;
  tmuxSession: string;
  runDir: string;
  /** Canonical launch base ref recorded in overture.json. */
  base: string;
  /** Compatibility alias kept for earlier overture consumers; same value as base. */
  baseRef: string;
  sourceType: string;
  sourceReference: string;
  sourceTitle: string;
  issueUrl?: string;
  noMistakes?: {
    branch?: string;
    worktree?: string;
    status?: string;
    outcome?: string;
  };
}

export interface OvertureResult {
  ok: boolean;
  createdAt: string;
  artifactPath?: string;
  resources: OvertureResources;
  resolvedTeam?: ComboTeam;
  checks: OvertureCheck[];
}

export interface OverturePreparation {
  result: OvertureResult;
  combo: ComboRecord;
  config: ComboConfig;
  workPlan: WorkPlan;
  runDir: string;
  issue?: IssueRef;
  issueDetails?: IssueDetails;
}

interface PrepareOvertureInput {
  deps: OvertureDeps;
  issueUrl?: string;
  planFile?: string;
  repoDir: string;
  baseRef: string;
  now?: () => string;
}

function readLocalMarkdownWorkPlan(planFile: string, repoDir: string): WorkPlan {
  const path = resolve(planFile);
  let markdown: string;
  try {
    markdown = readFileSync(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Work plan not readable: ${path} (${reason})`, { cause: error });
  }
  return normalizeMarkdownWorkPlan({
    markdown,
    source: { type: "local_file", reference: localPlanSourceReference({ path, markdown, repoDir }) },
  });
}

function localPlanSourceReference(input: { path: string; markdown: string; repoDir: string }): string {
  const repoRelative = relative(resolve(input.repoDir), input.path);
  if (!repoRelative.startsWith("..") && !isAbsolute(repoRelative)) return repoRelative;
  const hash = createHash("sha256").update(input.markdown).digest("hex").slice(0, 12);
  return `external:${hash}`;
}
// -/ 1/3

// -- 2/3 HELPER · Check helpers --
function ok(id: string, resource: string, detail?: string): OvertureCheck {
  return { id, status: "ok", resource, ...(detail !== undefined ? { detail } : {}) };
}

function failed(id: string, resource: string, detail: string): OvertureCheck {
  return { id, status: "failed", resource, detail };
}

function errorDetail(prefix: string, result: CommandResult): string {
  return `${prefix}: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`;
}

function checkRepoMatchesIssue(
  deps: OvertureDeps,
  repoDir: string,
  issue: IssueRef | undefined,
): OvertureCheck {
  if (issue === undefined) return ok("repo_matches_issue", repoDir, "not issue-backed");
  const remote = deps.git(["remote", "get-url", "origin"], repoDir);
  const remoteUrl = remote.stdout.trim();
  if (remote.status !== 0)
    return failed("repo_matches_issue", "origin", errorDetail("origin unavailable", remote));
  if (remoteUrl === "") return ok("repo_matches_issue", `${issue.owner}/${issue.repo}`, "origin unavailable");
  const slug = remoteSlug(remoteUrl);
  if (slug?.toLowerCase() !== `${issue.owner}/${issue.repo}`.toLowerCase()) {
    return failed(
      "repo_matches_issue",
      remoteUrl,
      `origin mismatch; issue belongs to ${issue.owner}/${issue.repo}`,
    );
  }
  return ok("repo_matches_issue", remoteUrl);
}

function checkSourceCheckout(deps: OvertureDeps, repoDir: string, requiredBranch: string): OvertureCheck {
  const branch = deps.git(["branch", "--show-current"], repoDir);
  if (branch.status !== 0)
    return failed("source_checkout_clean", repoDir, errorDetail("git branch --show-current failed", branch));
  const branchName = branch.stdout.trim();
  if (branchName !== requiredBranch) {
    return failed(
      "source_checkout_clean",
      repoDir,
      `must be on ${requiredBranch}; current branch is "${branchName || "(detached)"}"`,
    );
  }

  const status = deps.git(["status", "--porcelain"], repoDir);
  if (status.status !== 0)
    return failed("source_checkout_clean", repoDir, errorDetail("git status --porcelain failed", status));
  if (status.stdout.trim() !== "")
    return failed("source_checkout_clean", repoDir, "uncommitted changes in source checkout");
  return ok("source_checkout_clean", repoDir);
}

function checkBaseRef(deps: OvertureDeps, repoDir: string, baseRef: string): OvertureCheck {
  if (!baseRef.startsWith("origin/")) {
    const resolved = deps.git(["rev-parse", "--verify", baseRef], repoDir);
    if (resolved.status !== 0) {
      return failed(
        "base_ref_resolved",
        baseRef,
        errorDetail(`git rev-parse --verify ${baseRef} failed`, resolved),
      );
    }
    return ok("base_ref_resolved", baseRef, "local ref");
  }
  const branch = baseRef.slice("origin/".length);
  const fetched = deps.git(["fetch", "origin", branch], repoDir);
  if (fetched.status !== 0) {
    return failed("base_ref_resolved", baseRef, errorDetail(`git fetch origin ${branch} failed`, fetched));
  }
  return ok("base_ref_resolved", baseRef);
}

function checkTreehouseAvailable(deps: OvertureDeps, repoDir: string): OvertureCheck {
  const status = deps.treehouse(["status"], repoDir);
  if (status.status !== 0) {
    return failed("treehouse_available", repoDir, errorDetail("treehouse status failed", status));
  }
  return ok("treehouse_available", repoDir);
}

function checkComboId(id: string): OvertureCheck {
  if (id.trim() === "" || id.includes("/") || id.includes("\0")) {
    return failed("combo_id_valid", id, "must be non-empty and path-segment safe");
  }
  return ok("combo_id_valid", id);
}

function runDirReusable(runDir: string): OvertureCheck {
  if (!existsSync(runDir)) return ok("run_dir_free", runDir);
  const entries = readdirSync(runDir).filter((entry) => entry !== OVERTURE_ARTIFACT);
  if (entries.length === 0) return ok("run_dir_free", runDir, "overture-only run dir reusable");
  return failed("run_dir_free", runDir, `already contains ${entries[0]}`);
}

function checkBranchFree(deps: OvertureDeps, repoDir: string, branch: string): OvertureCheck {
  const local = deps.git(["branch", "--list", branch], repoDir);
  if (local.status !== 0)
    return failed("branch_free", branch, errorDetail("git branch --list failed", local));
  if (local.stdout.trim() !== "") return failed("branch_free", branch, "already exists locally");

  const originCheck = deps.git(["remote", "get-url", "origin"], repoDir);
  if (originCheck.status !== 0) return ok("branch_free", branch, "no origin remote");
  const remote = deps.git(["ls-remote", "--heads", "origin", branch], repoDir);
  if (remote.status !== 0)
    return failed("branch_free", branch, errorDetail("git ls-remote --heads origin failed", remote));
  if (remote.stdout.trim() !== "") return failed("branch_free", branch, "already exists on origin");
  return ok("branch_free", branch);
}

function checkConfigFilePredictable(repoDir: string, worktree: string): OvertureCheck {
  const source = join(repoDir, ".no-mistakes.yaml");
  if (!existsSync(source)) return ok("no_mistakes_config_predictable", source, "no repo config");
  return ok("no_mistakes_config_predictable", `${source} -> ${join(worktree, ".no-mistakes.yaml")}`);
}

const TEAM_ROLE_ORDER: ComboTeamRole[] = ["coder", "gatekeeper", "reviewer", "director"];

function identityLabel(identity: ComboTeamIdentity | undefined): string {
  if (identity === undefined) return "(unresolved)";
  return `${identity.binary}/${identity.agent}/${identity.model}`;
}

function identitiesMatch(left: ComboTeamIdentity, right: ComboTeamIdentity | undefined): boolean {
  return (
    right !== undefined &&
    left.binary === right.binary &&
    left.agent === right.agent &&
    left.model === right.model
  );
}

interface TeamIdentityCheckResult {
  check: OvertureCheck;
  resolvedTeam?: ComboTeam;
}

function checkTeamIdentity(
  deps: OvertureDeps,
  config: ComboConfig,
  repoDir: string,
): TeamIdentityCheckResult {
  const team = config.team;
  if (team === undefined) {
    return { check: ok("team_identity", "team", "undeclared; identity check skipped") };
  }

  const rows = ["role | declared | resolved | status"];
  const resolvedTeam: ComboTeam = {};
  let mismatch = false;
  for (const role of TEAM_ROLE_ORDER) {
    const declared = team[role];
    if (declared === undefined) continue;
    let resolved: ComboTeamIdentity | undefined;
    try {
      resolved = deps.resolveTeamIdentity?.(role, {
        config,
        declared,
        repoDir,
        env: deps.env,
      })?.identity;
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ");
      rows.push(`${role} | ${identityLabel(declared)} | ${reason} | error`);
      mismatch = true;
      continue;
    }
    if (resolved !== undefined) resolvedTeam[role] = resolved;
    const rowStatus = identitiesMatch(declared, resolved) ? "match" : "mismatch";
    if (rowStatus === "mismatch") mismatch = true;
    rows.push(`${role} | ${identityLabel(declared)} | ${identityLabel(resolved)} | ${rowStatus}`);
  }

  if (rows.length === 1) {
    return { check: ok("team_identity", "team", "declared but empty; identity check skipped") };
  }
  const detail = `${mismatch ? "mismatch" : "verified"}\n${rows.join("\n")}`;
  const check = mismatch ? failed("team_identity", "team", detail) : ok("team_identity", "team", detail);
  return Object.keys(resolvedTeam).length === 0 ? { check } : { check, resolvedTeam };
}

const ACTIVE_NO_MISTAKES_RUN_STATUSES = new Set(["active", "in_progress", "running", "waiting"]);

function parseNoMistakesWorktree(raw: string): string | undefined {
  for (const line of raw.split(/\r?\n/)) {
    const worktree = /^\s*worktree:\s*(.+)\s*$/.exec(line);
    if (worktree?.[1] !== undefined) return worktree[1].trim().replace(/^["']|["']$/g, "");
  }
  return undefined;
}

function noActiveRun(result: CommandResult): boolean {
  return /no active run/i.test(result.stdout) || /no active run/i.test(result.stderr);
}

function noMistakesFacts(raw: string): OvertureResources["noMistakes"] | undefined {
  const parsed = parseNoMistakesAxiStatus(raw);
  const worktree = parseNoMistakesWorktree(raw);
  const facts: OvertureResources["noMistakes"] = {
    ...(parsed.branch !== undefined ? { branch: parsed.branch } : {}),
    ...(worktree !== undefined ? { worktree } : {}),
    ...(parsed.runStatus !== undefined ? { status: parsed.runStatus } : {}),
    ...(parsed.outcome !== undefined ? { outcome: parsed.outcome } : {}),
  };
  return Object.keys(facts).length > 0 ? facts : undefined;
}

function checkNoMistakesRunway(
  deps: OvertureDeps,
  repoDir: string,
  branch: string,
  worktree: string,
): { checks: OvertureCheck[]; facts?: OvertureResources["noMistakes"] } {
  const available = deps.noMistakes(["status"], repoDir);
  if (available.status !== 0) {
    return {
      checks: [
        failed("no_mistakes_available", repoDir, errorDetail("no-mistakes status failed", available)),
        failed("no_mistakes_run_free", branch, "no-mistakes availability could not be confirmed"),
      ],
    };
  }

  const status = deps.noMistakes(["axi", "status"], repoDir);
  if (status.status !== 0) {
    if (noActiveRun(status)) {
      return {
        checks: [ok("no_mistakes_available", repoDir), ok("no_mistakes_run_free", branch, "no active run")],
      };
    }
    return {
      checks: [
        ok("no_mistakes_available", repoDir),
        failed("no_mistakes_run_free", branch, errorDetail("no-mistakes axi status failed", status)),
      ],
    };
  }

  const parsed = parseNoMistakesAxiStatus(status.stdout);
  const facts = noMistakesFacts(status.stdout);
  const active =
    (parsed.runStatus !== undefined && ACTIVE_NO_MISTAKES_RUN_STATUSES.has(parsed.runStatus)) ||
    parsed.outcome === "awaiting_approval";
  const activeStatus = parsed.runStatus ?? parsed.outcome ?? "active";
  if (active && parsed.branch === branch) {
    return {
      checks: [
        ok("no_mistakes_available", repoDir),
        failed("no_mistakes_run_free", branch, `active no-mistakes run is ${activeStatus}`),
      ],
      ...(facts !== undefined ? { facts } : {}),
    };
  }
  if (active && facts?.worktree === worktree) {
    return {
      checks: [
        ok("no_mistakes_available", repoDir),
        failed("no_mistakes_run_free", worktree, `active no-mistakes run is ${activeStatus}`),
      ],
      facts,
    };
  }
  return {
    checks: [ok("no_mistakes_available", repoDir), ok("no_mistakes_run_free", branch)],
    ...(facts !== undefined ? { facts } : {}),
  };
}
// -/ 2/3

// -- 3/3 CORE · prepareOverture, renderOvertureChecklist, assertOverturePassed <- START HERE --
class OvertureBlockedError extends Error {}

export function prepareOverture(input: PrepareOvertureInput): OverturePreparation {
  const hasIssue = input.issueUrl !== undefined;
  const hasPlan = input.planFile !== undefined;
  if (hasIssue === hasPlan) {
    throw new Error("combo-chen overture requires exactly one of --issue <url> or --plan <file>");
  }

  const issue = input.issueUrl === undefined ? undefined : parseIssueUrl(input.issueUrl);
  if (
    input.issueUrl !== undefined &&
    input.deps.issueExists !== undefined &&
    !input.deps.issueExists(input.issueUrl)
  ) {
    throw new Error(`Issue not reachable: ${input.issueUrl} (gh issue view failed)`);
  }
  const issueDetails =
    input.issueUrl === undefined ? undefined : fetchIssueDetails(input.deps.gh, input.issueUrl);
  const workPlan =
    issueDetails === undefined
      ? readLocalMarkdownWorkPlan(input.planFile!, input.repoDir)
      : normalizeGitHubIssueWorkPlan({
          issueUrl: input.issueUrl!,
          title: issueDetails.title,
          body: issueDetails.body,
        });
  const config = loadConfig({ repoDir: input.repoDir, env: input.deps.env });
  const id =
    input.issueUrl === undefined
      ? comboIdFromWorkPlanSource(workPlan.source, workPlan.title)
      : comboIdFromIssueUrl(input.issueUrl);
  const home = comboHome(input.deps.env);
  const runDir = runDirFor(home, id);
  const session = `combo-chen-${id}`;
  const branch = issue === undefined ? `combo/${id}` : `combo/issue-${issue.number}`;
  const worktree =
    issue === undefined
      ? join(input.repoDir, ".worktrees", id)
      : join(input.repoDir, ".worktrees", `issue-${issue.number}`);
  const combo: ComboRecord = {
    id,
    issueUrl: input.issueUrl ?? "",
    workItemSourceType: workPlan.source.type,
    workItemSourceReference: workPlan.source.reference,
    workItemTitle: workPlan.title,
    repoDir: input.repoDir,
    worktree,
    branch,
    tmuxSession: session,
    createdAt: input.now?.() ?? new Date().toISOString(),
  };
  const noMistakes = checkNoMistakesRunway(input.deps, input.repoDir, branch, worktree);
  const teamIdentity = checkTeamIdentity(input.deps, config, input.repoDir);
  const resources: OvertureResources = {
    comboId: id,
    repo: input.repoDir,
    branch,
    worktree,
    tmuxSession: session,
    runDir,
    base: input.baseRef,
    baseRef: input.baseRef,
    sourceType: workPlan.source.type,
    sourceReference: workPlan.source.reference,
    sourceTitle: workPlan.title,
    ...(input.issueUrl !== undefined ? { issueUrl: input.issueUrl } : {}),
    ...(noMistakes.facts !== undefined ? { noMistakes: noMistakes.facts } : {}),
  };
  const checks: OvertureCheck[] = [
    ok("work_item_readable", input.issueUrl ?? input.planFile!),
    existsSync(input.repoDir)
      ? ok("repo_exists", input.repoDir)
      : failed("repo_exists", input.repoDir, "path does not exist"),
    checkRepoMatchesIssue(input.deps, input.repoDir, issue),
    checkSourceCheckout(input.deps, input.repoDir, config.sourceBranch),
    checkBaseRef(input.deps, input.repoDir, input.baseRef),
    checkTreehouseAvailable(input.deps, input.repoDir),
    checkComboId(id),
    runDirReusable(runDir),
    checkBranchFree(input.deps, input.repoDir, branch),
    existsSync(worktree)
      ? failed("worktree_free", worktree, "path already exists")
      : ok("worktree_free", worktree),
    input.deps.tmux(hasSessionArgs(session)).status === 0
      ? failed("tmux_session_free", session, "session already exists")
      : ok("tmux_session_free", session),
    ok("config_parses", input.repoDir),
    teamIdentity.check,
  ];
  try {
    assertSafeCoderInvocation(config.coderCommand, { requireGnhf: config.roles.coder === "codex" });
    checks.push(ok("coder_command_safe", config.roles.coder));
  } catch (error) {
    checks.push(
      failed(
        "coder_command_safe",
        config.roles.coder,
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
  try {
    assertReviewerCommandSafe(config.reviewerCommand);
    checks.push(ok("reviewer_command_safe", config.reviewerAgent));
  } catch (error) {
    checks.push(
      failed(
        "reviewer_command_safe",
        config.reviewerAgent,
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
  checks.push(...noMistakes.checks);
  checks.push(checkConfigFilePredictable(input.repoDir, worktree));

  const result: OvertureResult = {
    ok: checks.every((check) => check.status === "ok"),
    createdAt: combo.createdAt,
    resources,
    ...(teamIdentity.resolvedTeam !== undefined ? { resolvedTeam: teamIdentity.resolvedTeam } : {}),
    checks,
  };
  writeOvertureArtifact(runDir, result);
  return {
    result,
    combo,
    config,
    workPlan,
    runDir,
    ...(issue !== undefined ? { issue } : {}),
    ...(issueDetails !== undefined ? { issueDetails } : {}),
  };
}

function writeOvertureArtifact(runDir: string, result: OvertureResult): void {
  const runDirCheck = result.checks.find((check) => check.id === "run_dir_free");
  if (runDirCheck?.status !== "ok") return;
  mkdirSync(runDir, { recursive: true });
  const artifactPath = join(runDir, OVERTURE_ARTIFACT);
  result.artifactPath = artifactPath;
  const artifact = {
    ok: result.ok,
    createdAt: result.createdAt,
    resources: result.resources,
    ...(result.resolvedTeam !== undefined ? { resolvedTeam: result.resolvedTeam } : {}),
    checks: result.checks,
  };
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
}

export function renderOvertureChecklist(result: OvertureResult): string[] {
  return [
    `overture ${result.resources.comboId}`,
    ...result.checks.map((check) => {
      const marker = check.status === "ok" ? "OK" : "X";
      return `${marker} ${check.id}: ${check.resource}${check.detail === undefined ? "" : ` ${check.detail}`}`;
    }),
    ...(result.artifactPath === undefined ? [] : [`artifact ${result.artifactPath}`]),
  ];
}

export function assertOverturePassed(result: OvertureResult): void {
  const firstFailed = result.checks.find((check) => check.status === "failed");
  if (firstFailed === undefined) return;
  throw new OvertureBlockedError(
    `overture failed: ${firstFailed.id}: ${firstFailed.resource}` +
      `${firstFailed.detail === undefined ? "" : ` ${firstFailed.detail}`}`,
  );
}
// -/ 3/3
