# Combo Chen — `main-combo-v1` (bash chain integration)

This branch is the **integration line for the new bash five-agent chain** (P1–P3 landed on `main`, then P4–P8).

- Product shape: `Launcher → Coder ⇄ Reviewer → Gate → Cleaner`
- Contents: only the **new bash-v1 surface** (`bin/cb-*`, shell contract tests, journal fixtures, docs/spec excerpts, CodeRabbit chill config). Legacy TypeScript capsule/runtime from historical `main` is **not** carried here.
- Source tip at creation: `main` @ `e2fe5a2` (P1 #319, P2 #321, P3 #323, CodeRabbit config).
- Do not treat historical `main-v1` as this line; that was the prior TS RC.

---

# combo-chen

[![CI](https://github.com/thellmwhisperer/combo-chen/actions/workflows/ci.yml/badge.svg)](https://github.com/thellmwhisperer/combo-chen/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
![Status: Active Development](https://img.shields.io/badge/status-active%20development-brightgreen.svg)

**A deterministic director for autonomous work-item-to-PR pipelines.**

combo-chen turns one GitHub issue or a local work-plan file into one reviewed
pull request. It leases an isolated Treehouse worktree, starts the configured coder,
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
2. It leases an isolated Treehouse worktree and creates the combo branch inside it.
3. A coder agent implements the work item and leaves local commits.
4. A gatekeeper validates and publishes the branch to GitHub. Before each gate run,
   the generated script acquires a branch-scoped gate lease so independent
   branches can publish in parallel while same-branch ownership stays exclusive.
   If the initial gate fails before a PR opens, the director auto-retries it up to
   a configurable limit. When no-mistakes exits non-zero after publishing but the
   gate log shows `outcome: checks-passed` with a later `context canceled`, the
   generated scripts treat that as recovered success instead of `gate_failed`,
   unless the repo `.no-mistakes.yaml` copy into the daemon worktree failed.
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
10. After the human merges the PR, the director-watch loop detects the merge
    and auto-triggers `closure` to converge local resources deterministically.
    The manual `combo-chen closure -n <combo-id>` remains available as a
    fallback.

The human still owns the merge.

```text
GitHub issue or work-plan file
    |
    v
combo-chen run (--issue <url> | --plan <file>)
    |
    +--> overture checks (see combo-chen overture)
    |
    +--> Treehouse lease + isolated worktree + branch
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
human merge -> director-watch auto-closure -> combo_closed
```

## What Makes It Different

- **A journal, not vibes.** Every run has `journal.jsonl`. Status is derived
  from events, not from terminal scrollback or agent memory.
- **Fixed role boundaries.** Coder, gatekeeper, reviewer, director, and human
  are separate roles. The reviewer cannot be the coder. The fixed tmux role
  topology is the stable six-window order journal, director, coder,
  gatekeeper, reviewer, and director-watch. Gatekeeper and reviewer windows are
  precreated at launch, and the coder-response target defaults to the
  persistent coder window.
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
- Treehouse CLI for worktree management
- GitHub CLI (`gh`) authenticated for the target repo
- the agent tools configured for your coder, gatekeeper, and reviewer roles

Install from a release tarball (recommended):

```bash
curl -fsSL https://raw.githubusercontent.com/thellmwhisperer/combo-chen/main/install.sh | sh
```

The installer resolves the latest GitHub release for your platform, verifies
the sha256 against `checksums.txt` before touching anything, extracts under
`~/.combo-chen/versions/combo-chen-vX.Y.Z/`, and symlinks
`~/.local/bin/combo-chen`. That layout is exactly the `release_archive`
install target `combo-chen update` auto-replaces, so one install keeps itself
current. Re-running the installer is idempotent and previous version
directories stay on disk. Flags: `--version X.Y.Z`, `--repo OWNER/NAME`,
`--prefix DIR`, `--bin-dir DIR`, and `--archive FILE --checksums FILE` for
offline installs. The installer never overwrites a non-symlink `combo-chen` on
your bin dir.

Uninstall:

```bash
rm ~/.local/bin/combo-chen
rm -rf ~/.combo-chen/versions
```

Install from source (contributors):

```bash
git clone https://github.com/thellmwhisperer/combo-chen.git
cd combo-chen
pnpm install
pnpm build
```

Run a combo from a GitHub issue:

```bash
combo-chen run --issue https://github.com/owner/repo/issues/123 --repo /path/to/repo --base origin/main
```

Or from a local work-plan file:

```bash
combo-chen run --plan plan.md --repo /path/to/repo --base origin/main
```

Work plans are markdown files with required `## Acceptance Criteria` and optional
sections for problem, scope, validation, and intent decisions. See `docs/spec.md`
section 9 for the full work-plan contract.

Watch it:

```bash
combo-chen status
combo-chen events -n owner-repo-123 --follow
```

`run` exits after setup. Launch it from a clean source checkout; the required
branch defaults to `main` and can be overridden with `[run].source_branch` or
`COMBO_CHEN_SOURCE_BRANCH`. The combo worktree is created from `origin/main` by
default, or from `--base <ref>` when you need an explicit recovery/test base.
The actual work continues inside tmux. Use `status`, `events`, or
`tmux list-sessions` to see the live run.

From a contributor source checkout that has not installed the `combo-chen`
binary, use `node dist/cli.mjs` in place of `combo-chen`.

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
# Dogfood default: CodeRabbit must be present with SUCCESS before READY.
required_checks = ["CodeRabbit"]

[external_review]
commands = ["@coderabbitai review"]

[pr_labels]
green_check_names = ["CodeRabbit"]

[external_comments]
# External comment/noise filters only; not approval and not READY checks.
agents = ["coderabbitai"]

[reviewer.claude]
command = "claude {prompt}"

[director]
# Promptable interactive director window; director-watch owns polling.
command = "claude {prompt}"

# [team] declares the expected effective identity per role. Overture resolves each
# tool's actual config and fails on mismatch. Undeclared: current behavior, noted
# in the checklist. Uncomment and tune for each role you want to pin.
# [team.coder]
# binary = "npx"
# agent = "gnhf/codex"
# model = "gpt-5.5"
```

Reviewer commands must submit reviews with a single inline
`gh pr review --comment --body "..."` command. They must not use heredocs, temp
files, pipes, redirects, semicolons, or cleanup commands to publish a review.
Only comments or reviews authored by `[reviewer].logins` can satisfy the
SHA-pinned reviewer LGTM gate and have their machine-readable verdict blocks
accepted for routing; by default this is the active reviewer agent name.
Verdict code 0 also requires a `lgtm @ <sha>` pin in the review body.
`[ready].required_checks` names GitHub status contexts/check runs that must be
present with exact `SUCCESS`; the runtime default is empty, and the example
dogfood config below opts into `CodeRabbit`. A skipped CodeRabbit review is not
a READY success. These external checks are not reviewer approval.
Keep the four external-review settings in sync when replacing CodeRabbit with
another bot.
`[external_review].commands` names PR-comment commands the director posts once
per current head after the active reviewer emits LGTM, typically to trigger
external review bots whose checks are listed under `[ready]`.
`[pr_labels].green_check_names` names the check contexts/runs that satisfy the
`combo:external-review-green` status label.
`[external_comments].agents` names GitHub App or bot logins whose comments are
filtered for bookkeeping/noise and otherwise routed to coder responding mode.
Comments from these agents that indicate a skipped or rate-limited review
(such as "review skipped", "review limit reached", or "rate limited") block
READY even when the corresponding check status reports SUCCESS.

## Agent CLI Policy

The default Codex coder path is gnhf-managed: combo-chen runs pinned `gnhf` with
`--agent codex`, `--max-iterations`, `--stop-when`, `--prevent-sleep on`,
`--meteor-frequency 0`, and `--current-branch`. gnhf 0.1.41 does not expose a
generic Codex CLI profile/flag pass-through, so Codex terminal flags are not
part of the normal coder command. Coder responding mode resumes the captured
thread with the configured resume command (default `codex resume {thread_id}`)
through the persistent `coder` tmux window.
The recommended `codex --profile sitter --no-alt-screen resume {thread_id}`
keeps tmux scrollback visible and the session resumable/auditable without
changing the underlying default. Custom `resume_command` templates remain
supported for local wrappers or other agents, and
`[coder_responding].window_name` remains as a compatibility bridge for older
capsules that still need a separate response window.

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
If the daemon copy cannot complete, the gate fails instead of accepting an
otherwise-recoverable no-mistakes result.

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
  CLI at `bin/combo-chen`, built from `dist/cli.mjs`, plus package metadata,
  README, LICENSE, and `combo-chen.example.toml`.
- The installed CLI is self-contained: runtime dependencies and every shell
  template are bundled into `dist/cli.mjs`, so extracted archives run without
  `node_modules` or sibling `dist` chunks.
- `checksums.txt` is sha256sum-compatible, sorted by filename, and covers every
  uploaded `.tar.gz` asset.
- `pnpm release:assets` builds the CLI and writes reproducible archives plus
  `checksums.txt` into `dist/release/`.
- The `release-assets` workflow runs for published and prereleased GitHub
  releases and uploads `dist/release/*.tar.gz` plus
  `dist/release/checksums.txt` to the release.
- Published release tags may be plain `vX.Y.Z` tags or release-please
  component tags such as `combo-chen-vX.Y.Z`; the updater normalizes both forms
  before asset lookup.

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

When the active command is reached through an installer-created bin symlink, it
resolves the real versioned executable and replaces that file so the symlinked
`release_archive` layout remains updateable.

Unsupported source checkouts and package-manager dev shims fail with useful
non-auto-replaceable errors. When a newer candidate exists, the command checks
persisted active combo runtime state. Active or uncertain runtime state prints a
concise warning and requires `-y/--yes`; without it, the update aborts before
staging.

After a successful replacement, the command performs an explicit post-update
refresh pass. If no active combo runtime is detected, it reports that no daemon
or runner refresh was needed. If live combos are detected, it runs
`no-mistakes daemon start` to refresh the managed no-mistakes daemon service
without restarting live combo tmux windows. The daemon refresh attempt is
bounded by `COMBO_CHEN_POST_UPDATE_DAEMON_REFRESH_TIMEOUT_MS` (default 30000).
Existing combo runners, director-watch loops, gatekeepers, and reviewers remain
under human control; when an operator intentionally wants a live runner to pick
up the new install, park and resume that combo:

```bash
combo-chen park -n <combo-id>
combo-chen resume -n <combo-id>
```

If runtime state is uncertain, combo-chen reports the uncertainty and skips
automatic daemon and runner refresh. If the daemon refresh fails, the installed
target remains replaced and the command prints the manual recovery command:

```bash
no-mistakes daemon start
```

The active update command does not apply passive update notices.

Normal public CLI commands also run quiet passive update checks. The check
reuses the same GitHub Releases resolution contract as `combo-chen update`, but
only records a local summary in
`$COMBO_CHEN_HOME/passive-update-cache.json` (default
`~/.combo-chen/passive-update-cache.json`). Fresh cache entries are reused for
24 hours. Set `COMBO_CHEN_DISABLE_PASSIVE_UPDATE_CHECKS=1` to skip the cache and
release lookup entirely. Cache-miss GitHub release lookups are bounded by
`COMBO_CHEN_PASSIVE_UPDATE_LOOKUP_TIMEOUT_MS` (default 60000). Cache misses,
malformed cache files, cache write failures, and network or GitHub errors are
ignored and never fail the command being run. Passive checks are quiet: they do
not write stdout or stderr, so JSON/JSONL command output stays
machine-readable.

## U0 update contract bridge and updater slices

U0, U1, U2, and U3 together span the updater contract from release identity
through release resolution, verified staging, and replacement eligibility. U0
is the read-only vocabulary layer: it defines shared types and pure helpers for
release tag/version normalization (plain versions, `vX.Y.Z`, and
`combo-chen-vX.Y.Z` component tags), current build versus candidate comparison,
platform asset selection, sha256sum-compatible checksum lookup, obvious install
target classification, active combo state, and the aggregate
`ReadOnlyUpdatePlan`.

U72-A adds the internal detector API at `src/core/active-runtime.ts`.
`detectActiveComboRuntime({ home, cli })` scans only persisted combo state under
`COMBO_CHEN_HOME/runs`: `combo.json`, `journal.jsonl`, and
`runtime-ledger.json` with legacy fallback. It returns `idle`, `active`,
`stale`, or `error` plus active combo, stale combo, and detection-error arrays.
It does not prompt, run tmux/git/gh/no-mistakes commands, write journals, create
ledgers, restart daemons, or change update/install targets.

U1 (`src/update/update-resolver.ts`) implements the release resolver and
latest/beta check flow. It consumes GitHub Releases metadata plus current build
metadata, ignores prereleases in stable mode, includes prereleases in beta mode,
normalizes candidates through the U0 contract, selects expected platform assets,
and returns a read-only update decision without downloads, extraction,
replacement, or live combo inspection.

U2 (`src/update/update-staging.ts`) implements download, SHA-256 checksum
verification, and isolated extraction primitives. It accepts a resolved update
plan or fixture, downloads the archive and `checksums.txt`, verifies the digest
before extraction, extracts into an isolated staging directory, and returns a
`StagedUpdateArtifact` descriptor with enough metadata for the replacement
primitive. All network and filesystem operations are injected through
`UpdateStagingDeps` so tests run without real I/O. Checksum mismatches, missing
entries, unavailable checksums, and extraction failures are reported
deterministically with cleanup status.

U0 itself does not download, extract, replace, restart, or mutate active combo
capsules.

U3 (`replaceInstallTargetFromStagedArtifact`) implements install target and
atomic replacement for staged release archive installs. This means source
checkouts and package-manager dev shims are non-auto-replaceable; only release
archive installs whose real executable path is shaped like
`combo-chen-vX.Y.Z/bin/combo-chen` are eligible for replacement.

U2 and U3 do not resolve releases, restart active combo capsules, or mutate
active combo runtime state.

Completed updater slices:

- U1: release resolver and latest/beta check flow. (Landed: `resolveLatestReleaseCandidate`, `resolveReadOnlyUpdatePlan`.)
- U2: download, checksum verification, and staging.
- U3: install target and atomic replacement. (Landed: `replaceInstallTargetFromStagedArtifact`.)
- U72-D: quiet passive update checks with local cache, TTL, and env disable knob. (Landed: `checkPassiveUpdate`, `runPassiveUpdateCheck`.)
- U72-C: post-update daemon and runner refresh. (Landed: `refreshPostUpdateLocalState`.)

Follow-up #72 slices:

- U72-B: active-runtime safety prompts and yes flag policy.

## Commands

```bash
combo-chen overture --issue <issue-url> [--repo <dir>] [--base <ref>]
combo-chen overture --plan <file> [--repo <dir>] [--base <ref>]
combo-chen run --issue <issue-url> [--repo <dir>] [--base <ref>] [--prompt <text>]
combo-chen run --plan <file> [--repo <dir>] [--base <ref>] [--prompt <text>]
combo-chen update [--beta] [-y|--yes]
combo-chen status [--deep] [--all]
combo-chen needs-human-report
combo-chen attach -n <combo-id>
combo-chen events --follow -n <combo-id>
combo-chen park -n <combo-id>
combo-chen resume -n <combo-id>
combo-chen forensics --issues <numbers> [--format json]
combo-chen forensics --issues <numbers> [--record-outcome]
combo-chen reconcile [-n <combo-id>] [--apply]
combo-chen stop -n <combo-id>
combo-chen director-prompt -n <combo-id> --reason <reason> <message...>
```

`overture` checks the launch runway before spending agent tokens or creating
tmux sessions. It runs the same deterministic checks that `run` executes
internally: work item readability, repo/issue match, clean checkout, base ref,
Treehouse/worktree/branch/tmux availability, no-mistakes status, team identity
(opt-in via `[team]` config), and coder/reviewer command safety. A blocked check prints an `X` and exits before any launch
resources are created. Run it standalone to verify readiness, or let `run`
consume it automatically.

`needs-human-report` scans all combo journals and reports a summary of
`needs_human` event counts grouped by reason. For `worker_stalled`, it also
prints how many stalled escalations later reached normal completion before
another human request. Corrupt combo records are skipped with a
`skipped <combo-id>: <reason>` line instead of stopping the report.

### Recovery Commands

- `status` is the parallel capsule dashboard: it shows actionable live combos
  by default. Add `--all` to include
  terminal historical rows, and `--deep` to compare the journal with downstream
  GitHub and gatekeeper state. When the local combo worktree HEAD has fallen
  behind the current PR head on GitHub, `status --deep` reports the drift
  explicitly with a recommended action (fetch PR head for review, or sync the
  combo worktree). Its table includes active branch-scoped gate
  lease owners when no-mistakes is reserved by combos. Before rendering, `status`
  quietly closes closed-PR salvage cases. For merged PRs it records the merge
  fact, leaves resources untouched, and keeps the row visible as
  `closure_pending` until the director-watch loop (or a manual
  `combo-chen closure -n <combo-id>`) records `combo_closed`. If a non-terminal
  combo no longer has its tmux session, status journals `tmux_missing` so it is
  shown as needing human attention instead of looking supervised.
- `combo-chen closure -n <combo-id>` is the canonical merged happy-path cleanup
  command. The director-watch loop auto-triggers closure on merge detection;
  the manual command remains as a fallback. Reviewer/director-watch and status
  can record or report the merge fact, but the closure logic owns resource
  convergence.
- `park` writes a local handoff and stops tmux without making the combo
  terminal.
- `resume` reconstructs the right next action from the journal and downstream
  state. It does not start a fresh run on an existing combo.
- `forensics` produces a read-only report for stalled or confusing runs. The
  markdown includes a copy-ready outcome block with PR link, head SHA, local
  worktree HEAD (when it differs from the published PR head), review/check state,
  failures found, and follow-up bug status for dogfood records. A
  `pr_head_local_drift` incident flags when the local combo worktree and GitHub
  PR head are out of sync. Add markdown-only `--record-outcome` to post that
  compact Outcome block to each matched source GitHub issue once a PR link and
  head SHA are known.
- `reconcile --apply` repairs journals that froze before a merged or closed PR
  was recorded locally. Add `-n <combo-id>` to scope repair and teardown to a
  single combo. Teardown is idempotent: already-returned worktrees, branches, and
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
- Pre-PR coder dead/stalled: the monitor first checks for a journaled
  `coder_done` or `coder_failed` event before classifying a dead pane.
  A prior `coder_done` means clean completion — no recovery runs.
  When no terminal outcome is journaled, the director auto-restarts dead
  pre-PR coder workers and stalled coder-response surfaces (the default
  `coder` window or a configured compatibility window) up to the configured
  recovery budget. After the budget is exhausted a `needs_human` event is
  journaled.
- Worker permission prompts: the `[monitor].permission_prompt_policy` knob
  (env `COMBO_CHEN_WORKER_PERMISSION_PROMPT_POLICY`) controls whether known
  interactive prompts are auto-approved, trigger coder-response recreation, or
  escalate to `needs_human`. Auto-approve and recreate attempts share the
  configured worker recovery budget. Default is `escalate`.
- Reviewer auth failures: fix the configured reviewer GitHub auth/login, then
  rerun reviewer activation or prompt the reviewer without changing the coder
  branch.
- Gate lease contention: for same-branch conflicts, inspect the lease owner in
  `status`, then resolve stale/conflicting ownership before retrying the gate.
- Post-merge closure: director-watch auto-triggers `closure`
  after GitHub reports `MERGED`; the manual `combo-chen closure -n <combo-id>`
  remains as a fallback. Status/reviewer may record the merge fact, but the
  closure logic owns resource convergence.

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
  Its `id` must exactly match the `<combo-id>` directory name; readers rebuild
  run paths from that id, so mismatches are treated as corrupt state.
- `journal.jsonl`: the source of truth. Includes `team` events that record the
  resolved role identities at launch, and `pr_labels_updated` events that record
  every PR label mutation with metadata (PR URL, head SHA, old/new labels,
  reason) for auditability.
- `runtime-ledger.json`: machine-readable combo capsule resource ledger; written at launch, updated when PR/reviewer/director resources appear.
- `config.snapshot.json`: frozen launch-time config; prevents runtime drift when repo TOML changes.
- `runner.sh`: generated initial runner.
- `gatekeeper.log`: initial gatekeeper output.
- `gatekeeper-post-<sha>.sh`: generated post-address gate.
- `work-plan.md`: normalized work-plan artifact; the canonical source of work-item intent for reviewer, gatekeeper, and forensics.
- `park-handoff.md`: local summary created by `park`.

Shared cross-combo state lives under:

- `~/.combo-chen/gate-leases.lock/<encoded-branch>/lease.json` — each branch
  gets its own atomic lease directory, so different branches can gate
  concurrently while the same branch remains single-owner.
- `~/.combo-chen/passive-update-cache.json` — quiet passive update check
  cache; written by normal public CLI commands and reused for 24 hours.
  Set `COMBO_CHEN_DISABLE_PASSIVE_UPDATE_CHECKS=1` to skip it entirely.

Do not hand-edit `journal.jsonl`. Write journal events through
`combo-chen emit` or the v1 `cb-emit.sh` script; both produce canonical
validated JSONL lines. Use them only when a real-world fact happened
and the journal missed it.

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
pnpm lint
pnpm lint:sh
pnpm format:check
pnpm slop:check
pnpm build
git diff --check
```

Behavior changes should be test-first. Keep operational values configurable
through env, TOML, then fallback defaults.

### Anti-Slop Surface

combo-chen ships with code-level anti-slop probes to prevent agent slop during
autonomous runs:

- `pnpm slop:check` — the hard gate, run by CI and no-mistakes lint. It runs
  `sg scan` in project mode (`sgconfig.yml`): every tombstone rule in
  `.slop/rules/` runs by birth with its own `files`/`ignores` scope,
  `severity: error` findings fail the command, and `severity: warning`
  findings print without failing (warning is a temporary state for rules
  whose pre-existing stock is still being cleaned; the rule file says so).
  It then gates non-test jscpd duplication with `--threshold 1.65`, a ratchet
  pinned just above the current baseline so new duplication fails: a PR that
  trips it must remove duplication or raise the threshold explicitly in the
  same PR with justification, and the threshold only moves down, in the PR
  that removes clones.
- `pnpm lint:sh` — shellcheck over `src/shell/templates/*.sh` plus
  `bin/cb-*.sh`, the v1 journal spine and tmux spawn scripts. Run by CI and
  no-mistakes lint.
- `pnpm slop:report` — verbose jscpd clone listing for non-test source plus
  the same `sg scan`, for reading warning output in full while a cleanup is
  in flight.
- `pnpm surface` — ast-grep structure outline of all functions across `src/`,
  used by the coder preflight when the target repo exposes the script.

## Status

Active development.

v0 implements the work-item-to-PR loop under the parallelize-first operating
contract: deterministic overture launch runway,
coder/gnhf, no-mistakes initial and
post-address gates with automatic initial-gate retry, reviewer with
machine-readable verdict codes (0-3) and deterministic routing, reviewer re-review,
lazy coder-response routing through the persistent coder window by default
(legacy `coder-responding` compatibility window only when configured), single `director-watch`
observation with compact per-tick operator status lines, frozen journal
`reconcile` repair for closed PRs (preserving all worktrees on close),
merged-PR `reconcile` with merge-fact recording only (resource convergence
deferred to `closure`), deterministic `closure` for post-merge local resource
convergence with director-watch auto-trigger on merge detection, director prompt
delivery for code-2 verdicts, no-mistakes config propagation,
read-only forensics reports with copy-ready Outcome blocks and markdown-only
`--record-outcome` for posting dogfood outcomes to GitHub issues, coder safety
validation (pinned gnhf with `--max-iterations`, `--stop-when`, stdin closed),
`park`/`resume` for reboot-safe capsule handoff, the parallel capsule dashboard
(`status`; actionable by default, `--all` for history, `--deep` for downstream
probes, auto-reconcile + tmux liveness), launch-time config snapshots for
deterministic runtime behavior, a machine-readable runtime ledger for each combo
capsule, branch-scoped gate leases for parallel capsules with stale recovery and
heartbeat, promptable director window inside each combo capsule (non-polling
contract, prompted by director-watch only for ambiguity or uncoded recovery),
wave-based parallel scaling (start 2 capsules, then 3, then 4-6 with postmortem
justification), explicit coder terminal outcomes (`coder_done` trust over dead-looking panes) before worker recovery, pre-PR dead coder recovery with bounded restarts before `needs_human` escalation,
stalled coder-response recovery with bounded retries, configurable worker permission-prompt recovery (auto-approve, recreate, or escalate) with bounded retries, orchestrator evidence consulted before worker stall escalation (gnhf run active, gate run active, external review active, reviewer artifact recent), current-head READY agreement with base-advance conflict
detection, live GitHub PR label projection with mutation journaling,
human-readable tmux topology (fixed tmux role topology: journal, director,
coder, gatekeeper, reviewer, and director-watch in that stable order;
gatekeeper and reviewer are precreated at launch; coder-response target
defaults to the persistent coder window; raw event output never replaces the
coder role), opt-in runner
progress status lines
(`COMBO_CHEN_RUNNER_PROGRESS=1`), coder helper preflight (use `pnpm surface`
when the target repo exposes it; otherwise search before adding helpers), reviewer
anti-slop guardrails (duplicate helper check, config plausibility, surface
budget awareness), and `needs-human-report` operational metrics.

P1: v1 Bash journal spine (`bin/cb-emit.sh`, `bin/cb-wait.sh`,
`bin/cb-run-state.sh`) with a five-agent event enum, JSONL append
locking, and deterministic phase folding.
P2: multi-run-safe tmux spawn (`bin/cb-tmux.sh`, `bin/cb-agent-spawn.sh`,
`bin/cb-send.sh`, `bin/cb-peek.sh`, `bin/cb-status.sh`) with atomic agent
meta under `runs/<runId>/agents/`.
P3: mechanical `bin/cb-launcher.sh` and `bin/cb-cleaner.sh` ends:
Treehouse holder/path custody is exact and live-verified, Git fallback
is an explicit distinct ownership kind, and run-local readiness/custody
commands are generic P4/P7 input boundaries.
Deferred: issue preflight scoring,
counterfactual automerge logs, and ACP role driving.

## License

MIT.
