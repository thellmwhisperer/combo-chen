# combo-chen

> Tell an agent "run a combo for issue #128" and come back to a reviewed PR.

combo-chen is a conductor for autonomous **issue → PR pipelines**. It
composes tools you may already use — [gnhf](https://github.com/kunchenguid/gnhf)
(the coder loop), [no-mistakes](https://github.com/kunchenguid/no-mistakes)
(the quality gate) — under a fixed role contract with swappable agents:

| Role | Does | Default |
|---|---|---|
| **director** | orchestrates, watches, escalates — never touches code | you, or your agent |
| **rower** | rows: implements the issue, loops until done | codex via gnhf |
| **hodor** | holds the door: review→test→docs→lint→push→PR, then watches CI | no-mistakes |
| **gordon** | judges: reviews the PR, no courtesy LGTMs | claude + coderabbit |
| **thread-sitter** | the resumed rower: reads review comments, addresses them, pushes replies | codex (resumed thread) |
| **merge** | the decision | human, always (v0) |

Hard rule, validated at launch: `gordon != rower` — no agent judges its own
cooking.

## v0

```sh
combo-chen run --issue https://github.com/you/repo/issues/128
# 🥢 combo-chen-you-repo-128 · worktree .worktrees/issue-128 · tmux up

combo-chen status            # which combos need a human RIGHT NOW
combo-chen events --follow -n you-repo-128
combo-chen stop -n you-repo-128
```

`run` validates the issue, creates an isolated git worktree and a tmux
session, and starts the combo's **runner**: a generated script that rows
(gnhf), then gates (`no-mistakes axi run`), detects the PR, activates the
judge, and journals every milestone as JSONL events. The CLI is setup and
introspection; the runner is the spine; the judge polls for merge signals
and re-reviews on push.

State lives under `~/.combo-chen/runs/<combo>/` (`combo.json`,
`journal.jsonl`, `rower-thread.json`, `runner.sh`). No daemon.

## Configuration

Copy [`combo-chen.example.toml`](combo-chen.example.toml) to
`combo-chen.toml` (repo) or `~/.config/combo-chen/config.toml` (user).
Cascade: defaults ← user ← repo. Zero hardcoded operational values.

Required judge config: `[roles].gordon` must be non-empty, and at least one
listed gordon agent must have a `[gordon.<agent>]` `command` template. The
top-level `[gordon]` protocol reference is optional; it falls back to the
default protocol reference when omitted.

## Status

v0 implemented and test-verified; awaiting its first real combo (the fire
test). The protocol is in [`docs/spec.md`](docs/spec.md). Deferred to v1+:
treehouse worktree pools, ACP role driving, automated director,
preflight issue grading, the automerge counterfactual log.

## Development

```sh
pnpm install
pnpm test        # vitest — schemas live as tests
pnpm typecheck
pnpm build       # tsdown → dist/cli.mjs
```

TDD is mandatory: red test before production code.
