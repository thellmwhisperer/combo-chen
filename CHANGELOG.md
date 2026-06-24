# Changelog

## [0.0.61](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.60...combo-chen-v0.0.61) (2026-06-24)


### Features

* **forensics:** Added a copy-ready dogfood outcome block to forensics markdown so issue [#210](https://github.com/thellmwhisperer/combo-chen/issues/210)’s required PR/head/review-check/failure/follow-up fields can be recorded from the combo report. ([09388dd](https://github.com/thellmwhisperer/combo-chen/commit/09388ddcfc9e9e9288e16c8ae8fcb21a17643530))
* **forensics:** Added an explicit forensics outcome-recording path so a matched dogfood report can post its compact Outcome block to the source GitHub issue. ([7a04832](https://github.com/thellmwhisperer/combo-chen/commit/7a04832a50057f40ed246e92fc23e4068c1f6abe))
* **observability:** Added the next [#210](https://github.com/thellmwhisperer/combo-chen/issues/210) observability slice: launch now prints a human-readable topology summary, and a lifecycle integration test pins first-pass READY through closure without creating coder-responding. ([e5f863f](https://github.com/thellmwhisperer/combo-chen/commit/e5f863fb206499c439572a15d85ca359e2f12603))
* **runner:** Added opt-in human-readable runner progress for tmux-launched combo runs so the coder pane shows concise deterministic lifecycle context around the live coder stream. ([caa1e66](https://github.com/thellmwhisperer/combo-chen/commit/caa1e66c71767082624d040758fdd2943eda3fd3))


### Bug Fixes

* **coder-responding:** Implemented the first [#210](https://github.com/thellmwhisperer/combo-chen/issues/210) slice by preventing first-pass PR-open flows from eagerly launching coder-responding and making coder-responding start lazily only when an actionable nudge needs it. ([ad570ae](https://github.com/thellmwhisperer/combo-chen/commit/ad570ae0ae574e059592680831ce4df191387ef6))
* **director-watch:** Removed redundant routine `director-watch` completion chatter so the pane now emits one compact dashboard status line per tick, with tests and spec coverage. ([7b8eff0](https://github.com/thellmwhisperer/combo-chen/commit/7b8eff0a3a5ba9624caed35b33996abb586d8b30))
* **forensics:** Added an actionable forensics no-match message so the issue [#210](https://github.com/thellmwhisperer/combo-chen/issues/210) outcome-recording path no longer silently produces an empty markdown report when the dogfood combo is not present locally. ([482d0e9](https://github.com/thellmwhisperer/combo-chen/commit/482d0e9e40ee18ad2849e61d40b65548a3aa56c6))
* **forensics:** Added an outcome-recording safety guard so `forensics --record-outcome` refuses to post incomplete dogfood outcomes without both a PR link and head SHA. ([e8e8e8a](https://github.com/thellmwhisperer/combo-chen/commit/e8e8e8ae538f8f3e30338f8ec76be5e01865b01e))
* **gate-live:** Split retry/post-address gate execution from the live no-mistakes gatekeeper pane so gate-live observability remains visible during gate runs. ([f536305](https://github.com/thellmwhisperer/combo-chen/commit/f5363055945ebfd37e2b08c6bab92b921b7540ea))
* **gate:** Addressed the CodeRabbit gate-live retry visibility comment with a focused TDD fix and full validation. ([4074935](https://github.com/thellmwhisperer/combo-chen/commit/40749350f0ad886a4b55d6ef783716429274834c))
* **resume:** Fixed the resume recovery topology so raw journal tailing no longer appears in the `coder` tmux window. ([5b5775f](https://github.com/thellmwhisperer/combo-chen/commit/5b5775f11ef773bccf2cf1491ebc09e9b5970cc3))
* **tmux:** Promoted first-pass combo launch observability so raw journal output now lives in a dedicated `journal` tmux window instead of a split pane inside `coder`, with tests and spec coverage. ([3bfd7df](https://github.com/thellmwhisperer/combo-chen/commit/3bfd7df84944b843ece5b9460c6d2407a63b4ab7))

## [0.0.61](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.60...combo-chen-v0.0.61) (2026-06-24)


### Features

* **observability:** human-readable tmux topology with separate coder, journal, gatekeeper/live, gate-runner, and director-watch windows; lazy coder responding mode (created only after review signals); opt-in runner progress lines (`COMBO_CHEN_RUNNER_PROGRESS=1`); and copy-ready forensics outcome blocks with `--record-outcome`. Fixes [#210](https://github.com/thellmwhisperer/combo-chen/issues/210). ([1877524](https://github.com/thellmwhisperer/combo-chen/commit/18775245c77f95007368e69770a80656811fbbb4))

## [0.0.60](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.59...combo-chen-v0.0.60) (2026-06-24)


### Bug Fixes

* **director:** Completed issue [#198](https://github.com/thellmwhisperer/combo-chen/issues/198) by routing READY conflicts into coder rebase recovery, post-rebase gating, and new-head READY restoration with the full suite green. ([9057734](https://github.com/thellmwhisperer/combo-chen/commit/905773408d4b61e1ac30f654c4211abdf3e6528e))
* **ready-conflict:** Implemented the first READY-conflict invalidation slice for issue [#198](https://github.com/thellmwhisperer/combo-chen/issues/198): dirty/conflicting GitHub mergeability now records a durable recovery event and prevents stale READY from hiding the conflict. ([51a945e](https://github.com/thellmwhisperer/combo-chen/commit/51a945e1808b159b8078e138c5e3101556e25835))
* **ready:** require coderabbit success ([9d0bc8b](https://github.com/thellmwhisperer/combo-chen/commit/9d0bc8b41b803c4039a5381e902e9b1af5002ab9))

## [0.0.59](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.58...combo-chen-v0.0.59) (2026-06-24)


### Features

* **update:** Implemented the first active `combo-chen update --yes` assembly slice, wiring the CLI through release resolution, verified staging, and guarded replacement with a mocked integration test. ([a2c6469](https://github.com/thellmwhisperer/combo-chen/commit/a2c6469455e4190fd5eb5375462c5586815b6997))


### Bug Fixes

* **update:** Added a command-boundary guard so source-checkout update targets fail before staging, download, extraction, or replacement begins. ([77acb78](https://github.com/thellmwhisperer/combo-chen/commit/77acb7809f8b92797e7a658cb7f6a4c30b2fa474))
* **update:** Added command-level checksum-mismatch failure reporting for `combo-chen update --yes` while preserving the no-extraction/no-replacement boundary. ([15b6cc2](https://github.com/thellmwhisperer/combo-chen/commit/15b6cc25fc113f91bfd6db2b2243e9ef54e037d7))
* **update:** classify shims before realpath ([f9f585d](https://github.com/thellmwhisperer/combo-chen/commit/f9f585db9a23d812b41dc2b98c84f2a55de11082))
* **update:** harden review edge cases ([b1e7cda](https://github.com/thellmwhisperer/combo-chen/commit/b1e7cda1fe4c94f86463d459b929959077b92916))
* **update:** Pinned and fixed the remaining update download-failure path so a checksums asset download failure cleans staging, skips extraction/replacement, and reports a precise before-replacement error. ([72893f0](https://github.com/thellmwhisperer/combo-chen/commit/72893f08ad2a428100706a6156753689c8136006))
* **update:** route missing checksums through staging ([263a064](https://github.com/thellmwhisperer/combo-chen/commit/263a064ce229dbb149d7ef8a9f0dc82c7eb746b5))

## [0.0.58](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.57...combo-chen-v0.0.58) (2026-06-23)


### Features

* **pr-labels:** Added the idempotent GitHub PR label updater slice with mutation journaling and green validation. ([f53db6a](https://github.com/thellmwhisperer/combo-chen/commit/f53db6a3b7c8b069b5d936cb6ba238f060ab8acd))
* **pr-labels:** Built the first issue [#188](https://github.com/thellmwhisperer/combo-chen/issues/188) slice: a pure, tested combo PR label projection/diff contract for current-head GitHub label state. ([7648674](https://github.com/thellmwhisperer/combo-chen/commit/764867411b550faa9f25df81da939b11e6d2078f))
* **pr-labels:** Wired the existing combo PR label updater into director-watch so live reviewer activity now updates GitHub PR labels and journals the change. ([db2e029](https://github.com/thellmwhisperer/combo-chen/commit/db2e029822a72e277760c494c5ed324b60216fe9))


### Bug Fixes

* **pr-labels:** address external review nits ([7808d14](https://github.com/thellmwhisperer/combo-chen/commit/7808d14b302bdd760f7394d5ec36e5bded1b8073))
* **pr-labels:** configure coderabbit checks ([105c371](https://github.com/thellmwhisperer/combo-chen/commit/105c371f6bb37ee0ff087e680c637858c0d0f959))
* **pr-labels:** generalize external review signals ([c0d1532](https://github.com/thellmwhisperer/combo-chen/commit/c0d15321abc0c6fbdb6119f357b08ab486311352))
* **pr-labels:** generalize green check config ([5450e30](https://github.com/thellmwhisperer/combo-chen/commit/5450e3026fec815f9477f47b8196fab135be4e75))
* **pr-labels:** journal partial label sync ([39c342d](https://github.com/thellmwhisperer/combo-chen/commit/39c342d5c9494c8c2dfb388d5b917d84cb338e56))
* **review:** address external review readiness nits ([551554f](https://github.com/thellmwhisperer/combo-chen/commit/551554f4a65e3474829419f3e1578368bdaa61b8))
* **status:** Wired `status --deep` into the existing idempotent combo PR label updater and verified the full suite is green. ([18c0863](https://github.com/thellmwhisperer/combo-chen/commit/18c0863c1b4ae4c9fa59c506f0ec211d5ef947e9))

## [0.0.57](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.56...combo-chen-v0.0.57) (2026-06-22)


### Features

* **director-watch:** Implemented the director-watch operator status line and validated the issue acceptance criteria with the full suite green. ([1f024d4](https://github.com/thellmwhisperer/combo-chen/commit/1f024d40002dfe1baafc57619d12f0da4f9e7f9c))


### Bug Fixes

* **director-watch:** preserve unknown PR state ([5864e52](https://github.com/thellmwhisperer/combo-chen/commit/5864e5297fdd4fe67835a6b0ccfe3b91434373a5))

## [0.0.56](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.55...combo-chen-v0.0.56) (2026-06-22)


### Bug Fixes

* scope gatekeeper attach by branch ([ae72c8f](https://github.com/thellmwhisperer/combo-chen/commit/ae72c8f81590db70bd412409382ea755aec5537c))
* scope no-mistakes gates by branch ([321db26](https://github.com/thellmwhisperer/combo-chen/commit/321db262890a45b5c9d8b710c5d78a0a6f79e050))

## [0.0.55](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.54...combo-chen-v0.0.55) (2026-06-22)


### Features

* **update:** Added the first read-only GitHub Releases resolver slice for issue [#181](https://github.com/thellmwhisperer/combo-chen/issues/181), covering stable and beta latest-release selection with tests. ([d976b37](https://github.com/thellmwhisperer/combo-chen/commit/d976b37ddda274249a3dc8aab79ed4e75f0342c0))
* **update:** Implemented the next read-only update-plan slice that compares the selected release against current build metadata and returns distinct plan states/errors. ([3e0c480](https://github.com/thellmwhisperer/combo-chen/commit/3e0c4804e4fe6582519da9db09b19ebad2d5e4de))


### Bug Fixes

* **update:** Added the read-only asset-planning slice for issue [#181](https://github.com/thellmwhisperer/combo-chen/issues/181) and validated the full suite green. ([d831b96](https://github.com/thellmwhisperer/combo-chen/commit/d831b965a21132df741ce0c0eb2cf220f6cdb1c3))
* **update:** preserve normalized release values ([acc0cad](https://github.com/thellmwhisperer/combo-chen/commit/acc0cadca22c854962e23f1e9672c7c431d39cae))

## [0.0.54](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.53...combo-chen-v0.0.54) (2026-06-22)


### Features

* **update:** Implemented the U71-B U2 staging primitive with mocked download/checksum/extraction coverage and a green validation suite. ([efcb573](https://github.com/thellmwhisperer/combo-chen/commit/efcb573a4de97993c3e14da7761fb3d1df9defbf))


### Bug Fixes

* **update:** reject empty staging filenames ([526772e](https://github.com/thellmwhisperer/combo-chen/commit/526772e742764d0a8dcc81fe2692b16f7224399e))
* **update:** report unavailable checksums ([4cfb4e2](https://github.com/thellmwhisperer/combo-chen/commit/4cfb4e24e5ccad6251e857afbd1576147d7a2153))

## [0.0.53](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.52...combo-chen-v0.0.53) (2026-06-22)


### Features

* **update:** Implemented and verified the local staged-artifact install replacement primitive for issue [#179](https://github.com/thellmwhisperer/combo-chen/issues/179). ([b35f83a](https://github.com/thellmwhisperer/combo-chen/commit/b35f83a2e5ee9a903a38f928818364595677fd1a))

## [0.0.52](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.51...combo-chen-v0.0.52) (2026-06-22)


### Features

* **update-contract:** Added the read-only checksum parsing and exact lookup slice for the update contract, with full validation green. ([520d735](https://github.com/thellmwhisperer/combo-chen/commit/520d735888e333bc062f70c365295c0c629b7bfb))
* **update-contract:** Added the read-only install target classification slice for issue [#176](https://github.com/thellmwhisperer/combo-chen/issues/176) and validated it with the full repo gate. ([335d93e](https://github.com/thellmwhisperer/combo-chen/commit/335d93e7d03b5488292831b2e7747018d3799bd8))
* **update:** Added the first read-only updater contract slice for release tag/version normalization and current-vs-candidate comparison. ([8adf166](https://github.com/thellmwhisperer/combo-chen/commit/8adf166358af704c903650a7a17700119bcfdc67))
* **update:** Added the read-only platform asset-selection contract slice for issue [#176](https://github.com/thellmwhisperer/combo-chen/issues/176) and validated it with the full repo gate. ([0edbc13](https://github.com/thellmwhisperer/combo-chen/commit/0edbc13f5c60f4f9982977eb6cf5be99f693ce99))


### Bug Fixes

* **update:** compare github prerelease candidates ([b280382](https://github.com/thellmwhisperer/combo-chen/commit/b2803823e1373d9b008a8bc53817b810ee35e218))

## [0.0.51](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.50...combo-chen-v0.0.51) (2026-06-21)


### Bug Fixes

* **runner:** fail coder phase when tee fails ([9d21a34](https://github.com/thellmwhisperer/combo-chen/commit/9d21a349b247f1ddf8e0aae33159bc9e557e11fb))
* **runner:** stream coder output ([f364887](https://github.com/thellmwhisperer/combo-chen/commit/f364887571715bbb28909e24032ae26f152a2b8d))

## [0.0.50](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.49...combo-chen-v0.0.50) (2026-06-21)


### Bug Fixes

* **cli:** Added tested parallel capsule dashboard wording to CLI status/help and public docs for issue [#157](https://github.com/thellmwhisperer/combo-chen/issues/157). ([2d66fe9](https://github.com/thellmwhisperer/combo-chen/commit/2d66fe9dd15b7f4d9ee9893a2154f8fe2e9141b4))

## [0.0.49](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.48...combo-chen-v0.0.49) (2026-06-21)


### Features

* **reviewer:** Established the reviewer verdict protocol foundation by requiring the prompt block and adding a strict current-head parser with regression coverage. ([737510b](https://github.com/thellmwhisperer/combo-chen/commit/737510bd69d57699f37d19cf9bd7a218e7fae2fd))
* **reviewer:** Implemented reviewer verdict code 1 routing so current-head mechanical-fix verdicts nudge coder responding through the existing review-comment path. ([103e405](https://github.com/thellmwhisperer/combo-chen/commit/103e4054b7ca66ab231ca17cc583b5677733da3a))
* **reviewer:** Implemented the next incremental routing slice: reviewer verdict code 3 now journals a human handoff and validation is green. ([be2305e](https://github.com/thellmwhisperer/combo-chen/commit/be2305ee2c99f36648aadab1128f32d823966883))


### Bug Fixes

* **reviewer:** create promptable director target ([e6fc6c7](https://github.com/thellmwhisperer/combo-chen/commit/e6fc6c7a2f5c12e442bf782e798fd9f2f2d35265))
* **reviewer:** Implemented the final reviewer verdict code-2 routing slice and validated the full suite green. ([7faf85b](https://github.com/thellmwhisperer/combo-chen/commit/7faf85b3a102c2697c8a4073b0478d7c6f0040cd))
* **reviewer:** Implemented the first routing slice: reviewer verdict code 0 now feeds the existing current-head LGTM journal path and validation is green. ([3edbc52](https://github.com/thellmwhisperer/combo-chen/commit/3edbc52ca71458f9c07dc3ef6a1ccca007cca35b))

## [0.0.48](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.47...combo-chen-v0.0.48) (2026-06-21)


### Features

* **director:** Implemented the first promptable-director slice: a verified `director-prompt` command that sends deterministic prompts via tmux paste-buffer and journals prompt facts. ([63d0b86](https://github.com/thellmwhisperer/combo-chen/commit/63d0b861e9627bb02d128d4b2b7a291b6094c72b))
* **director:** Implemented the launch-time promptable director window slice and validated it with the full local suite. ([17accf5](https://github.com/thellmwhisperer/combo-chen/commit/17accf5345b1186663419ca10916f17115005a39))

## [0.0.47](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.46...combo-chen-v0.0.47) (2026-06-21)


### Features

* **gate:** Added the first issue [#151](https://github.com/thellmwhisperer/combo-chen/issues/151) lease-foundation slice: a persisted shared gate lease contract with focused tests for free, busy, stale, and same-branch states. ([3bdaad3](https://github.com/thellmwhisperer/combo-chen/commit/3bdaad3ef56f43a83d3920fc4b10247a469c285a))
* **gate:** Added the next [#151](https://github.com/thellmwhisperer/combo-chen/issues/151) visibility slice by showing the active shared gate lease owner in `combo-chen status`. ([58d22b6](https://github.com/thellmwhisperer/combo-chen/commit/58d22b68adfe0fc1736a523fe710500c7584a38e))


### Bug Fixes

* **gate:** Closed the last status visibility edge for issue [#151](https://github.com/thellmwhisperer/combo-chen/issues/151) by showing an active gate lease even when default status has no actionable combo rows. ([700eca7](https://github.com/thellmwhisperer/combo-chen/commit/700eca77e3b61c4c2f31400f291c528e69cf0728))
* **gate:** Implemented the runtime gate-lease enforcement slice so generated no-mistakes gate scripts acquire a shared lease before running and report deterministic queued/conflict states when they cannot. ([ca6ae5e](https://github.com/thellmwhisperer/combo-chen/commit/ca6ae5eab5dece46beaa1e585064c586ed8f80c1))

## [0.0.46](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.45...combo-chen-v0.0.46) (2026-06-21)


### Features

* **runtime-ledger:** Added the first launch-time runtime ledger slice for issue-backed and plan-backed combo runs. ([3f908f0](https://github.com/thellmwhisperer/combo-chen/commit/3f908f01a1d1a5b6d21c5f5d9b294478fbb2cbf2))
* **runtime-ledger:** Added the next runtime-ledger slice: legacy fallback reading plus PR/reviewer resource updates wired into the CLI. ([b75b287](https://github.com/thellmwhisperer/combo-chen/commit/b75b28761b37ea6985feb4266c4da53ce0722260))


### Bug Fixes

* **closure:** Implemented the closure consumer slice for the runtime ledger by making closure honor ledger PR URLs while preserving legacy fallback behavior. ([639dab6](https://github.com/thellmwhisperer/combo-chen/commit/639dab6385d5426ddde3cb5eb84dc61f0b7fdd56))
* **runtime-ledger:** hydrate missing pr urls ([00a8909](https://github.com/thellmwhisperer/combo-chen/commit/00a89098aa39ada59972d07f385cdc22e0a41a4e))
* **runtime-ledger:** Status now consumes runtime-ledger PR URLs as the available dashboard-style reader, including deep GitHub readiness checks, with full validation green. ([8b2a1d0](https://github.com/thellmwhisperer/combo-chen/commit/8b2a1d09a38ef89825df6e3ea193bce00f866bbe))

## [0.0.45](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.44...combo-chen-v0.0.45) (2026-06-21)


### Features

* **director:** inspect worker panes in all combo phases ([#161](https://github.com/thellmwhisperer/combo-chen/issues/161)) ([d66b22e](https://github.com/thellmwhisperer/combo-chen/commit/d66b22ed2f47356b48a0a446004088e8a09197f2))

## [0.0.44](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.43...combo-chen-v0.0.44) (2026-06-21)


### Features

* **overture:** deterministic launch runway before combo run ([#158](https://github.com/thellmwhisperer/combo-chen/issues/158)) ([8a5cf30](https://github.com/thellmwhisperer/combo-chen/commit/8a5cf30c193cbc0a3e5e5408a7954cc3600f11b2))

## [0.0.43](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.42...combo-chen-v0.0.43) (2026-06-21)


### Features

* **cli:** deterministic post-merge resource convergence via closure command ([#145](https://github.com/thellmwhisperer/combo-chen/issues/145)) ([ae11e75](https://github.com/thellmwhisperer/combo-chen/commit/ae11e7549516c9037f6ad1ef2a68b0dc01679b47))

## [0.0.42](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.41...combo-chen-v0.0.42) (2026-06-19)


### Features

* **plan-run:** Implemented the first test-first `combo-chen run --plan <file>` launch slice for local markdown work plans without requiring a GitHub issue. ([5e17a21](https://github.com/thellmwhisperer/combo-chen/commit/5e17a2114e8c55c846f20a52b063be0fa382c41c))
* **work-plan:** Added the first canonical work-plan foundation so generic markdown plans and GitHub issue facts can normalize into the same artifact shape. ([1f16756](https://github.com/thellmwhisperer/combo-chen/commit/1f167564270a6c795284ec11929cf8456649b7d1))


### Bug Fixes

* **plan-gates:** Implemented a plan-aware runtime intent/gate-restart slice so plan-backed combos reuse persisted work-plan artifacts instead of requiring a GitHub issue. ([023c498](https://github.com/thellmwhisperer/combo-chen/commit/023c498a080894c244c2b7dab2da501e4b689379))
* **plan-inspection:** Implemented the next plan-inspection slice so status and forensics now surface generic work-plan source/title metadata without requiring a GitHub issue. ([6a9ee95](https://github.com/thellmwhisperer/combo-chen/commit/6a9ee951b026e9c3a3e069f21bc5094c2b46638f))
* **plan:** harden local work-plan references ([4041d40](https://github.com/thellmwhisperer/combo-chen/commit/4041d404781bbfebc05254e5bc624a06aa19d257))
* **reviewer:** Reviewer activation now carries normalized work-plan context for both plan-backed and GitHub issue-backed combos, completing issue [#134](https://github.com/thellmwhisperer/combo-chen/issues/134)'s remaining reviewer-context criterion. ([c12b625](https://github.com/thellmwhisperer/combo-chen/commit/c12b625bd68a0eb0f24d705947235ba9495d84ce))
* **reviewer:** tolerate issue plans without criteria ([57aabbb](https://github.com/thellmwhisperer/combo-chen/commit/57aabbb55e81843738a66e53e7089c7e11447a45))

## [0.0.41](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.40...combo-chen-v0.0.41) (2026-06-19)


### Bug Fixes

* **director:** Automatic initial-gate retry launch failures now preserve the journal start-before-terminal contract, with full validation green. ([b94342c](https://github.com/thellmwhisperer/combo-chen/commit/b94342c6ab836a6b0c52e0f72c3baa772b89ba8c))
* **events:** Implemented and validated the first journal-hygiene slice: duplicate `pr_opened` appends for the same PR URL are now idempotent. ([19f708f](https://github.com/thellmwhisperer/combo-chen/commit/19f708f61fcacff664df1e59bf92d9bfa4288e37))
* **journal:** Removed obsolete new `needs_human reason=pr_ready` emission from generated initial gate paths and documented the replacement journal contract. ([29dfc14](https://github.com/thellmwhisperer/combo-chen/commit/29dfc14a88ef893d465b3efea2ce7131c04ce88a))
* **reconcile:** Implemented the final journal-hygiene slice by preserving GitHub’s `mergedAt` timestamp on reconcile-synthesized `merged` events, with the full validation suite green. ([f533c83](https://github.com/thellmwhisperer/combo-chen/commit/f533c8345a33e2b774861684d7189eb75037559d))

## [0.0.40](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.39...combo-chen-v0.0.40) (2026-06-18)


### Bug Fixes

* **lifecycle:** Implemented the first issue [#133](https://github.com/thellmwhisperer/combo-chen/issues/133) slice: idempotent local teardown for already-clean worktrees, branches, and tmux sessions, with focused tests and full validation green. ([8b61361](https://github.com/thellmwhisperer/combo-chen/commit/8b61361473bb2ecd5bfc0955f6739909be4ad230))
* **reconcile:** Added the scoped per-combo post-merge cleanup path as `combo-chen reconcile -n <combo-id> --apply` with focused helper and CLI coverage. ([01503ea](https://github.com/thellmwhisperer/combo-chen/commit/01503ea44f4ba7f2db79edd205d298ef53701a4d))

## [0.0.39](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.38...combo-chen-v0.0.39) (2026-06-18)


### Features

* **release:** Added a tested release producer helper that materializes deterministic tar.gz assets and sha256sum-compatible checksums from the existing release contract. ([5db4a36](https://github.com/thellmwhisperer/combo-chen/commit/5db4a36b6ff2000a40091369d77206ef1edcb988))
* **release:** Added the tested release artifact contract helpers for asset naming, archive layout, and deterministic checksums, with full validation green. ([faf475e](https://github.com/thellmwhisperer/combo-chen/commit/faf475ef7c6a2f8b3837b7ac4e0d6e662e809a10))
* **release:** Implemented the first release-foundation slice: builds now embed version metadata and the CLI exposes it via `--version`, with tests and full validation green. ([38e9a61](https://github.com/thellmwhisperer/combo-chen/commit/38e9a61fcebd8d6dab813fad2d64d3f3f9e0c848))

## [0.0.38](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.37...combo-chen-v0.0.38) (2026-06-18)


### Bug Fixes

* **checks:** Implemented the H-3 filtered check-rollup fix so external-comment/ambient checks alone can no longer stand in for normal CI, with full validation green. ([46b0a63](https://github.com/thellmwhisperer/combo-chen/commit/46b0a6390ae3a21b831aca93840132fe00b715e6))
* **events:** Implemented the remaining H-4 journal append hardening with a per-run append lock and full validation green. ([63dceae](https://github.com/thellmwhisperer/combo-chen/commit/63dceaef8ddce9a3404982333a19a4693af04be9))
* **reviewer:** Implemented the issue [#127](https://github.com/thellmwhisperer/combo-chen/issues/127) H-1 security fix so SHA-pinned reviewer LGTM evidence is accepted only from configured reviewer GitHub logins, with full validation green. ([cfedf67](https://github.com/thellmwhisperer/combo-chen/commit/cfedf6770216fb57f8a4490f63ec6672ed99cbc0))
* **runner:** Implemented and validated the H-2 runner command quoting fix for combo ids derived from issue URLs. ([8a8ce1d](https://github.com/thellmwhisperer/combo-chen/commit/8a8ce1d9b547c38e5914a549e9fa6fd1055788a5))

## [0.0.37](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.36...combo-chen-v0.0.37) (2026-06-18)


### Bug Fixes

* **gate:** gate-restart parity breadcrumbs and in-flight warning ([c504cab](https://github.com/thellmwhisperer/combo-chen/commit/c504cab242812e39a0c2d221d6355095cbd3e094))
* **gate:** gate-restart parity breadcrumbs and in-flight warning ([366757e](https://github.com/thellmwhisperer/combo-chen/commit/366757eeac353a0acc0ae21a91e7fd7948ab6acb))

## [0.0.36](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.35...combo-chen-v0.0.36) (2026-06-18)


### Features

* **cli:** add gate-restart so the director relaunches the gate with one plain command ([e741c3b](https://github.com/thellmwhisperer/combo-chen/commit/e741c3bfac0d84735727a826b97dc201121f77a3))
* **cli:** expose intent command to print the canonical issue PR intent ([9c642a6](https://github.com/thellmwhisperer/combo-chen/commit/9c642a668533f31f2ad646d0a1e02a5fd830a870))
* **cli:** gate-restart para relanzar el gate del director con un comando plano ([333d414](https://github.com/thellmwhisperer/combo-chen/commit/333d414f330f5ad8cbfdff7badce2227192cc6d1))


### Bug Fixes

* **cli:** gate-restart force-restarts the post-address gate after pr_opened ([80ee8e8](https://github.com/thellmwhisperer/combo-chen/commit/80ee8e8c1e5253a85797f27e5c58bdd80235a850))
* **launch-combo:** capture intent into a var so a failed capture aborts before publishing empty ([52743ab](https://github.com/thellmwhisperer/combo-chen/commit/52743ab54160ff9a681a906e08d168a4a55b8a0b))

## [0.0.35](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.34...combo-chen-v0.0.35) (2026-06-18)


### Features

* **config:** Implemented the first issue [#44](https://github.com/thellmwhisperer/combo-chen/issues/44) slice by persisting an auditable launch-time config snapshot for each combo run and validating it green. ([4010a6c](https://github.com/thellmwhisperer/combo-chen/commit/4010a6c20cac036b162bb45d44a9768cb81d976e))


### Bug Fixes

* **cli:** Implemented the `gate_started` recovery snapshot slice so recovered gatekeeper tmux windows keep launch-time attach timing after repo TOML changes. ([9a309df](https://github.com/thellmwhisperer/combo-chen/commit/9a309dffdc6743a51eb44268bd849ba60bf89cf5))
* **coder:** Implemented the coder-responding snapshot slice so runtime coder resume and review-nudge behavior no longer drifts after repo TOML changes. ([63ed6b5](https://github.com/thellmwhisperer/combo-chen/commit/63ed6b530bcded10621819eff84d2dd9a4f2eb15))
* **config:** harden snapshot persistence ([b0343d9](https://github.com/thellmwhisperer/combo-chen/commit/b0343d95d318816a8fb5e394b4e5705e00a24b87))
* **config:** pin combo runtime behavior to launch-time config snapshots ([8808a9a](https://github.com/thellmwhisperer/combo-chen/commit/8808a9a6597a762548fc3623fc4e349f30ada96b))
* **config:** Pinned the final forensics runtime config read to the per-run launch snapshot and validated the full suite green. ([5cd9d4c](https://github.com/thellmwhisperer/combo-chen/commit/5cd9d4c6a6de646ea8c577ef2e4729cc0dfbee94))
* **director-watch:** Implemented the director-watch runtime snapshot slice so loop cadence no longer drifts after repo TOML changes. ([68b7085](https://github.com/thellmwhisperer/combo-chen/commit/68b708513952ea532757ab82c5786e54655aa9fc))
* **director:** Implemented the director runtime snapshot slice so director ticks and READY evaluation no longer drift after repo TOML changes. ([0a569b9](https://github.com/thellmwhisperer/combo-chen/commit/0a569b9555c49a07a5e43d1722d1e11057e0fba0))
* **gate:** Implemented the gatekeeper runtime snapshot slice so initial gate retries and post-address gates keep using the launch-time gatekeeper command after repo TOML changes. ([2fe2d2b](https://github.com/thellmwhisperer/combo-chen/commit/2fe2d2b3c161a003084ce97d4d575d83e7dc98ed))
* **reconcile:** Implemented the reconcile teardown snapshot slice so merged-combo reconciliation no longer drifts after repo TOML changes. ([29c6f5d](https://github.com/thellmwhisperer/combo-chen/commit/29c6f5d10341f0399ed82beb49d9ac4e47c71fa2))
* resolve rebase conflicts and fix typecheck ([296b0ad](https://github.com/thellmwhisperer/combo-chen/commit/296b0adfc7a5ea984362dd8c015aae7a2d2351bb))
* **reviewer:** Implemented the issue [#44](https://github.com/thellmwhisperer/combo-chen/issues/44) reviewer-runtime slice by making reviewer activation/tick paths use the per-run config snapshot and validating the suite green. ([8ce134e](https://github.com/thellmwhisperer/combo-chen/commit/8ce134e6133250d8049e1714551bbf74ad793cbc))
* **runtime-config:** Park and resume now use the launch-time config snapshot for combo-owned runtime behavior instead of mutable repo TOML. ([74f012d](https://github.com/thellmwhisperer/combo-chen/commit/74f012db5ae15b5a69ea048112f1d83cb395829c))
* **status:** Pinned `status --deep` downstream config to the launch snapshot and validated the full suite green. ([c1c6435](https://github.com/thellmwhisperer/combo-chen/commit/c1c6435e18bd9e4efbe1b7ccadc49d0d43f84f01))

## [0.0.34](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.33...combo-chen-v0.0.34) (2026-06-18)


### Features

* **config:** Implemented the external comment-agent config slice with green validation, moving comment routing/filtering off reviewer-owned ambient config and onto a neutral `[external_comments].agents` surface. ([dfc0829](https://github.com/thellmwhisperer/combo-chen/commit/dfc0829bf44e057c94d7fd0f0f6192e5e8640f6e))
* **ready:** Implemented the first READY required-checks slice for issue [#105](https://github.com/thellmwhisperer/combo-chen/issues/105), replacing external clean-comment gating with configurable GitHub check requirements while keeping the full suite green. ([fa05202](https://github.com/thellmwhisperer/combo-chen/commit/fa0520219f7e3b5667e5d41fbe76997cfab15f9a))


### Bug Fixes

* **ready:** address required check review notes ([1960868](https://github.com/thellmwhisperer/combo-chen/commit/1960868df97962ab4493985bbc5e5fd95c723241))
* **ready:** Completed the final issue [#105](https://github.com/thellmwhisperer/combo-chen/issues/105) cleanup by removing stale ambient-reviewer terminology from core READY-check forensics surfaces and validating the full suite. ([78148d7](https://github.com/thellmwhisperer/combo-chen/commit/78148d7db6a7ad5209d5885558d4fbae96724beb))

## [0.0.33](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.32...combo-chen-v0.0.33) (2026-06-18)


### Bug Fixes

* **status:** auto-reconcile merged PRs and hide terminal combos by default ([aa269d1](https://github.com/thellmwhisperer/combo-chen/commit/aa269d1dc895e163fde27b9d1730d11f8b0e91d6))
* **status:** Implemented the first issue [#90](https://github.com/thellmwhisperer/combo-chen/issues/90) slice: default status now hides terminal historical combos while `status --all` preserves the history view. ([81f9f71](https://github.com/thellmwhisperer/combo-chen/commit/81f9f71ddf8c26a74ecf8a32000bdff16c96068c))
* **status:** Implemented the next issue [#90](https://github.com/thellmwhisperer/combo-chen/issues/90) slice: default status now quietly reconciles merged and closed GitHub PRs before rendering actionable rows. ([33e299b](https://github.com/thellmwhisperer/combo-chen/commit/33e299b115db380501d1288069ab7357aca80a74))
* **status:** Implemented the remaining issue [#90](https://github.com/thellmwhisperer/combo-chen/issues/90) missing-tmux status slice and validated the final tree with the full suite green. ([e37d3fb](https://github.com/thellmwhisperer/combo-chen/commit/e37d3fb66ac6941d5c4e9eb682a749ac28dd019f))
* **status:** respect parked combos in liveness checks ([e342246](https://github.com/thellmwhisperer/combo-chen/commit/e342246085e413c53b433e0f070167470b30b766))

## [0.0.32](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.31...combo-chen-v0.0.32) (2026-06-18)


### Features

* **config:** Added the initial-gate retry configuration surface with red-first coverage and full validation green. ([0a23415](https://github.com/thellmwhisperer/combo-chen/commit/0a234156ab8ea3ff0534389e58c0cf537b2ee1c0))


### Bug Fixes

* **config:** keep no-mistakes config local ([44eaa4f](https://github.com/thellmwhisperer/combo-chen/commit/44eaa4f46990bc8717524da750f050e1092205ef))
* **director:** Implemented automatic pre-PR initial-gate retry for issue [#59](https://github.com/thellmwhisperer/combo-chen/issues/59) and validated the full suite green. ([b430fbb](https://github.com/thellmwhisperer/combo-chen/commit/b430fbba44bfc4180c664177f17c1f281c1893d2))
* **gate:** copy no-mistakes config during gate run ([f64074a](https://github.com/thellmwhisperer/combo-chen/commit/f64074ae40db50e592dcb7eca151a84b43743ce0))
* **gate:** copy no-mistakes config into daemon worktree ([ac3a99a](https://github.com/thellmwhisperer/combo-chen/commit/ac3a99add10e30dd3beeda61daa7e72752d6904a))
* **gate:** wait for no-mistakes config handoff ([d51142f](https://github.com/thellmwhisperer/combo-chen/commit/d51142fa8259dcf59afd5d504cd328c33d819ba8))

## [0.0.31](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.30...combo-chen-v0.0.31) (2026-06-17)


### Bug Fixes

* address remaining PR feedback ([bdb3130](https://github.com/thellmwhisperer/combo-chen/commit/bdb3130176da7a0eb5856d0819bc6495b0ff43ca))
* address remaining review threads ([04baca6](https://github.com/thellmwhisperer/combo-chen/commit/04baca606ee637c11466259d515b60f6cfce0919))
* address review flow comments ([d1ec3b5](https://github.com/thellmwhisperer/combo-chen/commit/d1ec3b5298e888ff15c5519fd9fdecf812886d28))
* configure worker prompt detection ([cb7b78c](https://github.com/thellmwhisperer/combo-chen/commit/cb7b78c222dfaaf55f9e35cf2a481ca22b597a03))
* harden combo launch and review flow ([3efb605](https://github.com/thellmwhisperer/combo-chen/commit/3efb6055ecf966b801713f522d06947ac9cc7041))
* keep reviewer prompt generic ([1abeaf4](https://github.com/thellmwhisperer/combo-chen/commit/1abeaf473f9c24bdafac4f1277ad87a00f40f7e8))
* keep reviewer skill contract local ([94d1bb2](https://github.com/thellmwhisperer/combo-chen/commit/94d1bb2b13331caa9a415ae9948df6c79fdccbbc))
* move reviewer instructions to prompt ([5bdb8b2](https://github.com/thellmwhisperer/combo-chen/commit/5bdb8b233aecb92080359306be433054c537f32e))
* validate reviewer prompt type ([3a92b0a](https://github.com/thellmwhisperer/combo-chen/commit/3a92b0aea487c261070b23b80851d876acb15ade))

## [0.0.30](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.29...combo-chen-v0.0.30) (2026-06-17)


### Bug Fixes

* address coderabbit cli hardening comments ([3846f5c](https://github.com/thellmwhisperer/combo-chen/commit/3846f5cc96f1a968c41087162cd4664b0bfb0a12))

## [0.0.29](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.28...combo-chen-v0.0.29) (2026-06-17)


### Bug Fixes

* **gatekeeper:** make PR autoclose guard blocking and preserve Fixes line in intent ([#109](https://github.com/thellmwhisperer/combo-chen/issues/109)) ([9254954](https://github.com/thellmwhisperer/combo-chen/commit/925495415e76a608b50503ef6ae6d8977394115a))

## [0.0.28](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.27...combo-chen-v0.0.28) (2026-06-17)


### Features

* **cli:** Implemented the first-class `combo-chen park -n` slice for issue [#76](https://github.com/thellmwhisperer/combo-chen/issues/76), with a resumable handoff file, non-terminal journal event, docs, and full validation green. ([4a2f95b](https://github.com/thellmwhisperer/combo-chen/commit/4a2f95b62e36788a16215b2ff1b82428a9a60962))
* **resume:** Implemented the first `combo-chen resume -n` slice so existing combos route through downstream state instead of starting a fresh run. ([cf9aa53](https://github.com/thellmwhisperer/combo-chen/commit/cf9aa534afd558c6c8c41d70057b6308460f757e))
* **status:** Implemented the first `status --deep` slice for issue [#76](https://github.com/thellmwhisperer/combo-chen/issues/76) by surfacing downstream no-mistakes CI/gate state from combo status. ([a8a1095](https://github.com/thellmwhisperer/combo-chen/commit/a8a109532f3da8528cac092cfe7a328e34bd21d8))


### Bug Fixes

* address coderabbit follow-ups ([43e2b7b](https://github.com/thellmwhisperer/combo-chen/commit/43e2b7baa223c76ceb6028e7336294a75622b021))
* address remaining review comments ([f36de8c](https://github.com/thellmwhisperer/combo-chen/commit/f36de8ca7bd09aacb2d5e415cf26774cd207081d))
* apply ambient reviewer gate feedback ([9b0e2f2](https://github.com/thellmwhisperer/combo-chen/commit/9b0e2f22555b83df557a6f2188a9f8c8baa08d34))
* broaden daemon guard and resume PR discovery ([3d65b08](https://github.com/thellmwhisperer/combo-chen/commit/3d65b08c12efc65bd08296f9c4211f9811475ac1))
* configure ambient reviewers ([536f261](https://github.com/thellmwhisperer/combo-chen/commit/536f261e9099fd79ba3dd74f5900a72503fff729))
* **gatekeeper:** force no-mistakes publish-only with park/resume recovery ([6f912e7](https://github.com/thellmwhisperer/combo-chen/commit/6f912e7b3f21d7ff4766bea8894a7c60112043b7))
* make no-mistakes publish-only ([cd504ce](https://github.com/thellmwhisperer/combo-chen/commit/cd504ceca4e8a618153f47898515ed86c6676533))
* resume failed combo gates ([5e5e5e6](https://github.com/thellmwhisperer/combo-chen/commit/5e5e5e645ef901124d508190d0e9ad14a57d85d9))
* resume review phase after follow-up gate ([8a17ec5](https://github.com/thellmwhisperer/combo-chen/commit/8a17ec5a9fab0390f5d2b2e3e1ab3df6149c705b))
* resume reviewer after gate-published pr ([7b832cb](https://github.com/thellmwhisperer/combo-chen/commit/7b832cbbc733be527ab3d9aec16a33b3fdc886ab))
* **resume:** Added the coder-stopped-before-handoff resume slice so `combo-chen resume -n` now reports a salvage-required path with exact recovery commands instead of a generic no-PR fallback. ([320462d](https://github.com/thellmwhisperer/combo-chen/commit/320462d3e69d4da6fe020e8930a07e7dc0b23372))
* **runner:** Implemented the safe runner config guard for issue [#76](https://github.com/thellmwhisperer/combo-chen/issues/76) and validated the full suite green. ([10a6583](https://github.com/thellmwhisperer/combo-chen/commit/10a6583f398befae2b995e0c549bcb23688fb476))
* **status:** Added the next `status --deep` slice so stale local combo state can surface an existing GitHub PR that is ready for reviewer. ([dd382ba](https://github.com/thellmwhisperer/combo-chen/commit/dd382ba00d6d79361ca3030190e887dcf35b92c2))

## [0.0.27](https://github.com/thellmwhisperer/combo-chen/compare/combo-chen-v0.0.26...combo-chen-v0.0.27) (2026-06-15)


### Features

* **forensics:** read-only combo forensics CLI with markdown and JSON reports ([8041ad2](https://github.com/thellmwhisperer/combo-chen/commit/8041ad266f5fd92147bd88adfa310f2f5b52defa))

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

* **reviewer:** parse verdict codes for deterministic routing — machine-readable verdict block with codes 0 (LGTM), 1 (mechanical fix→coder), 2 (ambiguous→director prompt), and 3 (needs_human); current-head parsing with stale/malformed/duplicate rejection; verdict author filtering via `[reviewer].logins` ([#153](https://github.com/thellmwhisperer/combo-chen/issues/153))

* **overture:** deterministic launch runway before `combo-chen run` — checks work-item readability, repo/issue match, clean checkout, base ref, branch/worktree/tmux availability, no-mistakes status, and coder/reviewer command safety; writes `overture.json` artifact and blocks before creating any launch resources when a check fails. Run standalone with `combo-chen overture --issue <url>` or `combo-chen overture --plan <file>` ([#144](https://github.com/thellmwhisperer/combo-chen/issues/144))

* **work-plan:** accept generic plan-based work items (`--plan <file>`) in addition to GitHub issues ([#134](https://github.com/thellmwhisperer/combo-chen/issues/134)) — canonically normalizing markdown plans into a `WorkPlan` artifact, persisting `work-plan.md` per combo, injecting work-plan context into reviewer prompts and forensics reports, and skipping the GitHub autoclose guard for plan-backed PRs

* **runtime-ledger:** machine-readable runtime ledger (`runtime-ledger.json`) for each combo capsule, written at launch with issue-backed and plan-backed records, updated when PR/reviewer/director resources appear, with legacy fallback for existing combos lacking a ledger ([#154](https://github.com/thellmwhisperer/combo-chen/issues/154))

* **config:** per-run launch-time config snapshot (`config.snapshot.json`) prevents runtime drift when repo TOML changes during a long-running combo; all runtime commands (director-watch, gate, reviewer activation, park/resume, reconcile teardown, status --deep, forensics) now use the frozen snapshot ([#44](https://github.com/thellmwhisperer/combo-chen/issues/44))
* **gatekeeper:** auto-retry initial gate failures before PR open with configurable retry count and backoff; exhausts to `needs_human reason=gate_failed` ([#59](https://github.com/thellmwhisperer/combo-chen/issues/59))

* **park:** first-class park command for reboot-safe combo handoff with handoff summary and tmux cleanup ([#76](https://github.com/thellmwhisperer/combo-chen/issues/76))
* **resume:** first-class resume command that reconstructs state from journal, tmux, worktree, no-mistakes, and GitHub PR state; never starts a fresh run on an existing combo ([#76](https://github.com/thellmwhisperer/combo-chen/issues/76))
* **status:** `status --deep` distinguishes stale combo state from real downstream state with no-mistakes and GitHub probes ([#76](https://github.com/thellmwhisperer/combo-chen/issues/76))
* **coder:** pin gnhf@0.1.41 with `--max-iterations`, `--stop-when`, `--prevent-sleep on`, and `--meteor-frequency 0`; validate safe coder invocation before launch
* **runner:** close coder stdin so the runner cannot block for input
* **gatekeeper:** publish HEAD to no-mistakes mirror with base64-encoded `no-mistakes.intent=` git push option before running the gate; use `--force-with-lease` when replacing an existing mirror branch
* **gatekeeper:** force publish-only mode by appending `--skip=ci` to every `no-mistakes axi run` command, preserving existing skip values and respecting shell quotes
* **reconcile:** Implemented the issue [#57](https://github.com/thellmwhisperer/combo-chen/issues/57) reconcile slice end-to-end: frozen merged journals can now be repaired with source-marked terminal events and teardown, with full validation green.
* **reconcile:** Hardened reconcile loop against loadConfig and killSession failures.
* **reconcile:** handle CLOSED (unmerged) PRs by journaling `needs_human reason=pr_closed` plus `combo_closed`, stopping tmux but preserving worktree and branch so local changes survive for human salvage ([#90](https://github.com/thellmwhisperer/combo-chen/issues/90))
* **reconcile:** preserve parked worktree and branch during merged PR teardown so intentional handoff artifacts survive reconcile repair; tmux session is still killed ([#90](https://github.com/thellmwhisperer/combo-chen/issues/90))
* **status:** default status hides terminal historical combos to surface only actionable work; `--all` flag restores full history view ([#90](https://github.com/thellmwhisperer/combo-chen/issues/90))
* **status:** auto-reconciles merged and closed GitHub PRs before rendering so repaired terminal rows never surface in the default actionable view ([#90](https://github.com/thellmwhisperer/combo-chen/issues/90))
* **status:** marks non-terminal combos with missing tmux sessions as `needs_human reason=tmux_missing` so the stale row remains visible and the operator can investigate instead of seeing a phantom supervised combo; parked combos are exempt ([#90](https://github.com/thellmwhisperer/combo-chen/issues/90))
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
* **gatekeeper:** `pr_autoclose_failed` journal event (required fields `exit_code`, `url`) transitions the combo to STALLED and marks the gate failed when the PR body still lacks a visible closing keyword after a post-edit verification pass ([#94](https://github.com/thellmwhisperer/combo-chen/issues/94))
* **release:** Release foundation — builds embed version, commit, and build date metadata exposed via `combo-chen --version`; local builds use safe fallbacks, automation supplies `COMBO_CHEN_COMMIT` and `COMBO_CHEN_BUILD_DATE` ([#70](https://github.com/thellmwhisperer/combo-chen/issues/70))
* **release:** Platform release artifact contract — asset naming (`combo-chen-vX.Y.Z-<platform>-<arch>.tar.gz`), archive layout, and sha256sum-compatible `checksums.txt` format, with full validation green ([#70](https://github.com/thellmwhisperer/combo-chen/issues/70))
* **release:** Reproducible release producer materializing deterministic tar.gz assets and `checksums.txt` under `dist/release/`, plus a `pnpm release:assets` package script that builds first ([#70](https://github.com/thellmwhisperer/combo-chen/issues/70))
* **ci:** GitHub Actions release workflow uploading `dist/release/*.tar.gz` and `dist/release/checksums.txt` for published and prereleased GitHub releases, with validation green ([#70](https://github.com/thellmwhisperer/combo-chen/issues/70))
* **docs:** Release artifact contract documented in README and spec for future update code, pinned with focused docs contract tests ([#70](https://github.com/thellmwhisperer/combo-chen/issues/70))
* **update:** U0 update contract bridge — read-only vocabulary layer defining shared types and pure helpers for release tag/version normalization, platform asset selection, sha256sum-compatible checksum parsing/lookup, install target classification, active combo state, and `ReadOnlyUpdatePlan` assembly; fully tested with coverage for stable/prerelease tags, supported/unsupported targets, checksums parsing/lookup, install target classification, and current-vs-candidate comparison ([#176](https://github.com/thellmwhisperer/combo-chen/issues/176))
* **update:** U2 download, checksum verification, and staging — downloads the selected archive and `checksums.txt`, verifies SHA-256 digest before extraction, extracts into an isolated staging directory, and returns a `StagedUpdateArtifact` descriptor; all network/I/O injected behind `UpdateStagingDeps` for testability; checksum mismatches, missing entries, unavailable checksums, malformed checksums, path-traversal filenames, empty filenames, download failures, write failures, and extraction failures reported deterministically with cleanup status through `UpdateStagingError` ([#180](https://github.com/thellmwhisperer/combo-chen/issues/180))
* **gatekeeper:** shared no-mistakes gate lease serializes parallel combo gate runs with stale lease recovery (30-min heartbeat timeout), `same_branch_conflict` detection, `queued` gate_status journaling, `needs_human reason=gate_lease_conflict` escalation, and EXIT trap release; surfaced in `status` via the `GATE-LEASE` column ([#151](https://github.com/thellmwhisperer/combo-chen/issues/151))
* **director:** promptable director window inside each combo capsule — created at launch with a non-polling contract, prompted by `director-watch` only for ambiguity, malformed signals, intent-touching choices, or uncoded recovery; `director-prompt` CLI command sends deterministic prompts via tmux paste-buffer and journals `director_prompted` events ([#152](https://github.com/thellmwhisperer/combo-chen/issues/152))

### Bug Fixes

* **lgtm:** harden LGTM pin extraction to require own-line verdicts with at least seven hex characters and filter out code fences, quoted text, indented code blocks, and inline code span fixtures ([#58](https://github.com/thellmwhisperer/combo-chen/issues/58))
* **hodor:** recreate missing hodor tmux window on `hodor_started` event so the live role window survives an early attach watcher exit ([#62](https://github.com/thellmwhisperer/combo-chen/issues/62))
* **thread-sitter:** replace send-keys with paste-buffer for nudge transport ([b9170eb](https://github.com/thellmwhisperer/combo-chen/commit/b9170eb4b231e58909712f921abcaf378f86cd12))
* **gatekeeper:** blocking PR autoclose guard with post-edit verification — exits non-zero and prevents `pr_opened` emission on failure instead of silently logging to the run directory ([#94](https://github.com/thellmwhisperer/combo-chen/issues/94))
* **gatekeeper:** move `Fixes #N` into an explicit PR body requirement directive before the issue body in the no-mistakes intent so the rewriter preserves it verbatim instead of dropping or misordering it ([#94](https://github.com/thellmwhisperer/combo-chen/issues/94))

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
