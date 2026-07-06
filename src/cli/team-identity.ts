/**
 * @overview Production team identity resolvers. ~175 lines, resolves the
 *   effective tool identity surfaces that overture verifies before launch.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at resolveConfiguredTeamIdentity <- resolver entrypoint.
 *   2. Then noMistakesIdentity               <- gatekeeper config parser.
 *   3. Then directCommandIdentity            <- direct role command parser.
 *   4. Finish at small YAML helpers           <- narrow scalar/list parsing.
 *
 *   PUBLIC API
 *   ----------
 *   resolveConfiguredTeamIdentity  Production TeamIdentityResolver for default deps.
 *
 * @exports resolveConfiguredTeamIdentity
 * @deps node:{fs,path}, ../infra/config, ./overture
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { ComboConfig, ComboTeamIdentity, ComboTeamRole } from "../infra/config.js";
import type { TeamIdentityResolver } from "./overture.js";

// -- 1/1 CORE · production resolver <- START HERE --
const DEFAULT_CLAUDE_MODEL = "fable";
const DEFAULT_UNPINNED_MODEL = "default";
type DirectRole = Exclude<ComboTeamRole, "gatekeeper">;

export const resolveConfiguredTeamIdentity: TeamIdentityResolver = (role, input) => {
  if (role !== "gatekeeper") {
    const identity = directCommandIdentity(commandForRole(role, input.config));
    return identity === undefined ? undefined : { role, identity };
  }
  return {
    role,
    identity: noMistakesIdentity(input.env),
  };
};

function noMistakesIdentity(env: Record<string, string | undefined>): ComboTeamIdentity {
  const path = noMistakesConfigPath(env);
  if (!existsSync(path)) throw new Error(`no-mistakes config not found at ${path}`);
  const raw = readFileSync(path, "utf8");
  const agent = topLevelScalar(raw, "agent");
  if (agent === undefined) throw new Error(`no-mistakes config ${path} is missing agent`);
  if (agent === "auto") throw new Error("no-mistakes agent is auto; pin the effective agent before launch");
  return {
    binary: "no-mistakes",
    agent,
    model: noMistakesModel(raw, agent),
  };
}

function noMistakesConfigPath(env: Record<string, string | undefined>): string {
  const explicit = env.COMBO_CHEN_NO_MISTAKES_CONFIG ?? env.NO_MISTAKES_CONFIG;
  if (explicit !== undefined && explicit.trim() !== "") return explicit;
  const home = env.HOME ?? env.USERPROFILE;
  if (home === undefined || home.trim() === "") throw new Error("HOME unavailable for no-mistakes config lookup");
  return join(home, ".no-mistakes", "config.yaml");
}

function commandForRole(role: DirectRole, config: ComboConfig): string {
  if (role === "coder") return config.coderCommand;
  if (role === "reviewer") return config.reviewerCommand;
  return config.directorCommand;
}

function directCommandIdentity(command: string): ComboTeamIdentity | undefined {
  const binary = commandBinary(command);
  if (binary !== "claude") return undefined;
  return {
    binary,
    agent: "claude",
    model: modelFromCommand(command) ?? DEFAULT_CLAUDE_MODEL,
  };
}

function commandBinary(command: string): string | undefined {
  const token = /^\s*(?:"(?<double>[^"]+)"|'(?<single>[^']+)'|(?<bare>\S+))/.exec(command)?.groups;
  const binary = token?.["double"] ?? token?.["single"] ?? token?.["bare"];
  return binary === undefined ? undefined : nonEmpty(basename(binary));
}

function noMistakesModel(raw: string, agent: string): string {
  const argsModel = modelFromArgs(listValueFromNestedKey(raw, "agent_args_override", agent) ?? []);
  if (argsModel !== undefined) return argsModel;

  if (agent.startsWith("acp:")) {
    const override = scalarValueFromNestedKey(raw, "acp_registry_overrides", agent.slice("acp:".length));
    const acpModel = override === undefined ? undefined : modelFromCommand(override);
    if (acpModel !== undefined) return acpModel;
  }

  if (agent === "claude") return DEFAULT_CLAUDE_MODEL;
  return DEFAULT_UNPINNED_MODEL;
}

function modelFromArgs(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--model") return args[i + 1];
    if (arg.startsWith("--model=")) return nonEmpty(arg.slice("--model=".length));
  }
  return undefined;
}

function modelFromCommand(command: string): string | undefined {
  return (
    /(?:^|\s)--model=(?<model>"[^"]+"|'[^']+'|\S+)/.exec(command)?.groups?.["model"] ??
    /(?:^|\s)--model\s+(?<model>"[^"]+"|'[^']+'|\S+)/.exec(command)?.groups?.["model"]
  )?.replace(/^["']|["']$/g, "");
}

function topLevelScalar(raw: string, key: string): string | undefined {
  const prefix = `${key}:`;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(" ") || line.startsWith("\t")) continue;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (!trimmed.startsWith(prefix)) continue;
    return yamlScalar(trimmed.slice(prefix.length));
  }
  return undefined;
}

function listValueFromNestedKey(raw: string, section: string, key: string): string[] | undefined {
  const block = topLevelBlock(raw, section);
  if (block === undefined) return undefined;
  const keyPattern = new RegExp(`^(\\s*)${escapeRegExp(key)}:\\s*(.*)$`);
  for (let i = 0; i < block.length; i += 1) {
    const match = keyPattern.exec(block[i]!);
    if (match === null) continue;
    const indent = match[1]!.length;
    const inline = match[2]!.trim();
    if (inline.startsWith("[")) return yamlInlineList(inline);
    const values: string[] = [];
    for (let j = i + 1; j < block.length; j += 1) {
      const line = block[j]!;
      if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
      const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
      if (lineIndent <= indent) break;
      const item = /^\s*-\s*(.*)$/.exec(line)?.[1];
      const value = item === undefined ? undefined : yamlScalar(item);
      if (value !== undefined) values.push(value);
    }
    return values;
  }
  return undefined;
}

function scalarValueFromNestedKey(raw: string, section: string, key: string): string | undefined {
  const block = topLevelBlock(raw, section);
  if (block === undefined) return undefined;
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}:\\s*(.*)$`);
  for (const line of block) {
    const value = keyPattern.exec(line)?.[1];
    if (value !== undefined) return yamlScalar(value);
  }
  return undefined;
}

function topLevelBlock(raw: string, key: string): string[] | undefined {
  const lines = raw.split(/\r?\n/);
  const block: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (!inBlock) {
      if (line.trim() === `${key}:`) inBlock = true;
      continue;
    }
    if (!line.startsWith(" ") && !line.startsWith("\t") && line.trim() !== "" && !line.trimStart().startsWith("#")) {
      break;
    }
    block.push(line);
  }
  return inBlock ? block : undefined;
}

function yamlInlineList(raw: string): string[] {
  const body = raw.replace(/^\[/, "").replace(/\].*$/, "");
  return body.split(",").map(yamlScalar).filter((value): value is string => value !== undefined);
}

function yamlScalar(raw: string): string | undefined {
  const value = raw.replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
  return nonEmpty(value);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
// -/ 1/1
