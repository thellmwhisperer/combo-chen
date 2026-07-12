/**
 * @overview Config cascade: defaults ← user config ← repo config.
 *   Repo wins on policy, user wins on local setup. ~920 lines, 20 exports.
 *
 *   READING GUIDE
 *   ─────────────
 *   1. Start at loadConfig              ← the cascade: reads + merges all layers
 *   2. renderCommand                    ← placeholder → POSIX-safe shell token
 *   3. ComboConfig / ComboRoles types   ← shape of the resolved config
 *   4. DEFAULTS + mergeRoles + pick*    ← internal helpers, read on demand
 *
 *   MAIN FLOW
 *   ─────────
 *   cli/main.ts → loadConfig({repoDir, env})
 *     → readTomlIfExists(user) → readTomlIfExists(repo)
 *     → mergeRoles → pickNumber* → pickNonEmptyString
 *     → returns ComboConfig used by buildCoderInvocation,
 *       buildGatekeeperInvocation, buildReviewerInvocation,
 *       buildDirectorInvocation
 *
 *   ┌─ PUBLIC API ──────────────────────────────────────────────────────┐
 *   │ loadConfig / renderCommand  Resolve config and command templates  │
 *   │ hasGnhfCommand / unsafeCoderInvocationReasons / assertSafeCoderInvocation │
 *   │ ComboConfigError; ComboRoles, ComboLimits, ComboTeam* types       │
 *   │ WorkerPermissionPromptPolicy, RunEngine, ComboConfig              │
 *   │ DEFAULT_GATEKEEPER_COMMAND, DEFAULT_PERMISSION_PROMPT_PATTERNS     │
 *   │ DEFAULT_WORKER_PERMISSION_PROMPT_POLICY, DEFAULT_ROLE_TOOL_ALLOWLISTS, │
 *   │ DEFAULT_REVIEW_SETTINGS,                                          │
 *   │ DEFAULT_WORKER_RECOVERY_ATTEMPTS                                  │
 *   ├─ INTERNALS ───────────────────────────────────────────────────────┤
 *   │ readTomlIfExists, asTable, mergeRoles, pickNumber,               │
 *   │ pickNumberAlias, pickNonNegativeInteger, pickPositiveInteger,   │
 *   │ pickNonEmptyString, pickStringArray, normalize*Aliases,         │
 *   │ DEFAULTS, PLACEHOLDER, defaultUserConfigPath, gnhf safety predicates │
 *   └───────────────────────────────────────────────────────────────────┘
 *
 * @exports ComboConfigError, ComboRoles, ComboLimits, ComboTeamRole, ComboTeamIdentity, ComboTeam, WorkerPermissionPromptPolicy, RunEngine, ComboConfig, DEFAULT_GATEKEEPER_COMMAND, DEFAULT_PERMISSION_PROMPT_PATTERNS, DEFAULT_WORKER_PERMISSION_PROMPT_POLICY, DEFAULT_ROLE_TOOL_ALLOWLISTS, DEFAULT_REVIEW_SETTINGS, DEFAULT_WORKER_RECOVERY_ATTEMPTS, loadConfig, hasGnhfCommand, unsafeCoderInvocationReasons, assertSafeCoderInvocation, renderCommand
 * @deps node:fs, node:os, node:path, smol-toml, ../core/shell-quote
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

import { shellQuote } from "../core/shell-quote.js";

// -- 1/4 HELPER · Types + role aliases + DEFAULTS --
export class ComboConfigError extends Error {}

export interface ComboRoles {
  coder: string;
  gatekeeper: string;
  reviewer: string[];
  merge: string;
}

export interface ComboLimits {
  babysitPollSeconds: number;
  coderTimeoutMinutes: number;
  teardownGitRetries: number;
  teardownGitBackoffSeconds: number;
  watchFailureLimit: number;
  watchBackoffMaxSeconds: number;
}

export type ComboTeamRole = "coder" | "gatekeeper" | "reviewer" | "director";

export interface ComboTeamIdentity {
  binary: string;
  agent: string;
  model: string;
}

export type ComboTeam = Partial<Record<ComboTeamRole, ComboTeamIdentity>>;

export type WorkerPermissionPromptPolicy =
  "auto-approve-known-safe" | "recreate-non-interactive" | "escalate";

/** Which launch/runtime engine a combo run uses; snapshot-frozen at launch. */
export type RunEngine = "v0" | "capsule";

export interface ComboConfig {
  roles: ComboRoles;
  limits: ComboLimits;
  /** Command template for the configured coder, with {placeholders}. */
  coderCommand: string;
  /** Resume command template for the configured coder, with {thread_id}. */
  coderResumeCommand: string;
  /** Command template for the gatekeeper's blocking gate run. May contain {placeholders}: issue_url, issue_title, issue_body (issue-backed combos only), issue_pr_intent, branch (all combos). */
  gatekeeperCommand: string;
  /** Command template for the promptable interactive director role, with {placeholders}. */
  directorCommand: string;
  /** Number of automatic relaunches allowed after an initial pre-PR gate failure. */
  gatekeeperInitialGateRetryAttempts: number;
  /** Seconds to wait before relaunching a failed initial pre-PR gate. */
  gatekeeperInitialGateRetryBackoffSeconds: number;
  /** First configured reviewer with an executable command template. */
  reviewerAgent: string;
  /** Command template for the reviewer loop, with {placeholders}. */
  reviewerCommand: string;
  /** Free-form reviewer prompt text injected into the reviewer guardrails. */
  reviewerPrompt: string;
  /** Round cap backstop for the v1 local review loop; the no-progress guard usually fires first. */
  reviewMaxRounds: number;
  /** Wall-clock bound for one owned reviewer turn before the capsule escalates. */
  reviewerTurnTimeoutMinutes: number;
  /** Wall-clock bound for one owned code-1 coder fix turn before the capsule escalates. */
  fixTurnTimeoutMinutes: number;
  /** How long the capsule waits for the verdict artifact after the reviewer exits. */
  reviewVerdictWaitMs: number;
  /** External PR comment agents matched for noise filtering and coder routing. */
  externalCommentAgents: string[];
  /** GitHub check names that must be present with SUCCESS before READY. */
  readyRequiredChecks: string[];
  /** Unchanged pane ticks before a worker is considered stalled. */
  workerStallTicks: number;
  /** Recovery attempts before a stalled, permission-prompted, or dead coder worker escalates. */
  workerRecoveryAttempts: number;
  /** Regex sources used to detect interactive permission prompts in worker panes. */
  workerPermissionPromptPatterns: string[];
  /** Legacy snapshot/config compatibility; prompts now always journal and escalate. */
  workerPermissionPromptPolicy: WorkerPermissionPromptPolicy;
  /** Snapshot-frozen executable/tool budget for each autonomous role. */
  roleToolAllowlists: Record<ComboTeamRole, string[]>;
  /** Max age of the gnhf.log mtime (ms) to consider the coder actively progressing. */
  coderGnhfProgressMaxAgeMs: number;
  /** Timeout for probing no-mistakes gatekeeper status evidence (ms). */
  gatekeeperStatusTimeoutMs: number;
  /** Required source checkout branch for `combo-chen run`. */
  sourceBranch: string;
  /** Launch/runtime engine: v0 shell runner (default) or the v1 capsule sequencer. */
  runEngine: RunEngine;
  /** Optional launch contract declaring the expected effective role identities. */
  team?: ComboTeam;
  /** Launch-time effective role identities resolved during overture. */
  resolvedTeam?: ComboTeam;
}

type CanonicalRoleName = "coder" | "gatekeeper" | "reviewer" | "merge";

const ROLE_ALIASES: Record<string, CanonicalRoleName> = {
  coder: "coder",
  rower: "coder",
  gatekeeper: "gatekeeper",
  gate: "gatekeeper",
  hodor: "gatekeeper",
  reviewer: "reviewer",
  gordon: "reviewer",
  merge: "merge",
};
const ROLE_NAMES = new Set(Object.keys(ROLE_ALIASES));
const TEAM_ROLE_NAMES = new Set<ComboTeamRole>(["coder", "gatekeeper", "reviewer", "director"]);
const TEAM_IDENTITY_FIELDS = new Set(["binary", "agent", "model"]);
const DEFAULT_REVIEWER_PROMPT = "";
export const DEFAULT_WORKER_RECOVERY_ATTEMPTS = 2;
const DEFAULT_CODER_STOP_WHEN =
  "Every acceptance criterion stated in the work item is met and the full test suite is green. " +
  "If the work item lists no explicit criteria: the reproduction it describes is fixed, a new test pins that fix, and the suite is green.";
const DEFAULT_CODER_COMMAND = [
  "npx -y gnhf@0.1.41",
  "--agent codex",
  "--max-iterations 12",
  `--stop-when ${shellQuote(DEFAULT_CODER_STOP_WHEN)}`,
  "--prevent-sleep on",
  "--meteor-frequency 0",
  "--current-branch {prompt}",
].join(" ");
export const DEFAULT_GATEKEEPER_COMMAND =
  "no-mistakes daemon start && no-mistakes axi run --intent {issue_pr_intent} --skip=ci";
const DEFAULT_DIRECTOR_COMMAND = "claude --permission-mode auto {prompt}";
export const DEFAULT_PERMISSION_PROMPT_PATTERNS = [
  "^\\s*This command requires approval:\\s*.+$",
  "^\\s*Do you want to (?:proceed|continue)\\?\\s*(?:\\[[yn]/[yn]\\])?\\s*$",
  "^\\s*(?:Allow|Approve|Confirm)\\?\\s*\\[[yn]/[yn]\\]\\s*$",
  "^\\s*(?:Press|Type)\\s+(?:y|yes)\\s+to\\s+(?:continue|proceed|confirm)\\.?\\s*$",
];
const WORKER_PERMISSION_PROMPT_POLICIES: WorkerPermissionPromptPolicy[] = [
  "auto-approve-known-safe",
  "recreate-non-interactive",
  "escalate",
];
export const DEFAULT_WORKER_PERMISSION_PROMPT_POLICY: WorkerPermissionPromptPolicy = "escalate";
export const DEFAULT_ROLE_TOOL_ALLOWLISTS: Record<ComboTeamRole, string[]> = {
  coder: ["node", "pnpm", "git", "rg"],
  reviewer: ["node", "pnpm", "git", "rg"],
  gatekeeper: ["node", "pnpm", "git", "no-mistakes", "gh-axi"],
  director: ["git", "tmux", "combo-chen", "gh-axi"],
};
/**
 * Documented [review] loop bounds. Exported so config-snapshot can backfill
 * pre-W5b frozen snapshots: a missing field must read as these defaults, not
 * as undefined (which would silently disable the round cap and timeouts).
 */
export const DEFAULT_REVIEW_SETTINGS = {
  maxRounds: 3,
  reviewerTurnTimeoutMinutes: 60,
  fixTurnTimeoutMinutes: 120,
  verdictWaitMs: 5000,
} as const;

const DEFAULT_REVIEWER_TEMPLATES: Record<string, { command?: string }> = {
  claude: {
    command: "claude --permission-mode auto {prompt}",
  },
};

const DEFAULTS = {
  roles: {
    coder: "codex",
    gatekeeper: "no-mistakes",
    reviewer: ["claude"],
    merge: "human",
  } satisfies ComboRoles,
  limits: {
    babysit_poll_seconds: 120,
    coder_timeout_minutes: 180,
    teardown_git_retries: 2,
    teardown_git_backoff_seconds: 2,
    watch_failure_limit: 5,
    watch_backoff_max_seconds: 3600,
  },
  coder: {
    codex: {
      command: DEFAULT_CODER_COMMAND,
      resume_command: "codex --ask-for-approval never --sandbox workspace-write exec resume {thread_id}",
    },
  } as Record<string, { command?: unknown; resume_command?: unknown }>,
  gatekeeper: {
    command: DEFAULT_GATEKEEPER_COMMAND,
    initial_gate_retry_attempts: 2,
    initial_gate_retry_backoff_seconds: 10,
  },
  director: {
    command: DEFAULT_DIRECTOR_COMMAND,
  },
  external_comments: {
    agents: [],
  },
  ready: {
    required_checks: [],
  },
  review: {
    max_rounds: DEFAULT_REVIEW_SETTINGS.maxRounds,
    reviewer_turn_timeout_minutes: DEFAULT_REVIEW_SETTINGS.reviewerTurnTimeoutMinutes,
    fix_turn_timeout_minutes: DEFAULT_REVIEW_SETTINGS.fixTurnTimeoutMinutes,
    verdict_wait_ms: DEFAULT_REVIEW_SETTINGS.verdictWaitMs,
  },
  monitor: {
    worker_stall_ticks: 3,
    worker_recovery_attempts: DEFAULT_WORKER_RECOVERY_ATTEMPTS,
    permission_prompt_patterns: DEFAULT_PERMISSION_PROMPT_PATTERNS,
    permission_prompt_policy: DEFAULT_WORKER_PERMISSION_PROMPT_POLICY,
    coder_gnhf_progress_max_age_ms: 10 * 60 * 1000,
    gatekeeper_status_timeout_ms: 5000,
  },
  run: {
    source_branch: "main",
    engine: "capsule",
  },
};

const RUN_ENGINES: RunEngine[] = ["capsule"];
const LEGACY_RUN_ENGINES: string[] = ["v0"];

function pickRunEngine(value: unknown, description: string): RunEngine {
  const engine = pickNonEmptyString(value, description);
  if (LEGACY_RUN_ENGINES.includes(engine)) {
    throw new ComboConfigError(
      `${description}: run engine "${engine}" was retired in v1. Use "capsule". Remove [run] from your config to accept the default, or set engine = "capsule".`,
    );
  }
  if (!RUN_ENGINES.includes(engine as RunEngine)) {
    throw new ComboConfigError(`${description} must be one of ${RUN_ENGINES.join(", ")}`);
  }
  return engine as RunEngine;
}

// -/ 1/4

// -- 2/4 HELPER · Parsing helpers (TOML read, merge, pick) --
function defaultUserConfigPath(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "combo-chen", "config.toml");
}

interface LoadOptions {
  repoDir: string;
  userConfigPath?: string;
  env?: Record<string, string | undefined>;
}

type TomlTable = Record<string, unknown>;

function readTomlIfExists(path: string): TomlTable {
  if (!existsSync(path)) return {};
  const parsed = parseToml(readFileSync(path, "utf8"));
  return parsed as TomlTable;
}

function asTable(value: unknown, where: string): TomlTable {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ComboConfigError(`${where} must be a table`);
  }
  return value as TomlTable;
}

function mergeRoles(base: ComboRoles, raw: unknown, source: string): ComboRoles {
  const table = asTable(raw, `[roles] in ${source}`);
  const merged = {
    coder: base.coder,
    gatekeeper: base.gatekeeper,
    reviewer: [...base.reviewer],
    merge: base.merge,
  };
  for (const [key, value] of Object.entries(table)) {
    if (!ROLE_NAMES.has(key)) {
      throw new ComboConfigError(
        `Unknown role "${key}" in ${source}. Known roles: ${[...ROLE_NAMES].join(", ")}`,
      );
    }
    const canonical = ROLE_ALIASES[key]!;
    // v1 command tables live directly under [roles.*]. Scalar role names are
    // retained only as a deprecated compatibility bridge for frozen v0 snapshots.
    if (typeof value === "object" && value !== null && !Array.isArray(value)) continue;
    if (canonical === "reviewer") {
      merged.reviewer = Array.isArray(value) ? value.map(String) : [String(value)];
    } else {
      merged[canonical] = String(value);
    }
  }
  return merged;
}

interface UnifiedRoleTables {
  coder: TomlTable;
  reviewer: TomlTable;
  gate: TomlTable;
}

function mergeUnifiedRoleTables(base: UnifiedRoleTables, raw: unknown, source: string): UnifiedRoleTables {
  const roles = asTable(raw, `[roles] in ${source}`);
  const merged = { coder: { ...base.coder }, reviewer: { ...base.reviewer }, gate: { ...base.gate } };
  for (const role of ["coder", "reviewer", "gate"] as const) {
    const value = roles[role];
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    merged[role] = { ...merged[role], ...asTable(value, `[roles.${role}] in ${source}`) };
  }
  return merged;
}

function mergeTeam(base: ComboTeam | undefined, raw: unknown, source: string): ComboTeam {
  const table = asTable(raw, `[team] in ${source}`);
  const merged: ComboTeam = { ...(base ?? {}) };
  for (const [role, value] of Object.entries(table)) {
    if (!TEAM_ROLE_NAMES.has(role as ComboTeamRole)) {
      throw new ComboConfigError(
        `Unknown team role "${role}" in ${source}. Known team roles: ${[...TEAM_ROLE_NAMES].join(", ")}`,
      );
    }
    const identity = asTable(value, `[team.${role}] in ${source}`);
    for (const field of Object.keys(identity)) {
      if (!TEAM_IDENTITY_FIELDS.has(field)) {
        throw new ComboConfigError(
          `Unknown team identity field "${field}" in [team.${role}] in ${source}. ` +
            `Known fields: ${[...TEAM_IDENTITY_FIELDS].join(", ")}`,
        );
      }
    }
    merged[role as ComboTeamRole] = {
      binary: pickNonEmptyString(identity["binary"], `team.${role}.binary`),
      agent: pickNonEmptyString(identity["agent"], `team.${role}.agent`),
      model: pickNonEmptyString(identity["model"], `team.${role}.model`),
    };
  }
  return merged;
}

function pickNumber(table: TomlTable, key: string, fallback: number, where = "[limits]"): number {
  const value = table[key];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ComboConfigError(`${where} ${key} must be a positive number`);
  }
  return parsed;
}

function pickNumberAlias(table: TomlTable, key: string, legacyKey: string, fallback: number): number {
  if (table[key] !== undefined) return pickNumber(table, key, fallback);
  return pickNumber(table, legacyKey, fallback);
}

function normalizeLimitAliases(table: TomlTable): TomlTable {
  if (table["coder_timeout_minutes"] !== undefined || table["rower_timeout_minutes"] === undefined) {
    return table;
  }
  return { ...table, coder_timeout_minutes: table["rower_timeout_minutes"] };
}

function pickNonNegativeInteger(table: TomlTable, key: string, fallback: number, where = "[limits]"): number {
  const value = table[key];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ComboConfigError(`${where} ${key} must be a non-negative integer`);
  }
  return parsed;
}

function pickPositiveInteger(table: TomlTable, key: string, fallback: number, where = "[limits]"): number {
  const value = table[key];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ComboConfigError(`${where} ${key} must be a positive integer`);
  }
  return parsed;
}

function pickNonEmptyString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ComboConfigError(`${description} must be a non-empty string`);
  }
  return value;
}

function pickStringArray(value: unknown, description: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ComboConfigError(`${description} must be an array of strings`);
  }
  return value.map((item) => pickNonEmptyString(item, description));
}

function pickNonEmptyStringArray(value: unknown, description: string): string[] {
  const values = pickStringArray(value, description);
  if (values.length === 0) {
    throw new ComboConfigError(`${description} must contain at least one string`);
  }
  return values;
}

function pickWorkerPermissionPromptPolicy(value: unknown, description: string): WorkerPermissionPromptPolicy {
  const policy = pickNonEmptyString(value, description);
  if (!WORKER_PERMISSION_PROMPT_POLICIES.includes(policy as WorkerPermissionPromptPolicy)) {
    throw new ComboConfigError(
      `${description} must be one of ${WORKER_PERMISSION_PROMPT_POLICIES.join(", ")}`,
    );
  }
  return policy as WorkerPermissionPromptPolicy;
}

function parseEnvStringArray(value: string, description: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      return pickNonEmptyStringArray(JSON.parse(trimmed) as unknown, description);
    } catch (err) {
      if (err instanceof ComboConfigError) throw err;
      throw new ComboConfigError(`${description} must be a JSON string array`);
    }
  }
  const values = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (values.length === 0) {
    throw new ComboConfigError(`${description} must contain at least one string`);
  }
  return values;
}

function assertValidRegexPatterns(patterns: string[], description: string): void {
  for (const pattern of patterns) {
    try {
      new RegExp(pattern, "i");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ComboConfigError(
        `${description} contains invalid regular expression ${JSON.stringify(pattern)}: ${message}`,
      );
    }
  }
}

export function hasGnhfCommand(command: string): boolean {
  return /(?:^|\s)(?:\S*\/)?gnhf(?:@[-\w.]+)?(?:\s|$)/.test(command);
}

function hasPinnedGnhfPackage(command: string): boolean {
  return /(?:^|\s)(?:\S*\/)?gnhf@[0-9]+(?:\.[0-9]+){1,2}(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)/.test(command);
}

function hasFlagValue(command: string, flag: string, value: string): boolean {
  const escapedFlag = flag.replaceAll("-", "\\-");
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${escapedFlag}(?:=|\\s+)${escapedValue}(?:\\s|$)`).test(command);
}

function hasPositiveIntegerFlag(command: string, flag: string): boolean {
  const escaped = flag.replaceAll("-", "\\-");
  const match = new RegExp(`(?:^|\\s)${escaped}(?:=|\\s+)(\\d+)(?:\\s|$)`).exec(command);
  return match !== null && Number(match[1]) > 0;
}

function hasStopWhenFlag(command: string): boolean {
  return /(?:^|\s)--stop-when(?:=|\s+)(?:'[^']+'|"[^"]+"|\S+)(?:\s|$)/.test(command);
}

interface CoderSafetyOptions {
  requireGnhf?: boolean;
}

export function unsafeCoderInvocationReasons(command: string, options: CoderSafetyOptions = {}): string[] {
  if (!hasGnhfCommand(command)) {
    return options.requireGnhf === true ? ["gnhf command"] : [];
  }

  const reasons: string[] = [];
  if (!hasPinnedGnhfPackage(command)) reasons.push("pinned gnhf package version");
  if (!hasPositiveIntegerFlag(command, "--max-iterations")) reasons.push("--max-iterations");
  if (!hasStopWhenFlag(command)) reasons.push("--stop-when");
  if (!hasFlagValue(command, "--prevent-sleep", "on")) reasons.push("--prevent-sleep on");
  if (!hasFlagValue(command, "--meteor-frequency", "0")) reasons.push("telemetry off (--meteor-frequency 0)");
  return reasons;
}

export function assertSafeCoderInvocation(command: string, options: CoderSafetyOptions = {}): void {
  const reasons = unsafeCoderInvocationReasons(command, options);
  if (reasons.length > 0) {
    throw new ComboConfigError(`Unsafe coder invocation: missing ${reasons.join(", ")}`);
  }
}

// -/ 2/4

// -- 3/4 CORE · loadConfig (cascade) ← START HERE --
export function loadConfig(options: LoadOptions): ComboConfig {
  const userPath = options.userConfigPath ?? defaultUserConfigPath();
  const repoPath = join(options.repoDir, "combo-chen.toml");

  const layers: Array<{ table: TomlTable; source: string }> = [
    { table: readTomlIfExists(userPath), source: userPath },
    { table: readTomlIfExists(repoPath), source: repoPath },
  ];

  let roles: ComboRoles = {
    ...DEFAULTS.roles,
    reviewer: [...DEFAULTS.roles.reviewer],
  };
  let limitsTable: TomlTable = { ...DEFAULTS.limits };
  let coderTemplates: Record<string, { command?: unknown; resume_command?: unknown }> = {
    ...DEFAULTS.coder,
  };
  let gatekeeperTable: TomlTable = { ...DEFAULTS.gatekeeper };
  let directorTable: TomlTable = { ...DEFAULTS.director };
  let externalCommentsTable: TomlTable = { ...DEFAULTS.external_comments };
  let readyTable: TomlTable = { ...DEFAULTS.ready };
  let reviewTable: TomlTable = { ...DEFAULTS.review };
  let unifiedRoles: UnifiedRoleTables = { coder: {}, reviewer: {}, gate: {} };
  let reviewerTemplates: Record<string, { command?: unknown }> = { ...DEFAULT_REVIEWER_TEMPLATES };
  let reviewerPrompt = DEFAULT_REVIEWER_PROMPT;
  let monitorTable: TomlTable = { ...DEFAULTS.monitor };
  let runTable: TomlTable = { ...DEFAULTS.run };
  let team: ComboTeam | undefined;

  for (const layer of layers) {
    if (layer.table["roles"] !== undefined) {
      roles = mergeRoles(roles, layer.table["roles"], layer.source);
      unifiedRoles = mergeUnifiedRoleTables(unifiedRoles, layer.table["roles"], layer.source);
    }
    if (layer.table["team"] !== undefined) {
      team = mergeTeam(team, layer.table["team"], layer.source);
    }
    if (layer.table["limits"] !== undefined) {
      limitsTable = {
        ...limitsTable,
        ...normalizeLimitAliases(asTable(layer.table["limits"], `[limits] in ${layer.source}`)),
      };
    }
    for (const section of ["rower", "coder"]) {
      if (layer.table[section] === undefined) continue;
      const coderTable = asTable(layer.table[section], `[${section}] in ${layer.source}`);
      for (const [name, entry] of Object.entries(coderTable)) {
        coderTemplates = {
          ...coderTemplates,
          [name]: { ...coderTemplates[name], ...asTable(entry, `[${section}.${name}] in ${layer.source}`) },
        };
      }
    }
    for (const section of ["hodor", "gatekeeper"]) {
      if (layer.table[section] === undefined) continue;
      gatekeeperTable = {
        ...gatekeeperTable,
        ...asTable(layer.table[section], `[${section}] in ${layer.source}`),
      };
    }
    if (layer.table["director"] !== undefined) {
      directorTable = {
        ...directorTable,
        ...asTable(layer.table["director"], `[director] in ${layer.source}`),
      };
    }
    for (const section of ["gordon", "reviewer"]) {
      if (layer.table[section] === undefined) continue;
      const reviewerTable = asTable(layer.table[section], `[${section}] in ${layer.source}`);
      if (reviewerTable["prompt"] !== undefined) {
        if (typeof reviewerTable["prompt"] !== "string") {
          throw new ComboConfigError(`${section}.prompt must be a string`);
        }
        reviewerPrompt = reviewerTable["prompt"];
      }
      if (reviewerTable["ambient"] !== undefined) {
        externalCommentsTable = {
          ...externalCommentsTable,
          agents: reviewerTable["ambient"],
        };
      }
      for (const [name, entry] of Object.entries(reviewerTable)) {
        if (name === "prompt" || name === "ambient" || name === "logins") continue;
        reviewerTemplates = {
          ...reviewerTemplates,
          [name]: {
            ...reviewerTemplates[name],
            ...asTable(entry, `[${section}.${name}] in ${layer.source}`),
          },
        };
      }
    }
    if (layer.table["ready"] !== undefined) {
      readyTable = {
        ...readyTable,
        ...asTable(layer.table["ready"], `[ready] in ${layer.source}`),
      };
    }
    if (layer.table["external_comments"] !== undefined) {
      externalCommentsTable = {
        ...externalCommentsTable,
        ...asTable(layer.table["external_comments"], `[external_comments] in ${layer.source}`),
      };
    }
    if (layer.table["review"] !== undefined) {
      reviewTable = {
        ...reviewTable,
        ...asTable(layer.table["review"], `[review] in ${layer.source}`),
      };
    }
    if (layer.table["monitor"] !== undefined) {
      monitorTable = {
        ...monitorTable,
        ...asTable(layer.table["monitor"], `[monitor] in ${layer.source}`),
      };
    }
    if (layer.table["run"] !== undefined) {
      runTable = {
        ...runTable,
        ...asTable(layer.table["run"], `[run] in ${layer.source}`),
      };
    }
  }

  const env = options.env ?? {};
  if (env["COMBO_CHEN_GATEKEEPER_INITIAL_GATE_RETRY_ATTEMPTS"] !== undefined) {
    gatekeeperTable["initial_gate_retry_attempts"] = env["COMBO_CHEN_GATEKEEPER_INITIAL_GATE_RETRY_ATTEMPTS"];
  }
  if (env["COMBO_CHEN_GATEKEEPER_INITIAL_GATE_RETRY_BACKOFF_SECONDS"] !== undefined) {
    gatekeeperTable["initial_gate_retry_backoff_seconds"] =
      env["COMBO_CHEN_GATEKEEPER_INITIAL_GATE_RETRY_BACKOFF_SECONDS"];
  }
  if (env["COMBO_CHEN_WATCH_FAILURE_LIMIT"] !== undefined) {
    limitsTable["watch_failure_limit"] = env["COMBO_CHEN_WATCH_FAILURE_LIMIT"];
  }
  if (env["COMBO_CHEN_WATCH_BACKOFF_MAX_SECONDS"] !== undefined) {
    limitsTable["watch_backoff_max_seconds"] = env["COMBO_CHEN_WATCH_BACKOFF_MAX_SECONDS"];
  }
  if (env["COMBO_CHEN_WORKER_STALL_TICKS"] !== undefined) {
    monitorTable["worker_stall_ticks"] = env["COMBO_CHEN_WORKER_STALL_TICKS"];
  }
  if (env["COMBO_CHEN_WORKER_RECOVERY_ATTEMPTS"] !== undefined) {
    monitorTable["worker_recovery_attempts"] = env["COMBO_CHEN_WORKER_RECOVERY_ATTEMPTS"];
  }
  if (env["COMBO_CHEN_WORKER_PERMISSION_PROMPT_PATTERNS"] !== undefined) {
    monitorTable["permission_prompt_patterns"] = parseEnvStringArray(
      env["COMBO_CHEN_WORKER_PERMISSION_PROMPT_PATTERNS"],
      "monitor.permission_prompt_patterns",
    );
  }
  if (env["COMBO_CHEN_WORKER_PERMISSION_PROMPT_POLICY"] !== undefined) {
    monitorTable["permission_prompt_policy"] = env["COMBO_CHEN_WORKER_PERMISSION_PROMPT_POLICY"];
  }
  if (env["COMBO_CHEN_CODER_GNHF_PROGRESS_MAX_AGE_MS"] !== undefined) {
    monitorTable["coder_gnhf_progress_max_age_ms"] = env["COMBO_CHEN_CODER_GNHF_PROGRESS_MAX_AGE_MS"];
  }
  if (env["COMBO_CHEN_GATEKEEPER_STATUS_TIMEOUT_MS"] !== undefined) {
    monitorTable["gatekeeper_status_timeout_ms"] = env["COMBO_CHEN_GATEKEEPER_STATUS_TIMEOUT_MS"];
  }
  if (env["COMBO_CHEN_READY_REQUIRED_CHECKS"] !== undefined) {
    readyTable["required_checks"] = parseEnvStringArray(
      env["COMBO_CHEN_READY_REQUIRED_CHECKS"],
      "ready.required_checks",
    );
  }
  if (env["COMBO_CHEN_EXTERNAL_COMMENT_AGENTS"] !== undefined) {
    externalCommentsTable["agents"] = parseEnvStringArray(
      env["COMBO_CHEN_EXTERNAL_COMMENT_AGENTS"],
      "external_comments.agents",
    );
  }
  if (env["COMBO_CHEN_SOURCE_BRANCH"] !== undefined) {
    runTable["source_branch"] = env["COMBO_CHEN_SOURCE_BRANCH"];
  }
  if (env["COMBO_CHEN_RUN_ENGINE"] !== undefined) {
    runTable["engine"] = env["COMBO_CHEN_RUN_ENGINE"];
  }
  if (env["COMBO_CHEN_REVIEW_MAX_ROUNDS"] !== undefined) {
    reviewTable["max_rounds"] = env["COMBO_CHEN_REVIEW_MAX_ROUNDS"];
  }
  if (env["COMBO_CHEN_REVIEW_REVIEWER_TURN_TIMEOUT_MINUTES"] !== undefined) {
    reviewTable["reviewer_turn_timeout_minutes"] = env["COMBO_CHEN_REVIEW_REVIEWER_TURN_TIMEOUT_MINUTES"];
  }
  if (env["COMBO_CHEN_REVIEW_FIX_TURN_TIMEOUT_MINUTES"] !== undefined) {
    reviewTable["fix_turn_timeout_minutes"] = env["COMBO_CHEN_REVIEW_FIX_TURN_TIMEOUT_MINUTES"];
  }
  if (env["COMBO_CHEN_REVIEW_VERDICT_WAIT_MS"] !== undefined) {
    reviewTable["verdict_wait_ms"] = env["COMBO_CHEN_REVIEW_VERDICT_WAIT_MS"];
  }
  if (env["COMBO_CHEN_DIRECTOR_COMMAND"] !== undefined) {
    directorTable["command"] = env["COMBO_CHEN_DIRECTOR_COMMAND"];
  }

  if (roles.reviewer.length === 0) {
    throw new ComboConfigError(
      "reviewer (formerly gordon) must name at least one judge: an empty reviewer silently disables judgment.",
    );
  }

  if (roles.reviewer.includes(roles.coder)) {
    throw new ComboConfigError(
      `reviewer != coder (formerly gordon != rower): "${roles.coder}" cannot review its own cooking. Pick a different reviewer or coder.`,
    );
  }

  const coderCommand = pickNonEmptyString(
    unifiedRoles.coder["implement_command"] ??
      unifiedRoles.coder["command"] ??
      coderTemplates[roles.coder]?.command,
    `command template for coder "${roles.coder}"`,
  );
  const coderResumeCommand = pickNonEmptyString(
    unifiedRoles.coder["respond_command"] ?? coderTemplates[roles.coder]?.resume_command,
    `resume command template for coder "${roles.coder}"`,
  );

  const reviewerAgent =
    unifiedRoles.reviewer["command"] !== undefined
      ? roles.reviewer[0]
      : roles.reviewer.find((agent) => reviewerTemplates[agent]?.command !== undefined);
  if (!reviewerAgent) {
    throw new ComboConfigError(
      `No command template for reviewer (formerly gordon) ${roles.reviewer.map((agent) => `"${agent}"`).join(", ")}. ` +
        `Add [reviewer."<name>"] command = "..." to your config.`,
    );
  }
  const reviewerCommand = pickNonEmptyString(
    unifiedRoles.reviewer["command"] ?? reviewerTemplates[reviewerAgent]?.command,
    `command template for reviewer "${reviewerAgent}"`,
  );
  const configuredAgents = pickStringArray(
    externalCommentsTable["agents"],
    "external_comments.agents",
  ).filter((agent) => agent !== roles.coder && agent !== reviewerAgent);
  const legacyAmbient = roles.reviewer.filter((agent) => agent !== roles.coder && agent !== reviewerAgent);
  const externalCommentAgents = [...new Set([...configuredAgents, ...legacyAmbient])];
  const readyRequiredChecks = [
    ...new Set(pickStringArray(readyTable["required_checks"], "ready.required_checks")),
  ];
  const workerPermissionPromptPatterns = pickNonEmptyStringArray(
    monitorTable["permission_prompt_patterns"],
    "monitor.permission_prompt_patterns",
  );
  assertValidRegexPatterns(workerPermissionPromptPatterns, "monitor.permission_prompt_patterns");

  return {
    roles,
    limits: {
      babysitPollSeconds: pickNumber(
        limitsTable,
        "babysit_poll_seconds",
        DEFAULTS.limits.babysit_poll_seconds,
      ),
      coderTimeoutMinutes: pickNumberAlias(
        limitsTable,
        "coder_timeout_minutes",
        "rower_timeout_minutes",
        DEFAULTS.limits.coder_timeout_minutes,
      ),
      teardownGitRetries: pickNonNegativeInteger(
        limitsTable,
        "teardown_git_retries",
        DEFAULTS.limits.teardown_git_retries,
      ),
      teardownGitBackoffSeconds: pickNumber(
        limitsTable,
        "teardown_git_backoff_seconds",
        DEFAULTS.limits.teardown_git_backoff_seconds,
      ),
      watchFailureLimit: pickPositiveInteger(
        limitsTable,
        "watch_failure_limit",
        DEFAULTS.limits.watch_failure_limit,
      ),
      watchBackoffMaxSeconds: pickPositiveInteger(
        limitsTable,
        "watch_backoff_max_seconds",
        DEFAULTS.limits.watch_backoff_max_seconds,
      ),
    },
    coderCommand,
    coderResumeCommand,
    gatekeeperCommand: pickNonEmptyString(
      unifiedRoles.gate["command"] ?? gatekeeperTable["command"],
      "command template for [roles.gate]",
    ),
    directorCommand: pickNonEmptyString(directorTable["command"], "command template for [director]"),
    gatekeeperInitialGateRetryAttempts: pickNonNegativeInteger(
      gatekeeperTable,
      "initial_gate_retry_attempts",
      DEFAULTS.gatekeeper.initial_gate_retry_attempts,
      "[gatekeeper]",
    ),
    gatekeeperInitialGateRetryBackoffSeconds: pickNonNegativeInteger(
      gatekeeperTable,
      "initial_gate_retry_backoff_seconds",
      DEFAULTS.gatekeeper.initial_gate_retry_backoff_seconds,
      "[gatekeeper]",
    ),
    reviewerAgent,
    reviewerCommand,
    reviewerPrompt:
      typeof unifiedRoles.reviewer["prompt"] === "string" ? unifiedRoles.reviewer["prompt"] : reviewerPrompt,
    reviewMaxRounds: pickPositiveInteger(reviewTable, "max_rounds", DEFAULTS.review.max_rounds, "[review]"),
    reviewerTurnTimeoutMinutes: pickPositiveInteger(
      reviewTable,
      "reviewer_turn_timeout_minutes",
      DEFAULTS.review.reviewer_turn_timeout_minutes,
      "[review]",
    ),
    fixTurnTimeoutMinutes: pickPositiveInteger(
      reviewTable,
      "fix_turn_timeout_minutes",
      DEFAULTS.review.fix_turn_timeout_minutes,
      "[review]",
    ),
    reviewVerdictWaitMs: pickPositiveInteger(
      reviewTable,
      "verdict_wait_ms",
      DEFAULTS.review.verdict_wait_ms,
      "[review]",
    ),
    externalCommentAgents: [...new Set(externalCommentAgents)],
    readyRequiredChecks,
    workerStallTicks: pickPositiveInteger(
      monitorTable,
      "worker_stall_ticks",
      DEFAULTS.monitor.worker_stall_ticks,
      "[monitor]",
    ),
    workerRecoveryAttempts: pickNonNegativeInteger(
      monitorTable,
      "worker_recovery_attempts",
      DEFAULTS.monitor.worker_recovery_attempts,
      "[monitor]",
    ),
    workerPermissionPromptPatterns: [...workerPermissionPromptPatterns],
    workerPermissionPromptPolicy: pickWorkerPermissionPromptPolicy(
      monitorTable["permission_prompt_policy"],
      "monitor.permission_prompt_policy",
    ),
    roleToolAllowlists: {
      coder: pickStringArray(
        unifiedRoles.coder["allowed_tools"] ?? DEFAULT_ROLE_TOOL_ALLOWLISTS.coder,
        "roles.coder.allowed_tools",
      ),
      reviewer: pickStringArray(
        unifiedRoles.reviewer["allowed_tools"] ?? DEFAULT_ROLE_TOOL_ALLOWLISTS.reviewer,
        "roles.reviewer.allowed_tools",
      ),
      gatekeeper: pickStringArray(
        unifiedRoles.gate["allowed_tools"] ?? DEFAULT_ROLE_TOOL_ALLOWLISTS.gatekeeper,
        "roles.gate.allowed_tools",
      ),
      director: pickStringArray(
        directorTable["allowed_tools"] ?? DEFAULT_ROLE_TOOL_ALLOWLISTS.director,
        "director.allowed_tools",
      ),
    },
    coderGnhfProgressMaxAgeMs: pickPositiveInteger(
      monitorTable,
      "coder_gnhf_progress_max_age_ms",
      DEFAULTS.monitor.coder_gnhf_progress_max_age_ms,
      "[monitor]",
    ),
    gatekeeperStatusTimeoutMs: pickPositiveInteger(
      monitorTable,
      "gatekeeper_status_timeout_ms",
      DEFAULTS.monitor.gatekeeper_status_timeout_ms,
      "[monitor]",
    ),
    sourceBranch: pickNonEmptyString(runTable["source_branch"], "run.source_branch"),
    runEngine: pickRunEngine(runTable["engine"], "run.engine"),
    ...(team !== undefined ? { team } : {}),
  };
}
// -/ 3/4

// -- 4/4 CORE · renderCommand --
const PLACEHOLDER = /\{([a-z_]+)\}/g;

export function renderCommand(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      throw new ComboConfigError(`Unknown placeholder {${name}} in command template`);
    }
    return shellQuote(value);
  });
}
// -/ 4/4
