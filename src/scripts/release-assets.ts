#!/usr/bin/env node
/**
 * @overview Node entrypoint for producing combo-chen release assets.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at main <- forwards process state to runReleaseAssetsCommand.
 *   2. Error handling is intentionally tiny so CI gets readable stderr.
 *
 *   MAIN FLOW
 *   ---------
 *   process argv/cwd -> runReleaseAssetsCommand -> stdout or non-zero exit
 *
 *   PUBLIC API
 *   ----------
 *   none (script entrypoint)
 *
 *   INTERNALS
 *   ---------
 *   main.
 *
 * @exports none
 * @deps ../infra/release-command
 */
import { runReleaseAssetsCommand } from "../infra/release-command.js";

// -- 1/1 CORE · main <- START HERE --
function main(): void {
  try {
    runReleaseAssetsCommand({
      cwd: process.cwd(),
      argv: process.argv.slice(2),
      out: (line) => process.stdout.write(`${line}\n`),
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

main();
// -/ 1/1
