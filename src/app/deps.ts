/**
 * @overview Shared application dependency contract used by CLI adapters and extracted handlers.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at AppDeps               <- complete injectable runtime boundary.
 *   2. Use narrow Pick<AppDeps, ...>  <- handlers should request only what they use.
 *
 *   MAIN FLOW
 *   ---------
 *   cli/defaultDeps -> AppDeps -> app handler -> injected adapter
 *
 *   PUBLIC API
 *   ----------
 *   AppDeps    Injectable process, git, GitHub, tmux, and update dependencies.
 *
 *   INTERNALS
 *   ---------
 *   None.
 *
 * @exports AppDeps
 * @deps ../infra/tmux, ../update/index, ./launch/overture, ./reporting/status
 */
import type { TeamIdentityResolver } from "./launch/overture.js";
import type { PassiveUpdateCliDeps, UpdateCommandDeps } from "../update/index.js";
import type { CommandResult } from "./reporting/status.js";
import type { TmuxResult } from "../infra/tmux.js";

// -- 1/1 CORE · AppDeps <- START HERE --
export interface AppDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  tmux: (args: string[]) => TmuxResult;
  git: (args: string[], cwd: string) => { status: number; stdout: string; stderr: string };
  treehouse: (args: string[], cwd: string) => { status: number; stdout: string; stderr: string };
  gh: UpdateCommandDeps["gh"];
  noMistakes: (args: string[], cwd: string, options?: { timeoutMs?: number }) => CommandResult;
  resolveTeamIdentity?: TeamIdentityResolver;
  sleep: (ms: number) => Promise<void>;
  issueExists: (issueUrl: string) => boolean;
  update?: Partial<UpdateCommandDeps>;
  passiveUpdate?: Partial<PassiveUpdateCliDeps>;
}
// -/ 1/1
