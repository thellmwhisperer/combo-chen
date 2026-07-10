/**
 * @overview Runnable release-assets command wrapper around the producer contract.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at runReleaseAssetsCommand <- script/package entrypoint behavior.
 *   2. Then parseReleaseAssetsArgs      <- supported command-line flags.
 *   3. Helper functions read package metadata and normalize paths.
 *
 *   MAIN FLOW
 *   ---------
 *   argv + package.json -> producer options -> release tarballs + checksums.txt
 *
 *   PUBLIC API
 *   ----------
 *   runReleaseAssetsCommand   Produce release assets for the current package.
 *
 *   INTERNALS
 *   ---------
 *   parseReleaseAssetsArgs, packageVersion, resolveOutputDir.
 *
 * @exports RunReleaseAssetsCommandOptions, runReleaseAssetsCommand
 * @deps node:{fs,path}, ../update/index
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { produceReleaseAssets, type ProduceReleaseAssetsResult } from "../update/index.js";

// -- 1/3 HELPER · command data contracts --
interface ParsedReleaseAssetsArgs {
  outDir: string;
}

export interface RunReleaseAssetsCommandOptions {
  cwd: string;
  argv?: readonly string[];
  out?: (line: string) => void;
}

function resolveOutputDir(cwd: string, value: string | undefined): string {
  if (value === undefined || value.length === 0) return join(cwd, "dist", "release");
  return isAbsolute(value) ? value : join(cwd, value);
}
// -/ 1/3

// -- 2/3 HELPER · package metadata and argv parsing --
function packageVersion(cwd: string): string {
  const raw = readFileSync(join(cwd, "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("package.json must contain a non-empty version before producing release assets");
  }
  return parsed.version;
}

function parseReleaseAssetsArgs(cwd: string, argv: readonly string[]): ParsedReleaseAssetsArgs {
  let outDir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--out requires a directory");
      outDir = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown release-assets argument: ${arg}`);
  }
  return { outDir: resolveOutputDir(cwd, outDir) };
}
// -/ 2/3

// -- 3/3 CORE · runReleaseAssetsCommand <- START HERE --
export function runReleaseAssetsCommand(options: RunReleaseAssetsCommandOptions): ProduceReleaseAssetsResult {
  const args = parseReleaseAssetsArgs(options.cwd, options.argv ?? []);
  const result = produceReleaseAssets({
    repoDir: options.cwd,
    outDir: args.outDir,
    version: packageVersion(options.cwd),
  });
  options.out?.(`wrote ${result.assets.length} release assets to ${args.outDir}`);
  return result;
}
// -/ 3/3
