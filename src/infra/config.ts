/**
 * Config cascade: defaults ← user config ← repo config.
 * Repo wins on policy, user wins on local setup, nothing operational is
 * hardcoded beyond the in-code fallbacks defined here.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

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
  /** Command template for hodor's blocking gate run. */
  hodorCommand: string;
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
      command: 'npx -y gnhf --agent codex --current-branch "{prompt}"',
    },
  } as Record<string, { command?: string }>,
  hodor: {
    command: "no-mistakes axi run",
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
  let rowerTemplates: Record<string, { command?: string }> = { ...DEFAULTS.rower };
  let hodorCommand = DEFAULTS.hodor.command;

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

  return {
    roles,
    limits: {
      babysitPollSeconds: pickNumber(limitsTable, "babysit_poll_seconds", DEFAULTS.limits.babysit_poll_seconds),
      rowerTimeoutMinutes: pickNumber(limitsTable, "rower_timeout_minutes", DEFAULTS.limits.rower_timeout_minutes),
    },
    rowerCommand,
    hodorCommand,
  };
}

const PLACEHOLDER = /\{([a-z_]+)\}/g;

export function renderCommand(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      throw new ComboConfigError(`Unknown placeholder {${name}} in command template`);
    }
    return value;
  });
}
