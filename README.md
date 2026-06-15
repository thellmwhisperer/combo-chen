# combo-chen

combo-chen is the deterministic harness for an autonomous issue-to-PR loop.
It does not try to be the coder, the reviewer, or the gate. It creates the
worktree, starts the right role windows, records hard events, and keeps one
director loop watching until the PR is ready for a human merge decision.

It composes:

| Role | Tooling | Contract |
|---|---|---|
| **coder** | gnhf + Codex by default | implements the issue, then resumes the same thread to answer review comments |
| **gatekeeper** | no-mistakes | validates, publishes, watches CI, and republishes fixes |
| **reviewer** | configured reviewer + CodeRabbit | comments and records a SHA-pinned LGTM signal, no merge authority |
| **director** | combo-chen | orchestrates and observes only |
| **merge** | human | final decision |

Hard rule: `reviewer != coder`. The reviewer cannot be the same agent that
wrote the code.

## Lifecycle

`combo-chen run --issue <github-issue-url>` starts a named combo:

1. **Setup**: validates the issue/repo match, creates `.worktrees/issue-N`,
   writes `runner.sh`, opens a tmux session, and journals `combo_created`.
2. **Coder**: runs the configured coder command, normally gnhf. The coder
   leaves local commits in the combo worktree.
3. **Initial gate**: runs the configured no-mistakes gate. If the worktree has
   a `no-mistakes` remote, the default command pushes to that remote before
   `no-mistakes axi run --intent ...`. The gate opens the PR and journals
   gate state.
4. **PR observation**: once `pr_opened` is journaled, `director-watch` becomes
   the single observer. Reviewer and coder responding mode are worker windows,
   not independent polling loops.
5. **Review**: reviewer comments on the PR and, when clean, records an LGTM
   pinned to the current head SHA. CodeRabbit is treated as clean only through
   its current-head status/check plus a non-skipped current-head comment.
6. **Coder responding**: review comments are routed back to the original coder
   thread. The coder may answer and commit locally, but does not push.
7. **Post-address gate**: if local addressing commits appear, combo-chen
   journals the stale gate, generates a short post-address gate script, and
   safely publishes `HEAD:refs/heads/<branch>` to the no-mistakes mirror
   using `--force-with-lease` when a mirror branch already exists. It then
   starts no-mistakes again. no-mistakes remains the sole normal publisher.
8. **READY**: combo-chen emits `ready_for_merge` only when all current-head
   signals agree: gate validated this SHA, reviewer LGTM is pinned to this SHA,
   CodeRabbit is clean for this SHA, and non-CodeRabbit CI/check rollup is
   successful for this SHA.
9. **Human merge**: combo-chen does not merge. A human owns the merge decision.

Rate limits and transient GitHub/git/tmux failures are operational events. The
director loop logs concise notes and re-evaluates on later ticks when possible.

## Commands

```sh
combo-chen run --issue https://github.com/you/repo/issues/128
combo-chen status
combo-chen attach -n you-repo-128
combo-chen events --follow -n you-repo-128
combo-chen stop -n you-repo-128
```

Useful behavior:

- `run` creates the worktree and tmux session, then starts the generated
  runner.
- `status` prints one line per combo: phase, human-needed reason, and PR URL.
- `attach` opens the combo tmux session and recreates the short journal pane if
  needed.
- `events --follow` tails the JSONL journal without attaching to tmux.
- `stop` kills the tmux session and leaves the journal/worktree for inspection.

Hidden commands such as `activate-reviewer`, `activate-coder`,
`director-tick`, `director-watch`, `ensure-pr-autoclose`, and
`nudge-review-comments` are internal runner/director entry points.

## State And Logs

Per-run state lives under:

```text
~/.combo-chen/runs/<combo-id>/
```

Important artifacts:

| Path | Purpose |
|---|---|
| `combo.json` | combo identity, repo, worktree, branch, tmux session |
| `journal.jsonl` | ordered lifecycle and hard-signal events |
| `runner.sh` | generated initial coder/gate script |
| `coder-thread.json` | captured coder session/thread id for resume |
| `coder.log` | initial coder output |
| `gatekeeper.log` | initial no-mistakes gate output |
| `gatekeeper-post-<sha>.sh` | generated post-address gate script |
| `gatekeeper-post-<sha>.log` | post-address no-mistakes output |
| `autoclose*.log` | PR body autoclose repair attempts |

The journal is the source of truth for orchestration. Pane text is only a
health surface.

## Configuration

Copy [`combo-chen.example.toml`](combo-chen.example.toml) to
`combo-chen.toml` in the target repo or to
`~/.config/combo-chen/config.toml`. Cascade:

```text
defaults <- user config <- repo config
```

The default gatekeeper command passes an issue-derived intent to no-mistakes
and ends with `Fixes #N`, where `N` comes from the source issue URL. Custom
gatekeeper commands support `{issue_url}`, `{issue_title}`, `{issue_body}`,
`{issue_pr_intent}`, and `{branch}` placeholders. Placeholders are shell-quoted
when the runner is generated.

Reviewer config must define `[roles].reviewer` and a command template for that
agent under `[reviewer.<agent>]`.

**Rate limits and watcher resilience:** The director-watch polling loop handles
transient failures (rate limits, network errors) with exponential backoff
(doubling the poll interval, capped by
`[limits].watch_backoff_max_seconds`, default 3600 s). After
`[limits].watch_failure_limit` consecutive failures (default 5), the watcher
journals `watch_dead` and exits so the operator can inspect or restart it.
Environment overrides: `COMBO_CHEN_WATCH_FAILURE_LIMIT`,
`COMBO_CHEN_WATCH_BACKOFF_MAX_SECONDS`.

### no-mistakes local config

no-mistakes repo commands belong in the repo's ignored local
`.no-mistakes.yaml`, not in combo-chen source. For this repo, that file pins
explicit commands such as `pnpm test`, `pnpm typecheck`, and `pnpm build` so
no-mistakes does not have to infer validation or request broad permissions.

Git worktrees do not automatically materialize ignored working-tree files.
combo-chen therefore treats `<repoDir>/.no-mistakes.yaml` as a local artifact:

- if the source file exists and `<worktree>/.no-mistakes.yaml` is missing,
  combo-chen copies it into the combo worktree before no-mistakes runs;
- content and mode are preserved;
- an existing worktree `.no-mistakes.yaml` is never overwritten;
- post-address gates run the same propagation step so old worktrees can
  recover if the artifact is missing;
- the file remains local and must not be staged or committed.

## Development

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

TDD is mandatory for behavior changes: write the failing test first. Keep
operational values configurable through env, TOML, then fallback defaults.

The source files use Sherpa-style navigable comments: read the `@overview`,
follow the reading guide to the core section, and keep the section map current
when changing a file.

## Status

v0 is implemented with `run`, `attach`, `status`, `stop`, `events`, the hidden
director loop, coder responding mode, no-mistakes initial and post-address
gates, reviewer re-review, local no-mistakes config propagation, and
current-head READY agreement. Deferred work: preflight, counterfactual
automerge log, treehouse worktree pools, ACP role driving, and multi-combo
dashboarding.
