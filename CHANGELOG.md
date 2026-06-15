# Changelog

## [0.0.26](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.25...combo-chen-v0.0.26) (2026-06-15)


### Bug Fixes

* **cli:** harden LGTM pin extraction to exclude quoted, code-fixture, and invalid short/inline pins ([9da607e](https://github.com/thellmwhisperer/combo-chen/commit/9da607ea05379e5539300e8fd1a217bd02ec488f))

## [0.0.25](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.24...combo-chen-v0.0.25) (2026-06-15)


### Features

* **cli:** add reconcile command to repair frozen merged journals ([260265f](https://github.com/thellmwhisperer/combo-chen/commit/260265ff2e24ebdd4d1a0e0fe4c1c435182b4fe2))

## [0.0.24](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.23...combo-chen-v0.0.24) (2026-06-15)


### Features

* **core:** fetch and rebase origin/main before coder startup ([07047f2](https://github.com/thellmwhisperer/combo-chen/commit/07047f2be314c7c7515499a3e9d00cd261e9d701))


### Bug Fixes

* **runner:** Implemented issue [#61](https://github.com/thellmwhisperer/combo-chen/issues/61) by making runner.sh fetch and rebase origin/main before coder startup, aborting with a rebase_conflict journal event on failure, with full validation green. ([b1e8296](https://github.com/thellmwhisperer/combo-chen/commit/b1e829661073e58a3468d91e31e5c265e155a17e))

## [0.0.23](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.22...combo-chen-v0.0.23) (2026-06-15)


### Bug Fixes

* **cli:** harden director pipeline with shared PR URL parser, per-tick gh api cache, and direct-run fix ([d96c271](https://github.com/thellmwhisperer/combo-chen/commit/d96c2719ca71358da18cb7815cae23d930809924))
* **cli:** Implemented and validated the remaining direct-run robustness fix by switching CLI entrypoint URL comparison to `pathToFileURL(argv1)`. ([a806268](https://github.com/thellmwhisperer/combo-chen/commit/a806268caddc245ccb30ec30209025af97f00181))
* **github:** Added a per-director-tick GitHub API cache and shared `gh api` failure classifier so overlapping PR endpoint reads are reused within a director pass. ([85904b0](https://github.com/thellmwhisperer/combo-chen/commit/85904b0d6ca146cb5247cf61e6c89df1cfdf9b9d))

## [0.0.22](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.21...combo-chen-v0.0.22) (2026-06-15)


### Features

* centralize post-pr director loop ([a221d37](https://github.com/thellmwhisperer/combo-chen/commit/a221d37af5dba68d9acc4a637887c0b13c37db24))
* **cli:** centralize post-PR director observation loop ([e279bf3](https://github.com/thellmwhisperer/combo-chen/commit/e279bf3cb4375a7dd7c492507a2605d65a87f6f2))


### Bug Fixes

* **gatekeeper:** follow explicit no-mistakes run ([db0517c](https://github.com/thellmwhisperer/combo-chen/commit/db0517c7f178950abf0c6eede4ce87f72e15428a))
* ignore non-actionable review artifacts ([dd884e2](https://github.com/thellmwhisperer/combo-chen/commit/dd884e2e0ccaea95700960459782f9b7db159764))
* lease post-address mirror publish ([7eca93a](https://github.com/thellmwhisperer/combo-chen/commit/7eca93a0ca2397a6522ee5208af3def5520cb164))
* port director loop to split cli ([a50a86e](https://github.com/thellmwhisperer/combo-chen/commit/a50a86ea87e3461cd549fa3227fca4d3395cc6bb))
* propagate no-mistakes config artifacts ([5f82375](https://github.com/thellmwhisperer/combo-chen/commit/5f82375fd695b589d9c139fe918a34cd6690e914))
* reconcile director watcher with main ([da09039](https://github.com/thellmwhisperer/combo-chen/commit/da090394cedfae415fbefcce4879714ffe655ff8))
* wire ready-for-merge signal ([16939e2](https://github.com/thellmwhisperer/combo-chen/commit/16939e23260dc28bd1420cc1800bed72ecf11b7f))

## [0.0.21](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.20...combo-chen-v0.0.21) (2026-06-15)


### Bug Fixes

* **watcher:** back off on transient reviewer ticks ([e2276b8](https://github.com/thellmwhisperer/combo-chen/commit/e2276b8b004e2273d5eef82f98e37d7e3471ec61))
* **watcher:** Implemented the reviewer-watch retry loop for issue [#56](https://github.com/thellmwhisperer/combo-chen/issues/56) with visible journal events and full validation green. ([bc49f65](https://github.com/thellmwhisperer/combo-chen/commit/bc49f65cb1c1d1d0a106b01b6ec0a10fd842734c))

## [0.0.20](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.19...combo-chen-v0.0.20) (2026-06-15)


### Features

* add sherpa navigable comment standard with CLI and audit ([5acb93b](https://github.com/thellmwhisperer/combo-chen/commit/5acb93b93febdfa400474236f98de30c8c9aedef))
* Sherpa navigable comment standard + CLI (pilot) ([94e7fb0](https://github.com/thellmwhisperer/combo-chen/commit/94e7fb084f0e44e2f86dfc557ba4a6d5bae4d134))
* Sherpa navigable comment standard applied to entire codebase ([dba6f45](https://github.com/thellmwhisperer/combo-chen/commit/dba6f451afaaa2ec3877c1c256e49035441bb157))


### Bug Fixes

* address PR [#78](https://github.com/thellmwhisperer/combo-chen/issues/78) review comments ([1660c5a](https://github.com/thellmwhisperer/combo-chen/commit/1660c5a64aab774da89d110c3c752f400feb4dc4))
* normalize all markers to SPEC contract ([03af256](https://github.com/thellmwhisperer/combo-chen/commit/03af25628363c1fcbe5e87c30c349e1314d5be3b))
* normalize markers to SPEC format, add missing test markers ([b0e57dd](https://github.com/thellmwhisperer/combo-chen/commit/b0e57ddd2d3c3dec153b43fec94e6a9c6cfcfb4d))

## [0.0.19](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.18...combo-chen-v0.0.19) (2026-06-13)


### Features

* **cli:** Renamed the hidden CLI activation surface and generated runner invocations from thread-sitter/judge commands to coder/reviewer commands. ([e49b1b3](https://github.com/thellmwhisperer/combo-chen/commit/e49b1b34dc606ce58b082e054d9f495fc9fdd1e0))
* **config:** accept OSS role aliases ([a3dc0d4](https://github.com/thellmwhisperer/combo-chen/commit/a3dc0d41f72c9913a7005fe6f0040b6af7bb69d3))
* **config:** Updated the shipped config example to OSS-friendly role names and pinned it with tests while adding canonical `[coder_responding]` config support. ([d742a6b](https://github.com/thellmwhisperer/combo-chen/commit/d742a6b0e76241c63b0d03ee2a9219894017e115))
* **events:** Implemented and validated the journal-event rename slice for issue [#43](https://github.com/thellmwhisperer/combo-chen/issues/43), moving runner/status contracts to canonical coder/gate event names while preserving legacy readability. ([031787c](https://github.com/thellmwhisperer/combo-chen/commit/031787c6d18c19df2a4a4d58d9deb1bb5308fa2c))
* **roles:** Renamed the implementer role adapter surface from rower to coder and verified the new canonical coder thread artifact with legacy artifact fallback. ([e5cb456](https://github.com/thellmwhisperer/combo-chen/commit/e5cb4562e65845972dccd9825dac93821734e91f))


### Bug Fixes

* **config:** Removed deprecated rower/hodor/gordon keys from the returned config roles API while keeping legacy TOML role aliases readable and validating the full suite. ([54ef082](https://github.com/thellmwhisperer/combo-chen/commit/54ef0824c675a069ecf6709bfe48e70234c859d7))
* **config:** Renamed the public coder timeout config key/API from rower terminology to coder terminology while preserving legacy TOML compatibility. ([3e829d0](https://github.com/thellmwhisperer/combo-chen/commit/3e829d0c6acc0434d3ce5d53cfe0c073d07becbe))
* **config:** Renamed the remaining coder-responding window config result fields from threadSitter* to coderResponding* and validated the full suite green. ([96433bf](https://github.com/thellmwhisperer/combo-chen/commit/96433bffca75b2d7d2b6f607e94a100f19080370))
* **config:** Renamed the remaining gatekeeper config result API from deprecated `hodor*` fields to canonical `gatekeeper*` fields and validated the repo. ([5f2f574](https://github.com/thellmwhisperer/combo-chen/commit/5f2f574f785cba84c644f81d8690bf715ee0eef2))
* **review:** address role rename review comments ([60b42e1](https://github.com/thellmwhisperer/combo-chen/commit/60b42e1e8b36c1943c31a5d5f2ff8367b6547e81))
* **roles:** Renamed the next runtime role-label slice to OSS-friendly coder/gatekeeper/reviewer terminology and validated it with the full suite. ([777bac3](https://github.com/thellmwhisperer/combo-chen/commit/777bac35e1d397d0871e9465d3c95c4314c6c4f9))
* **runner:** Renamed the generated runner API from rower/hodor command fields to canonical coder/gatekeeper command fields and validated the full suite green. ([5bff8f8](https://github.com/thellmwhisperer/combo-chen/commit/5bff8f8470773087f358cbc08f3fe94de0c9f1be))
* **runner:** Renamed the generated runner's role log artifacts from rower/hodor to coder/gatekeeper and validated the slice end to end. ([b1b0d58](https://github.com/thellmwhisperer/combo-chen/commit/b1b0d58128a34e9598624259665fcb99fbad4618))

## [0.0.18](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.17...combo-chen-v0.0.18) (2026-06-12)


### Bug Fixes

* **hodor:** Implemented and verified the hodor tmux-window recovery path for issue [#62](https://github.com/thellmwhisperer/combo-chen/issues/62) so `hodor_started` recreates a missing visible attach watcher. ([24ea198](https://github.com/thellmwhisperer/combo-chen/commit/24ea198f4e955604614ff679516997631c05219a))
* **hodor:** recover tmux window on hodor_started and poll for active run before attach ([31f6328](https://github.com/thellmwhisperer/combo-chen/commit/31f63282ead6995fd74b379a981e2a2755ea9233))
* **hodor:** wait for active run before attach ([95dfd55](https://github.com/thellmwhisperer/combo-chen/commit/95dfd55c88e65de05a195e2e50261130d3bde6b9))

## [0.0.17](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.16...combo-chen-v0.0.17) (2026-06-12)


### Bug Fixes

* **hodor:** ensure PR body autocloses issue ([0726c7c](https://github.com/thellmwhisperer/combo-chen/commit/0726c7c429edfebe924c4aecebb514f65e9dbc1a))
* **hodor:** ensure PR body autocloses issue ([35e3751](https://github.com/thellmwhisperer/combo-chen/commit/35e375166f00eec1cf9f3189486d9d00a9d69f2b))
* **hodor:** reject hidden autoclose false positives ([f04066b](https://github.com/thellmwhisperer/combo-chen/commit/f04066bda3c5ea30816b38fb439a9af5763e55b7))

## [0.0.16](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.15...combo-chen-v0.0.16) (2026-06-12)


### Bug Fixes

* **hodor:** implement issue-derived autoclose contract and truncate intent at 8KB ([76255ec](https://github.com/thellmwhisperer/combo-chen/commit/76255ecb28cc896bb60e65c0542fc6563f461c97))
* **hodor:** Implemented the issue-derived GitHub autoclose contract for default combo PR generation and validated the full suite green. ([ef2d9d9](https://github.com/thellmwhisperer/combo-chen/commit/ef2d9d97b424c19fe70998f529a41a7d5a9d0e93))

## [0.0.15](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.14...combo-chen-v0.0.15) (2026-06-12)


### Bug Fixes

* **sitter:** defend mirror freshness against stale-reconciliation data loss ([21fc843](https://github.com/thellmwhisperer/combo-chen/commit/21fc8432fb470c0a866e60ee37242a9514f7d019))
* **sitter:** force-refresh origin mirror ref ([d406bac](https://github.com/thellmwhisperer/combo-chen/commit/d406bac803dba1c078a6847d2c345cc51793caf8))
* **sitter:** harden mirror sync after rebase ([c5c21d2](https://github.com/thellmwhisperer/combo-chen/commit/c5c21d2869464c89d2acb12e129d0e01a69252bf))
* **sitter:** Implemented issue [#40](https://github.com/thellmwhisperer/combo-chen/issues/40) by making the sitter watcher fast-forward a stale no-mistakes mirror from origin before each review-comment polling cycle, with full validation green. ([61bd0a2](https://github.com/thellmwhisperer/combo-chen/commit/61bd0a27927faa060700e959819c83406ec7143e))

## [0.0.14](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.13...combo-chen-v0.0.14) (2026-06-11)


### Bug Fixes

* **thread-sitter:** submit nudges via paste buffer ([facc89f](https://github.com/thellmwhisperer/combo-chen/commit/facc89f4359211ec860f0e39c9d50b587923173c))
* **thread-sitter:** submit nudges via paste buffer instead of send-keys ([e1846d9](https://github.com/thellmwhisperer/combo-chen/commit/e1846d9a57f96b0ad431c56efb14b2fbc04a6d01))

## [0.0.13](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.12...combo-chen-v0.0.13) (2026-06-11)


### Bug Fixes

* **judge-watch:** Fixed issue [#37](https://github.com/thellmwhisperer/combo-chen/issues/37) by making the generated gordon-watch script zsh-safe and validating it with tests plus a real tmux smoke run. ([ed18e91](https://github.com/thellmwhisperer/combo-chen/commit/ed18e91c008edf05307b0286a966b25d78baee02))
* **judge-watch:** use rc instead of status for exit code in generated gordon-watch script ([8204b6e](https://github.com/thellmwhisperer/combo-chen/commit/8204b6ee669c7a8d710bd8ddbd061f05ba4fdfd9))

## [0.0.12](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.11...combo-chen-v0.0.12) (2026-06-11)


### Bug Fixes

* **judge:** Fixed issue [#38](https://github.com/thellmwhisperer/combo-chen/issues/38) by preventing negated GitHub LGTM text from being journaled as a valid pinned LGTM, with full validation green. ([b4b9c54](https://github.com/thellmwhisperer/combo-chen/commit/b4b9c54c94705557dde48f3dc0854829878ab44a))
* **judge:** handle punctuated lgtm negation ([fcb65d6](https://github.com/thellmwhisperer/combo-chen/commit/fcb65d6f0e6e5bd85e9347372726f712bebfe2ff))
* **judge:** prevent negated LGTM comments from being journaled as valid pins ([72ff41a](https://github.com/thellmwhisperer/combo-chen/commit/72ff41a3ff2cd076cb7cb590cee72f638f2f48b1))

## [0.0.11](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.10...combo-chen-v0.0.11) (2026-06-11)


### Features

* **hodor:** Implemented the AC1 slice for issue [#12](https://github.com/thellmwhisperer/combo-chen/issues/12): hodor placeholders now render into runner.sh with safely quoted issue facts. ([9865786](https://github.com/thellmwhisperer/combo-chen/commit/98657864fdb32f7c3f7e29a46d9c97d4f01b0324))
* **hodor:** placeholder substitution in hodor commands with safe shell quoting ([a474e8b](https://github.com/thellmwhisperer/combo-chen/commit/a474e8bae87ac1ee61152bf6fb0785966a983a38))


### Bug Fixes

* **hodor:** Completed the final issue [#12](https://github.com/thellmwhisperer/combo-chen/issues/12) AC2 slice by preserving no-placeholder hodor commands byte-identically when they contain shell `${...}` variables, with the full suite green. ([12c9d7b](https://github.com/thellmwhisperer/combo-chen/commit/12c9d7bf436c892a1d87319890e9e9a1d6ce74ce))
* **hodor:** Implemented and validated the first issue [#12](https://github.com/thellmwhisperer/combo-chen/issues/12) slice: unknown hodor command placeholders now fail during runner generation instead of leaking into runner.sh. ([85c6521](https://github.com/thellmwhisperer/combo-chen/commit/85c6521581c98d30c0dbcd0fdacfb01d84e8e31c))

## [0.0.10](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.9...combo-chen-v0.0.10) (2026-06-11)


### Features

* **teardown:** auto-teardown combos on terminal PR states ([d1dcf57](https://github.com/thellmwhisperer/combo-chen/commit/d1dcf570fd0186be19b430850be542cb83317cd2))


### Bug Fixes

* **teardown:** harden terminal cleanup retry ([15c042d](https://github.com/thellmwhisperer/combo-chen/commit/15c042d6b89225e9c3cbf068dcbffc7b6b42b50e))
* **teardown:** Implemented and validated the merged-PR teardown path for issue [#11](https://github.com/thellmwhisperer/combo-chen/issues/11), completing the remaining acceptance criteria with the full suite green. ([a81c9d2](https://github.com/thellmwhisperer/combo-chen/commit/a81c9d24c2b2c658292401cb1408b521e04aaa4a))
* **teardown:** Implemented the closed-without-merge teardown slice for issue [#11](https://github.com/thellmwhisperer/combo-chen/issues/11) and validated it end to end. ([1ec466e](https://github.com/thellmwhisperer/combo-chen/commit/1ec466e8b76dec22f4bb4a5586c6e68874b37b2e))

## [0.0.9](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.8...combo-chen-v0.0.9) (2026-06-11)


### Features

* **events:** Added the first issue [#24](https://github.com/thellmwhisperer/combo-chen/issues/24) observability slice by making `hodor_status` a real journal event accepted through the CLI. ([5e554c8](https://github.com/thellmwhisperer/combo-chen/commit/5e554c89407e2f536a7c3c0a3e20a9789baa45bd))
* **hodor:** Added the issue [#24](https://github.com/thellmwhisperer/combo-chen/issues/24) hodor layout slice so new combo runs create a watchable hodor tmux window attached via no-mistakes’ active-run fallback. ([c87c7bb](https://github.com/thellmwhisperer/combo-chen/commit/c87c7bbaa71196daba992174c9a984e2a5579960))
* **hodor:** journal hodor_status events and detect axi approval gates ([afbd709](https://github.com/thellmwhisperer/combo-chen/commit/afbd70922aa1cba8a4ddf0e9a3e453349310eb8c))
* **runner:** Implemented the runner-side axi gate observability slice so `outcome: awaiting_approval` now journals `needs_human reason=gate_waiting` before PR detection. ([f17499f](https://github.com/thellmwhisperer/combo-chen/commit/f17499fb81b19c6797edd6e01b2ff6b1da1143d3))


### Bug Fixes

* **hodor:** Completed the final issue [#24](https://github.com/thellmwhisperer/combo-chen/issues/24) hodor status slice and validated that all acceptance criteria are now met with the full suite green. ([4914cab](https://github.com/thellmwhisperer/combo-chen/commit/4914cabeeedb9370d4d30b9bc1ec6d84070be7ea))
* **hodor:** configure attach retry loop ([403b9af](https://github.com/thellmwhisperer/combo-chen/commit/403b9afea966906322f6a250fa87988fe738890f))

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

* **reconcile:** Implemented the issue [#57](https://github.com/thellmwhisperer/combo-chen/issues/57) reconcile slice end-to-end: frozen merged journals can now be repaired with source-marked terminal events and teardown, with full validation green.
* **reconcile:** Hardened reconcile loop against loadConfig and killSession failures.
* **runner:** pre-coder fetch and rebase onto `origin/main` before coder startup, with `rebase_failed` (fetch failure) and `rebase_conflict` (merge conflict) journal events that transition the combo to STALLED ([#61](https://github.com/thellmwhisperer/combo-chen/issues/61))
* **sitter:** no-mistakes mirror freshness guard — the review-comment watcher fast-forwards a stale `no-mistakes` mirror from `origin` before each polling cycle, gated on the hodor `fix_inflight` semaphore ([#40](https://github.com/thellmwhisperer/combo-chen/issues/40))
* **attach:** `combo-chen attach` command for attaching to a running combo's tmux session, with auto-resolution when only one combo is running and journal pane recreation on attach.
* **cli:** journal pane in rower window replaces the separate watch window; cleanup on failure.
* **hodor:** gate pre-push to `no-mistakes` remote before pipeline ([#8](https://github.com/thellmwhisperer/combo-chen/issues/8))
* **hodor:** command templates with `{issue_url}`, `{issue_title}`, `{issue_body}`, `{branch}` placeholders ([#12](https://github.com/thellmwhisperer/combo-chen/issues/12))
* **hodor:** `hodor_status` event journals hodor lifecycle (fix_inflight, awaiting_approval, failed, idle) with head_sha ([#24](https://github.com/thellmwhisperer/combo-chen/issues/24))
* **hodor:** hodor output captured to `hodor.log`; runner detects `outcome: awaiting_approval` and emits `needs_human reason=gate_waiting` ([#24](https://github.com/thellmwhisperer/combo-chen/issues/24))
* **hodor:** hodor tmux watcher window with retry loop attaches to the active no-mistakes run ([#24](https://github.com/thellmwhisperer/combo-chen/issues/24))
* **judge:** gordon judge loop (activate-judge, judge-tick), incremental re-review on LGTM staleness, and merge/close detection
* **forensics:** read-only combo forensics CLI with markdown and JSON reporting over local journal data, live GitHub PR/issue enrichment, tmux session probing, and incident detection for gate/drift conditions ([#55](https://github.com/thellmwhisperer/combo-chen/issues/55))
* **watcher:** reviewer-watch retry loop with `watch_error`/`watch_dead` journal events, exponential backoff (doubling capped by configurable `[limits].watch_backoff_max_seconds`, default 3600 s), and configurable `[limits].watch_failure_limit` (default 5) for resilience against transient rate limits and network failures ([#56](https://github.com/thellmwhisperer/combo-chen/issues/56))

### Bug Fixes

* **lgtm:** harden LGTM pin extraction to require own-line verdicts with at least seven hex characters and filter out code fences, quoted text, indented code blocks, and inline code span fixtures ([#58](https://github.com/thellmwhisperer/combo-chen/issues/58))
* **hodor:** recreate missing hodor tmux window on `hodor_started` event so the live role window survives an early attach watcher exit ([#62](https://github.com/thellmwhisperer/combo-chen/issues/62))
* **thread-sitter:** replace send-keys with paste-buffer for nudge transport ([b9170eb](https://github.com/thellmwhisperer/combo-chen/commit/b9170eb4b231e58909712f921abcaf378f86cd12))

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
