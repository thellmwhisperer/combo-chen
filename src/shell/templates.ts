/**
 * @overview Shell template loader. All generated shell lives in ./templates/*.sh;
 *   TS code renders placeholders, never embeds shell as string literals.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at renderShellTemplate  <- placeholder substitution + unresolved check.
 *   2. Then shellTemplate            <- raw template lookup (bundled or from disk).
 *   3. AXI_STATUS_LIB_PLACEHOLDER    <- canonical axi-status parser partial, auto-resolved.
 *
 *   MAIN FLOW
 *   ---------
 *   builder (core/cli) -> renderShellTemplate(name, values) -> script text
 *   build time: tsdown define inlines every template into dist/cli.mjs
 *
 *   PUBLIC API
 *   ----------
 *   shellTemplate              Raw template content by name.
 *   renderShellTemplate        Rendered template with all placeholders substituted.
 *   guardNoMistakesDaemonStart Wrap a daemon-starting command in the double-start guard.
 *
 *   INTERNALS
 *   ---------
 *   bundledTemplates, templateFromDisk, AXI_STATUS_LIB_PLACEHOLDER, DAEMON_START_PREFIX
 *
 * @exports shellTemplate, renderShellTemplate, guardNoMistakesDaemonStart
 * @deps node:fs
 */
import { readFileSync } from "node:fs";

declare const __COMBO_CHEN_SHELL_TEMPLATES__: Record<string, string> | undefined;

// -- 1/2 HELPER · template lookup --
//    Build define keeps dist/cli.mjs self-contained; source/test runs read
//    the sibling templates directory.
function bundledTemplates(): Record<string, string> | undefined {
  return typeof __COMBO_CHEN_SHELL_TEMPLATES__ === "undefined" ? undefined : __COMBO_CHEN_SHELL_TEMPLATES__;
}

function templateFromDisk(name: string): string {
  return readFileSync(new URL(`./templates/${name}.sh`, import.meta.url), "utf8");
}

export function shellTemplate(name: string): string {
  const bundled = bundledTemplates();
  if (bundled !== undefined) {
    const content = bundled[name];
    if (content === undefined) throw new Error(`shell template not bundled: ${name}`);
    return content;
  }
  return templateFromDisk(name);
}
// -/ 1/2

// -- 2/2 CORE · renderShellTemplate <- START HERE --
//    The canonical axi-status parser partial is resolved automatically so
//    every consumer shares the exact same field parsing (see issue #281).
const AXI_STATUS_LIB_PLACEHOLDER = "__AXI_STATUS_LIB__";

export function renderShellTemplate(name: string, values: Record<string, string> = {}): string {
  let rendered = shellTemplate(name);
  if (rendered.includes(AXI_STATUS_LIB_PLACEHOLDER)) {
    rendered = rendered.split(AXI_STATUS_LIB_PLACEHOLDER).join(shellTemplate("axi-status-lib").trimEnd());
  }
  // Single pass over the template text: substituted values are never
  // re-scanned, so a value containing placeholder-shaped text cannot be
  // double-substituted (it fails the unresolved check below instead).
  rendered = rendered.replace(/__[A-Z0-9_]+__/g, (token) => values[token] ?? token);
  const unresolved = rendered.match(/__[A-Z0-9_]+__/);
  if (unresolved !== null) {
    throw new Error(`shell template placeholder not rendered: ${name}: ${unresolved[0]}`);
  }
  return rendered;
}

const DAEMON_START_PREFIX = "no-mistakes daemon start && ";

export function guardNoMistakesDaemonStart(gatekeeperCommand: string): string {
  if (!gatekeeperCommand.startsWith(DAEMON_START_PREFIX)) return gatekeeperCommand;
  const remainder = gatekeeperCommand.slice(DAEMON_START_PREFIX.length);
  return renderShellTemplate("daemon-start-guard", { __GUARDED_COMMAND__: remainder }).trimEnd();
}
// -/ 2/2
