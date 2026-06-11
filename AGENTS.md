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
   ├─ PHASE 1 · ROWER     gnhf in a worktree (treehouse)   → thread_id captured
   ├─ PHASE 2 · HODOR     no-mistakes: pipeline → PR       (agent from .no-mistakes.yaml)
   ├─ PHASE 3 · JUDGING   gordon on /loop (+ coderabbit)  ⇄  RESUMED rower addresses
   │                      hodor ci-step in parallel (CI/conflicts, force-push)
   └─ MERGE               human (hard default); per-type automerge once the
                          counterfactual log earns it
```

Role names: the **rower** rows (implements); **hodor** holds the door (the
quality gate); **gordon** judges (the MasterChef reviewer — no courtesy
LGTMs).

Hard rules:
- `gordon != rower` (enforced by config validation, not convention).
- The director only orchestrates: never code, never review threads.
- Thread-sitter = the SAME thread that implemented, resumed (`codex resume`,
  `hermes --resume`, stateful ACP session). Fallback: fresh instance + diff.
- Push semaphore: the rower never pushes while a hodor CI fix is in flight
  (no-mistakes force-pushes; check its state before pushing).
- LGTM is pinned to a SHA: it expires on every push; merging requires a
  current LGTM on HEAD ∧ clean CodeRabbit ∧ hodor checks-passed.
- Rate limits are system events, not failures: the role pauses and resumes
  at reset. Priority under scarcity: rower > thread-sitter > gordon >
  sweeps.

## The two babysitters (an investigated boundary, not an assumed one)

- **hodor** = no-mistakes' `ci` step: watches the PR until merge/close,
  auto-fixes CI failures and merge conflicts. It does NOT read or answer
  review threads (verified against no-mistakes docs). He holds the door.
- **thread-sitter** = the resumed rower: answers and addresses review
  comments (CodeRabbit, reviewers, humans). This is the half no piece of the
  stack provides — combo-chen's contribution.

## Dependencies (Kun Chen's products)

| Piece | Role | Stack |
|---|---|---|
| treehouse | worktree pool with warm caches | Go |
| gnhf | the rower's loop over an issue | TypeScript |
| no-mistakes | hodor: review→test→docs→lint→push→PR→ci | Go |
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
- Persistent roles (reviewer, thread-sitter) run in INTERACTIVE sessions
  (subscription limits; legitimate 24/7 use within enforced rate limits);
  headless `-p`/SDK only for one-off sweeps (separate billing pool since
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
with `run`/`attach`/`status`/`stop`/`events`/`activate-judge` plus the hidden `judge-tick`
poll loop. Rower (codex+gnhf), hodor (no-mistakes), and gordon judge (tmux
poll + incremental re-review) are all implemented. Next: preflight,
counterfactual log, treehouse, ACP role driving.
