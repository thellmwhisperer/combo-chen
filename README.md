# combo-chen

[![CI](https://github.com/thellmwhisperer/combo-chen/actions/workflows/ci.yml/badge.svg)](https://github.com/thellmwhisperer/combo-chen/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
![Status: Active Development](https://img.shields.io/badge/status-active%20development-brightgreen.svg)

**A deterministic director for autonomous work-item-to-PR pipelines.**

combo-chen turns one GitHub issue or a local work-plan file into one reviewed
pull request. It creates an isolated worktree, starts the configured coder,
routes the result through a gatekeeper, opens or updates the PR, starts a
reviewer, and records every hard signal in an append-only journal.

It does not replace your agents. It gives them a spine.

## The Problem

Autonomous coding agents are good at bursts of work. Full work-item-to-PR delivery
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

1. You point combo-chen at a GitHub issue or a local work-plan file.
2. It creates an isolated worktree and branch.
3. A coder agent implements the work item and leaves local commits.
4. A gatekeeper validates and publishes the branch to GitHub. Before each gate run,
   the generated script acquires a branch-scoped gate lease so independent
   branches can publish in parallel while same-branch ownership stays exclusive.
   If the initial gate fails before a PR opens, the director auto-retries it up to
   a configurable limit.
5. A reviewer comments with a machine-readable verdict block (codes: 0=OK/LGTM,
   1=mechanical fix→coder, 2=ambiguous→director, 3=needs human) and/or a
   SHA-pinned LGTM verdict.
6. Review comments are routed back to the coder in responding mode.
7. New addressing commits go back through the gatekeeper before publication.
8. The run becomes ready only when the current PR head has gate validation,
    reviewer LGTM, configured required READY checks, and passing remaining checks.
    If a sibling merge advances the base and the READY PR becomes dirty or
    conflicting, the director invalidates READY and routes the coder to rebase.
9. While the PR is open, GitHub labels reflect the live combo state
   (`combo:working-coder`, `combo:working-reviewer`, `combo:working-gate`,
   `combo:lgtm`, `combo:external-review-green`, `combo:ready`, `combo:stale`,
   `combo:conflict`), leaving a visible path through the workflow timeline.
10. After the human merges the PR, `combo-chen closure -n <combo-id>` converges
   local resources deterministically.

The human still owns the merge.

```text
GitHub issue or work-plan file
    |
    v
combo-chen run (--issue <url> | --plan <file>)
    |
    +--> overture checks (see combo-chen overture)
    |
    +--> isolated worktree + branch
    |
    +--> coder agent writes local commits
    |
    +--> gatekeeper validates and publishes
    |
    +--> PR opens
    |
    +--> reviewer comments with machine-readable verdict codes (0-3) or "lgtm @ <head-sha>"
    |
    +--> coder responding mode addresses review comments
    |
    +--> post-address gate republishes
    |
    +--> live combo PR labels kept in sync on GitHub
    |
    v
ready_for_merge
    |
    v
human merge -> combo-chen closure -n <combo-id>
```

## What Makes It Different

- **A journal, not vibes.** Every run has `journal.jsonl`. Status is derived
  from events, not from terminal scrollback or agent memory.
- **Fixed role boundaries.** Coder, gatekeeper, reviewer, director, and human
  are separate roles. The reviewer cannot be the coder.
- **Publish boundary.** Coders leave local commits. The gatekeeper is the normal
  publisher.
- **Visible PR state.** GitHub labels track the live combo workflow
  (`combo:working-coder` → `combo:working-gate` → `combo:working-reviewer`
  → `combo:lgtm` → `combo:ready`), so an operator can read the timeline
  without inspecting tmux scrollback or journal files.
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

Run a combo from a GitHub issue:

```bash
node dist/cli.mjs run --issue https://github.com/owner/repo/issues/123 --repo /path/to/repo --base origin/main
```

Or from a local work-plan file:

```bash
node dist/cli.mjs run --plan plan.md --repo /path/to/repo --base origin/main
```

Work plans are markdown files with required `## Acceptance Criteria` and optional
sections for problem, scope, validation, and intent decisions. See `docs/spec.md`
section 9 for the full work-plan contract.

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
# GitHub authors allowed to satisfy "lgtm @ <sha>" and verdict block routing.
logins = ["claude"]

[ready]
required_checks = ["CodeRabbit"]

[pr_labels]
green_check_names = ["CodeRabbit"]

[external_comments]
# External comment/noise filters only; not approval and not READY checks.
agents = ["external-reviewer"]

[reviewer.claude]
command = "claude {prompt}"

[director]
# Promptable interactive director window; director-watch owns polling.
command = "claude {prompt}"
```

Reviewer commands must submit reviews with a single inline
`gh pr review --comment --body "..."` command. They must not use heredocs, temp
files, pipes, redirects, semicolons, or cleanup commands to publish a review.
Only comments or reviews authored by `[reviewer].logins` can satisfy the
SHA-pinned reviewer LGTM gate and have their machine-readable verdict blocks
accepted for routing; by default this is the active reviewer agent name.
`[ready].required_checks` names GitHub status contexts/check runs that must be
present with exact `SUCCESS`; by default this includes `CodeRabbit`, and a
skipped CodeRabbit review is not a READY success. These external checks are not
reviewer approval.
`[pr_labels].green_check_names` names the check contexts/runs that satisfy the
`combo:external-review-green` status label.
`[external_comments].agents` names GitHub App or bot logins whose comments are
filtered for bookkeeping/noise and otherwise routed to coder responding mode.

## Agent CLI Policy

The default Codex coder path is gnhf-managed: combo-chen runs pinned `gnhf` with
`--agent codex`, `--max-iterations`, `--stop-when`, `--prevent-sleep on`,
`--meteor-frequency 0`, and `--current-branch`. gnhf 0.1.41 does not expose a
generic Codex CLI profile/flag pass-through, so Codex terminal flags are not
part of the normal coder command. Coder responding mode resumes the captured
thread with the configured resume command (default `codex resume {thread_id}`).
The recommended `codex --profile sitter --no-alt-screen resume {thread_id}`
keeps tmux scrollback visible and the session resumable/auditable without
changing the underlying default. Custom `resume_command` templates remain
supported for local wrappers or other agents.

If combo-chen later adds a direct noninteractive Codex runner, it must keep
`-C {worktree}` explicit, use an autonomous isolated sandbox such as
`--sandbox workspace-write --ask-for-approval never`, emit parseable events with
`--json`, and capture the final answer with `-o {run_dir}/final.md`.
`--search` stays opt-in per issue. Normal project agents should keep project
rules and user config enabled, avoid `--ephemeral`, and avoid
`dangerously-bypass-approvals-and-sandbox` unless another sandbox boundary owns
that risk.

Reviewer commands are tmux-visible interactive role commands by default and
therefore honor project context. If a reviewer role is later moved to a
headless Claude `-p`/SDK runner whose output is consumed by combo-chen, that
runner should use JSON or stream-JSON output, explicit budget/turn limits, a
read/review-oriented tool surface, and separate cost/usage artifacts.

The target repo may carry a repo-level `.no-mistakes.yaml` with explicit test,
lint, and build commands. combo-chen tracks this file in this repo on purpose
so every worker and no-mistakes gate shares the same validation contract; keep
user-local secrets and operator preferences in ignored config such as
`combo-chen.toml` or the user's environment. combo-chen propagates
`.no-mistakes.yaml` in two phases: copies it from the repo into issue
worktrees, then from the worktree into the no-mistakes daemon's active run
worktree before each gate, so validation stays deterministic. The daemon copy
polls with up to
`COMBO_CHEN_NO_MISTAKES_CONFIG_COPY_ATTEMPTS` retries (default 120, 1 s delay).

## Release Artifacts

Release builds carry inspectable metadata: `combo-chen --version` prints the
package version, commit, and build date embedded at build time. Local builds use
safe fallbacks; release automation passes `COMBO_CHEN_COMMIT` and
`COMBO_CHEN_BUILD_DATE`.

The release asset contract feeds the active `combo-chen update` command
directly:

- Platform archives are named
  `combo-chen-vX.Y.Z-<platform>-<arch>.tar.gz`; the default targets are
  `darwin-arm64`, `darwin-x64`, `linux-arm64`, and `linux-x64`.
- Each archive expands under `combo-chen-vX.Y.Z/` and installs the executable
  CLI at `bin/combo-chen`, sourced from `dist/cli.mjs`, plus package metadata,
  README, LICENSE, and `combo-chen.example.toml`.
- `checksums.txt` is sha256sum-compatible, sorted by filename, and covers every
  uploaded `.tar.gz` asset.
- `pnpm release:assets` builds the CLI and writes reproducible archives plus
  `checksums.txt` into `dist/release/`.
- The `release-assets` workflow runs for published and prereleased GitHub
  releases and uploads `dist/release/*.tar.gz` plus
  `dist/release/checksums.txt` to the release.

`combo-chen update` queries GitHub Releases, compares the current embedded build
metadata with the latest eligible release, and prints the current,
update-available, unsupported, or failure state. Stable mode ignores prereleases:

```bash
combo-chen update --yes
```

Beta mode includes prereleases:

```bash
combo-chen update --beta --yes
```

After resolving a newer candidate, the command downloads the selected archive
and checksums.txt, verifies the checksum before extraction, extracts into an
isolated staging directory, and then hands the staged release archive to the
atomic replacement primitive. Checksum, download, and extraction failures are
explicit: the command reports failures before replacement and leaves the
previous installation intact.
Unsupported source checkouts and package-manager dev shims fail with useful
non-auto-replaceable errors. The live combo/session integration is owned by
#72; the active update command does not restart daemons, inspect running
capsules, or apply passive update notices.

## U0 update contract bridge and updater slices

U0, U1, U2, and U3 together span the updater contract from release identity
through release resolution, verified staging, and replacement eligibility.  U0
is the read-only vocabulary layer: it defines shared types and pure helpers for
release tag/version normalization, current build versus candidate comparison,
platform asset selection, sha256sum-compatible checksum lookup, obvious install
target classification, active combo state, and the aggregate
`ReadOnlyUpdatePlan`.

U1 (`src/core/update-resolver.ts`) implements the release resolver and
latest/beta check flow.  It consumes GitHub Releases metadata plus current build
metadata, ignores prereleases in stable mode, includes prereleases in beta mode,
normalizes candidates through the U0 contract, selects expected platform assets,
and returns a read-only update decision without downloads, extraction,
replacement, or live combo inspection.

U2 (`src/core/update-staging.ts`) implements download, SHA-256 checksum
verification, and isolated extraction primitives.  It accepts a resolved update
plan or fixture, downloads the archive and `checksums.txt`, verifies the digest
before extraction, extracts into an isolated staging directory, and returns a
`StagedUpdateArtifact` descriptor with enough metadata for the replacement
primitive.  All network and filesystem operations are injected through
`UpdateStagingDeps` so tests run without real I/O.  Checksum mismatches, missing
entries, unavailable checksums, and extraction failures are reported
deterministically with cleanup status.

U0 itself does not download, extract, replace, restart, or mutate active combo
capsules.

U3 (`replaceInstallTargetFromStagedArtifact`) implements install target and
atomic replacement for staged release archive installs.  This means source
checkouts and package-manager dev shims are non-auto-replaceable; only release
archive paths shaped like `combo-chen-vX.Y.Z/bin/combo-chen` are eligible for
replacement.

U2 and U3 do not resolve releases, restart active combo capsules, or mutate
active combo runtime state.

Completed updater slices:

- U1: release resolver and latest/beta check flow. (Landed: `resolveLatestReleaseCandidate`, `resolveReadOnlyUpdatePlan`.)
- U2: download, checksum verification, and staging.
- U3: install target and atomic replacement. (Landed: `replaceInstallTargetFromStagedArtifact`.)

Remaining follow-up slices:

- U4: live combo/session integration owned by #72.

## Commands

```bash
combo-chen overture --issue <issue-url> [--repo <dir>] [--base <ref>]
combo-chen overture --plan <file> [--repo <dir>] [--base <ref>]
combo-chen run --issue <issue-url> [--repo <dir>] [--base <ref>] [--prompt <text>]
combo-chen run --plan <file> [--repo <dir>] [--base <ref>] [--prompt <text>]
combo-chen update [--beta] [-y|--yes]
combo-chen status [--deep] [--all]
combo-chen attach -n <combo-id>
combo-chen events --follow -n <combo-id>
combo-chen park -n <combo-id>
combo-chen resume -n <combo-id>
combo-chen forensics --issues <numbers> [--format json] [--record-outcome]
combo-chen reconcile [-n <combo-id>] [--apply]
combo-chen stop -n <combo-id>
combo-chen director-prompt -n <combo-id> --reason <reason> <message...>
```

`overture` checks the launch runway before spending agent tokens or creating
tmux sessions. It runs the same deterministic checks that `run` executes
internally: work item readability, repo/issue match, clean checkout, base ref,
branch/worktree/tmux availability, no-mistakes status, and coder/reviewer
command safety. A blocked check prints an `X` and exits before any launch
resources are created. Run it standalone to verify readiness, or let `run`
consume it automatically.

### Recovery Commands

- `status` is the parallel capsule dashboard: it shows actionable live combos
  by default. Add `--all` to include
  terminal historical rows, and `--deep` to compare the journal with downstream
  GitHub and gatekeeper state. Its table includes active branch-scoped gate
  lease owners when no-mistakes is reserved by combos. Before rendering, `status`
  quietly closes closed-PR salvage cases. For merged PRs it records the merge
  fact, leaves resources untouched, and keeps the row visible as `closure_pending` until
  `combo-chen closure -n <combo-id>` records `combo_closed`. If a non-terminal
  combo no longer has its tmux session, status journals `tmux_missing` so it is
  shown as needing human attention instead of looking supervised.
- `combo-chen closure -n <combo-id>` is the canonical merged happy-path cleanup
  command. Reviewer/director-watch and status can record or report the merge
  fact, but they leave resource convergence to closure.
- `park` writes a local handoff and stops tmux without making the combo
  terminal.
- `resume` reconstructs the right next action from the journal and downstream
  state. It does not start a fresh run on an existing combo.
- `forensics` produces a read-only report for stalled or confusing runs. The
  markdown includes a copy-ready outcome block with PR link, head SHA,
  review/check state, failures found, and follow-up bug status for dogfood
  records. Add markdown-only `--record-outcome` to post that compact Outcome
  block to each matched source GitHub issue.
- `reconcile --apply` repairs journals that froze before a merged or closed PR
  was recorded locally. Add `-n <combo-id>` to scope repair and teardown to a
  single combo. Teardown is idempotent: already-clean worktrees, branches, and
  tmux sessions count as success.

## Parallelize-First Operating Protocol

Start with 2 live capsules, then 3, then 4 to 6 only after the previous wave has
clean journal evidence and no unrecovered resource conflicts. A capsule is the
unit of ownership: each capsule keeps one branch, one worktree, one tmux
session, and one runtime ledger. Do not share branches across capsules.

Branch-scoped gate leases keep no-mistakes publication exclusive only per
branch. Parallel coders, reviewers, and no-mistakes publishers may run at the
same time when their capsules own different branches; a same-branch owner
mismatch journals a human-facing lease conflict instead of starting a second
publisher for that branch.

Recovery playbook:

- Parked combos: use `combo-chen resume -n <combo-id>` to reconstruct the next
  action from the journal and downstream state.
- Pre-PR coder stalls: use `status --deep` or `forensics` to confirm the stall,
  then resume or park the capsule; do not relaunch on the same branch.
- Reviewer auth failures: fix the configured reviewer GitHub auth/login, then
  rerun reviewer activation or prompt the reviewer without changing the coder
  branch.
- Gate lease contention: for same-branch conflicts, inspect the lease owner in
  `status`, then resolve stale/conflicting ownership before retrying the gate.
- Post-merge closure: run `combo-chen closure -n <combo-id>` after GitHub reports
  `MERGED`; status/reviewer may record the merge fact but do not remove local
  resources.

Future parallel runs should leave postmortem metadata: wave size, combo ids,
branches, PRs, gate-lease waits/conflicts, recovery commands used, final
closure state, and any changed wave limit.

## State

By default, run state lives under:

```text
~/.combo-chen/runs/<combo-id>/
```

Important files:

- `overture.json`: launch runway check results before worktree/tmux/branch creation.
- `combo.json`: repo, worktree, branch, tmux identity, and work-item source metadata.
- `journal.jsonl`: the source of truth. Includes `pr_labels_updated` events
  that record every PR label mutation with metadata (PR URL, head SHA, old/new
  labels, reason) for auditability.
- `runtime-ledger.json`: machine-readable combo capsule resource ledger; written at launch, updated when PR/reviewer/director resources appear.
- `config.snapshot.json`: frozen launch-time config; prevents runtime drift when repo TOML changes.
- `runner.sh`: generated initial runner.
- `coder.log`: initial coder output.
- `gatekeeper.log`: initial gatekeeper output.
- `gatekeeper-post-<sha>.sh`: generated post-address gate.
- `work-plan.md`: normalized work-plan artifact; the canonical source of work-item intent for reviewer, gatekeeper, and forensics.
- `park-handoff.md`: local summary created by `park`.

Shared cross-combo state lives under
`~/.combo-chen/gate-leases.lock/<encoded-branch>/lease.json`. Each branch gets
its own atomic lease directory, so different branches can gate concurrently
while the same branch remains single-owner.

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

v0 implements the work-item-to-PR loop under the parallelize-first operating
contract: deterministic overture launch
runway, coder, gatekeeper, initial-gate
retry with configurable attempts and backoff, reviewer with machine-readable
verdict codes (0-3) and deterministic routing, director watching,
review-comment routing, post-address gates, director prompt delivery for
code-2 verdicts, park/resume, reconcile, forensics,
launch-time config snapshots to protect runtime behavior from repo TOML drift,
a machine-readable runtime ledger for each combo capsule,
branch-scoped gate leases for parallel capsules with stale recovery and heartbeat,
wave-based parallel scaling (start 2, then 3, then 4-6 with postmortem justification),
current-head READY agreement with base-advance conflict detection, and live GitHub PR label projection
(combo:working-*, combo:lgtm, combo:external-review-green, combo:ready, combo:stale,
combo:conflict) with mutation journaling. Work items can be GitHub issues (`--issue`) or
local markdown work plans (`--plan`).

Deferred: preflight scoring, counterfactual automerge logs, worktree pools, and ACP
role driving.

## License

MIT.
