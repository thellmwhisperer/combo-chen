# The Combo Chen Protocol — spec v1

A combo chen is an autonomous issue → PR pipeline run by fixed roles filled
by configurable agents. This spec is the constitution: the CLI, the event
schema, and the config schema must conform to it, not the other way around.

## 1. Roles

| Role | Does | Never does | Default agent |
| --- | --- | --- | --- |
| **director** | launches phases, consumes events, reports status, escalates to the human | touch code, answer review threads | any (claude /loop, codex, human) |
| **coder** | implements the issue (phase 1); the same thread resumes in responding mode for review comments (phase 3) | merge, deploy | codex via gnhf |
| **gatekeeper** | no-mistakes pipeline review→test→docs→lint→push→PR (publish-only; combo-chen appends `--skip=ci`). The gatekeeper command supports {issue_url}, {issue_title}, {issue_body}, {issue_pr_intent}, {branch} placeholders expanded at runner generation. | answer review threads | agent from `.no-mistakes.yaml` (e.g. `acp:hermes-deepseek`) |
| **reviewer** | reviews the PR per configured repository protocol, incrementally until merge | review its own changes | claude (+ configured ambient reviewers) |
| **merge** | the decision slot | — | human (hard default) |

Validation at launch (hard failures, the combo refuses to start):

- `reviewer != coder` — no agent reviews its own changes.
- every role resolves to an available agent (binary present, auth alive).
- gnhf coder commands must be safe runner commands before any worktree is
  created: pinned `gnhf@<version>`, `--max-iterations`, `--stop-when`,
  `--prevent-sleep on`, and telemetry/noise disabled with
  `--meteor-frequency 0`. The runner also closes coder stdin.

## 2. Phases and transitions

```text
SETUP      worktree acquired under the project .worktrees/ directory, tmux session up
  └─▶ CODING     gnhf loop; ends with coder_done + captured thread_id
        └─▶ GATING     gate_started; publishes HEAD to the no-mistakes mirror (with --force-with-lease and base64-encoded intent) via generated shell script, then no-mistakes pipeline (publish-only, --skip=ci); ends with pr_opened, gate_failed (exit_code), or awaiting_approval (needs_human reason=gate_waiting)
              └─▶ REVIEWING  director-watch observes reviewer and coder responding mode workers
                    └─▶ READY      gate_current ∧ reviewer_current ∧ ambient_review_current_clean ∧ ci_current_success
                          └─▶ MERGED | CLOSED   (human, or earned automerge)
```

Any phase can transition to `STALLED` (timeout, rate limit, agent death) —
a director concern, never a silent state.

For `combo-chen run --issue <issue-url>`, the default gatekeeper intent is derived
from the ComboRecord issue URL and issue details and includes a PR body
requirement to preserve the exact visible line `Fixes #N`. That explicit
autoclose keyword is required for generated issue PRs; a plain mention such as
`issue #N` is not treated as sufficient. Custom gatekeeper commands that still
create source-issue PRs must preserve `{issue_pr_intent}` or provide an
equivalent GitHub autoclose keyword in the PR/body generation path.

A recoverable coder failure journals `coder_retry` (no required fields) and
the loop restarts; repeated failures transition to `STALLED`.

Before the coder starts, the runner fetches and rebases the worktree onto
`origin/main`. A fetch failure journals `rebase_failed` (required field
`base`) and exits 1; a merge-conflict rebase failure journals
`rebase_conflict` (required field `base`) and exits 1. Both events
transition the combo immediately to `STALLED`.

A terminal coder failure (non-zero exit) journals `coder_failed` (required
fields: `exit_code`, `has_new_commits`). The runner captures the git HEAD
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
(gatekeeper started and no-mistakes is running), `awaiting_approval` (gate requires
human sign-off), `failed` (non-zero exit), or `idle` (gatekeeper completed
successfully, awaiting PR detection).  On successful completion the gate emits
`gate_validated` (required field `sha`) alongside the `idle` gate status,
recording the validated head SHA.

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
runs `director-tick` to poll reviewer hard signals, route new review comments
to the resumed coder, detect committed local HEAD changes, and run a
post-address no-mistakes gate before anything is published again.

If the source checkout has an ignored local `.no-mistakes.yaml`, combo-chen
copies it into the combo worktree as a local artifact before the initial gate.
It preserves content and mode, never overwrites an existing worktree config,
and repeats the same copy step before post-address gates so older worktrees can
recover if the artifact is missing. The artifact carries repo-specific
test/lint/build commands for no-mistakes; combo-chen only propagates it.

## 4. Coder responding contract

- On `coder_done`, combo-chen captures the implementing session's thread id
  (gnhf logs, or lookup in a configured session metadata store).
- On `review_comment` (fields: `author`, `kind`, `url`, plus optional `head_sha`), coder responding mode is the implementing thread resumed:
  `codex resume <id>`, `hermes --resume <session>`, or a stateful ACP session.
- Fallback (resume unavailable or context-saturated): fresh coder instance
  primed with issue + PR diff + the comment. Degraded, never blocking.
- Two-bucket policy per comment (mirrors no-mistakes findings): mechanical
  addresses (rename, guard, doc, test tweak) are handled and answered
  autonomously; intent-touching comments emit `needs_human` and pause that
  thread until the human rules.
- Context discipline (empirical, from no-mistakes' design): resumed context
  is for WRITING (addressing with intent memory); fresh context is for
  REVIEWING (the reviewer is never the resumed thread).

## 5. Review state

- The reviewer emits `lgtm` (required field `sha`) to journal the reviewed commit;
  the LGTM is pinned to that SHA.
- Any push invalidates it and the journal records `lgtm_stale` (fields
  `old_sha`, `new_sha`); the reviewer re-reviews the delta
  (incremental: diff since last reviewed SHA), then re-LGTMs or files
  findings.
- When all four signals agree on the current head SHA — gatekeeper has
  validated the SHA, the reviewer has a live pinned LGTM for that SHA,
  every configured ambient reviewer has a SUCCESS status context/check for
  that SHA and its latest matching review/comment for that SHA is not a
  rate-limit/skipped/no-review message, and all remaining status contexts/checks
  in the rollup are successful for that SHA — the director journals
  `ready_for_merge` (required fields `sha`, `pr_url`) and the combo
  transitions to READY.

## 6. Merge policy and the counterfactual log

- Default: human merges. Always.
  - **Merged:** The combo journals `merged` (fields: `sha`=merge commit oid,
    `by`, optional `source`), verifies the merge commit is in the base branch,
    removes the local worktree and branch, then journals `combo_closed`
    (fields: optional `source`). The remote branch is left alone by default.
    When `source` is `"reconcile"`, the event was synthesized from GitHub PR
    state during a frozen journal repair pass, not observed live by the
    director loop.
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

## 8. Director mechanics (v0)

- One tmux session per combo: windows for coder, gatekeeper, and any
  interactive agent roles (reviewer, coder responding mode). The gatekeeper
  window resolves the branch's no-mistakes run id from the local no-mistakes
  state, then follows `no-mistakes axi status --run <id>` instead of using
  global attach, so simultaneous combos cannot render each other's run. On
  `gate_started` the emit handler recreates the gatekeeper window so the live
  role window is visible when no-mistakes becomes active. The coder window
  includes a short (12-line) journal pane showing live events. After PR open,
  one `director-watch` window runs the polling loop; reviewer and coder
  responding mode are worker windows, not independent babysitters.
- Post-address no-mistakes gates are launched with generated run scripts in
  the combo run directory. The tmux command stays short (`sh <script>`), while
  the script owns gate status events, log capture, PR autoclose repair, and
  current-head validation. Before running no-mistakes, the script publishes
  `HEAD:refs/heads/<branch>` to the no-mistakes mirror; when the mirror branch
  already exists, it uses `--force-with-lease` against the observed mirror SHA
  instead of a broad force or plain `git push no-mistakes HEAD`. Transient
  GitHub, git, or tmux failures are logged and re-evaluated on the next
  director tick where possible.
- v0 drives interactive agents with tmux `send-keys` after readiness checks
  via `capture-pane`; state reading relies on hard signals (`gh`, events),
  pane scraping is health-check only.
- Attention surface: tmux window titles + `combo-chen status` always answer
  "which combos need a human RIGHT NOW" (phase + needs_human flag). Five
  combos = five status lines, zero attaching until escalation.
- The director consumes events, never logs: deep dives (why did the coder
  stall?) go to a subagent that reports back a conclusion, protecting the
  director's context window.
- The ACP migration path (acpx) replaces send-keys role by role when it
  hurts; the role contract does not change.
- `combo-chen reconcile [--apply]` compares every persisted combo journal
  against GitHub PR state. For merged PRs whose journal froze before the
  director could record `merged`/`combo_closed`, it appends the missing
  terminal events (marked `source: "reconcile"`) and runs teardown (worktree
  removal, branch deletion, tmux session kill). Without `--apply` it reports
  what would change without mutating state.

## 8b. Preflight

- The issue is the combo's spec: plan quality buys autonomous runtime.
  `combo-chen preflight --issue <url>` grades the issue (requirements,
  acceptance criteria, measurable goal) and warns before launch; it also
  warns when the target repo's AGENTS.md lacks testing instructions
  (predictor of weak validation).
- combo-chen carries no testing knowledge of its own: the target repo's
  AGENTS.md is the testing brain.
- Anti-scope: combos are for issue-sized work. Typo-sized changes belong in
  direct sessions, not pipelines.

## 9. Inherited hard limits

No merge, no deploy, no rocaup, no LaunchAgents. The combo produces a PR and
conversation, nothing else. Lingering processes die with the tmux session.

## 10. Decided (vetoed via the plan-v1 lavish artifact, 2026-06-10)

1. **Claude codes v0**, TDD — Codex is the coder inside combos and the first
   director user is Claude.
2. **GitHub repo created now, private**; flips public when OSS-ready.
3. **v0 scope as proposed**:
   `run`/`attach`/`status`/`park`/`resume`/`stop`/`events`/`forensics`/`reconcile`/`activate-reviewer`,
   coder (codex+gnhf), gatekeeper (no-mistakes), reviewer (incremental
   re-review), director-owned tmux poll loop; manual director; treehouse, ACP,
   counterfactual log, preflight and multi-combo dashboard deferred to v1+.

Public role names are now **coder**, **gatekeeper**, and **reviewer** so the
contract describes each role directly before the project has external users.
