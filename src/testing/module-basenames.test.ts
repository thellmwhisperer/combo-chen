/**
 * @overview Contract test that keeps TypeScript module basenames unique across src.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at the contract test       <- reports every colliding basename and path.
 *   2. Read sourceModules on demand     <- recursively discovers checked source files.
 *
 *   MAIN FLOW
 *   ---------
 *   src tree -> TypeScript paths -> basename groups -> duplicate-free expectation
 *
 *   PUBLIC API
 *   ----------
 *   none (test file)
 *
 *   INTERNALS
 *   ---------
 *   sourceModules.
 *
 * @exports none
 * @deps vitest, node:{fs,path,url}
 */
import { readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));

// -- 1/2 HELPER · sourceModules --
function sourceModules(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceModules(path);
    return entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) ? [path] : [];
  });
}
// -/ 1/2

// -- 2/2 CORE · unique module basename contract <- START HERE --
it("keeps module basenames unique across src", () => {
  const pathsByBasename = new Map<string, string[]>();
  for (const path of sourceModules(sourceRoot)) {
    const name = basename(path);
    pathsByBasename.set(name, [...(pathsByBasename.get(name) ?? []), path]);
  }
  const duplicates = Object.fromEntries(
    [...pathsByBasename]
      .filter(([, paths]) => paths.length > 1)
      .map(([name, paths]) => [name, paths.map((path) => relative(sourceRoot, path)).sort()]),
  );

  expect(duplicates).toEqual({});
});
// -/ 2/2
