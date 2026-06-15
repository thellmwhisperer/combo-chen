# combo-chen

> Tell an agent "run a combo for issue #128" and come back to a reviewed PR.

combo-chen is a conductor for autonomous **issue → PR pipelines**. It
composes tools you may already use — [gnhf](https://github.com/kunchenguid/gnhf)
(the coder loop), [no-mistakes](https://github.com/kunchenguid/no-mistakes)
(the quality gate) — under a fixed role contract with swappable agents:

| Role | Does | Default |
|---|---|---|
| **director** | orchestrates, watches, escalates — never touches code | you, or your agent |
| **coder** | implements the issue, then resumes the same thread to address review comments | codex via gnhf |
| **gatekeeper** | runs review→test→docs→lint→push→PR, then watches CI | no-mistakes |
| **reviewer** | reviews the PR, no courtesy LGTMs | claude + coderabbit |
| **merge** | the decision | human, always (v0) |

Hard rule, validated at launch: `reviewer != coder` — no agent reviews its
own changes.

## v0

```sh
combo-chen run --issue https://github.com/you/repo/issues/128
# 🥢 combo-chen-you-repo-128 · worktree .worktrees/issue-128 · tmux up

combo-chen status            # which combos need a human RIGHT NOW
combo-chen attach             # tmux into the running combo (--name when several)
combo-chen events --follow -n you-repo-128  # blocks; run in another terminal
combo-chen stop -n you-repo-128
```

`run` validates the issue, creates an isolated git worktree and a tmux
session, and starts the combo's **runner**: a generated script that codes
(gnhf), then gates (pre-pushes to the `no-mistakes` remote if one exists,
then runs `no-mistakes axi run --intent` with the source issue contract),
journals `gate_status` events through
the gatekeeper lifecycle (fix_inflight → idle / failed / awaiting_approval),
and journals every milestone as JSONL events. If the gate opens and
`pr_opened` is detected, the runner activates the reviewer; if no-mistakes is
`awaiting_approval`, the combo remains in `GATING` with `gate_waiting`
until a human resolves the gate. The CLI is setup and
introspection; the runner is the spine; the reviewer polls for merge signals
and re-reviews on push.

State lives under `~/.combo-chen/runs/<combo>/` (`combo.json`,
`journal.jsonl`, `coder-thread.json`, `coder.log`, `gatekeeper.log`, `runner.sh`). No daemon.

## Configuration

Copy [`combo-chen.example.toml`](combo-chen.example.toml) to
`combo-chen.toml` (repo) or `~/.config/combo-chen/config.toml` (user).
Cascade: defaults ← user ← repo. Zero hardcoded operational values.
The default gatekeeper command passes an issue-derived intent to no-mistakes that
ends with `Fixes #N`, where `N` comes from the source issue URL. That explicit
GitHub autoclose keyword is the PR/body contract for normal issue combos:
merging the generated PR should close the source issue automatically.

The gatekeeper command supports `{issue_url}`, `{issue_title}`, `{issue_body}`,
`{issue_pr_intent}`, and `{branch}` placeholders that are shell-quoted at
runner generation time. Custom commands that still create issue-closing PRs
should pass `{issue_pr_intent}` or include an equivalent autoclose keyword;
free-form text such as `issue #N` is not sufficient for GitHub autoclose.

Required reviewer config: `[roles].reviewer` must be non-empty, and at least one
listed reviewer agent must have a `[reviewer.<agent>]` `command` template. The
top-level `[reviewer]` protocol reference is optional; it falls back to the
default protocol reference when omitted.

**Rate limits and watcher resilience:** The reviewer-watch polling loop
handles transient failures (rate limits, network errors) with exponential
backoff (doubling the poll interval, capped by
`[limits].watch_backoff_max_seconds`, default 3600 s). After
`[limits].watch_failure_limit` consecutive failures (default 5), the watcher
journals `watch_dead` and exits — the director sees the dead-watcher event
and can escalate. Environment overrides:
`COMBO_CHEN_WATCH_FAILURE_LIMIT`, `COMBO_CHEN_WATCH_BACKOFF_MAX_SECONDS`.

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
