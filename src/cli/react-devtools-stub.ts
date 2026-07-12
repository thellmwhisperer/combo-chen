/**
 * @overview Production release replacement for Ink's optional React DevTools
 *   peer. Ink conditionally imports react-devtools-core; with code splitting
 *   disabled that optional edge becomes a static bare import that fails at
 *   runtime in the single-file release archive. This no-op stub satisfies it.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at reactDevtoolsStub   <- the default export aliased by tsdown.
 *
 *   MAIN FLOW
 *   ---------
 *   tsdown.config alias -> react-devtools-core -> this stub (no-op)
 *
 *   PUBLIC API
 *   ----------
 *   reactDevtoolsStub   No-op adapter with initialize/connectToDevTools.
 *
 * @exports reactDevtoolsStub
 * @deps none
 */
// -- 1/1 CORE · no-op devtools stub --
const reactDevtoolsStub = {
  initialize(): void {},
  connectToDevTools(): void {},
};

export default reactDevtoolsStub;
// -/ 1/1
