/**
 * Config cascade: defaults ← user config ← repo config.
 * Repo wins on policy, user wins on local setup, nothing operational is
 * hardcoded beyond the in-code fallbacks defined here.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

import { shellQuote } from "../core/combo.js";

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
}

export interface ComboConfig {
  roles: ComboRoles;
  limits: ComboLimits;
  /** Command template for the configured coder, with {placeholders}. */
  coderCommand: string;
  /** Resume command template for the configured coder, with {thread_id}. */
  coderResumeCommand: string;
  /** Command template for the gatekeeper's blocking gate run. May contain {placeholders}: issue_url, issue_title, issue_body, issue_pr_intent, branch. */
  gatekeeperCommand: string;
  /** How long the gatekeeper tmux window waits for no-mistakes' active run. */
  gatekeeperAttachTimeoutSeconds: number;
  /** How often the gatekeeper tmux window polls for no-mistakes' active run. */
  gatekeeperAttachRetryIntervalSeconds: number;
  /** Prompt template sent to the coder responding mode for each routed review signal. */
  reviewNudgePrompt: string;
  /** tmux window name for the resumed coder responding mode. */
  coderRespondingWindowName: string;
  /** tmux window name for the review-comment watcher. */
  coderRespondingWatchWindowName: string;
  /** First configured reviewer with an executable command template. */
  reviewerAgent: string;
  /** Command template for the reviewer loop, with {placeholders}. */
  reviewerCommand: string;
  /** Review protocol reference injected into the reviewer prompt. */
  reviewerProtocol: string;
}

type CanonicalRoleName = "coder" | "gatekeeper" | "reviewer" | "merge";

const ROLE_ALIASES: Record<string, CanonicalRoleName> = {
  coder: "coder",
  rower: "coder",
  gatekeeper: "gatekeeper",
  hodor: "gatekeeper",
  reviewer: "reviewer",
  gordon: "reviewer",
  merge: "merge",
};
const ROLE_NAMES = new Set(Object.keys(ROLE_ALIASES));
const DEFAULT_REVIEWER_PROTOCOL = "La Roca review protocol 7989 + project overlay";
export const DEFAULT_GATEKEEPER_COMMAND =
  "if git remote get-url no-mistakes >/dev/null 2>&1; then git push no-mistakes HEAD && no-mistakes axi run --intent {issue_pr_intent}; else no-mistakes axi run --intent {issue_pr_intent}; fi";
const DEFAULT_REVIEWER_TEMPLATES: Record<string, { command?: string }> = {
  claude: {
    command: "claude {prompt}",
  },
};

const DEFAULTS = {
  roles: {
    coder: "codex",
    gatekeeper: "no-mistakes",
    reviewer: ["claude", "coderabbit"],
    merge: "human",
  } satisfies ComboRoles,
  limits: {
    babysit_poll_seconds: 120,
    coder_timeout_minutes: 180,
    teardown_git_retries: 2,
    teardown_git_backoff_seconds: 2,
  },
  coder: {
    codex: {
      command: "npx -y gnhf --agent codex --current-branch {prompt}",
      resume_command: "codex resume {thread_id}",
    },
  } as Record<string, { command?: unknown; resume_command?: unknown }>,
  gatekeeper: {
    command: DEFAULT_GATEKEEPER_COMMAND,
    attach_timeout_seconds: 1800,
    attach_retry_interval_seconds: 10,
  },
  coder_responding: {
    window_name: "coder-responding",
    watch_window_name: "comment-watch",
    review_nudge_prompt: [
      "New review comment for coder responding mode:",
      "{url}",
      "",
      "Use the two-bucket contract: handle mechanical fixes autonomously with TDD, code, push, and PR replies; escalate intent-touching decisions with needs_human before changing code.",
      "Before pushing, check the gatekeeper push semaphore.",
    ].join("\n"),
  },
};

export function defaultUserConfigPath(): string {
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
    if (canonical === "reviewer") {
      merged.reviewer = Array.isArray(value) ? value.map(String) : [String(value)];
    } else {
      merged[canonical] = String(value);
    }
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

function pickNonNegativeInteger(table: TomlTable, key: string, fallback: number): number {
  const value = table[key];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ComboConfigError(`[limits] ${key} must be a non-negative integer`);
  }
  return parsed;
}

function pickNonEmptyString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ComboConfigError(`${description} must be a non-empty string`);
  }
  return value;
}

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
  let coderRespondingTable: TomlTable = { ...DEFAULTS.coder_responding };
  let reviewerTemplates: Record<string, { command?: string }> = { ...DEFAULT_REVIEWER_TEMPLATES };
  let reviewerProtocol = DEFAULT_REVIEWER_PROTOCOL;

  for (const layer of layers) {
    if (layer.table["roles"] !== undefined) {
      roles = mergeRoles(roles, layer.table["roles"], layer.source);
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
    for (const section of ["thread_sitter", "coder_responding"]) {
      if (layer.table[section] === undefined) continue;
      coderRespondingTable = {
        ...coderRespondingTable,
        ...asTable(layer.table[section], `[${section}] in ${layer.source}`),
      };
    }
    for (const section of ["gordon", "reviewer"]) {
      if (layer.table[section] === undefined) continue;
      const reviewerTable = asTable(layer.table[section], `[${section}] in ${layer.source}`);
      if (reviewerTable["protocol"] !== undefined) {
        reviewerProtocol = String(reviewerTable["protocol"]);
      }
      for (const [name, entry] of Object.entries(reviewerTable)) {
        if (name === "protocol") continue;
        reviewerTemplates = {
          ...reviewerTemplates,
          [name]: { ...reviewerTemplates[name], ...asTable(entry, `[${section}.${name}] in ${layer.source}`) },
        };
      }
    }
  }

  const env = options.env ?? {};
  const gatekeeperAttachTimeout =
    env["COMBO_CHEN_GATEKEEPER_ATTACH_TIMEOUT_SECONDS"] ??
    env["COMBO_CHEN_HODOR_ATTACH_TIMEOUT_SECONDS"];
  if (gatekeeperAttachTimeout !== undefined) {
    gatekeeperTable["attach_timeout_seconds"] = gatekeeperAttachTimeout;
  }
  const gatekeeperAttachRetryInterval =
    env["COMBO_CHEN_GATEKEEPER_ATTACH_RETRY_INTERVAL_SECONDS"] ??
    env["COMBO_CHEN_HODOR_ATTACH_RETRY_INTERVAL_SECONDS"];
  if (gatekeeperAttachRetryInterval !== undefined) {
    gatekeeperTable["attach_retry_interval_seconds"] = gatekeeperAttachRetryInterval;
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
    coderTemplates[roles.coder]?.command,
    `command template for coder "${roles.coder}"`,
  );
  const coderResumeCommand = pickNonEmptyString(
    coderTemplates[roles.coder]?.resume_command,
    `resume command template for coder "${roles.coder}"`,
  );

  const reviewerAgent = roles.reviewer.find((agent) => reviewerTemplates[agent]?.command);
  const reviewerCommand = reviewerAgent === undefined ? undefined : reviewerTemplates[reviewerAgent]?.command;
  if (!reviewerAgent || !reviewerCommand) {
    throw new ComboConfigError(
      `No command template for reviewer (formerly gordon) ${roles.reviewer.map((agent) => `"${agent}"`).join(", ")}. ` +
        `Add [reviewer."<name>"] command = "..." to your config.`,
    );
  }

  return {
    roles,
    limits: {
      babysitPollSeconds: pickNumber(limitsTable, "babysit_poll_seconds", DEFAULTS.limits.babysit_poll_seconds),
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
    },
    coderCommand,
    coderResumeCommand,
    gatekeeperCommand: String(gatekeeperTable["command"]),
    gatekeeperAttachTimeoutSeconds: pickNumber(
      gatekeeperTable,
      "attach_timeout_seconds",
      DEFAULTS.gatekeeper.attach_timeout_seconds,
      "[gatekeeper]",
    ),
    gatekeeperAttachRetryIntervalSeconds: pickNumber(
      gatekeeperTable,
      "attach_retry_interval_seconds",
      DEFAULTS.gatekeeper.attach_retry_interval_seconds,
      "[gatekeeper]",
    ),
    reviewNudgePrompt: String(coderRespondingTable["review_nudge_prompt"]),
    coderRespondingWindowName: String(coderRespondingTable["window_name"]),
    coderRespondingWatchWindowName: String(coderRespondingTable["watch_window_name"]),
    reviewerAgent,
    reviewerCommand,
    reviewerProtocol,
  };
}

const PLACEHOLDER = /\{([a-z_]+)\}/g;

/**
 * Each value is substituted as one single-quoted POSIX shell token, so
 * templates must not add their own quotes around {placeholders}.
 */
export function renderCommand(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      throw new ComboConfigError(`Unknown placeholder {${name}} in command template`);
    }
    return shellQuote(value);
  });
}
