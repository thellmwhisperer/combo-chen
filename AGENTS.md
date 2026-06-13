# combo-chen

Conductor for autonomous issue → PR pipelines. It composes existing products
(treehouse, gnhf, no-mistakes) and interchangeable agents (Claude, Codex,
Hermes) under a fixed role contract. Named after Kun Chen, author of the
stack this project conducts.

A user (or an agent) says `combo-chen run --issue <url>` and gets: an
isolated worktree, a coder implementing in a loop, a quality gate that opens
the PR, a multi-model review loop, and babysitting until the PR is ready for
a human merge decision.

## Architecture: fixed roles, configurable agents

```text
DIRECTOR  (orchestrates and watches; NEVER touches code)   [tmux: combo-chen-N]
   │
   ├─ PHASE 1 · CODER     gnhf in a worktree (treehouse)   → thread_id captured
   ├─ PHASE 2 · GATEKEEPER git push to no-mistakes remote (if exists);
   │                      then no-mistakes pipeline → PR       (agent from .no-mistakes.yaml)
   ├─ PHASE 3 · REVIEWING reviewer on /loop (+ coderabbit) ⇄  RESUMED coder responds
   │                      gatekeeper ci-step in parallel (CI/conflicts, force-push)
   └─ MERGE               human (hard default); per-type automerge once the
                          counterfactual log earns it
```

Role names: the **coder** implements and later responds in the same thread;
the **gatekeeper** owns validation, push, and CI; the **reviewer** reviews
the PR with no courtesy LGTMs.

Hard rules:
- `reviewer != coder` (enforced by config validation, not convention).
- The director only orchestrates: never code, never review threads.
- Coder responding mode = the SAME thread that implemented, resumed (`codex resume`,
  `hermes --resume`, stateful ACP session). Fallback: fresh instance + diff.
- Push semaphore: the coder never pushes while a gatekeeper CI fix is in flight
  (no-mistakes force-pushes; check `gate_status` with `state=fix_inflight`
  before pushing).
- Mirror freshness: on every review-comment watcher cycle, combo-chen
  compares `origin/<branch>` with the `no-mistakes` mirror and fast-forwards
  the mirror when it is stale (also gated on the push semaphore).
- LGTM is pinned to a SHA: it expires on every push; merging requires a
  current LGTM on HEAD ∧ clean CodeRabbit ∧ gatekeeper checks-passed.
- Rate limits are system events, not failures: the role pauses and resumes
  at reset. Priority under scarcity: coder coding mode > coder responding
  mode > reviewer > sweeps.

## The two post-PR loops (an investigated boundary, not an assumed one)

- **gatekeeper** = no-mistakes' `ci` step: watches the PR until merge/close,
  auto-fixes CI failures and merge conflicts. It does NOT read or answer
  review threads (verified against no-mistakes docs).
- **coder responding mode** = the resumed coder: answers and addresses
  review comments (CodeRabbit, reviewers, humans). This is the part no-mistakes
  does not provide — combo-chen's contribution.

## Dependencies (Kun Chen's products)

| Piece | Role | Stack |
|---|---|---|
| treehouse | worktree pool with warm caches | Go |
| gnhf | the coder loop over an issue | TypeScript |
| no-mistakes | gatekeeper: review→test→docs→lint→push→PR→ci | Go |
| acpx | stateful ACP sessions (clean future channel) | TypeScript |

Agents supported as slots: `claude`, `codex`, `hermes:<model>`
(deepseek/gemini/...), `acp:<target>`. All three harnesses support the same
trio of mechanics: interactive tmux session + resume + ACP.

## Frozen decisions

- CLI product (determinism) + thin per-agent adapters (judgment). A Claude
  skill or an AGENTS.md paragraph only says "call the binary and babysit its
  events".
- Stack: TypeScript with gnhf's masonry — Node ≥20, pnpm, vitest, tsdown,
  commander. Matching the companion tool's conventions minimizes contributor
  friction and lets us reuse gnhf's e2e patterns (acp-mock) when ACP lands.
- v0 session driver: tmux `send-keys`/`capture-pane`. Migrate to ACP (acpx)
  role by role when it hurts.
- Persistent roles (reviewer, coder responding mode) run in INTERACTIVE sessions
  (subscription limits; legitimate 24/7 use within enforced rate limits);
  headless `-p`/SDK only for one-off sweeps (separate billing pool effective
  2026-06-15).
- Human merge by default. combo-chen records the counterfactual ("would have
  automerged") so per-PR-type automerge is earned with data, not faith.
- Review protocol: La Roca global pattern 7989 + per-project overlay (e.g.
  8034 for roca-madre). Referenced, never copied here.

## Development conventions

- TDD is mandatory: red test before production code.
- Zero hardcoded operational values: env → TOML config → fallback cascade.
- Config: per-repo `combo-chen.toml` + user-level; repo wins on policy,
  user wins on local setup (same model as treehouse/no-mistakes).
- Short conventional commits. Small PRs. No co-authors.

## Status

Spec v1 frozen (see `docs/spec.md` §10 for the decided vetoes). v0 implemented
with `run`/`attach`/`status`/`stop`/`events`/`activate-reviewer` plus the hidden `reviewer-tick`
poll loop. Coder (codex+gnhf), gatekeeper (no-mistakes), and reviewer (tmux
poll + incremental re-review) are all implemented. Next: preflight,
counterfactual log, treehouse, ACP role driving.
