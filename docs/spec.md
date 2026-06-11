# The Combo Chen Protocol — spec v1

A combo chen is an autonomous issue → PR pipeline run by fixed roles filled
by configurable agents. This spec is the constitution: the CLI, the event
schema, and the config schema must conform to it, not the other way around.

## 1. Roles

| Role | Does | Never does | Default agent |
|---|---|---|---|
| **director** | launches phases, consumes events, reports status, escalates to the human | touch code, answer review threads | any (claude /loop, codex, human) |
| **rower** | the one who rows: implements the issue (phase 1); resumed, addresses review comments (phase 3) | merge, deploy | codex via gnhf |
| **hodor** | holds the door: no-mistakes pipeline review→test→docs→lint→push→PR; then ci-step: watch CI, auto-fix failures/conflicts | answer review threads | agent from `.no-mistakes.yaml` (e.g. `acp:hermes-deepseek`) |
| **gordon** | the judge: reviews the PR per protocol (La Roca 7989 + project overlay), incrementally until merge | review its own cooking | claude (+ coderabbit as ambient reviewer) |
| **merge** | the decision slot | — | human (hard default) |

Validation at launch (hard failures, the combo refuses to start):
- `gordon != rower` — no agent judges its own cooking.
- every role resolves to an available agent (binary present, auth alive).

## 2. Phases and transitions

```
SETUP      worktree acquired (treehouse pool or .worktrees/), tmux session up
  └─▶ ROWING     gnhf loop; ends with rower_done + captured thread_id
        └─▶ GATING     no-mistakes pipeline; ends with pr_opened (or hodor_failed)
              └─▶ JUDGING    gordon loop + thread-sitter + hodor ci-step in parallel
                    └─▶ READY      lgtm_current ∧ rabbit_clean ∧ checks_passed
                          └─▶ MERGED | CLOSED   (human, or earned automerge)
```

Any phase can transition to `STALLED` (timeout, rate limit, agent death) —
a director concern, never a silent state.

A recoverable rower failure journals `rower_retry` (no required fields) and
the loop restarts; repeated failures transition to `STALLED`.

A terminal rower failure (non-zero exit) journals `rower_failed` (required
fields: `exit_code`, `has_new_commits`). The runner captures the git HEAD
before and after the rower run: `base_sha`, `head_sha`, and
`new_commit_count` quantify what — if anything — the rower committed before
failing. `rower_failed` transitions the combo immediately to `STALLED`.

## 3. The two babysitters and their boundary

- **hodor** (no-mistakes ci-step): machine signals only. Watches the PR
  until merged/closed; fetches failed CI logs, lets its agent fix, commits and
  force-pushes; rebases over merge conflicts. Verified: it never reads or
  answers review threads. He holds the door.
- **thread-sitter** (the resumed rower): conversation signals only. Reads new
  review comments, answers them, pushes addressing commits.

**Push semaphore:** the thread-sitter must not push while hodor has a CI
fix in flight (hodor force-pushes). Before pushing: check hodor state
(`no-mistakes axi status` or the `hodor_fix_inflight` event). Hodor needs no
symmetric check — he owns CI-red moments; the thread-sitter owns CI-green
moments.

## 4. Thread-sitter resume contract

- On `rower_done`, combo-chen captures the implementing session's thread id
  (gnhf logs, or lookup in La Roca's ingested session metadata).
- On `review_comment` (fields: `author`, `kind`, `url`), the thread-sitter is the implementing thread resumed:
  `codex resume <id>`, `hermes --resume <session>`, or a stateful ACP session.
- Fallback (resume unavailable or context-saturated): fresh rower instance
  primed with issue + PR diff + the comment. Degraded, never blocking.
- Two-bucket policy per comment (mirrors no-mistakes findings): mechanical
  addresses (rename, guard, doc, test tweak) are handled and answered
  autonomously; intent-touching comments emit `needs_human` and pause that
  thread until the human rules.
- Context discipline (empirical, from no-mistakes' design): resumed context
  is for WRITING (addressing with intent memory); fresh context is for
  JUDGING (the reviewer is never the resumed thread).

## 5. Review state

- Gordon emits `lgtm` (required field `sha`) to journal the reviewed commit;
  the LGTM is pinned to that SHA.
- Any push invalidates it and the journal records `lgtm_stale` (fields
  `old_sha`, `new_sha`); gordon re-reviews the delta
  (incremental: diff since last reviewed SHA), then re-LGTMs or files
  findings.
- READY requires: current LGTM on HEAD ∧ CodeRabbit clean ∧ hodor
  checks-passed.

## 6. Merge policy and the counterfactual log

- Default: human merges. Always. When merged, the combo journals `merged`
  (fields: `sha`, `by`). When the PR is closed without merge, the combo
  journals `combo_closed` (no required fields).
- Every run records the counterfactual: would this combo have automerged
  (PR type, hodor risk assessment, signals, timestamp)? After enough runs,
  per-risk-tier automerge can be enabled where the counterfactual matches
  human decisions — trust earned with data, low-risk tier first. Hodor
  already emits a risk assessment in the PR body; the log keys on it.
- The READY report links evidence (hodor test artifacts, screenshots, CI
  runs), not just green booleans: humans merge on evidence.

## 7. Capacity and rate limits

- 24/7 operation within provider-enforced rate limits is legitimate use of
  each plan; limits are the contract.
- `rate_limited(role, until)` is a first-class event: the role pauses, the
  director knows, the role resumes at reset.
- Priority under scarcity: rower > thread-sitter > gordon > sweeps.
- Roles spread across independent budgets by design (Claude subscription,
  Codex subscription, Hermes API providers).
- Persistent roles run interactive sessions; headless `-p`/SDK calls are
  reserved for one-off sweeps (separate billing pool since 2026-06-15).

## 8. Director mechanics (v0)

- One tmux session per combo: windows for rower, hodor, watch, and any
  interactive agent roles (gordon, thread-sitter).
- v0 drives interactive agents with tmux `send-keys` after readiness checks
  via `capture-pane`; state reading relies on hard signals (`gh`, events),
  pane scraping is health-check only.
- Attention surface: tmux window titles + `combo-chen status` always answer
  "which combos need a human RIGHT NOW" (phase + needs_human flag). Five
  combos = five status lines, zero attaching until escalation.
- The director consumes events, never logs: deep dives (why did the rower
  stall?) go to a subagent that reports back a conclusion, protecting the
  director's context window.
- The ACP migration path (acpx) replaces send-keys role by role when it
  hurts; the role contract does not change.

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

1. **Claude codes v0**, TDD — Codex is the rower inside combos and the first
   director user is Claude.
2. **GitHub repo created now, private**; flips public when OSS-ready.
3. **v0 scope as proposed**: `run`/`status`/`stop`/`events`/`activate-judge`, rower
   (codex+gnhf), hodor (no-mistakes), gordon judge (tmux poll loop +
   incremental re-review); manual director; treehouse, ACP,
   counterfactual log, preflight and multi-combo
   dashboard deferred to v1+.

Role names ruled by the architect: the implementer is the **rower** (the one
who rows), the gate is **hodor** (he holds the door), and the reviewer is
**gordon** (the MasterChef judge: no courtesy LGTMs).
