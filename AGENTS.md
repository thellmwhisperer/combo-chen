# combo-chen Agent Contract

combo-chen is a deterministic director harness for autonomous work-item-to-PR
work. It coordinates existing tools; it does not collapse their roles.

## Role Boundaries

- **Director**: orchestrates only. Starts phases, watches hard signals, writes
  journal events, routes work, and escalates `needs_human`. It does not edit
  code, answer review threads, approve PRs, push, merge, or deploy.
- **Coder**: implements the work item and later resumes the same thread for review
  comments. The coder leaves local commits in the combo worktree and does not
  push to origin or the PR branch in the normal path.
- **Reviewer**: reviews by comment and records a machine-readable verdict block
  with routing codes (0=OK/LGTM, 1=mechanical fix→coder, 2=ambiguous→director,
  3=needs_human) alongside the current SHA-pinned LGTM signal. It does not use
  GitHub approval as the merge contract, does not review its own code, and does
  not publish.
- **Gatekeeper**: no-mistakes is the normal publisher. It validates, pushes,
  and opens/updates the PR.
- **Human**: owns merge decisions and intent-touching escalations.

Hard rule: `reviewer != coder`.

## Implemented Loop

1. `combo-chen run --issue <url>` or `combo-chen run --plan <file>` runs overture
   first: deterministic launch runway checks are recorded to `overture.json`
   before any agent tokens are spent or tmux role windows are started. On
   success it leases an isolated Treehouse worktree, creates the combo branch
   inside it, writes `runner.sh`, starts tmux, and journals `combo_created`.
2. Coder/gnhf runs in the worktree and commits locally.
3. no-mistakes validates and publishes the initial PR. If the initial gate
   fails before the PR opens, the director auto-retries it up to configured
   `initial_gate_retry_attempts` with `initial_gate_retry_backoff_seconds`
   delay; after exhausting retries it journals `needs_human reason=gate_failed`.
4. After `pr_opened`, `director-watch` is the single observer. Reviewer and
   gatekeeper windows were precreated at launch, and coder-response prompts
   route through the persistent coder window by default; a configured
   `coder-responding` window remains only as a compatibility bridge for older
   capsules. Reviewer verdict codes drive deterministic routing: code 0 feeds
   the LGTM journal path, code 1 nudges coder-response, code 2 prompts the
   director, and code 3 journals
   `needs_human`. On each tick the director also updates the PR's GitHub
   labels to project the live combo state (`combo:working-*`, `combo:lgtm`,
   `combo:external-review-green`, `combo:ready`, `combo:stale`, `combo:conflict`).
5. Review comments are routed to the resumed coder thread. Mechanical fixes are
   handled locally; intent-touching decisions emit `needs_human`.
6. Local addressing commits trigger a generated-script post-address
   no-mistakes gate. The script publishes `HEAD:refs/heads/<branch>` to the
   no-mistakes mirror with `--force-with-lease` when replacing an existing
   mirror branch; the tmux command stays short (`sh <script>`).
7. READY is journaled only when all current-head signals agree:
    gate validated the PR head SHA, reviewer LGTM is pinned to that SHA by a
    configured reviewer GitHub login, every configured required READY check is
    present with SUCCESS, and the remaining CI/check rollup is successful for
    that SHA. If GitHub later reports an open READY PR as dirty or conflicting
    after the base advances, the director journals `pr_conflict`, invalidates
    READY back to REVIEWING, and nudges coder-response to rebase.
8. After the human merges the PR, the director-watch loop detects the merge
   on its next tick and auto-triggers `closure` convergence: it verifies
   GitHub reports MERGED, records any missing `merged` event, refuses
   teardown while no-mistakes is active, returns the Treehouse worktree lease,
   removes the branch, journals `combo_closed`, and kills the tmux session.
   The manual `combo-chen closure -n <combo-id>` remains as a fallback.
   The reviewer and director-watch report the closure command to run when
   `combo_closed` is already journaled. Reconcile can record a
   missing merge fact but similarly defers resource convergence to closure.

Rate limits and transient GitHub/git/tmux errors are operational events. Log a
concise note, keep the director loop alive when possible, and re-evaluate on
the next tick.

## Branch And Worktree Ownership

- One branch has one owner. Do not share a work branch between agents.
- Combo worktrees live under the project `.worktrees/` directory.
- Scratch artifacts live under the project `.tmp/` directory.
- Do not create project worktrees under system temp directories or unrelated
  external scratch locations unless explicitly instructed.
- Preserve unrelated user changes. Never reset or checkout away work you did
  not create.

## no-mistakes Config Artifact

The source checkout may have a repo-level `.no-mistakes.yaml` with explicit
test, lint/typecheck, and build commands. In combo-chen itself this file is
tracked on purpose so the validation contract is pinned for every worker and
gate. User-local secrets and operator preferences belong in ignored local
config such as `combo-chen.toml` or the user's environment, not in the tracked
no-mistakes policy file. Target repos may also provide the same file as local
ignored config; git worktrees do not materialize ignored working-tree files
automatically. In both cases, combo-chen propagates the config in two phases:

1. **Repo → worktree copy.** When the source config exists and the worktree
   config is missing, combo-chen copies `<repoDir>/.no-mistakes.yaml` to
   `<worktree>/.no-mistakes.yaml` before each gate run. The copy preserves
   content and mode and never overwrites an existing worktree config.

2. **Worktree → daemon worktree copy.** Before running the gate command, the
   generated gate script copies `.no-mistakes.yaml` from the combo worktree
   into the no-mistakes daemon's active run worktree so the gate runner has it.
   It polls `no-mistakes status` to discover the daemon's worktree path and
    retries up to `COMBO_CHEN_NO_MISTAKES_CONFIG_COPY_ATTEMPTS` times (default
    120, 1 s delay). The gate runs in parallel with the config copy watcher,
    but a successful gate that finishes before the config copy completes is
    rejected so validation stays deterministic. A config-copy failure remains
    a gate failure even when no-mistakes output would otherwise match the
    checks-passed plus context-canceled recovery path.

Do not remove the tracked repo-level `.no-mistakes.yaml`; update it only when
the shared validation commands intentionally change.

## Development Discipline

- TDD is mandatory for behavior changes: write the failing test first, then
  implement.
- Keep operational values configurable through env, TOML, then fallback.
- Use focused tests for orchestration contracts and broaden only when shared
  behavior changes.
- Validate with `pnpm test`, `pnpm typecheck`, `pnpm build`,
  `pnpm slop:check`, and `git diff --check` before committing.
- Use short conventional commits. No co-authors.

## Sherpa Navigation

Source files carry Sherpa-style navigable headers:

- read `@overview` first;
- follow the READING GUIDE to the core section;
- use `// -- N/M` markers instead of reading top-to-bottom;
- keep the header and marker map current when editing touched files.

## Status

v0 implements the work-item-to-PR loop under the parallelize-first operating
contract: deterministic overture launch runway with declared team identity
check (opt-in `[team]` block, resolves effective role identities,
hard-fails on mismatch, journals `team` event),
coder/gnhf, no-mistakes initial and
post-address gates with automatic initial-gate retry, reviewer with
machine-readable verdict codes (0-3) and deterministic routing, reviewer re-review,
lazy coder-response routing through the persistent coder window by default
(legacy `coder-responding` compatibility window only when configured), single `director-watch`
observation with compact per-tick operator status lines, frozen journal
`reconcile` repair for closed PRs (preserving all worktrees on close),
merged-PR `reconcile` with merge-fact recording only (resource convergence
deferred to `closure`), deterministic `closure` with director-watch auto-trigger
for post-merge local resource convergence, director prompt delivery for code-2
verdicts, no-mistakes config propagation,
read-only forensics reports with copy-ready Outcome blocks and markdown-only
`--record-outcome` for posting dogfood outcomes to GitHub issues, coder safety
validation (pinned gnhf with `--max-iterations`, `--stop-when`, stdin closed),
`park`/`resume` for reboot-safe capsule handoff, the parallel capsule dashboard
(`status`; actionable by default, `--all` for history, `--deep` for downstream
probes, auto-reconcile + tmux liveness), launch-time config snapshots for
deterministic runtime behavior, a machine-readable runtime ledger for each combo
capsule, branch-scoped gate leases for parallel capsules with stale recovery and
heartbeat, promptable director window inside each combo capsule (non-polling
contract, prompted by director-watch only for ambiguity or uncoded recovery),
wave-based parallel scaling (start 2 capsules, then 3, then 4-6 with postmortem
justification), explicit coder terminal outcomes (`coder_done` trust over dead-looking panes) before worker recovery, pre-PR dead coder recovery with bounded restarts before `needs_human` escalation,
stalled coder-response recovery with bounded retries,
configurable worker permission-prompt recovery (auto-approve, recreate, or escalate) with bounded retries, orchestrator evidence consulted before worker stall escalation (gnhf run active, gate run active, external review active, reviewer artifact recent),
current-head READY agreement with base-advance conflict
detection, live GitHub PR label projection with mutation journaling,
human-readable tmux topology (fixed tmux role topology: journal, director,
coder, gatekeeper, reviewer, and director-watch in that stable order;
gatekeeper and reviewer are precreated at launch; coder-response target
defaults to the persistent coder window; raw event output never replaces the
coder role), opt-in runner
progress status lines
(`COMBO_CHEN_RUNNER_PROGRESS=1`), mandatory Treehouse-backed worktree
leases, coder helper preflight (use `pnpm surface` when the target repo exposes
it; otherwise search before adding helpers), reviewer anti-slop guardrails
(duplicate helper check, config plausibility, surface budget awareness),
anti-slop surface probes (`pnpm slop:check`, `pnpm slop:report`,
`pnpm surface`), and `needs-human-report` operational metrics.
Deferred: issue preflight scoring, counterfactual
automerge log, and ACP role driving.
