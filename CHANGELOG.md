# Changelog

## [0.0.3](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.2...combo-chen-v0.0.3) (2026-06-11)


### Features

* **rower:** Implemented and validated rower_done persistence of the Codex implementer thread id as a combo run artifact. ([1a73336](https://github.com/thellmwhisperer/combo-chen/commit/1a73336bf8d4694e977aef3fc41989d6688406d8))
* **thread-sitter:** Implemented the first idempotent thread-sitter nudger slice that routes read-only PR comment signals into exactly-once tmux nudges and journaled `review_comment` events. ([e5d842f](https://github.com/thellmwhisperer/combo-chen/commit/e5d842f5e92adf642d5ae4ef0abab33af9bdbe55))
* **thread-sitter:** Wired issue [#10](https://github.com/thellmwhisperer/combo-chen/issues/10)’s nudger into the post-PR runner path so the resumed thread-sitter and comment watcher start automatically after `pr_opened`. ([64a411a](https://github.com/thellmwhisperer/combo-chen/commit/64a411a2a577cf5cb3322d04830c044f194c34d1))
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
