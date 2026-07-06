/**
 * @overview Production team identity resolvers. ~330 lines, resolves the
 *   effective tool identity surfaces that overture verifies before launch.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at resolveConfiguredTeamIdentity <- resolver entrypoint.
 *   2. Then noMistakesIdentity               <- gatekeeper config parser.
 *   3. Then directCommandIdentity            <- direct/gnhf role command parser.
 *   4. Then codexIdentity                    <- Codex command/config model resolution.
 *   5. Then opencodeIdentity                 <- resolved opencode config.
 *   6. Finish at small YAML helpers           <- narrow scalar/list parsing.
 *
 *   PUBLIC API
 *   ----------
 *   resolveConfiguredTeamIdentity  Production TeamIdentityResolver for default deps.
 *
 * @exports resolveConfiguredTeamIdentity
 * @deps node:{child_process,fs,path}, smol-toml, ../core/guards, ../infra/config, ./overture
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseToml } from "smol-toml";

import { errorMessage, isRecord } from "../core/guards.js";
import { hasGnhfCommand, type ComboConfig, type ComboTeamIdentity, type ComboTeamRole } from "../infra/config.js";
import type { TeamIdentityResolver } from "./overture.js";

// -- 1/1 CORE · production resolver <- START HERE --
const DEFAULT_CLAUDE_MODEL = "fable";
const DEFAULT_UNPINNED_MODEL = "default";
const DEFAULT_TEAM_IDENTITY_TOOL_TIMEOUT_MS = 5000;
const DEFAULT_GNHF_AGENT = "claude";
type DirectRole = Exclude<ComboTeamRole, "gatekeeper">;

export const resolveConfiguredTeamIdentity: TeamIdentityResolver = (role, input) => {
  if (role !== "gatekeeper") {
    const identity = directCommandIdentity(commandForRole(role, input.config), input.repoDir, input.env);
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

function directCommandIdentity(
  command: string,
  repoDir: string,
  env: Record<string, string | undefined>,
): ComboTeamIdentity | undefined {
  const binary = commandBinary(command);
  if (hasGnhfCommand(command)) return gnhfIdentity(command, env);
  if (binary === "codex") return codexIdentity(command, env);
  if (binary === "opencode") return opencodeIdentity(command, repoDir, env);
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

function gnhfIdentity(command: string, env: Record<string, string | undefined>): ComboTeamIdentity | undefined {
  const config = readGnhfConfig(env);
  const agent = agentFromCommand(command) ?? (config === undefined ? undefined : topLevelScalar(config, "agent")) ?? DEFAULT_GNHF_AGENT;
  if (agent !== "codex") return undefined;
  const codexArgs = config === undefined ? [] : listValueFromNestedKey(config, "agentArgsOverride", "codex") ?? [];
  return {
    binary: commandBinary(command) ?? "gnhf",
    agent: "gnhf/codex",
    model: codexModelFromArgs(codexArgs, env),
  };
}

function readGnhfConfig(env: Record<string, string | undefined>): string | undefined {
  const path = gnhfConfigPath(env);
  if (path === undefined || !existsSync(path)) return undefined;
  return readFileSync(path, "utf8");
}

function gnhfConfigPath(env: Record<string, string | undefined>): string | undefined {
  const home = nonEmpty(env.HOME ?? env.USERPROFILE);
  return home === undefined ? undefined : join(home, ".gnhf", "config.yml");
}

function codexIdentity(command: string, env: Record<string, string | undefined>): ComboTeamIdentity {
  return {
    binary: "codex",
    agent: "codex",
    model: codexModelFromCommand(command, env),
  };
}

function codexModelFromCommand(command: string, env: Record<string, string | undefined>): string {
  return requireCodexModel(
    modelFromCommand(command) ??
      configModelFromCommand(command) ??
      codexModelFromConfig(env, profileFromCommand(command)),
  );
}

function codexModelFromArgs(args: string[], env: Record<string, string | undefined>): string {
  return requireCodexModel(
    modelFromArgs(args) ??
      configModelFromArgs(args) ??
      codexModelFromConfig(env, profileFromArgs(args)),
  );
}

function requireCodexModel(model: string | undefined): string {
  if (model === undefined) {
    throw new Error("codex config is missing model; pin the effective model before launch");
  }
  return model;
}

function codexModelFromConfig(env: Record<string, string | undefined>, profile: string | undefined): string | undefined {
  const home = codexHome(env);
  const baseModel = codexConfigModel(join(home, "config.toml"), false);
  const profileModel = profile === undefined ? undefined : codexConfigModel(join(home, `${profile}.config.toml`), true);
  return profileModel ?? baseModel;
}

function codexHome(env: Record<string, string | undefined>): string {
  const explicit = nonEmpty(env.CODEX_HOME);
  if (explicit !== undefined) return explicit;
  const home = nonEmpty(env.HOME ?? env.USERPROFILE);
  if (home === undefined) throw new Error("HOME unavailable for codex config lookup");
  return join(home, ".codex");
}

function codexConfigModel(path: string, required: boolean): string | undefined {
  if (!existsSync(path)) {
    if (required) throw new Error(`codex profile config not found at ${path}`);
    return undefined;
  }
  try {
    const parsed = parseToml(readFileSync(path, "utf8"));
    return isRecord(parsed) ? stringField(parsed, "model") : undefined;
  } catch (error) {
    throw new Error(`codex config ${path} is invalid TOML: ${errorMessage(error)}`);
  }
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

function opencodeIdentity(
  command: string,
  repoDir: string,
  env: Record<string, string | undefined>,
): ComboTeamIdentity {
  const model =
    modelFromCommand(command) ??
    opencodeModelFromConfig(opencodeResolvedConfig(repoDir, env), agentFromCommand(command));
  const normalizedModel = nonEmpty(model);
  if (normalizedModel === undefined) throw new Error("opencode resolved config is missing model");
  const parts = identityPartsFromModel(normalizedModel, "opencode");
  return {
    binary: "opencode",
    agent: parts.agent,
    model: parts.model,
  };
}

function opencodeResolvedConfig(repoDir: string, env: Record<string, string | undefined>): unknown {
  const result = spawnSync("opencode", ["debug", "config"], {
    cwd: repoDir,
    encoding: "utf8",
    env,
    timeout: teamIdentityToolTimeoutMs(env),
  });
  if (result.error !== undefined) {
    throw new Error(`opencode debug config failed: ${errorMessage(result.error)}`);
  }
  if ((result.status ?? 1) !== 0) {
    const detail = nonEmpty(result.stderr) ?? nonEmpty(result.stdout) ?? `exit ${result.status ?? "unknown"}`;
    throw new Error(`opencode debug config failed: ${detail}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`opencode debug config returned invalid JSON: ${errorMessage(error)}`);
  }
}

function teamIdentityToolTimeoutMs(env: Record<string, string | undefined>): number {
  const parsed = Number.parseInt(env.COMBO_CHEN_TEAM_IDENTITY_TOOL_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TEAM_IDENTITY_TOOL_TIMEOUT_MS;
}

function opencodeModelFromConfig(config: unknown, commandAgent: string | undefined): string | undefined {
  if (!isRecord(config)) return undefined;
  return opencodeAgentModel(config["agent"], commandAgent) ?? stringField(config, "model");
}

function opencodeAgentModel(agentConfig: unknown, commandAgent: string | undefined): string | undefined {
  if (commandAgent === undefined || !isRecord(agentConfig)) return undefined;
  const selectedAgent = agentConfig[commandAgent];
  return isRecord(selectedAgent) ? stringField(selectedAgent, "model") : undefined;
}

function identityPartsFromModel(model: string, defaultAgent: string): { agent: string; model: string } {
  const separator = model.indexOf("/");
  if (separator <= 0 || separator >= model.length - 1) return { agent: defaultAgent, model };
  return {
    agent: model.slice(0, separator),
    model: model.slice(separator + 1),
  };
}

function modelFromArgs(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--model" || arg === "-m") return nonEmpty(args[i + 1]);
    if (arg.startsWith("--model=")) return nonEmpty(arg.slice("--model=".length));
    if (arg.startsWith("-m=")) return nonEmpty(arg.slice("-m=".length));
  }
  return undefined;
}

function modelFromCommand(command: string): string | undefined {
  return flagValueFromCommand(command, "model") ?? shortFlagValueFromCommand(command, "m");
}

function agentFromCommand(command: string): string | undefined {
  return flagValueFromCommand(command, "agent");
}

function profileFromArgs(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--profile" || arg === "-p") return nonEmpty(args[i + 1]);
    if (arg.startsWith("--profile=")) return nonEmpty(arg.slice("--profile=".length));
    if (arg.startsWith("-p=")) return nonEmpty(arg.slice("-p=".length));
  }
  return undefined;
}

function profileFromCommand(command: string): string | undefined {
  return flagValueFromCommand(command, "profile") ?? shortFlagValueFromCommand(command, "p");
}

function configModelFromArgs(args: string[]): string | undefined {
  let model: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const value =
      arg === "--config" || arg === "-c"
        ? args[i + 1]
        : arg.startsWith("--config=")
          ? arg.slice("--config=".length)
          : arg.startsWith("-c=")
            ? arg.slice("-c=".length)
            : undefined;
    const parsed = value === undefined ? undefined : codexModelFromConfigOverride(value);
    if (parsed !== undefined) model = parsed;
  }
  return model;
}

function configModelFromCommand(command: string): string | undefined {
  return codexModelFromConfigOverride(flagValueFromCommand(command, "config") ?? "") ??
    codexModelFromConfigOverride(shortFlagValueFromCommand(command, "c") ?? "");
}

function codexModelFromConfigOverride(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("model")) return undefined;
  try {
    const parsed = parseToml(trimmed);
    return isRecord(parsed) ? stringField(parsed, "model") : undefined;
  } catch {
    const raw = /^model\s*=\s*(.*)$/.exec(trimmed)?.[1];
    return raw === undefined ? undefined : yamlScalar(raw);
  }
}

function flagValueFromCommand(command: string, flag: string): string | undefined {
  const escapedFlag = escapeRegExp(flag);
  return (
    new RegExp(`(?:^|\\s)--${escapedFlag}=(?<value>"[^"]+"|'[^']+'|\\S+)`).exec(command)?.groups?.["value"] ??
    new RegExp(`(?:^|\\s)--${escapedFlag}\\s+(?<value>"[^"]+"|'[^']+'|\\S+)`).exec(command)?.groups?.["value"]
  )?.replace(/^["']|["']$/g, "");
}

function shortFlagValueFromCommand(command: string, flag: string): string | undefined {
  const escapedFlag = escapeRegExp(flag);
  return (
    new RegExp(`(?:^|\\s)-${escapedFlag}=(?<value>"[^"]+"|'[^']+'|\\S+)`).exec(command)?.groups?.["value"] ??
    new RegExp(`(?:^|\\s)-${escapedFlag}\\s+(?<value>"[^"]+"|'[^']+'|\\S+)`).exec(command)?.groups?.["value"]
  )?.replace(/^["']|["']$/g, "");
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? nonEmpty(value) : undefined;
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
