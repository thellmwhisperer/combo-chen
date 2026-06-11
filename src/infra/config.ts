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
  rower: string;
  hodor: string;
  gordon: string[];
  merge: string;
}

export interface ComboLimits {
  babysitPollSeconds: number;
  rowerTimeoutMinutes: number;
}

export interface ComboConfig {
  roles: ComboRoles;
  limits: ComboLimits;
  /** Command template for the configured rower, with {placeholders}. */
  rowerCommand: string;
  /** Resume command template for the configured rower, with {thread_id}. */
  rowerResumeCommand: string;
  /** Command template for hodor's blocking gate run. */
  hodorCommand: string;
  /** Prompt template sent to the thread-sitter for each routed review signal. */
  reviewNudgePrompt: string;
  /** tmux window name for the resumed thread-sitter. */
  threadSitterWindowName: string;
  /** tmux window name for the review-comment watcher. */
  threadSitterWatchWindowName: string;
}

const ROLE_NAMES = new Set(["rower", "hodor", "gordon", "merge"]);

const DEFAULTS = {
  roles: {
    rower: "codex",
    hodor: "no-mistakes",
    gordon: ["claude", "coderabbit"],
    merge: "human",
  },
  limits: {
    babysit_poll_seconds: 120,
    rower_timeout_minutes: 180,
  },
  rower: {
    codex: {
      command: "npx -y gnhf --agent codex --current-branch {prompt}",
      resume_command: "codex resume {thread_id}",
    },
  } as Record<string, { command?: string; resume_command?: string }>,
  hodor: {
    command: "no-mistakes axi run",
  },
  thread_sitter: {
    window_name: "thread-sitter",
    watch_window_name: "thread-sitter-watch",
    review_nudge_prompt: [
      "New review comment for the thread-sitter:",
      "{url}",
      "",
      "Use the two-bucket contract: handle mechanical fixes autonomously with TDD, code, push, and PR replies; escalate intent-touching decisions with needs_human before changing code.",
      "Before pushing, check the hodor push semaphore.",
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
  const merged: ComboRoles = { ...base, gordon: [...base.gordon] };
  for (const [key, value] of Object.entries(table)) {
    if (!ROLE_NAMES.has(key)) {
      throw new ComboConfigError(
        `Unknown role "${key}" in ${source}. Known roles: ${[...ROLE_NAMES].join(", ")}`,
      );
    }
    if (key === "gordon") {
      merged.gordon = Array.isArray(value) ? value.map(String) : [String(value)];
    } else {
      (merged as unknown as Record<string, string>)[key] = String(value);
    }
  }
  return merged;
}

function pickNumber(table: TomlTable, key: string, fallback: number): number {
  const value = table[key];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ComboConfigError(`[limits] ${key} must be a positive number`);
  }
  return parsed;
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
    gordon: [...DEFAULTS.roles.gordon],
  };
  let limitsTable: TomlTable = { ...DEFAULTS.limits };
  let rowerTemplates: Record<string, { command?: string; resume_command?: string }> = {
    ...DEFAULTS.rower,
  };
  let hodorCommand = DEFAULTS.hodor.command;
  let threadSitterTable: TomlTable = { ...DEFAULTS.thread_sitter };

  for (const layer of layers) {
    if (layer.table["roles"] !== undefined) {
      roles = mergeRoles(roles, layer.table["roles"], layer.source);
    }
    if (layer.table["limits"] !== undefined) {
      limitsTable = { ...limitsTable, ...asTable(layer.table["limits"], `[limits] in ${layer.source}`) };
    }
    if (layer.table["rower"] !== undefined) {
      const rowerTable = asTable(layer.table["rower"], `[rower] in ${layer.source}`);
      for (const [name, entry] of Object.entries(rowerTable)) {
        rowerTemplates = {
          ...rowerTemplates,
          [name]: { ...rowerTemplates[name], ...asTable(entry, `[rower.${name}] in ${layer.source}`) },
        };
      }
    }
    if (layer.table["hodor"] !== undefined) {
      const hodorTable = asTable(layer.table["hodor"], `[hodor] in ${layer.source}`);
      if (hodorTable["command"] !== undefined) hodorCommand = String(hodorTable["command"]);
    }
    if (layer.table["thread_sitter"] !== undefined) {
      threadSitterTable = {
        ...threadSitterTable,
        ...asTable(layer.table["thread_sitter"], `[thread_sitter] in ${layer.source}`),
      };
    }
  }

  if (roles.gordon.length === 0) {
    throw new ComboConfigError(
      "gordon must name at least one judge: an empty gordon silently disables judgment.",
    );
  }

  if (roles.gordon.includes(roles.rower)) {
    throw new ComboConfigError(
      `gordon != rower: "${roles.rower}" cannot judge its own cooking. Pick a different gordon or rower.`,
    );
  }

  const rowerCommand = rowerTemplates[roles.rower]?.command;
  if (!rowerCommand) {
    throw new ComboConfigError(
      `No command template for rower "${roles.rower}". Add [rower."${roles.rower}"] command = "..." to your config.`,
    );
  }
  const rowerResumeCommand = rowerTemplates[roles.rower]?.resume_command;
  if (!rowerResumeCommand) {
    throw new ComboConfigError(
      `No resume command template for rower "${roles.rower}". Add [rower."${roles.rower}"] resume_command = "..." to your config.`,
    );
  }

  return {
    roles,
    limits: {
      babysitPollSeconds: pickNumber(limitsTable, "babysit_poll_seconds", DEFAULTS.limits.babysit_poll_seconds),
      rowerTimeoutMinutes: pickNumber(limitsTable, "rower_timeout_minutes", DEFAULTS.limits.rower_timeout_minutes),
    },
    rowerCommand,
    rowerResumeCommand,
    hodorCommand,
    reviewNudgePrompt: String(threadSitterTable["review_nudge_prompt"]),
    threadSitterWindowName: String(threadSitterTable["window_name"]),
    threadSitterWatchWindowName: String(threadSitterTable["watch_window_name"]),
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
