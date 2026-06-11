# Changelog

## [0.0.8](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.7...combo-chen-v0.0.8) (2026-06-11)


### Bug Fixes

* **hodor:** Implemented the first issue [#8](https://github.com/thellmwhisperer/combo-chen/issues/8) slice by making the stock generated hodor command pre-push to the no-mistakes gate before `axi run`. ([177e638](https://github.com/thellmwhisperer/combo-chen/commit/177e638889e674a9c686c5dd11c25ac5fc059661))

## [0.0.7](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.6...combo-chen-v0.0.7) (2026-06-11)


### Features

* **attach:** Implemented and verified the remaining issue [#3](https://github.com/thellmwhisperer/combo-chen/issues/3) attach command scope, completing the tmux layout/attach acceptance criteria. ([140ec85](https://github.com/thellmwhisperer/combo-chen/commit/140ec857c52461f408424ae140c1b4bea8662032))
* **tmux:** Implemented the first issue [#3](https://github.com/thellmwhisperer/combo-chen/issues/3) slice: `combo-chen run` now creates a one-window rower layout with a 12-line journal pane and focused main pane. ([30c5d54](https://github.com/thellmwhisperer/combo-chen/commit/30c5d54f49ba5bde0e99397fe5ab2b4260a5ae4b))


### Bug Fixes

* **tmux:** keep journal pane focus stable ([3c29063](https://github.com/thellmwhisperer/combo-chen/commit/3c290637ce9f13514c6ef451f7662e6880a0ba09))

## [0.0.6](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.5...combo-chen-v0.0.6) (2026-06-11)


### Features

* **core:** log rower output and enrich failure events with commit evidence ([4a7fd74](https://github.com/thellmwhisperer/combo-chen/commit/4a7fd74500d1b155c5c05d96aecf91d24019fc4e))


### Bug Fixes

* **runner:** Implemented issue [#5](https://github.com/thellmwhisperer/combo-chen/issues/5) AC3 by enriching `rower_failed` journal events with branch-vs-base commit evidence and verified the full suite is green. ([d9e7f25](https://github.com/thellmwhisperer/combo-chen/commit/d9e7f25747c3cb8958ef3894f9f0f462c9e9e937))
* **runner:** Implemented the issue [#5](https://github.com/thellmwhisperer/combo-chen/issues/5) AC1 slice by redirecting the generated runner’s rower stdout/stderr to `rower.log` and pinning it with a red-first test. ([7bf0214](https://github.com/thellmwhisperer/combo-chen/commit/7bf0214f3a1ae9e3a3117819fc210f8477d1f8da))

## [0.0.5](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.4...combo-chen-v0.0.5) (2026-06-11)


### Bug Fixes

* **release-please:** parse pr number in shell, not env fromJSON ([073e308](https://github.com/thellmwhisperer/combo-chen/commit/073e3080d67cb2c2ead971e330c3132a8aac5836))
* **release-please:** parse pr number in shell, not env fromJSON ([3379535](https://github.com/thellmwhisperer/combo-chen/commit/3379535cf648511b049eb114861bb6d398fdef64))

## [0.0.4](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.3...combo-chen-v0.0.4) (2026-06-11)


### Features

* **judge:** Added a one-shot judge hard-signal tick that detects stale pinned LGTMs from the PR head SHA and starts an incremental gordon re-review. ([3863782](https://github.com/thellmwhisperer/combo-chen/commit/38637821def66e5f16a9d3ed60664b496d5677f2))
* **judge:** Added the explicit judge activation slice: `combo-chen activate-judge` now opens a configured `gordon` tmux window from the recorded `pr_opened` PR URL. ([615f0ec](https://github.com/thellmwhisperer/combo-chen/commit/615f0ecc159294c5e00f2245511149bc76c95b12))
* **judge:** Added the judge command/protocol contract foundation for issue [#9](https://github.com/thellmwhisperer/combo-chen/issues/9), with tests and full validation green. ([7fd1341](https://github.com/thellmwhisperer/combo-chen/commit/7fd13417c2a093ce4f563511fe8aff8a6e9090b4))
* **judge:** Added the judge hard-signal watcher so `activate-judge` now starts continuous `judge-tick` polling alongside the initial gordon review window. ([150b4c2](https://github.com/thellmwhisperer/combo-chen/commit/150b4c2e3aee37f8757e7af1fffbf83d1f9db637))
* **judge:** Automatically activated the judge loop from the generated runner immediately after `pr_opened`, completing the issue [#9](https://github.com/thellmwhisperer/combo-chen/issues/9) orchestration path with the full suite green. ([7e2a225](https://github.com/thellmwhisperer/combo-chen/commit/7e2a225aad389577e7b27a3980634027f120e567))
* **judge:** gordon judge loop with activate-judge, judge-tick polling, incremental re-review, and merge/close detection ([e08d60e](https://github.com/thellmwhisperer/combo-chen/commit/e08d60e3c569e6e1d9a44d59428891f0e8d210a2))


### Bug Fixes

* **judge:** derive lgtm pins from GitHub ([299c1cb](https://github.com/thellmwhisperer/combo-chen/commit/299c1cb2495c9c8cac7966a3c0d948ba07a4de94))
* **judge:** Implemented the terminal PR hard-signal slice for the judge tick and validated the full suite green. ([88786ec](https://github.com/thellmwhisperer/combo-chen/commit/88786ec7a6eaed03b7f424aaac96d824b5770c1b))
* **judge:** normalize short lgtm pins ([b558115](https://github.com/thellmwhisperer/combo-chen/commit/b5581159a35f53f4ee6daf5408c8c3bfa6168716))
* **release-please:** Implemented the three requested Gordon review fixes in `.github/workflows/release-please.yml` and verified them with local typecheck and tests. ([095101a](https://github.com/thellmwhisperer/combo-chen/commit/095101a82ea34c0b2959eb2b73aa87950548b198))
* **release-please:** validate token, approve before auto-merge ([917f896](https://github.com/thellmwhisperer/combo-chen/commit/917f89619205e0a05f67760be6ef4c263225aad1))

## [Unreleased]

### Features

* **attach:** `combo-chen attach` command for attaching to a running combo's tmux session, with auto-resolution when only one combo is running and journal pane recreation on attach.
* **cli:** journal pane in rower window replaces the separate watch window; cleanup on failure.
* **hodor:** gate pre-push to `no-mistakes` remote before pipeline ([#8](https://github.com/thellmwhisperer/combo-chen/issues/8))
* **hodor:** `hodor_status` event journals hodor lifecycle (fix_inflight, awaiting_approval, failed, idle) with head_sha ([#24](https://github.com/thellmwhisperer/combo-chen/issues/24))
* **hodor:** hodor output captured to `hodor.log`; runner detects `outcome: awaiting_approval` and emits `needs_human reason=gate_waiting` ([#24](https://github.com/thellmwhisperer/combo-chen/issues/24))
* **hodor:** hodor tmux watcher window with retry loop attaches to the active no-mistakes run ([#24](https://github.com/thellmwhisperer/combo-chen/issues/24))
* **judge:** gordon judge loop (activate-judge, judge-tick), incremental re-review on LGTM staleness, and merge/close detection

## [0.0.3](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.2...combo-chen-v0.0.3) (2026-06-11)


### Features

* **rower:** Implemented and validated rower_done persistence of the Codex implementer thread id as a combo run artifact. ([1a73336](https://github.com/thellmwhisperer/combo-chen/commit/1a73336bf8d4694e977aef3fc41989d6688406d8))
* **thread-sitter:** Implemented the first idempotent thread-sitter nudger slice that routes read-only PR comment signals into exactly-once tmux nudges and journaled `review_comment` events. ([e5d842f](https://github.com/thellmwhisperer/combo-chen/commit/e5d842f5e92adf642d5ae4ef0abab33af9bdbe55))
* **thread-sitter:** Wired issue [#10](https://github.com/thellmwhisperer/combo-chen/issues/10)'s nudger into the post-PR runner path so the resumed thread-sitter and comment watcher start automatically after `pr_opened`. ([64a411a](https://github.com/thellmwhisperer/combo-chen/commit/64a411a2a577cf5cb3322d04830c044f194c34d1))
* **tmux:** Implemented and validated the issue [#10](https://github.com/thellmwhisperer/combo-chen/issues/10) tmux nudge delivery contract for sending a thread-sitter prompt followed by a separate bare Enter. ([878cdeb](https://github.com/thellmwhisperer/combo-chen/commit/878cdeb53092b43d293044d9ae5ec7a2589eb497))


### Bug Fixes

* **thread-sitter:** configure sitter windows ([a1535ad](https://github.com/thellmwhisperer/combo-chen/commit/a1535adb0620295fdd4fe7c7091c287d725ff97f))
* **thread-sitter:** harden activation edge cases ([e4e7dd4](https://github.com/thellmwhisperer/combo-chen/commit/e4e7dd43c6cc474b68793c6a76639da4153580d5))
* **thread-sitter:** make nudges configurable ([cdf15b6](https://github.com/thellmwhisperer/combo-chen/commit/cdf15b65e977914a9acb7a6ef124fe40f4e56e7f))

## [0.0.2](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.1...combo-chen-v0.0.2) (2026-06-10)


### Features

* **cli:** run, status, stop, events (+ hidden emit for the runner) ([2494de1](https://github.com/thellmwhisperer/combo-chen/commit/2494de1004d75de1a9187d5254b387df4bb9c946))
* combo-chen v0 (run, status, stop, events) ([60fc324](https://github.com/thellmwhisperer/combo-chen/commit/60fc324dbae70ce24184a55fa6716159b2413115))
* **core:** events journal, run state, phase derivation, runner script ([aae3d65](https://github.com/thellmwhisperer/combo-chen/commit/aae3d6569c21376045760e890af8566bc2eb2b94))
* **events:** extend post-PR event vocabulary with emit, journal, and follow ([bf9bf04](https://github.com/thellmwhisperer/combo-chen/commit/bf9bf0464a9d8be27e5bcd49cd6ba11f62e9acc9))
* **events:** Implemented issue [#7](https://github.com/thellmwhisperer/combo-chen/issues/7) by extending the post-PR event vocabulary and pinning emit/journal/follow behavior with tests. ([6aa3b70](https://github.com/thellmwhisperer/combo-chen/commit/6aa3b70cb48b72b65d73b80a10409df7ade346df))
* **infra,roles:** config cascade, tmux plumbing, rower and hodor adapters ([ca88f7b](https://github.com/thellmwhisperer/combo-chen/commit/ca88f7b018ca60b4c6e73d28591975905afd5660))


### Bug Fixes

* **review-2:** literal value substitution, exact origin match, run rollback, config and schema hardening ([82f3fee](https://github.com/thellmwhisperer/combo-chen/commit/82f3fee9a6856998d7225f9e8e290a2b034aeeac))
* **review-3:** delete the fresh branch on run rollback so retry is idempotent ([f23764a](https://github.com/thellmwhisperer/combo-chen/commit/f23764ad94b4b17d1444aec53ca425601928846e))
* **review:** address gordon and rabbit findings ([5378d97](https://github.com/thellmwhisperer/combo-chen/commit/5378d971b8f20a83eca0bedc7ecfbfefc2d19656))
