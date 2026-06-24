# The Combo Chen Protocol — spec v1

A combo chen is an autonomous work-item → PR pipeline run by fixed roles filled
by configurable agents. Work items can be GitHub issues or local markdown work
plans. This spec is the constitution: the CLI, the event schema, and the config
schema must conform to it, not the other way around.

## 1. Roles

| Role | Does | Never does | Default agent |
| --- | --- | --- | --- |
| **director** | launches phases, consumes events, reports status, escalates to the human | touch code, answer review threads | any (claude /loop, codex, human) |
| **coder** | implements the work item (phase 1); the same thread resumes in responding mode for review comments (phase 3) | merge, deploy | codex via gnhf |
| **gatekeeper** | no-mistakes pipeline review→test→docs→lint→push→PR (publish-only; combo-chen appends `--skip=ci`). The gatekeeper command supports {issue_url}, {issue_title}, {issue_body}, {issue_pr_intent}, {branch} placeholders expanded at runner generation. For plan-backed combos, {issue_pr_intent} carries the rendered work-plan intent; other issue-specific placeholders are unsupported and cause a config error. | answer review threads | agent from `.no-mistakes.yaml` (e.g. `acp:hermes-deepseek`) |
| **reviewer** | reviews the PR with configured prompt text, emits machine-readable verdict codes (0–3), incrementally until merge | review its own changes | claude |
| **merge** | the decision slot | — | human (hard default) |

Validation at launch (hard failures, the combo refuses to start):

- `combo-chen overture` runs a deterministic launch runway before any agent tokens
  are spent or tmux windows are created. `combo-chen run` consumes the same
  overture logic internally. A failing check prints `X <check>: <resource> <detail>`
  and exits before creating worktrees, branches, or tmux sessions.
- Checks: work_item_readable, repo_exists, repo_matches_issue,
  source_checkout_clean, base_ref_resolved, combo_id_valid, run_dir_free,
  branch_free, worktree_free, tmux_session_free, config_parses,
  coder_command_safe, reviewer_command_safe, no_mistakes_available,
  no_mistakes_run_free, no_mistakes_config_predictable.
- The result is written as a machine-readable `overture.json` artifact in the
  combo run directory when the run directory is available, recording all
  resources the run is allowed to create and every check result. A
  run-directory collision blocks launch before an overture artifact can be
  written.
- `reviewer != coder` — no agent reviews its own changes.
- every role resolves to an available agent (binary present, auth alive).
- the source checkout is clean and on `[run].source_branch` (default `main`,
  env override `COMBO_CHEN_SOURCE_BRANCH`); local dirty state or launching from
  another branch is a hard error.
- the combo branch is created from `origin/main` by default, or from the
  explicit `--base <ref>` supplied to `combo-chen run`.
- gnhf coder commands must be safe runner commands before any worktree is
  created: pinned `gnhf@<version>`, `--max-iterations`, `--stop-when`,
  `--prevent-sleep on`, and telemetry/noise disabled with
  `--meteor-frequency 0`. The runner also closes coder stdin. gnhf 0.1.41
  selects Codex with `--agent codex` but does not expose a general Codex CLI
  profile/flag pass-through, so role-specific Codex terminal flags belong in
  the resume command or in an explicit repo-owned wrapper.
- reviewer submit commands must be safe before launch: one plain command, no
  heredocs, temp files, `cat`, `rm`, shell redirection, pipes, semicolons,
  `&&`, or `||`. The generated prompt tells reviewers to submit with
  `gh pr review <pr-url> --comment --body "<body>"`.
- After launch, all runtime behavior (director polling cadence, gatekeeper
  command, reviewer settings, teardown retries) reads from the per-run
  `config.snapshot.json` artifact, not from the mutable repo TOML. This
  prevents runtime drift when repo config changes during a long-running combo.

## 2. Phases and transitions

```text
OVERTURE    deterministic launch runway: checks work-item readability, repo/issue
  │           match, clean source checkout, base ref, branch/worktree/tmux
  │           availability, run dir reuse, config parse, coder/reviewer command
  │           safety, no-mistakes availability and run conflict. Blocked checks
  │           print an X with the failing resource and exit before creating any
  │           launch resources. Writes overture.json when the run dir is available.
  └─▶ SETUP      clean main verified, worktree acquired from base ref under project .worktrees/, tmux session up
  └─▶ CODING     gnhf loop; ends with coder_done + captured thread_id
        └─▶ GATING     gate_started; publishes HEAD to the no-mistakes mirror (with --force-with-lease and base64-encoded intent) via generated shell script, then no-mistakes pipeline (publish-only, --skip=ci); ends with pr_opened, gate_failed (exit_code), or awaiting_approval (needs_human reason=gate_waiting). A pre-PR gate_failed triggers automatic director retry up to the configured [gatekeeper].initial_gate_retry_attempts with [gatekeeper].initial_gate_retry_backoff_seconds delay; exhausting retries journals needs_human reason=gate_failed.
              └─▶ REVIEWING  director-watch observes reviewer verdict signals (machine-readable codes 0–3), reviewer LGTM pins, coder responding mode workers, and live PR label sync; code-2 verdicts prompt the director via `director_prompted`
                    └─▶ READY      gate_current ∧ reviewer_current ∧ required_checks_current_success ∧ ci_current_success
                          └─▶ MERGED | CLOSED   (human, or earned automerge)
```

Any phase can transition to `STALLED` (timeout, rate limit, agent death) —
a director concern, never a silent state.

For `combo-chen run --issue <issue-url>`, the default gatekeeper intent is derived
from the ComboRecord issue URL and issue details and includes a PR body
requirement to preserve the exact visible line `Fixes #N`. For `combo-chen run
--plan <file>`, the intent is derived from the normalized work-plan artifact and
does not inject autoclose keywords unless the plan explicitly asks for one — the
autoclose guard is skipped and the PR body describes the work-plan source and
completed acceptance criteria. That explicit
autoclose keyword is required for generated issue PRs; a plain mention such as
`issue #N` is not treated as sufficient. Custom gatekeeper commands that still
create source-issue PRs must preserve `{issue_pr_intent}` or provide an
equivalent GitHub autoclose keyword in the PR/body generation path.
After a PR URL exists, the hidden autoclose guard reads the PR body, edits it
if needed, then reads it again and verifies the visible autoclose keyword is
present. A guard failure journals `pr_autoclose_failed` (required fields
`exit_code`, `url`), marks the gate `failed`, and exits non-zero instead of
continuing to `pr_opened` or `gate_validated`.
New generated gate scripts do not emit the legacy `needs_human
reason=pr_ready` handoff: `pr_opened` means the reviewer path has been
started, `needs_human reason=pr_missing` is the blocked no-PR case, and
`ready_for_merge` is the only READY transition.

A recoverable coder failure journals `coder_retry` (no required fields) and
the loop restarts; repeated failures transition to `STALLED`.

Before the coder starts, the runner fetches and rebases the worktree onto the
launch base ref (`origin/main` by default, or `--base <ref>`). A fetch failure
journals `rebase_failed` (required field `base`) and exits 1; a merge-conflict
rebase failure journals
`rebase_conflict` (required field `base`) and exits 1. Both events
transition the combo immediately to `STALLED`.

A terminal coder failure (non-zero exit) journals `coder_failed` (required
fields: `exit_code`, `has_new_commits`). An empty or non-numeric exit code
is sanitized to 1 before journaling. The runner captures the git HEAD
before and after the coder run: `base_sha`, `head_sha`, and
`new_commit_count` quantify what — if anything — the coder committed before
failing. `coder_failed` transitions the combo immediately to `STALLED`.

When no-mistakes detects that the gate requires approval (the
`outcome: awaiting_approval` pattern in its output), the runner emits
`gate_status` with `state=awaiting_approval` and `needs_human` with
`reason=gate_waiting`, then exits 0. The combo stays in `GATING` until a
human resolves the gate.

Note: this path does not emit `pr_opened`; downstream automations that
depend on `pr_opened` (reviewer activation, coder-response nudging, status PR
updates) do not start until the gate is resolved or the PR is journaled by
another path.

## 3. Post-PR loops and their boundary

- **gatekeeper** (no-mistakes): publish-only. Validates and publishes
  the PR. combo-chen appends `--skip=ci` so the gate runs without CI
  monitoring. Verified: it never reads or answers review threads.
- **coder responding mode** (the resumed coder): conversation signals only.
  Reads new review comments, answers them, and leaves committed local changes.

**Publish boundary:** coder responding mode never pushes directly to origin or
the PR branch. Any addressing commit it creates is routed back through the
gatekeeper/no-mistakes gate, which validates the new HEAD and publishes it.
If the gatekeeper already has a gate in flight, combo-chen defers the next
gate instead of starting a second publisher.
On every director tick, combo-chen also compares `origin/<branch>`
with the `no-mistakes` mirror and syncs the mirror when it is stale, using
`--force-with-lease` when reconciling an existing mirror branch.
The gatekeeper is the only normal publisher for addressing commits.

The generated director-watch polling loop (`director-tick`) has built-in
resilience: on transient failures (rate limits, network errors), it journals
a `watch_error` event and retries with exponential backoff (base poll
interval × 2ⁿ, capped by `[limits].watch_backoff_max_seconds`, default
3600 s). After `watch_failure_limit` consecutive failures (default 5,
configurable via `[limits].watch_failure_limit`), it journals `watch_dead`
and exits so the human/operator can restart or inspect the combo. On a
successful tick the failure counter and backoff reset.

`gate_started` marks the beginning of the gatekeeper lifecycle.  The
`gate_status` event records the gatekeeper's ongoing lifecycle: `fix_inflight`
(the branch-scoped lease was acquired and no-mistakes is running), `awaiting_approval`
(gate requires human sign-off), `failed` (non-zero exit), or `idle` (gatekeeper
completed successfully, awaiting PR detection). Older journals may also contain
`queued` from the former repo-global lease path. On successful completion the gate emits
`gate_validated` (required field `sha`) alongside the `idle` gate status,
recording the PR `headRefOid` when a PR exists, otherwise the local worktree
HEAD. Post-address gates run the PR autoclose
guard before emitting `gate_validated`, so a successful no-mistakes run cannot
be promoted to READY while the PR body still lacks a recognized closing
keyword. Automatic initial-gate retry paths follow the same start-before-terminal
contract: when the director cannot launch the retry script, it journals
`gate_started` (`source=director_retry`) immediately before `gate_failed`
(`reason=retry_start_failed`).

The hidden `gate-lease acquire` command scopes leases by branch. Different
branches acquire independently. When the same branch is owned by a different
combo, it returns exit code 76 and journals
`needs_human reason=gate_lease_conflict` with the active owner's branch,
worktree, and run directory. Exit code 75 is reserved for legacy repo-global
contention and is treated as a queued no-op by generated scripts.

When the worktree HEAD moves past the last validated or published SHA, the
director journals `gate_stale` (fields `old_sha`, `new_sha`) to mark the old
validation as superseded and trigger a post-address gate.  The director
detects the stall by comparing the worktree HEAD against
`latestPublishedGateSha` on each tick.

When the director detects committed but unpublished addressing changes in the
worktree after an actionable `review_comment` nudge, it journals `address_done`
(required field `head_sha`) to lock in the addressing commit before starting a
post-address no-mistakes gate. `review_comment` records the nudge URL plus the
optional `head_sha` baseline observed when the coder was nudged, so LGTM reviews
and bookkeeping comments cannot by themselves trigger an addressing gate. The
companion `address_noop` event (same required field `head_sha`) is defined for
empty-addressing paths and transitions the combo out of READY the same way.
After the PR exists, `director-watch` is the single observer. It repeatedly
runs `director-tick` to poll reviewer hard signals (including machine-readable
verdict codes from review comments), route new review comments to the resumed
coder, detect committed local HEAD changes, run a post-address no-mistakes
gate before anything is published again, and sync live combo PR labels on
GitHub (see §8d). Verdict code 1 routes to coder
responding mode through the existing review-comment path; verdict code 2
prompts the director via `director_prompted`; verdict code 3 journals
`needs_human`. When the reviewer tick observes a GitHub `MERGED` PR, it
records the merge fact, reports `closure_pending`, and stops the post-PR loop;
resource convergence belongs to `combo-chen closure -n <combo-id>`.

If the source checkout has a repo-level `.no-mistakes.yaml`, combo-chen
propagates it in two phases: first, it copies the file from the repo into the
combo worktree before each gate. Second, the generated gate script copies it
from the combo worktree into the no-mistakes daemon's active run worktree so
the gate runner reads it. The daemon copy polls `no-mistakes status` to
discover the worktree path and retries up to
`COMBO_CHEN_NO_MISTAKES_CONFIG_COPY_ATTEMPTS` times (default 120, 1 s delay).
The gate command waits for this copy to complete before running. Both phases
preserve content and mode and never overwrite an existing config. In
combo-chen, `.no-mistakes.yaml` is intentionally tracked as shared
test/lint/build policy; user-local secrets and operator preferences stay in
ignored config or environment outside that file.

## 4. Coder responding contract

- On `coder_done`, combo-chen captures the implementing session's thread id
  (gnhf logs, or lookup in a configured session metadata store).
- On `review_comment` (fields: `author`, `kind`, `url`, plus optional `head_sha`), coder responding mode is the implementing thread resumed with the configured `resume_command` template:
  default `codex resume <id>` (recommended `codex --profile sitter --no-alt-screen resume <id>` for tmux visibility),
  `hermes --resume <session>`, or a stateful ACP session.
- A first-pass PR-open happy path does not start coder responding mode. The
  window is created lazily before the first actionable review nudge or
  PR-conflict recovery prompt.
- Fallback (resume unavailable or context-saturated): fresh coder instance
  primed with work-item context + PR diff + the comment. Degraded, never
  blocking.
- Two-bucket policy per comment (mirrors no-mistakes findings): mechanical
  addresses (rename, guard, doc, test tweak) are handled and answered
  autonomously; intent-touching comments emit `needs_human` and pause that
  thread until the human rules.
- Context discipline (empirical, from no-mistakes' design): resumed context
  is for WRITING (addressing with intent memory); fresh context is for
  REVIEWING (the reviewer is never the resumed thread).

## 5. Review state

- The reviewer prompt requires a machine-readable verdict block in every
  review body:

  ```
  combo-chen-reviewer-verdict:
  head: <current PR head SHA>
  code: <0|1|2|3>
  ```

  Verdict codes route deterministically without model interpretation:
  - **0** (`OK, current-head LGTM`): treated as a current-head LGTM signal;
    journals `lgtm` (required field `sha`) for that head SHA.
  - **1** (`mechanical fix required`): routes to coder responding mode
    through the existing review-comment nudge path.
  - **2** (`ambiguous or intent-sensitive`): prompts the director via the
    `director_prompted` event (required fields `reason`, `target`), which
    delivers the prompt to the director's tmux window.
  - **3** (`needs human`): journals `needs_human` with `reason=reviewer_needs_human`
    and `verdict_code: 3`.

  Only verdicts pinned to the current PR head SHA are accepted; stale-head
  verdicts are ignored. The parser expects exactly one verdict block per
  review body (duplicate headers cause rejection). Only verdicts authored by
  GitHub logins listed in `[reviewer].logins` are accepted. The existing
  `lgtm @ <sha>` path is preserved for compatibility.

  Verdict codes 0, 1, and 2 are idempotent per head SHA (no duplicate events
  for the same code and SHA). Code 3 (`needs_human`) is also guarded against
  duplicate journaling for the same `reason` + `sha` combination.

- The reviewer may also emit a plain `lgtm` (required field `sha`) to journal
  the reviewed commit; the LGTM is pinned to that SHA and must come from a
  GitHub author listed in `[reviewer].logins` before the director treats it as
  reviewer evidence. This legacy path is preserved alongside the verdict
  protocol.
- Any push invalidates both verdict-code 0 and plain LGTM signals and the
  journal records `lgtm_stale` (fields `old_sha`, `new_sha`); the reviewer
  re-reviews the delta (incremental: diff since last reviewed SHA), then
  re-LGTMs or files findings.
- When all four signals agree on the current head SHA — gatekeeper has
  validated the SHA, the reviewer has a live pinned LGTM for that SHA,
  every configured `[ready].required_checks` entry is present in the GitHub
  rollup with exact SUCCESS, and all remaining status contexts/checks in the
  rollup are successful for that SHA — the director journals
  `ready_for_merge` (required fields `sha`, `pr_url`) and the combo
  transitions to READY.
- The default required READY check list includes `CodeRabbit`. A skipped or
  pending CodeRabbit result does not satisfy READY; the check must report exact
  SUCCESS.
- If GitHub later reports an open READY PR as dirty or conflicting against the
  current base (`mergeStateStatus=DIRTY` or `mergeable=CONFLICTING`), the
  director journals `pr_conflict` (required fields `sha`, `pr_url`,
  `merge_state`, `action`) with `action=rebase_required`, which invalidates
  READY back to REVIEWING. `status --deep` surfaces the same state as
  `PR conflict: rebase required`. The same event is the coder-recovery
  baseline: director-watch nudges coder responding to rebase the local
  worktree, and once the committed local HEAD differs from the conflicted SHA,
  the normal post-address no-mistakes gate, reviewer, and current-head READY
  path resume.
- External agent comments are routed as review input for the coder. Configure
  their comment/noise filters with `[external_comments].agents`; clean or
  rate-limited external comments do not approve the PR and do not affect READY
  except through their configured GitHub check/status result.
- If no-mistakes dies after publishing and journals `gate_failed` with
  `reason=daemon_dead`, while GitHub reports the current PR head check rollup
  as successful, the director may reconcile stale local gate evidence by
  journaling a GitHub-sourced `gate_status idle` and `gate_validated` pinned to
  the PR `headRefOid`. Generic gate failures are not recoverable through this
  path.

## 6. Merge policy and the counterfactual log

- Default: human merges. Always.
  - **Merged:** The combo journals `merged` (fields: `sha`=merge commit oid,
    `by`, optional `mergedAt`=GitHub PR merge timestamp, optional `source`).
    A `merged` event records the GitHub fact but is not resource convergence;
    until `combo_closed` appears, `status` reports the combo as
    `closure_pending`. Closure verifies the merge commit is in the base
    branch, removes the local worktree and branch, then journals
    `combo_closed` (fields: optional `source`). The remote branch is left
    alone by default.
    When `source` is `"closure"`, the event was synthesized by the explicit
    `combo-chen closure -n <combo-id>` convergence command. When `source` is
    `"reviewer"`, the event was observed live by the reviewer/director loop and
    is only a closure-pending signal. When `source` is
    `"reconcile"`, the event was synthesized from GitHub PR state during a
    frozen journal repair pass, not observed live by the director loop.
  - **Closed without merge:** The combo journals `needs_human` (fields:
    `reason`=`"pr_closed"`), then `combo_closed`. The reviewer stops the tmux
    session but does NOT remove the worktree or local branch, preserving
    local work for human salvage.
- Every run records the counterfactual: would this combo have automerged
  (PR type, gatekeeper risk assessment, signals, timestamp)? After enough runs,
  per-risk-tier automerge can be enabled where the counterfactual matches
  human decisions — trust earned with data, low-risk tier first. The gatekeeper
  already emits a risk assessment in the PR body; the log keys on it.
- The READY report links evidence (gatekeeper test artifacts, screenshots, CI
  runs), not just green booleans: humans merge on evidence.

## 7. Capacity and rate limits

- 24/7 operation within provider-enforced rate limits is legitimate use of
  each plan; limits are the contract.
- `rate_limited(role, until)` is a first-class event: the role pauses, the
  director knows, the role resumes at reset.
- Watcher resilience: the director-watch loop journals `watch_error` on each
  transient failure (rate limits, network errors) with the exit code and
  stderr snippet, and `watch_dead` after `[limits].watch_failure_limit`
  consecutive failures. The watcher doubles its backoff on each failure
  (capped by `[limits].watch_backoff_max_seconds`) and resets both counter
  and backoff on a healthy tick.
- Priority under scarcity: coder coding mode > coder responding mode > reviewer > sweeps.
- Roles spread across independent budgets by design (Claude subscription,
  Codex subscription, Hermes API providers).
- Persistent roles run interactive sessions; headless `-p`/SDK calls are
  reserved for one-off sweeps (separate billing pool since 2026-06-15).
- Direct noninteractive Codex runners are not part of v0. If added, they must
  keep `-C <worktree>` explicit, avoid approval stalls with an isolated
  `workspace-write`/`never` policy, emit `--json` events, capture the final
  message artifact with `-o <run_dir>/final.md`, keep `--search` opt-in, and
  preserve project/user rules unless the run is an explicitly hermetic
  benchmark.
- Reviewer roles stay tmux-visible and project-context-aware by default. A
  future headless Claude reviewer whose output is machine-consumed must use
  JSON or stream-JSON output, explicit budget/turn limits, read/review-focused
  permissions, and separate cost/usage artifacts.

## 8. Director mechanics (v0)

- One tmux session per combo: windows for coder, journal, gatekeeper, director,
  and any interactive agent roles (reviewer, coder responding mode). The gatekeeper
  window resolves the branch's no-mistakes run id from the local no-mistakes
  state, then follows `no-mistakes axi status --run <id>` instead of using
  global attach, so simultaneous combos cannot render each other's run. On
  `gate_started` the emit handler recreates the gatekeeper window so the live
  role window is visible when no-mistakes becomes active. The coder window
  streams live coder stdout/stderr, while the journal window tails
  `combo-chen events --follow` so raw event output never replaces the coder role. After PR open,
  one `director-watch` window runs the polling loop and renders a
  per-tick operator status line (combo id, phase age, PR state/head,
  last journal event age, GitHub poll timing, worker counters, gate
  and reviewer pins, READY checklist, and the current pending action);
  reviewer and coder responding mode are worker windows, not independent
  babysitters.
- The journal is an append-only JSONL spine per combo run. Each combo run
  directory also contains `combo.json` (combo identity),
  `runtime-ledger.json` (machine-readable capsule resources, written at launch
  and updated when PR/reviewer/director resources appear),
  `config.snapshot.json`
  (frozen launch-time config), `overture.json` (pre-launch runway check results),
  generated runner/gate scripts, and work-plan/role artifacts. Each append acquires
  a per-run directory lock (30 s staleness timeout) that serializes concurrent
  writers from the runner, director, emit command, and resume/reconcile paths.
  A stale lock from a dead process is removed before the next writer proceeds;
  lock contention is bounded to 5 s before the writer fails. The journal
  tolerates torn lines from crashes (a reader skips unparseable lines) and
  re-reads pick up complete entries that land after a torn fragment.
  Duplicate `pr_opened` append attempts for the same PR URL in one combo return
  the existing event and do not write a second line, preserving one PR-open
  transition even when retry paths re-emit the same fact.
- The director-watch polling loop, post-address gates, reviewer activation,
  park/resume, reconcile teardown, `status --deep`, and forensics all read
  runtime config from the launch-time `config.snapshot.json` in the run
  directory, not from the mutable repo TOML. Poll cadence and gatekeeper
  commands stay deterministic after repo config changes.
- Post-address no-mistakes gates are launched with generated run scripts in
  the combo run directory. The tmux command stays short (`sh <script>`), while
  the script owns gate status events, log capture, PR autoclose repair, and
  current-head validation. Before running no-mistakes, the script acquires the
  branch-scoped gate lease through the hidden `gate-lease` command and releases
  an acquired lease via an EXIT trap. Leases are persisted under
  `~/.combo-chen/gate-leases.lock/<encoded-branch>/lease.json`; each branch
  directory uses `mkdir` as the atomicity primitive, so one writer can own a
  branch while sibling branches gate concurrently. Each lease carries a
  `heartbeatAt` timestamp refreshed by the owning combo; a lease whose
  heartbeat is older than 30 minutes (`DEFAULT_GATE_LEASE_STALE_MS`) is
  considered stale. A new acquirer recovers a stale lease atomically by
  removing the dead owner's record before installing its own, proceeding
  without blocking. When the lease is held by a different combo on the same
  branch (`same_branch_conflict`), the gate script journals
  `needs_human reason=gate_lease_conflict` and exits 76 — this is a hard
  conflict because two combos cannot share one branch safely. After acquiring
  the lease, the script publishes
  `HEAD:refs/heads/<branch>` to the no-mistakes mirror; when the mirror branch
  already exists, it uses `--force-with-lease` against the observed mirror SHA
  instead of a broad force or plain `git push no-mistakes HEAD`. Transient
  GitHub, git, or tmux failures are logged and re-evaluated on the next
  director tick where possible.
- v0 drives interactive agents with tmux `send-keys` after readiness checks
  via `capture-pane`; state reading relies on hard signals (`gh`, events),
  pane scraping is health-check only.
- Every director tick inspects active worker panes (`coder`, `reviewer`,
  `gatekeeper`, and coder responding mode). A permission prompt matching
  `[monitor].permission_prompt_patterns`, missing/dead pane, or
  `[monitor].worker_stall_ticks` unchanged captures for the same worker
  journals `needs_human` with `worker_permission_prompt`, `worker_dead`, or
  `worker_stalled`.
- Attention surface: tmux window titles + the default parallel capsule
  dashboard (`combo-chen status`) always answer "which combos need a human RIGHT
  NOW" (phase + needs_human flag) and show the active branch-scoped gate lease
  owner in a `GATE-LEASE` column when present.
  Before rendering, status quietly reconciles closed PRs into the human-salvage
  terminal state. For merged PRs it records the GitHub merge fact, then leaves
  resources untouched and keeps the row visible as `closure_pending` until
  `combo-chen closure -n <combo-id>` records `combo_closed`. If a non-terminal
  combo has no tmux session and is not parked, status journals `needs_human
  reason=tmux_missing` so the row remains visible as stale. Parked combos are
  exempt from this check because the missing session is expected. Terminal
  historical rows are hidden unless the operator passes `status --all`.
- The director consumes events, never logs: deep dives (why did the coder
  stall?) go to a subagent that reports back a conclusion, protecting the
  director's context window.
- The ACP migration path (acpx) replaces send-keys role by role when it
  hurts; the role contract does not change.
-   `combo-chen closure -n <combo-id>` is the canonical merged happy-path
    resource convergence command. It reads the persisted combo record,
    runtime ledger (for the PR URL), and GitHub PR facts; it refuses teardown unless GitHub
    reports `MERGED`; then it records any missing `merged` event with
    `source: "closure"`, refuses resource teardown while no-mistakes still
    reports an active or awaiting run for the combo branch, removes the local
    worktree and branch, kills the tmux session, and records `combo_closed`
    with `source: "closure"`. Existing `combo_closed` events are treated as
    already converged. Reviewer/director-watch only records the live merge fact
    and reports the closure command to run; it does not run cleanup itself.
-   `combo-chen reconcile [-n <combo-id>] [--apply]` is a compatibility repair
    pass that compares every persisted
    combo journal against GitHub PR state. When `-n <combo-id>` is provided,
    only that single combo is reconciled. For merged PRs whose journal froze
    before the director could record `merged`/`combo_closed`, it appends the
    missing terminal events (marking `merged` with `source: "reconcile"` and
    GitHub's `mergedAt` when available) and runs teardown
    (worktree removal, branch deletion, tmux session kill); parked combos skip
    worktree removal and branch deletion but still receive the terminal events
    and tmux cleanup. Teardown is idempotent: already-gone worktrees (not a
    working tree), already-deleted branches, and already-killed tmux sessions
    count as success. For closed PRs, it appends `needs_human reason=pr_closed`
    plus `combo_closed` and stops tmux while preserving the local worktree and
    branch. Without `--apply` it reports what would change without mutating
    state. The `status` command uses reconcile in a status-only mode for merged
    PRs: it can record the missing `merged` fact, but it does not run teardown
    or append `combo_closed`.

## 8a. Release artifact contract

The release channel is the producer side of the active updater. A release build
carries inspectable metadata: `combo-chen --version` reports the package
version, commit, and build date embedded by the bundler. Automation supplies
`COMBO_CHEN_COMMIT` and `COMBO_CHEN_BUILD_DATE`; local builds use deterministic
fallbacks where configured and otherwise mark unknown/current values.

Assets are platform archives named
`combo-chen-vX.Y.Z-<platform>-<arch>.tar.gz`. The default release targets are
`darwin-arm64`, `darwin-x64`, `linux-arm64`, and `linux-x64`. Each archive is
rooted at `combo-chen-vX.Y.Z/` and contains `bin/combo-chen` with executable
mode, sourced from `dist/cli.mjs`, plus package metadata, README, LICENSE, and
`combo-chen.example.toml`.

`checksums.txt` is sha256sum-compatible: one SHA-256 digest and filename per
line, sorted by filename, covering every uploaded `.tar.gz` asset. `pnpm
release:assets` runs the build and materializes reproducible archives plus
`checksums.txt` under `dist/release/`.

GitHub release automation runs the release asset producer for published and
prereleased GitHub releases, using the release tag checkout and release creation
timestamp, then uploads `dist/release/*.tar.gz` and
`dist/release/checksums.txt` to that release. This release asset contract feeds
the active `combo-chen update` command directly.

The active command queries GitHub Releases, compares the current embedded build
metadata with the selected release candidate, and reports the current,
update-available, unsupported, or failure state. Stable mode ignores
prereleases:

```bash
combo-chen update --yes
```

Beta mode includes prereleases:

```bash
combo-chen update --beta --yes
```

For an installable candidate, the command downloads the selected archive and
checksums.txt, verifies the checksum before extraction, extracts into an
isolated staging directory, and hands the staged release archive to the atomic
replacement primitive. Checksum, download, and extraction failures are
explicit: the command reports failures before replacement and leaves the
previous installation intact.
Replacement errors are contained by the U3 atomic replacement primitive.
Unsupported source checkouts and package-manager dev shims fail before staging
with useful non-auto-replaceable errors. The live combo/session integration is
owned by #72; the active update command does not restart daemons, inspect
running capsules, or apply passive update notices.

### U0 update contract bridge

U0 is the read-only update contract bridge between release production and the
updater implementation. It provides shared language and pure helper
contracts for normalizing release tags and versions, comparing current build
metadata with a release candidate, selecting the expected platform archive,
parsing and looking up sha256sum-compatible `checksums.txt` entries,
classifying obvious local install targets, recording active combo state, and
assembling a `ReadOnlyUpdatePlan`.

U0 does not download, extract, replace, restart, or mutate active combo
capsules. It does not add passive update notices, archive staging, binary
replacement, or live capsule restart behavior. This means source checkouts and
package-manager dev shims are non-auto-replaceable; the U3 replacement primitive
(`replaceInstallTargetFromStagedArtifact`) only considers release archive
installs whose executable path is under `combo-chen-vX.Y.Z/bin/combo-chen`.

### U1 release resolver and latest/beta check flow

U1 (`src/core/update-resolver.ts`) consumes GitHub Releases metadata plus
current build metadata and returns a read-only update decision.  Stable mode
ignores GitHub prereleases, beta mode includes them, candidates are normalized
through the U0 contract, current builds are compared with the selected
candidate, and expected platform assets are selected through U0 asset naming.
U1 does not download release bytes, verify checksums, extract archives, replace
install targets, or inspect active combo sessions.

### U2 download, checksum verification, and staging

U2 (`src/core/update-staging.ts`) implements download, SHA-256 checksum
verification, and isolated extraction for a resolved update plan.  The
`stageResolvedUpdate` primitive downloads the selected archive asset and
`checksums.txt`, verifies the digest before extraction, extracts into an
isolated staging directory, and returns a `StagedUpdateArtifact` descriptor
with archive paths, checksums, and extracted executable metadata for the
replacement primitive.  All network and filesystem operations are injected
behind `UpdateStagingDeps` so tests can run with mock downloads, filesystem
calls, and extraction.  Checksum mismatches, missing entries, unavailable
checksums, malformed `checksums.txt`, archive download failures, and extraction
failures are reported deterministically through `UpdateStagingError` with
cleanup status.  U2 does not resolve releases, compare versions, classify
install targets, replace binaries, or detect active combo sessions.

Completed updater slices:

- U1: release resolver and latest/beta check flow. (Landed: `resolveLatestReleaseCandidate`, `resolveReadOnlyUpdatePlan`.)
- U2: download, checksum verification, and staging.
- U3: install target and atomic replacement. (Landed: `replaceInstallTargetFromStagedArtifact`.)

Remaining follow-up slices:

- U4: live combo/session integration owned by #72.

## 8b. Parallelize-first operating contract

Parallel operation scales by waves, not by unbounded launch. Start with 2 live
capsules, then 3, then 4 to 6 only after the previous wave has clean journal
evidence, no unresolved ownership collisions, and no unexplained gate lease
holds. Higher concurrency requires a new observed limit and a postmortem that
justifies it.

A capsule is the isolation boundary: each capsule keeps one branch, one
worktree, one tmux session, and one runtime ledger. The director may supervise
many capsules, but role boundaries do not collapse: coders leave local commits,
the gatekeeper publishes, reviewers comment, and humans own merges and
intent-changing decisions.

The shared resource rule is publication-first: branch-scoped gate leases keep
no-mistakes publication single-owner per branch. Parallel coder, reviewer, and
no-mistakes publisher work can continue while sibling capsules own different
branches. A same-branch owner mismatch journals
`needs_human reason=gate_lease_conflict`. No capsule starts a second
no-mistakes publisher for a branch already owned by another capsule.

Recovery playbook:

- Parked combos resume through `combo-chen resume -n <combo-id>`; missing tmux is
  expected for parked combos and must not be treated as drift.
- Pre-PR coder stalls are diagnosed with `status --deep`, `forensics`, and pane
  health signals. Resume or park the same capsule; do not launch a replacement
  on the same branch.
- Reviewer auth failures are configuration/auth problems. Restore the configured
  reviewer GitHub login and rerun reviewer activation or prompt the reviewer;
  do not mark the review current by hand.
- Gate lease contention is same-branch contention. Resolve it by inspecting the
  `status` gate-lease column or clearing stale/conflicting ownership through the
  existing lease recovery path before retrying the gate.
- Post-merge closure belongs to `combo-chen closure -n <combo-id>`. Watchers and
  status may record the merge fact, but local resource removal waits for the
  closure command.

Every future parallel run should capture postmortem metadata: wave size,
combo ids, branches, PR URLs, gate lease wait/conflict counts, reviewer auth
incidents, parked/resumed capsules, closure outcomes, validation commands, and
whether the wave-derived limit changed.

## 8c. Preflight

- The issue or work plan is the combo's spec: plan quality buys autonomous
  runtime. `combo-chen preflight --issue <url>` grades a GitHub issue
  (requirements, acceptance criteria, measurable goal) and warns before
  launch; it also warns when the target repo's AGENTS.md lacks testing
  instructions (predictor of weak validation).
- combo-chen carries no testing knowledge of its own: the target repo's
  AGENTS.md is the testing brain.
- Anti-scope: combos are for issue-sized work. Typo-sized changes belong in
  direct sessions, not pipelines.

## 8d. PR label projection

While the PR is open, the director-watch loop and `status --deep` keep
GitHub PR labels in sync with the live combo state. Labels are a UI/status
projection only; the journal and GitHub checks remain the source of truth.

### Label catalogue

| Label | Condition |
| --- | --- |
| `combo:working-coder` | Coder responding mode is active, or a current-head review comment is pending address. |
| `combo:working-reviewer` | Reviewer window is active and no higher-priority work is underway. |
| `combo:working-gate` | Gatekeeper window is active or a `gate_started` journal entry is the latest gate event. |
| `combo:lgtm` | A current-head SHA-pinned LGTM exists from a configured reviewer login. |
| `combo:external-review-green` | A `[pr_labels].green_check_names` check is SUCCESS for the current head. |
| `combo:ready` | All current-head READY signals agree: gate, reviewer LGTM, required checks, and remaining CI. |
| `combo:stale` | One or more current-head signals (LGTM, gate, READY) are pinned to an older SHA. Removed when signals realign. |
| `combo:conflict` | GitHub reports the PR merge state as DIRTY or CONFLICTING. |
| `combo:needs-human` | Reserved for future use; not actively applied in v0. |

### Projection rules

- Labels are applied only while the PR is open (GitHub state `OPEN`).
- A single work-in-progress label is chosen with this precedence:
  `combo:working-gate` > `combo:working-coder` > `combo:working-reviewer`.
- Signal labels (`combo:lgtm`, `combo:external-review-green`, `combo:ready`) are
  removed when the PR head changes and revalidated against the new head.
- When GitHub reports a dirty/conflicting merge state, all signal labels are
  removed and `combo:conflict` is applied instead.
- Labels are derived from journal events plus live `gh pr view` facts; they
  do not drive the state machine.
- Label updates are idempotent: a no-op when live labels already match the
  desired projection.

### Mutation journaling

Every label change journals a `pr_labels_updated` event with:
- `pr_url`: the PR URL.
- `head_sha`: the PR head SHA at projection time.
- `old_labels` / `new_labels`: the label set before and after mutation.
- `added_labels` / `removed_labels`: the diff.
- `reason`: one of `pr_not_open`, `conflict`, `stale`, or `current`.
- `source` (optional): `director-watch` or `status-deep`.

Label mutation failures (network errors, missing `gh`) are best-effort and
do not block the director tick or status dashboard.

## 9. Work plans

A work plan is a markdown file that drives a combo without a GitHub issue.
Work plans are canonicalized into a `WorkPlan` shape with structured sections
and persisted alongside the combo record as `work-plan.md`.

### Format

A work plan must include a top-level heading (`# Title`) and one or more
sections delimited by `##` headings. The following section names are recognized
(case-insensitive, aliases listed):

- **Problem / Context** (aliases: `Problem`, `Context`, `Background`, `Goal`, `Objective`) — what problem this work solves.
- **Scope Boundaries** (aliases: `Scope`, `Constraints`) — what is in scope.
- **Acceptance Criteria** (aliases: `Acceptance Criterion`, `Criteria`, `Done`, `Definition of Done`) — **required** for local plan launches; must be present before a plan can drive a combo.
- **Validation** (aliases: `Validation Commands`, `Tests`, `Test Plan`) — commands or expectations that verify the work.
- **Out Of Scope** (aliases: `Non Goals`, `Non-Goals`, `Non Goal`, `Non-Goal`) — explicitly excluded work.
- **Human Intent Decisions** (aliases: `Intent Decisions`, `Product Intent Decisions`, `Must Not Change`) — decisions the coder must not change.

### Launching

```bash
combo-chen run --plan <file> --repo <dir> [--base <ref>]
```

The work plan is normalized from the markdown file and persisted as
`work-plan.md` in the combo run directory. The coder prompt references the
normalized plan. The PR body describes the work-plan source and completed
acceptance criteria; it must never include GitHub autoclose keywords. If a
plan asks to close an issue, the gatekeeper should call that out for a human
instead.

### Normalization from GitHub issues

GitHub issue facts are normalized into the same `WorkPlan` shape via
`normalizeGitHubIssueWorkPlan`. This ensures both issue-backed and plan-backed
combos produce the same `work-plan.md` artifact for downstream runtime commands
(reviewer context, gatekeeper intent, forensics, status).

## 10. Inherited hard limits

No merge, no deploy, no rocaup, no LaunchAgents. The combo produces a PR and
conversation, nothing else. Lingering processes die with the tmux session.

## 11. Decided (vetoed via the plan-v1 lavish artifact, 2026-06-10)

1. **Claude codes v0**, TDD — Codex is the coder inside combos and the first
   director user is Claude.
2. **GitHub repo created now, private**; flips public when OSS-ready.
3. **v0 scope as proposed**:
   `run`/`attach`/`status`/`park`/`resume`/`stop`/`events`/`forensics`/`closure`/`reconcile`/`activate-reviewer`,
   coder (codex+gnhf), gatekeeper (no-mistakes), reviewer (incremental
   re-review), director-owned tmux poll loop; promptable director window; treehouse, ACP,
   counterfactual log, preflight and multi-combo dashboard deferred to v1+.

Public role names are now **coder**, **gatekeeper**, and **reviewer** so the
contract describes each role directly before the project has external users.
