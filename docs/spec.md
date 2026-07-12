# The Combo Chen Protocol — spec v1

A combo chen is an autonomous work-item-to-PR pipeline run by fixed roles filled
by configurable agents. Work items can be GitHub issues or local markdown work
plans. This spec describes the v1 system that exists in the codebase now.

## 1. Roles

| Role           | Does                                                                                         | Never does                              | Default agent                  |
| -------------- | -------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------ |
| **director**   | launches phases, consumes events, reports status, escalates to the human                     | touch code, answer review threads       | any                            |
| **coder**      | implements the work item; same thread resumes for review-fix turns and post-publish comments | merge, deploy, publish                  | codex via gnhf                 |
| **gatekeeper** | no-mistakes pipeline (publish-only, `--skip=ci`). Runs in-process as an awaited child.       | answer review threads                   | agent from `.no-mistakes.yaml` |
| **reviewer**   | writes verdict-<round>.json artifacts with machine-readable codes (0–3)                      | review its own changes, write to GitHub | configured reviewer binary     |
| **merge**      | the decision slot                                                                            | —                                       | human (hard default)           |

Validation at launch (hard failures):

- `combo-chen overture` runs a deterministic launch runway before any agent tokens
  are spent or tmux windows are created. Checks include: work_item_readable,
  repo_exists, source_checkout_clean, base_ref_resolved, treehouse_available,
  combo_id_valid, run_dir_free, branch_free, worktree_free, tmux_session_free,
  config_parses, coder_command_safe, reviewer_command_safe, no_mistakes_available,
  no_mistakes_run_free, team_identity, role_command_autonomous.
- The result is written as `overture.json` in the combo run directory.
- `reviewer != coder` — no agent reviews its own changes.
- All runtime behavior reads from the per-run `config.snapshot.json`, frozen at launch.

### Role permission envelope

Every role declares an explicit `allowed_tools` budget in config; the resolved
budgets are frozen in `config.snapshot.json`. Overture fails a role with no
allowlist. Harness bypass flags remain accepted only as a warning-level emergency
escape hatch, never the recommendation.

Permission prompts form a learning loop: the watchdog journals a typed
`permission_prompt_detected` event with the worker, requested tool, and command,
then immediately creates a `needs_human` decision card. The operator flow is
grant → add the tool to that role's `allowed_tools` → retry the turn. Over repeated
runs the per-role budgets converge. A `retry` decision authorizes the next
supervisor tick to recreate and re-prompt the blocked coder turn. Prompts are
captured as learning signals, never left blocking a pane and never silently approved.

## 2. Launch

`combo-chen run --issue <url>` or `--plan <file>`:

1. **Overture** — deterministic runway checks (see §1 Validation). Writes `overture.json`
   with frozen resource references (including the base ref).
2. **Treehouse worktree** — leased under `<repo>/.worktrees/combo-chen-<id>/`.
3. **Combo branch** — created from `origin/main` (or `--base <ref>`) inside the worktree.
4. **tmux session** — fixed capsule topology: pane 0 runs the capsule engine
   (`combo-chen capsule <run-dir>`), plus journal, director, coder, gatekeeper, and
   reviewer role windows. There is no director-watch window: supervision runs
   in-process inside the capsule pane. The gatekeeper window's entry command is the
   static `cd <worktree> && no-mistakes attach`; coder and reviewer windows idle
   until prompted.
5. **Config snapshot** — `config.snapshot.json` frozen at launch with
   `runEngine: "capsule"`. All runtime behavior reads from this snapshot, not the
   mutable repo TOML. Prevents drift when repo config changes during a long-running
   combo. Frozen pre-v1 artifacts (missing or `v0` engine) are deterministically
   migrated to capsule on read, and `resume` rewrites the artifact itself before any
   topology change; an unknown frozen engine fails closed with an explicit
   incompatibility error.

Issue-backed combos derive the gatekeeper intent from the issue (with `Fixes #N`
autoclose requirement). Plan-backed combos derive intent from the normalized work
plan and must not inject autoclose keywords.

## 3. Capsule engine

The v1 sequencer (`combo-chen capsule <run-dir>`) replaces the retired shell `runner.sh`.
It is a TypeScript process that runs in tmux pane 0 and owns the entire pre-publish pipeline:

```
rebase → coder → local review loop (V-C-V) → in-process gate (with retry) → LGTM carry-over → supervisor handoff
```

### resume

`classifyCapsulePhase` derives the resume entry point from the journal:

| Phase       | What happened                     | Resumes at                             |
| ----------- | --------------------------------- | -------------------------------------- |
| `sequence`  | Coder never finished              | Rebase (fresh start)                   |
| `gate`      | Coder finished, gate not yet done | Skip rebase+coder, enter review → gate |
| `supervise` | PR is open                        | Skip to supervisor                     |
| `closed`    | `combo_closed` exists             | No-op                                  |

### coder phase

`runCoderPhase` records `coder_started`, spawns the coder as an inherited-PTY child,
captures before/after HEAD SHAs and new commit count. A non-zero exit with no new
commits journals `coder_failed`; a zero exit with new commits journals `coder_done`.
gnhf stop-condition detection (`success:true, should_fully_stop:true`) is an optional
enrichment bridge; it does not change the exit-code contract.

## 4. Local review loop (V-C-V)

Every iteration opens and closes with a verdict; a code-1 coder fix turn can at
most trigger the next round. Verdicts are never reused round numbers. Code 0
advances to gate; codes 2/3 escalate to `needs_human`.

Verdict collection is artifact-driven: a complete current-round/current-SHA
artifact closes the turn; child exit is cleanup or fallback, never the trigger.
The shared `runAgentProcess` custody interface owns this artifact-vs-exit
first-of for both file-backed reviewer verdicts and state-backed coder fix
commits.
The `TOMBSTONE` tests in `src/app/capsule/capsule.test.ts` enforce this invariant.
The mandatory `artifact-driven-waits` verdict checklist item makes the same rule
machine-validated for every future inter-agent wait point.
Role commands documented in `combo-chen.example.toml` are runtime contracts, so
end-to-end coverage MUST exercise their interactive shapes, not only synthetic
children that conveniently exit.

### Verdict codes

| Code | Meaning               | Action                                       |
| ---- | --------------------- | -------------------------------------------- |
| 0    | LGTM at current head  | Proceed to gate (pin `lgtm` with `patch_id`) |
| 1    | Mechanical fix needed | Coder fix turn (resumed thread, bounded)     |
| 2    | Ambiguous / intent    | Escalate `needs_human`                       |
| 3    | Needs human           | Escalate `needs_human`                       |

### Coder fix turn

Code 1 resumes the implementing coder thread as an owned child of the capsule
(never a fresh gnhf loop). The turn is bounded by `fixTurnTimeoutMinutes`
(SIGTERM/SIGKILL custody). Its completion artifact is a new HEAD relative to
turn start with a clean worktree; custody collects that state, reaps the child,
and advances to re-review. Child exit remains cleanup/fallback, and the
wall-clock timeout remains the backstop.

### Guard rails

- **No-progress:** A finding whose fingerprint matches a prior round after a fix
  turn fires `review_no_progress`. Two consecutive survivals escalate.
- **No-op:** Zero new commits after a code-1 coder turn fires `review_fix_noop`.
- **Round cap:** After `reviewMaxRounds` (default 3, snapshot-frozen) verdicts,
  `review_max_rounds` escalates.

### Loop state

`loop-state.json` persists round records, the fingerprint survival map, and the
guard resolution (`iterating | cleared | escalated`). Write-then-rename for crash
safety. `resolveLoopEntry` folds journal + loop-state into the exact next action:
consumes orphan verdict artifacts, judges interrupted fix turns by commit
observables, and parks pending escalations until a retry decision.

## 5. Verdict artifacts

`verdict-<round>.json` — schema-versioned JSON written by the reviewer:

```
{
  schemaVersion: 1, round, code (0–3),
  reviewed: { sha },
  identity: { model, runtime },
  checklist: [...],   // 9 required items (LOCAL_REVIEW_CHECKLIST)
  findings: [...],    // each with id, severity, file, line?, title, body
  followUps: [...],
  attackTable?: [...] // optional security review
}
```

The checklist is a hard contract (issue #276): a verdict without all 9 items is
malformed and rejected. Findings carry two identity channels for cross-round
fingerprinting: the reviewer-assigned `id` and the `file + normalized-title`
location channel. Line numbers are excluded from fingerprints so the location
channel survives line drift.

A tier-2 review dossier (`review-<round>-<sha12>.md`) is projected
deterministically from the verdict JSON and written to the run directory.

## 6. Patch-id READY and LGTM carry-over

Whole-range `git patch-id --stable` over `merge-base(baseRef, head)..head`.
A code-0 verdict journals `lgtm {sha, patch_id}` pinned to the reviewed
changeset's patch-id.

After the gate publishes (possibly rebased), `applyLgtmCarryOver` decides:

- **Already current** — published sha equals pinned sha (nothing to do).
- **Carried** — same patch-id, different sha (pure rebase): re-pin `lgtm` to the published sha.
- **Re-review requested** — different or uncomputable patch-id (gate autofix changed the changeset):
  journals `lgtm_stale` + `local_review_requested`. Routes back through the review loop,
  never `needs_human`.
- **No pin** — no `lgtm` event exists in the journal.

`capsuleReadyAgreement` is the four-leg deterministic READY fold:

1. Gate validated the published head and is not in a blocking state.
2. Local lgtm holds at head (by sha or patch-id).
3. Check rollup and every required READY check are SUCCESS.
4. Findings-aware external review evidence is clean (a SUCCESS check alone is not review evidence).

All four legs agree on the current head → READY. The runtime default for required
READY checks is empty; the example dogfood config opts into CodeRabbit.

## 7. In-process gate

`runInProcessGate` (`src/app/gate/in-process-gate.ts`) replaces the retired shell
gate scripts. It runs as an awaited child process within the capsule.

Pipeline within the gate:

1. **Restart custody probe** — when the journal ends in `gate_status state=fix_inflight`,
   query `no-mistakes axi status`. A matching active branch
   and head is journaled as `gate_reattached`, then the frozen gatekeeper command
   drives that same run (including its `--yes` policy) instead of publishing or
   aborting a duplicate.
2. **Branch-scoped lease** — acquire via `withGateLease`; same-branch conflict
   exits with a deterministic code and does not block sibling branches.
3. **Mirror publish** — `git push no-mistakes HEAD:refs/heads/<branch>` with
   `--force-with-lease` when the mirror branch exists.
4. **Daemon start** — `no-mistakes daemon start` (idempotent; left running for
   sibling capsules).
5. **Gatekeeper + config copy race** — the gateway command and `.no-mistakes.yaml`
   propagation to the daemon's active run worktree run in parallel. If the gate
   finishes before the config copy, the result is rejected (deterministic validation).
6. **Outcome classification** — `awaiting_approval` journals `needs_human reason=gate_waiting`;
   `checks-passed` + `context canceled` recovers as success; all other non-zero exits
   journal `gate_failed`.
7. **PR detection** — queries `gh pr list --head <branch>`, runs the autoclose guard
   (for issue-backed combos), journals `pr_opened`.
8. **Initial-gate retry** — up to `gatekeeperInitialGateRetryAttempts` with
   `gatekeeperInitialGateRetryBackoffSeconds` delay; exhausted retries escalate
   `needs_human reason=gate_failed`.

### Config propagation

If the combo worktree has `.no-mistakes.yaml`, the gate copies it to the no-mistakes
daemon's active run worktree before the gate command runs. The copy polls
`no-mistakes status` + `no-mistakes axi status` to discover the daemon worktree
path, retrying up to 120 times (1s delay). Gate and config copy run in parallel;
a successful gate that finishes before the config copy is rejected so validation
stays deterministic.

## 8. Event-driven supervisor

`superviseCapsuleCombo` replaces `director-watch-loop.sh`. It is the in-process
post-publish observer:

- **Wake mechanism:** `fs.watch` on the journal with a 500ms poll fallback (for
  network volumes). A GitHub sampling timer fires every `babysitPollSeconds` since
  GitHub has no push channel.
- **Tick:** `tickDirector` runs one deterministic observer pass: worker health,
  reviewer hard signals, review comment nudging (external comments route to the
  persistent coder window), PR conflict detection, READY agreement, PR label
  sync, and auto-closure on merge detection.
- **Resilience:** On tick failure, journals `watch_error` with exponential backoff
  (doubled each failure, capped by `watchBackoffMaxSeconds`). After
  `watchFailureLimit` consecutive failures, journals `watch_dead` and exits.
- **Terminal exit:** Derived from `combo_closed` in the journal, not from stdin
  or stdout markers.

### Worker monitoring

`inspectWorkerPanes` runs on each tick, reading tmux pane content to detect:

- **Dead workers** — pane no longer exists or shows a terminal orchestrator
  failure. Pre-PR: `recoverDeadCoder` relaunches the capsule sequencer pane
  (capsule-owned recovery: the relaunched capsule re-derives its phase from the
  journal and re-runs the coder itself), bounded by `workerRecoveryAttempts`;
  exhausted budgets escalate `needs_human reason=worker_dead`. Post-PR: escalate
  `needs_human reason=worker_dead`.
- **Stalled workers** — pane unchanged across `workerStallTicks` consecutive
  ticks with no orchestrator evidence. Pre-PR stalls escalate
  `needs_human reason=worker_stalled`; a post-PR stalled coder responding window
  is recreated and re-prompted via `recoverStuckWorker` (bounded by the same
  recovery budget).
- **Permission prompts** — pane content matches `permission_prompt_patterns`.
  The watchdog records `permission_prompt_detected` and journals a `needs_human`
  decision card; legacy recovery-policy values never silently approve or recreate
  a prompted role.

Worker recovery is bounded: after `workerRecoveryAttempts` attempts for the same
worker/reason, the next finding escalates `needs_human`.

### Park / Resume / Closure / Reconcile

- **Park** (`combo-chen park -n <id>`): writes a `park-handoff.md` summary
  (phase, branch, worktree, PR, downstream, last event, resume command),
  journals `parked`, and kills the tmux session. Worktree and branch are
  preserved; loop position already persists in `loop-state.json`.
- **Resume** (`combo-chen resume -n <id>`): migrates a frozen legacy-engine
  snapshot to capsule (or fails closed on an unknown engine), then converges the
  capsule topology in the persisted tmux session (recreating the session with the
  capsule as pane 0 when it is gone) and prunes stale v0 windows. The relaunched
  capsule resolves its phase from the journal and the loop entry point from
  journal + loop-state. A merged PR converges closure instead.
- **Closure** (`combo-chen closure -n <id>`): canonical merged happy-path
  resource convergence. Verifies GitHub reports MERGED, records any missing
  `merged` event, refuses teardown while no-mistakes is active for the branch,
  returns the Treehouse worktree lease, deletes the local branch, journals
  `combo_closed`, and kills the tmux session. Auto-triggered by the supervisor on
  merge detection; the manual command is a fallback.
- **Reconcile** (`combo-chen reconcile [--apply]`): compares every persisted
  combo journal against GitHub PR state. For merged PRs whose journal froze,
  appends missing terminal events. For closed PRs (merged=false), appends
  `needs_human reason=pr_closed` + `combo_closed`. Without `--apply`, reports
  without mutating. The `status` command uses reconcile in read-only mode to
  detect stale rows.

## 9. PR body dossier and exit summary

`projectDossierPrBody` renders collapsed `<details>` blocks per review round
(newest first) inside a marker-delimited section (`<!-- combo-chen-review-dossier -->`
... `<!-- /combo-chen-review-dossier -->`). Re-projection is idempotent:
human-authored text and the autoclose footer outside the markers survive. When the
65,536-char GitHub body limit approaches, older rounds compact to one-line verdict
summaries.

At closure, `renderExitSummary` produces `exit-summary.md` and prints it to
stdout: rounds, findings, merged by whom, duration, PR URL.

## 10. TUI fleet view

Bare `combo-chen` on a TTY opens the Ink/React fleet view in a dedicated tmux
session (`combo-chen-home`). The TUI module is lazy-loaded so ordinary commands
never initialize React/Yoga.

`deriveFleetRow` is a pure fold over journal events + combo record + injected
liveness (tmux session alive). Rows are sorted by priority: `NEEDS_YOU` first,
then live rows by phase, then parked, then closed. The fleet refreshes on a
configurable interval (default 5s).

## 11. PR label projection

While the PR is open, `syncComboPrLabels` keeps GitHub labels in sync with the
live combo state. Labels are derived from journal events plus PR facts; they do
not drive the state machine. The model is monotonic: exactly one lifecycle label
at a time, advancing `combo:working` → `combo:ready` → `combo:merged`, with
`combo:conflict` as the explicit non-monotonic exception.

| Label            | Condition                                                |
| ---------------- | -------------------------------------------------------- |
| `combo:working`  | PR open, no current-head `ready_for_merge` yet           |
| `combo:ready`    | `ready_for_merge` journaled (all four READY legs agreed) |
| `combo:merged`   | GitHub reports MERGED or the journal records `merged`    |
| `combo:conflict` | GitHub reports merge state as DIRTY or CONFLICTING       |

Labels are auto-provisioned on the target repo when missing. Only the supervisor
tick (`director-tick`) writes labels to GitHub; read-only inspection commands
such as `status`, `status --deep`, and `status --deep --all` do not mutate
labels. Label mutations journal `pr_labels_updated`.

## 12. CLI surface

```
combo-chen                Open the TUI fleet home (TTY) or show help
combo-chen run            Launch a combo (--issue <url> or --plan <file>)
combo-chen capsule <dir>  Run the v1 sequencer for a persisted combo
combo-chen status         Parallel capsule dashboard (--deep, --all)
combo-chen recap          Plain-text since-you-left digest
combo-chen forensics      Combo forensics reports (--record-outcome)
combo-chen decide -n <id> <verb>       Resolve a pending needs_human (retry|skip|take_over|ignore)
combo-chen park -n <id>                Write reboot handoff and stop processes
combo-chen resume -n <id>              Resume a parked combo
combo-chen stop -n <id>                Kill tmux session (journal survives)
combo-chen attach -n <id>              Attach to a running combo tmux session
combo-chen events -n <id>             Print journal (--follow)
combo-chen closure -n <id>             Converge merged combo terminal state and resources
combo-chen reconcile [-n <id>] [--apply]  Compare journals with GitHub, repair
combo-chen update [--beta] [-y]        Self-update from GitHub Releases
combo-chen overture                    Run launch runway checks only
combo-chen needs-human-report          Report needs_human counts by reason
combo-chen intent -n <id>              Print the canonical PR intent (inspection/forensics)
combo-chen director-prompt -n <id>     Prompt the interactive director window
combo-chen activate-reviewer -n <id>   Start the reviewer window
```

## 13. Journal events

The journal is an append-only JSONL file (`journal.jsonl`) with a per-run
directory lock. Key v1 events:

| Event                    | Emitted by       | Purpose                                                           |
| ------------------------ | ---------------- | ----------------------------------------------------------------- |
| `combo_created`          | launch           | Combo worktree + branch + tmux are up                             |
| `rebase_failed/conflict` | capsule          | Rebase failure or merge conflict                                  |
| `coder_started`          | capsule          | Coder process started (review-fix turns carry `mode: review_fix`) |
| `coder_done`             | capsule          | New commits landed after coder exit                               |
| `coder_failed`           | capsule          | Coder exited non-zero with no new commits                         |
| `local_review_requested` | capsule          | Review round started (round, sha)                                 |
| `local_verdict`          | capsule          | Verdict artifact ingested (round, code, findings)                 |
| `follow_ups`             | capsule          | Deferred findings from a verdict                                  |
| `lgtm`                   | capsule/ready    | SHA-pinned LGTM (sha, patch_id?, round, source)                   |
| `lgtm_stale`             | ready            | Prior LGTM invalidated (old_sha, new_sha, reason)                 |
| `gate_started`           | in-process-gate  | Gate process started                                              |
| `gate_reattached`        | in-process-gate  | Interrupted gate custody resumed by run ID and head               |
| `gate_status`            | in-process-gate  | State: `fix_inflight`, `idle`, `failed`, `awaiting_approval`      |
| `gate_failed`            | in-process-gate  | Gate exited non-zero (exit_code, reason)                          |
| `gate_validated`         | in-process-gate  | Post-address gate validated the published head                    |
| `pr_opened`              | in-process-gate  | Initial PR created (url)                                          |
| `needs_human`            | multiple         | Escalation (reason, round?, sha?)                                 |
| `decision`               | CLI (decide)     | Human resolution of a needs_human (verb, needs_human_ref)         |
| `ready_for_merge`        | director         | All four READY legs agree (sha, pr_url)                           |
| `pr_conflict`            | director         | PR merge state is DIRTY/CONFLICTING (sha, action)                 |
| `merged`                 | director/closure | PR merged (sha, by, mergedAt)                                     |
| `combo_closed`           | closure          | Terminal resource convergence                                     |
| `capsule_crashed`        | capsule backstop | Fatal reason journaled synchronously before process exit          |
| `pr_labels_updated`      | director         | Label mutation (old_labels, new_labels, reason)                   |
| `watch_error/dead`       | supervisor       | Tick failure tracking                                             |

## 14. Deferred and retired

### Deferred

- Glance pane (not built)
- Forge connectors (non-GitHub, not built)
- Automerge (counterfactual log exists but not wired)
- CodeRabbit request-comment path (`external_review_requested` not emitted)
- GitHub-login LGTM parsing (local verdict files only)
- PR body dossier projection trigger (projection function exists, not called in supervisor loop)

### Retired (W6d sweep)

- **Shell templates** — 22 `.sh` files under `src/shell/templates/` deleted. All
  generated gate/runner/director-watch scripts are gone. The only shell that
  reaches tmux is a static one-liner window entry command (the gatekeeper's
  `cd <worktree> && no-mistakes attach`); every retry, conditional, and status
  decision lives in TypeScript.
- **runner.sh generation** — The capsule sequencer replaces it. Launch-handlers
  no longer write a `runner.sh`; tmux pane 0 runs `combo-chen capsule <run-dir>` directly.
- **director-watch-loop.sh** — Replaced by the in-process `superviseCapsuleCombo`
  that uses `fs.watch` + GitHub sampling timer.
- **emit/gate-lease/gate-restart CLI** — The engine writes every journal event
  itself, gate lease acquisition moved into `in-process-gate.ts`, and gate
  relaunch happens through `resume` (the capsule re-runs the gate path). No
  script-facing CLI endpoints remain.
- **Gatekeeper attach retry knobs** — `attach_timeout_seconds` and
  `attach_retry_interval_seconds` configured the retired shell polling wrapper;
  they are ignored if present in old config.
- **CodeRabbit request-comment path** — `external_review_requested` journal event
  exists but is not emitted.
- **GitHub-login LGTM parsing** — v0 reviewer required a GitHub login listed in
  `[reviewer].logins` and a `lgtm @ <sha>` pin in the review body. v1 uses local
  verdict artifacts, not GitHub review comments.

## 15. Inherited hard limits

No merge, no deploy, no rocaup, no LaunchAgents. The combo produces a PR and
conversation, nothing else. Lingering processes die with the tmux session.
