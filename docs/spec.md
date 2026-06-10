# The Combo Chen Protocol — spec v1 (draft for veto)

A combo chen is an autonomous issue → PR pipeline run by fixed roles filled
by configurable agents. This spec is the constitution: the CLI, the event
schema, and the config schema must conform to it, not the other way around.

## 1. Roles

| Role | Does | Never does | Default agent |
|---|---|---|---|
| **director** | launches phases, consumes events, reports status, escalates to the human | touch code, answer review threads | any (claude /loop, codex, human) |
| **coder** | implements the issue (phase 1); resumed, addresses review comments (phase 3) | merge, deploy | codex via gnhf |
| **gate** | no-mistakes pipeline: review→test→docs→lint→push→PR; then ci-step: watch CI, auto-fix failures/conflicts | answer review threads | agent from `.no-mistakes.yaml` (e.g. `acp:hermes-deepseek`) |
| **reviewer** | reviews the PR per protocol (La Roca 7989 + project overlay), incrementally until merge | self-review its own code | claude (+ coderabbit as ambient reviewer) |
| **merge** | the decision slot | — | human (hard default) |

Validation at launch (hard failures, the combo refuses to start):
- `reviewer != coder` — no agent reviews its own implementation.
- every role resolves to an available agent (binary present, auth alive).

## 2. Phases and transitions

```
SETUP      worktree acquired (treehouse pool or .worktrees/), tmux session up
  └─▶ CODING     gnhf loop; ends with coder_done + captured thread_id
        └─▶ GATING     no-mistakes pipeline; ends with pr_opened (or gate_failed)
              └─▶ REVIEWING  reviewer loop + thread-sitter + gate ci-step in parallel
                    └─▶ READY      lgtm_current ∧ rabbit_clean ∧ checks_passed
                          └─▶ MERGED | CLOSED   (human, or earned automerge)
```

Any phase can transition to `STALLED` (timeout, rate limit, agent death) —
a director concern, never a silent state.

## 3. The two babysitters and their boundary

- **gate-sitter** (no-mistakes ci-step): machine signals only. Watches the PR
  until merged/closed; fetches failed CI logs, lets its agent fix, commits and
  force-pushes; rebases over merge conflicts. Verified: it never reads or
  answers review threads.
- **thread-sitter** (the resumed coder): conversation signals only. Reads new
  review comments, answers them, pushes addressing commits.

**Push semaphore:** the thread-sitter must not push while the gate has a CI
fix in flight (the gate force-pushes). Before pushing: check gate state
(`no-mistakes axi status` or the `gate_fix_inflight` event). The gate needs no
symmetric check — it owns CI-red moments; the thread-sitter owns CI-green
moments.

## 4. Thread-sitter resume contract

- On `coder_done`, combo-chen captures the implementing session's thread id
  (gnhf logs, or lookup in La Roca's ingested session metadata).
- On `review_comment`, the thread-sitter is the implementing thread resumed:
  `codex resume <id>`, `hermes --resume <session>`, or a stateful ACP session.
- Fallback (resume unavailable or context-saturated): fresh coder instance
  primed with issue + PR diff + the comment. Degraded, never blocking.

## 5. Review state

- A reviewer LGTM is pinned to the SHA it reviewed: `lgtm @ <sha>`.
- Any push invalidates it (`lgtm_stale`); the reviewer re-reviews the delta
  (incremental: diff since last reviewed SHA), then re-LGTMs or files
  findings.
- READY requires: current LGTM on HEAD ∧ CodeRabbit clean ∧ gate
  checks-passed.

## 6. Merge policy and the counterfactual log

- Default: human merges. Always.
- Every run records the counterfactual: would this combo have automerged
  (PR type, signals, timestamp)? After enough runs, per-PR-type automerge can
  be enabled where the counterfactual matches human decisions — trust earned
  with data.

## 7. Capacity and rate limits

- 24/7 operation within provider-enforced rate limits is legitimate use of
  each plan; limits are the contract.
- `rate_limited(role, until)` is a first-class event: the role pauses, the
  director knows, the role resumes at reset.
- Priority under scarcity: coder > thread-sitter > reviewer > sweeps.
- Roles spread across independent budgets by design (Claude subscription,
  Codex subscription, Hermes API providers).
- Persistent roles run interactive sessions; headless `-p`/SDK calls are
  reserved for one-off sweeps (separate billing pool since 2026-06-15).

## 8. Director mechanics (v0)

- One tmux session per combo: windows for coder, gate, watch, and any
  interactive agent roles (reviewer, thread-sitter).
- v0 drives interactive agents with tmux `send-keys` after readiness checks
  via `capture-pane`; state reading relies on hard signals (`gh`, events),
  pane scraping is health-check only.
- The ACP migration path (acpx) replaces send-keys role by role when it
  hurts; the role contract does not change.

## 9. Inherited hard limits

No merge, no deploy, no rocaup, no LaunchAgents. The combo produces a PR and
conversation, nothing else. Lingering processes die with the tmux session.

## 10. Open for veto

1. Who codes v0 (proposal: Claude, TDD, since Codex is the coder inside
   combos and the first director user is Claude).
2. GitHub repo now vs after v0 (proposal: now; issues are the product's raw
   material).
3. v0 scope cut (proposal: `run`/`status`/`stop`/`events`, codex+gnhf coder,
   no-mistakes gate, manual director; treehouse, ACP, auto-reviewer,
   counterfactual and dashboard deferred to v1+).
