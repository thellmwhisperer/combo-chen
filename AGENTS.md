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
   inside it, starts tmux, and journals `combo_created`.
2. The capsule engine runs in pane 0 as `combo-chen capsule <run-dir>`. It
   replaces the retired `runner.sh` shell script and `director-watch-loop.sh`.
3. Coder/gnhf runs in the worktree and commits locally.
4. The local reviewer writes `verdict-<round>.json`; the capsule routes its
   verdict code deterministically and records local LGTM evidence without using
   GitHub comments or reviewer logins.
5. The capsule runs the V-C-V review loop with bounded rounds: code-1 verdicts
   resume the implementing thread for mechanical fixes, code-0 verdicts
   advance to gate. Owned turns are wall-clock bounded; same-finding survival
   and no-op fix turns escalate `needs_human`; the loop is capped by
   `[review].max_rounds` (default 3).
6. The in-process gate (`src/app/gate/in-process-gate.ts`) validates through
   no-mistakes without shell templates. An initial-gate failure auto-retries
   up to `initial_gate_retry_attempts` with `initial_gate_retry_backoff_seconds`
   delay; after exhausting retries it journals `needs_human reason=gate_failed`.
7. no-mistakes publishes the initial PR.
8. Post-publish, the in-process supervisor (`src/app/director/supervisor.ts`)
   observes via journal `fs.watch` with poll fallback and GitHub sampling.
   Post-publish review comments (CodeRabbit rounds) route through the
   persistent coder window. The local reviewer is never prompted to GitHub.
9. Patch-id LGTM carry-over (`src/core/patch-id.ts`): a code-0 verdict pins
   `lgtm {sha, patch_id}`; after gate publishes, the carry-over re-pins across
   pure rebases and on mismatch journals `lgtm_stale` + `local_review_requested`
   (re-review round, never needs_human). `capsuleReadyAgreement` is the
   four-leg deterministic READY fold.
10. The director projects monotonic PR labels `combo:working` → `combo:ready` →
    `combo:merged`, with `combo:conflict` as the explicit non-monotonic
    exception. READY is journaled only when all current-head signals agree.
11. Review comments are routed to the resumed coder thread. Mechanical fixes
    are handled locally; intent-touching decisions emit `needs_human`.
12. After the human merges the PR, the supervisor detects the merge and
    auto-triggers `closure` convergence: it verifies GitHub reports MERGED,
    records any missing `merged` event, refuses teardown while no-mistakes is
    active, returns the Treehouse worktree lease, removes the branch, journals
    `combo_closed`, and kills the tmux session. The manual
    `combo-chen closure -n <combo-id>` remains as a fallback. Reconcile can
    record a missing merge fact but similarly defers resource convergence to
    closure.

Rate limits and transient GitHub/git/tmux errors are operational events. Log a
concise note, keep the supervisor alive when possible, and re-evaluate on the
next tick.

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
   in-process gate copies `.no-mistakes.yaml` from the combo worktree into the
   no-mistakes daemon's active run worktree so the gate runner has it. It polls
   `no-mistakes status` to discover the daemon's worktree path and retries up
   to `COMBO_CHEN_NO_MISTAKES_CONFIG_COPY_ATTEMPTS` times (default 120, 1 s
   delay). The gate runs in parallel with the config copy watcher, but a
   successful gate that finishes before the config copy completes is rejected
   so validation stays deterministic. A config-copy failure remains a gate
   failure even when no-mistakes output would otherwise match the
   checks-passed plus context-canceled recovery path.

Do not remove the tracked repo-level `.no-mistakes.yaml`; update it only when
the shared validation commands intentionally change.

## Development Discipline

- TDD is mandatory for behavior changes: write the failing test first, then
  implement.
- Keep operational values configurable through env, TOML, then fallback.
- Use focused tests for orchestration contracts and broaden only when shared
  behavior changes.
- Validate with `pnpm test`, `pnpm typecheck`, `pnpm lint`,
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

v1 implements the work-item-to-PR loop with the capsule as the only engine.
v0 and its shell substrate are retired: the `runner.sh` shell script,
`director-watch-loop.sh`, and all 22 shell gate templates are deleted.
The gate is in-process (`src/app/gate/in-process-gate.ts`); the
in-process event-driven supervisor (`src/app/director/supervisor.ts`)
replaces the shell-based director-watch loop. Frozen pre-v1 config snapshots
(missing or `v0` engine) migrate deterministically to capsule on read, and
`resume` rewrites the artifact before topology changes; unknown engines fail
closed.

Active features:

- Deterministic overture launch runway with declared team identity check
  (opt-in `[team]` block, resolves effective role identities, hard-fails on
  mismatch, journals `team` event)
- Coder/gnhf with safety validation (pinned gnhf with `--max-iterations`,
  `--stop-when`, stdin closed)
- Local reviewer verdict files with machine-readable codes (0-3) and
  deterministic routing; the V-C-V review loop (`src/app/capsule/capsule.ts`)
  with bounded rounds (cap `[review].max_rounds`, default 3), fingerprint
  survival detection, and no-op fix turn escalation
- In-process initial gate with automatic retry
  (`src/app/gate/in-process-gate.ts`)
- no-mistakes config propagation (repo → worktree → daemon worktree copy)
- Patch-id LGTM carry-over (`src/core/patch-id.ts`): code-0 verdict pins
  `lgtm {sha, patch_id}`; carry-over (`src/app/capsule/ready.ts`) re-pins
  across pure rebases, journals `lgtm_stale` + `local_review_requested` on
  mismatch (re-review round, never needs_human)
- `capsuleReadyAgreement`: four-leg deterministic READY fold; external-review
  leg reads reviews + threads via `src/app/github/review-evidence.ts`
- PR body dossier projection (`src/core/pr-body-dossier.ts`): idempotent
  marker-delimited PR body edits via `gh pr edit --body-file`; the projection
  trigger is not yet wired (natural call site: post-publish CodeRabbit-round
  handling)
- Permanent exit summary (`src/core/exit-summary.ts`): folds over verdict
  files + journal events, emitted at closure
- Post-publish review comments (CodeRabbit rounds) route through the
  persistent coder window; mechanical fixes handled locally, intent-touching
  decisions emit `needs_human`
- Monotonic GitHub PR label projection (`combo:working` → `combo:ready` →
  `combo:merged`) with mutation journaling; `combo:conflict` as the explicit
  non-monotonic exception
- Current-head READY agreement with base-advance conflict detection
- Deterministic `closure` with supervisor auto-trigger on merge detection;
  manual `combo-chen closure -n <combo-id>` as fallback
- Frozen journal `reconcile` repair for closed PRs; merged-PR `reconcile`
  with merge-fact recording only (resource convergence deferred to `closure`)
- `park`/`resume` for reboot-safe capsule handoff; loop position persists in
  `loop-state.json` (`src/core/loop-state.ts`, write-then-rename);
  `resolveLoopEntry` resumes the exact next action
- `combo-chen decide -n <id> <verb>` for answering pending needs_human
  escalations (verbs: retry, skip, take_over, ignore)
- Parallel capsule dashboard (`status`; actionable by default, `--all` for
  history, `--deep` for downstream probes, auto-reconcile + tmux liveness)
- Launch-time config snapshots for deterministic runtime behavior;
  machine-readable runtime ledger per combo capsule
- Branch-scoped gate leases for parallel capsules with stale recovery and
  heartbeat
- Promptable director window inside each combo capsule (non-polling contract)
- Wave-based parallel scaling (start 2 capsules, then 3, then 4-6 with
  postmortem justification)
- Explicit coder terminal outcomes (`coder_done` trust over dead-looking
  panes) before worker recovery; capsule-owned pre-PR dead coder recovery
  (bounded capsule pane relaunches before `needs_human`); stalled
  coder-response recovery with bounded retries
- Snapshot-frozen per-role tool allowlists; permission prompts journal typed
  tool/command learning signals and escalate decision cards for grant → config
  allowlist update → turn retry convergence (never silent approval)
- Human-readable tmux topology (capsule engine in pane 0, plus journal,
  director, coder, gatekeeper, and reviewer windows; no director-watch window;
  D1 seats: capsule-owned role children — initial coder pass, verdict rounds,
  fix turns — run their stdio on the role window's pane tty
  (`resolveRoleSeatTty`/`seatOccupancy` in `src/app/runtime/sessions.ts`;
  occupancy requires the live pane AND an active role child pid from spawn
  facts, so the idle placeholder never counts as occupied), so each agent is
  visible and interactive in its named window while the capsule keeps real
  exit codes and timeout custody; a seat that cannot be resolved or opened
  escalates `needs_human seat_unavailable` after bounded retries
  (env `COMBO_CHEN_SEAT_RESOLVE_ATTEMPTS`/`_RETRY_MS`) — a role child never
  runs unseated in the capsule pane;
  the gatekeeper window entry is the static `no-mistakes attach` one-liner;
  reviewer performs no post-publish GitHub writes; coder-response targets the
  persistent coder window; raw event output never replaces the coder role)
- Ink/React TUI home (fleet view): bare `combo-chen` on a TTY opens the
  home; pure folds in `src/app/tui/`; Ink 6.8.0 + React 19.2.7 bundled
  single-file via tsdown `codeSplitting: false` + react-devtools-core alias
  stub; live-actor telemetry (gnhf iteration/tokens from `.gnhf` files, commit
  count/last subject from git rev-list, gate steps from no-mistakes axi status)
  enriches fleet detail lines and dive-in live actor entries with animation
  (fleet rows: dot train; dive-in live actor: braille loop spinner; 200ms
  cadence, `COMBO_CHEN_TUI_ANIM_MS`); dive-in thread is viewport-bounded
  (`viewportRows` prop, `boundEntriesForViewport` in `home.tsx`) so the title
  bar and footer stay visible and Ink's log-update can erase prior frames;
  telemetry readers (`src/app/tui/telemetry-readers.ts`) are entry-layer I/O,
  pure formatting in `src/app/tui/live-telemetry.ts`; NEVER reads tmux panes;
  bare `combo-chen` inside tmux delegates to the managed `combo-chen-home`
  session and exits 0 BY DESIGN (`runTuiHome` → `homeSessionActions`) — a dead
  pane with exit 0 in a scripted tmux test is normal launcher delegation, not a
  crash; set `COMBO_CHEN_TUI_DIRECT=1` to run the renderer in-place
- `recap` subcommand; v1 journal events + LOCAL_REVIEW phase + schema_version
- Coder helper preflight (use `pnpm surface` when the target repo exposes it;
  otherwise search before adding helpers); reviewer anti-slop guardrails
  (duplicate helper check, config plausibility, surface budget awareness);
  anti-slop surface probes (`pnpm slop:check`, `pnpm slop:report`,
  `pnpm surface`)
- `needs-human-report` operational metrics
- Read-only forensics reports with copy-ready Outcome blocks and markdown-only
  `--record-outcome` for posting dogfood outcomes to GitHub issues

Deferred: glance pane, forge connectors, auto-merge opt-in, CodeRabbit
findings-aware READY leg wiring, issue preflight scoring, counterfactual
automerge log, and ACP role driving.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
