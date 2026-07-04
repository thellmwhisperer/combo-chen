/**
 * @overview tsdown build configuration for combo-chen CLI and release bundles.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at releaseDefines       <- version/commit/date values embedded in dist.
 *   2. Then default export           <- the actual tsdown bundle contract.
 *   3. Helpers are deterministic fallbacks for local and CI builds.
 *
 *   MAIN FLOW
 *   ---------
 *   package/git/env metadata -> releaseDefines -> tsdown define -> dist bundles
 *   src/core/runner-template.sh -> runnerTemplateDefine -> inlined into dist/cli.mjs
 *
 *   PUBLIC API
 *   ----------
 *   default   tsdown configuration.
 *
 *   INTERNALS
 *   ---------
 *   packageVersion, gitCommit, buildDate, sourceDateEpochIso, runnerTemplateDefine.
 *
 * @exports default
 * @deps tsdown, node:{child_process,fs}
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

// -- 1/2 HELPER · release metadata define values --
function packageVersion(): string {
  const raw = readFileSync(new URL("./package.json", import.meta.url), "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : "0.0.0-dev";
}

function gitCommit(): string {
  const envCommit = process.env["COMBO_CHEN_COMMIT"] ?? process.env["GITHUB_SHA"];
  if (envCommit !== undefined && envCommit.length > 0) return envCommit;

  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function sourceDateEpochIso(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return undefined;
  return new Date(seconds * 1000).toISOString();
}

function buildDate(): string {
  const explicit = process.env["COMBO_CHEN_BUILD_DATE"];
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return sourceDateEpochIso(process.env["SOURCE_DATE_EPOCH"]) ?? new Date().toISOString();
}

const releaseDefines = {
  __COMBO_CHEN_VERSION__: JSON.stringify(packageVersion()),
  __COMBO_CHEN_COMMIT__: JSON.stringify(gitCommit()),
  __COMBO_CHEN_BUILD_DATE__: JSON.stringify(buildDate()),
};

const runnerTemplateDefine = {
  __COMBO_CHEN_RUNNER_TEMPLATE__: JSON.stringify(
    readFileSync(new URL("./src/core/runner-template.sh", import.meta.url), "utf8"),
  ),
};
// -/ 1/2

// -- 2/2 CORE · tsdown config <- START HERE --
// Separate builds keep each dist entry single-file: a shared multi-entry build
// splits common modules into a chunk the release archive would have to ship.
export default defineConfig([
  {
    entry: { cli: "src/cli/main.ts" },
    format: "esm",
    outDir: "dist",
    clean: true,
    dts: false,
    define: { ...releaseDefines, ...runnerTemplateDefine },
    // Release archives run without node_modules; bundle runtime deps in.
    noExternal: () => true,
  },
  {
    entry: { "release-assets": "src/scripts/release-assets.ts" },
    format: "esm",
    outDir: "dist",
    clean: false,
    dts: false,
    define: releaseDefines,
  },
]);
// -/ 2/2
