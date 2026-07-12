# combo-chen Agent Contract

combo-chen is a deterministic director harness for autonomous work-item-to-PR
work. It coordinates existing tools; it does not collapse their roles.

## Role Boundaries

- **Director**: orchestrates only. Starts phases, watches hard signals, writes
  journal events, routes work, and escalates `needs_human`. It does not edit
  code, answer review threads, approve PRs, push, merge, or deploy.
- **Coder**: implements the work item and later resumes the same thread for local
  verdict fixes or post-publish review comments. The coder leaves local commits
  in the combo worktree and does not push to origin or the PR branch in the
  normal path.
- **Reviewer**: reviews the local changeset before publication and writes a
  schema-versioned verdict file with routing codes (0=OK/LGTM, 1=mechanical
  fix→coder, 2=ambiguous→director/human, 3=needs_human). It never writes to
  GitHub, does not review its own code, and does not publish.
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
3. The local reviewer writes `verdict-<round>.json`; the capsule routes its
   verdict code deterministically and records local LGTM evidence without using
   GitHub comments or reviewer logins.
4. no-mistakes validates and publishes the initial PR. If the initial gate
   fails before the PR opens, the director auto-retries it up to configured
   `initial_gate_retry_attempts` with `initial_gate_retry_backoff_seconds`
   delay; after exhausting retries it journals `needs_human reason=gate_failed`.
5. After `pr_opened`, `director-watch` is the single observer. The local
   reviewer is never prompted to GitHub; post-publish review comments route
   through the persistent coder window. On each tick the director projects the
   monotonic PR labels `combo:working` → `combo:ready` → `combo:merged`, with
   `combo:conflict` as the explicit non-monotonic exception.
6. Review comments are routed to the resumed coder thread. Mechanical fixes are
   handled locally; intent-touching decisions emit `needs_human`.
7. Local addressing commits trigger a generated-script post-address
   no-mistakes gate. The script publishes `HEAD:refs/heads/<branch>` to the
   no-mistakes mirror with `--force-with-lease` when replacing an existing
   mirror branch; the tmux command stays short (`sh <script>`).
8. READY is journaled only when all current-head signals agree: the local LGTM
   survives publication by patch-id equivalence, gate validated the PR head,
   every configured required READY check is present with SUCCESS, the remaining
   CI/check rollup is successful, and external-review evidence is clean for that
   head. If GitHub later reports an open READY PR as dirty or conflicting
   after the base advances, the director journals `pr_conflict`, invalidates
   READY back to REVIEWING, and nudges coder-response to rebase.
9. After the human merges the PR, the director-watch loop detects the merge
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
- Validate with `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:sh`,
  `pnpm format:check`, `pnpm build`, `pnpm slop:check`, and
  `git diff --check` before committing.
- eslint exceptions live in `eslint.config.mjs`, never as inline
  `eslint-disable` comments; prefer a compliant rewrite over any exception.
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
post-address gates with automatic initial-gate retry, local reviewer verdict
files with machine-readable codes (0-3) and deterministic routing, local
re-review, coder-response routing through the persistent coder window, single `director-watch`
observation with compact per-tick operator status lines, frozen journal
`reconcile` repair for closed PRs (preserving all worktrees on close),
merged-PR `reconcile` with merge-fact recording only (resource convergence
deferred to `closure`), deterministic `closure` with director-watch auto-trigger
for post-merge local resource convergence, needs-human routing for ambiguous
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
configurable worker permission-prompt recovery (auto-approve, recreate, or escalate) with bounded retries, orchestrator evidence consulted before worker stall escalation (gnhf run active, gate run active, reviewer artifact recent),
current-head READY agreement with base-advance conflict
detection, monotonic GitHub PR label projection with mutation journaling,
human-readable tmux topology (fixed tmux role topology: journal, director,
coder, gatekeeper, reviewer, and director-watch in that stable order;
gatekeeper and reviewer are precreated at launch; the reviewer performs no
post-publish GitHub writes; coder-response targets the persistent coder window;
raw event output never replaces the
coder role), opt-in runner
progress status lines
(`COMBO_CHEN_RUNNER_PROGRESS=1`), mandatory Treehouse-backed worktree
leases, coder helper preflight (use `pnpm surface` when the target repo exposes
it; otherwise search before adding helpers), reviewer anti-slop guardrails
(duplicate helper check, config plausibility, surface budget awareness),
anti-slop surface probes (`pnpm slop:check`, `pnpm slop:report`,
`pnpm surface`), and `needs-human-report` operational metrics.
v1 foundations: v1 journal events + LOCAL_REVIEW phase + schema_version (W1),
pure status fold + `recap` subcommand (W7a), and the Ink/React TUI home (fleet
view, W7c): bare `combo-chen` on a TTY opens the home; the TUI substrate is
pure folds in `src/app/tui/` (fleet-fold, navigation) rendering from journal +
combo + injected liveness; Ink 6.8.0 + React 19.2.7 bundled single-file via
tsdown `codeSplitting: false` + react-devtools-core alias stub.
W5a adds the pre-publish verdict artifact + one capsule review round: the
schema, checklist contract, and finding-fingerprint semantics live in
`src/core/verdict.ts`; the tier-2 dossier renders deterministically from the
verdict (`src/core/review-dossier.ts`); the versioned local review prompt with
critical-surfaces calibration is `localReviewerPrompt` in
`src/roles/reviewer-invocation.ts`; the capsule runs the round between coder
and gate.
W5b turns that round into the V-C-V loop (PRD s3) in
`src/app/capsule/capsule.ts`: code 1 resumes the implementing thread as an
owned child (`buildCoderFixTurnCommand` + `buildReviewFixPrompt`), judges the
fix turn by process exit + new-commit count, then re-reviews; the loop opens
and closes with a verdict. Owned turns are wall-clock bounded by the frozen
`[review]` timeouts (custody SIGTERM/SIGKILLs on expiry; timeouts, spawn
rejection, and failed commit counts each escalate with their own reason).
Guards: same finding fingerprint surviving two consecutive rounds
(`findingsSurvivingRound` over the persisted survival map, restart-safe), a
no-op fix turn, and the `[review].max_rounds` cap (default 3,
snapshot-frozen; pre-W5b snapshots backfill defaults in readConfigSnapshot)
all escalate needs_human carrying the findings. Loop position persists in the
tier-1 `loop-state.json` (`src/core/loop-state.ts`, write-then-rename), and
`resolveLoopEntry` resumes the exact next action from journal + loop-state
(round numbers never reused; orphan verdict artifacts consumed; interrupted
fix turns judged by commit observables; pending escalations park until a
retry decision). `combo-chen decide -n <id> <verb>` answers a pending
needs_human with a `decision` event (verbs: retry, skip, take_over, ignore);
journal timestamps are unique per append, and deriveStatus resolves
escalations per needs_human_ref, keeping other pending escalations visible.
W6c adds the PR body dossier projection (`src/core/pr-body-dossier.ts`) and
permanent exit summary (`src/core/exit-summary.ts`): the dossier edits the PR
body via `gh pr edit --body-file` (same pattern as ensurePrAutoclose in
`src/app/github/github-handlers.ts`) with a marker-delimited section;
re-projection is idempotent. The projection trigger is not yet wired — the
natural call site is the post-publish external-review-green leg in the
capsule's CodeRabbit-round handling; `updatePrBodyDossier` is ready to call
when that leg lands. The exit summary folds over verdict files + journal
events and is emitted at closure (file + stdout).
W6a adds the patch-id READY core for capsule runs (D3: whole-range
`git patch-id --stable`, primitive in `src/core/patch-id.ts`): a code-0
verdict pins `lgtm {sha, patch_id}`; after the gate publishes, the carry-over
(`src/app/capsule/ready.ts`) re-pins across pure rebases and on mismatch
journals `lgtm_stale` + `local_review_requested` (re-review round, never
needs_human). `capsuleReadyAgreement` is the four-leg deterministic READY
fold; the findings-aware external-review leg (#295 slice B: SUCCESS check is
not review evidence) reads reviews + threads via
`src/app/github/review-evidence.ts`. v0 sha-equality READY stays untouched
until the contract flip (W6b).
Deferred: issue preflight scoring, counterfactual
automerge log, and ACP role driving.

v1 (integration line `main-v1`) adds an opt-in capsule engine:
`[run] engine = "capsule"` (env `COMBO_CHEN_RUN_ENGINE`), snapshot-frozen at
launch. It replaces `runner.sh` with `combo-chen capsule <run-dir>` as tmux
pane 0, shrinks the topology (no director-watch shell loop or gate-script
windows; journal, director, coder, gatekeeper, reviewer remain), retries the
initial gate inside the capsule, and supervises post-PR through the in-process
event-driven supervisor (`src/app/director/supervisor.ts`: journal fs.watch
wake with poll fallback, GitHub sampling timer, journal-derived terminal exit,
`watch_error`/`watch_dead` parity). `combo-chen capsule` re-derives its phase
from the journal (`classifyCapsulePhase`), so resume relaunches the same
command; worker-monitor liveness evidence is injectable per role
(`WorkerEvidenceSource`). v0 stays the default and byte-identical.
`--prompt` overrides are not yet supported under the capsule engine.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
