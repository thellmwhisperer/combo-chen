/**
 * @overview POSIX shell quoting. ~10 lines, 1 export, no deps. Neutral home
 *   so command builders do not depend on the runner-script half of core/combo.
 *
 *   READING GUIDE
 *   -------------
 *   1. shellQuote is the whole module.
 *
 *   MAIN FLOW
 *   ---------
 *   command builders -> shellQuote(value) -> safely single-quoted argument
 *
 *   PUBLIC API
 *   ----------
 *   shellQuote  POSIX-safe single-quoting for paths, branch names, anything.
 *
 *   INTERNALS
 *   ---------
 *   none
 *
 * @exports shellQuote
 * @deps none
 */

// -- 1/1 CORE · shellQuote <- START HERE --
//    POSIX-safe single-quoting. Paths, branch names, anything.
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
// -/ 1/1
