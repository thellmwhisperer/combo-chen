# combo-chen

[![CI](https://github.com/thellmwhisperer/combo-chen/actions/workflows/ci.yml/badge.svg)](https://github.com/thellmwhisperer/combo-chen/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
![Status: Active Development](https://img.shields.io/badge/status-active%20development-brightgreen.svg)

**A deterministic director for autonomous issue-to-PR work.**

combo-chen turns one GitHub issue into one reviewed pull request. It creates an
isolated worktree, starts the configured coder, routes the result through a
gatekeeper, opens or updates the PR, starts a reviewer, and records every hard
signal in an append-only journal.

It does not replace your agents. It gives them a spine.

## The Problem

Autonomous coding agents are good at bursts of work. Full issue-to-PR delivery
is a different problem.

Someone still has to decide which branch owns the work, where the coder runs,
which commits are real, whether the gate actually published the PR, whether a
reviewer has seen the current head, and whether a previous "LGTM" went stale
after a new push.

When that orchestration lives in terminal scrollback or in a human's memory, the
run is fragile. Context compacts. A tmux pane dies. A CI wait goes quiet. A
review bot comments after the coder has gone idle. The PR may be close, but no
one can prove the state.

combo-chen makes the process explicit.

## How It Works

1. You point combo-chen at a GitHub issue.
2. It creates `.worktrees/issue-N` and a branch for that issue.
3. A coder agent implements the issue and leaves local commits.
4. A gatekeeper validates and publishes the branch to GitHub. If the initial gate
   fails before a PR opens, the director auto-retries it up to a configurable limit.
5. A reviewer comments with a SHA-pinned verdict.
6. Review comments are routed back to the coder in responding mode.
7. New addressing commits go back through the gatekeeper before publication.
8. The run becomes ready only when the current PR head has gate validation,
   reviewer LGTM, configured ambient reviewer success, and passing checks.

The human still owns the merge.

```text
GitHub issue
    |
    v
combo-chen run
    |
    +--> isolated worktree + issue branch
    |
    +--> coder agent writes local commits
    |
    +--> gatekeeper validates and publishes
    |
    +--> PR opens
    |
    +--> reviewer comments with "lgtm @ <head-sha>" or findings
    |
    +--> coder responding mode addresses review comments
    |
    +--> post-address gate republishes
    |
    v
ready_for_merge
```

## What Makes It Different

- **A journal, not vibes.** Every run has `journal.jsonl`. Status is derived
  from events, not from terminal scrollback or agent memory.
- **Fixed role boundaries.** Coder, gatekeeper, reviewer, director, and human
  are separate roles. The reviewer cannot be the coder.
- **Publish boundary.** Coders leave local commits. The gatekeeper is the normal
  publisher.
- **Recoverability.** `status --deep`, `resume`, `park`, `reconcile`, and
  `forensics` exist because long autonomous runs fail in boring ways.
- **Configurable agents.** The default shape uses Codex/gnhf, no-mistakes, and a
  configured reviewer command, but the role commands are TOML config.

## Quick Start

Requirements:

- Node 20+
- pnpm
- git
- tmux
- GitHub CLI (`gh`) authenticated for the target repo
- the agent tools configured for your coder, gatekeeper, and reviewer roles

Install from source:

```bash
git clone https://github.com/thellmwhisperer/combo-chen.git
cd combo-chen
pnpm install
pnpm build
```

Run a combo:

```bash
node dist/cli.mjs run --issue https://github.com/owner/repo/issues/123 --repo /path/to/repo --base origin/main
```

Watch it:

```bash
node dist/cli.mjs status
node dist/cli.mjs events -n owner-repo-123 --follow
```

`run` exits after setup. Launch it from a clean source checkout; the required
branch defaults to `main` and can be overridden with `[run].source_branch` or
`COMBO_CHEN_SOURCE_BRANCH`. The combo worktree is created from `origin/main` by
default, or from `--base <ref>` when you need an explicit recovery/test base.
The actual work continues inside tmux. Use `status`, `events`, or
`tmux list-sessions` to see the live run.

## Example Config

Copy [`combo-chen.example.toml`](combo-chen.example.toml) into the target repo as
`combo-chen.toml`, then tune the commands for your local tools.

```toml
[roles]
coder = "codex"
gatekeeper = "no-mistakes"
reviewer = ["claude"]
merge = "human"

[reviewer]
# Optional free-form reviewer instructions.
# prompt = "Apply my local review process."
ambient = ["coderabbit"]

[reviewer.claude]
command = "claude {prompt}"
```

Reviewer commands must submit reviews with a single inline
`gh pr review --comment --body "..."` command. They must not use heredocs, temp
files, pipes, redirects, semicolons, or cleanup commands to publish a review.

The target repo may also carry a local ignored `.no-mistakes.yaml` with explicit
test, lint, and build commands. combo-chen propagates it in two phases:
copies it from the repo into issue worktrees, then from the worktree into the
no-mistakes daemon's active run worktree before each gate, so validation stays
deterministic. The daemon copy polls with up to
`COMBO_CHEN_NO_MISTAKES_CONFIG_COPY_ATTEMPTS` retries (default 120, 1 s delay).

## Commands

```bash
combo-chen run --issue <issue-url> [--repo <dir>] [--base <ref>] [--prompt <text>]
combo-chen status [--deep] [--all]
combo-chen attach -n <combo-id>
combo-chen events --follow -n <combo-id>
combo-chen park -n <combo-id>
combo-chen resume -n <combo-id>
combo-chen forensics --issues <numbers> [--format json]
combo-chen reconcile [--apply]
combo-chen stop -n <combo-id>
```

### Recovery Commands

- `status` shows actionable live combos by default. Add `--all` to include
  terminal historical rows, and `--deep` to compare the journal with downstream
  GitHub and gatekeeper state.
- `park` writes a local handoff and stops tmux without making the combo
  terminal.
- `resume` reconstructs the right next action from the journal and downstream
  state. It does not start a fresh run on an existing combo.
- `forensics` produces a read-only report for stalled or confusing runs.
- `reconcile --apply` repairs journals that froze before a merged PR was
  recorded locally.

## State

By default, run state lives under:

```text
~/.combo-chen/runs/<combo-id>/
```

Important files:

- `combo.json`: repo, worktree, branch, and tmux identity.
- `journal.jsonl`: the source of truth.
- `runner.sh`: generated initial runner.
- `coder.log`: initial coder output.
- `gatekeeper.log`: initial gatekeeper output.
- `gatekeeper-post-<sha>.sh`: generated post-address gate.
- `park-handoff.md`: local summary created by `park`.

Do not hand-edit `journal.jsonl`. Use `combo-chen emit` only when a real-world
fact happened and the journal missed it.

## Why This Matters

The hard part of multi-agent coding is not getting an agent to write a diff. The
hard part is knowing what happened after the diff: which head was reviewed,
which head passed validation, what changed after review, whether the PR is
really ready, and where to resume after interruption.

combo-chen is the director layer for that space. It keeps the work moving
without collapsing the roles that make the result trustworthy.

## Development

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Behavior changes should be test-first. Keep operational values configurable
through env, TOML, then fallback defaults.

## Status

Active development.

v0 implements the issue-to-PR loop with coder, gatekeeper, initial-gate retry
with configurable attempts and backoff, reviewer, director watching,
review-comment routing, post-address gates, park/resume, reconcile, forensics,
and current-head READY agreement.

Deferred: preflight scoring, counterfactual automerge logs, worktree pools, ACP
role driving, and multi-combo dashboards.

## License

MIT.
