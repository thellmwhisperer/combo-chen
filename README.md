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
3. The capsule engine (`combo-chen capsule <run-dir>`, tmux pane 0) owns the whole
   pipeline: rebase, coder, local review loop, in-process gate, and supervision.
4. A coder agent implements the work item as an owned child of the capsule and
   leaves local commits.
5. A local reviewer writes `verdict-<round>.json` with a machine-readable code
   (0=OK/LGTM, 1=mechanical fix→coder, 2=ambiguous, 3=needs human). Code 1 turns
   resume the same coder thread; code 0 pins `lgtm {sha, patch_id}` and advances
   to the gate. The reviewer never writes to GitHub.
6. The in-process gate validates and publishes through no-mistakes. It acquires a
   branch-scoped gate lease so independent branches can publish in parallel while
   same-branch ownership stays exclusive. If the initial gate fails before a PR
   opens, the capsule auto-retries it up to a configurable limit. When no-mistakes
   exits non-zero after publishing but the gate output shows
   `outcome: checks-passed` with a later `context canceled`, the gate treats that
   as recovered success instead of `gate_failed`, unless the repo
   `.no-mistakes.yaml` copy into the daemon worktree failed.
7. After the PR opens, the in-process supervisor observes: external review
   comments route to the persistent coder window, and new addressing commits go
   back through the gate before publication.
8. The run becomes ready only when the current PR head has gate validation, a
   live local LGTM (carried across pure rebases by patch-id), configured required
   READY checks, and passing remaining checks. If a sibling merge advances the
   base and the READY PR becomes dirty or conflicting, the supervisor invalidates
   READY and routes the coder to rebase.
9. While the PR is open, monotonic GitHub labels reflect the combo state:
   `combo:working` → `combo:ready` → `combo:merged`, with `combo:conflict` as the
   explicit exception.
10. After the human merges the PR, the supervisor detects the merge and
    auto-triggers `closure` to converge local resources deterministically.
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
    +--> capsule engine (tmux pane 0)
    |
    +--> coder writes local commits (owned child)
    |
    +--> local review loop: verdict-<round>.json codes 0-3, lgtm pinned by patch-id
    |
    +--> in-process gate validates and publishes
    |
    +--> PR opens; in-process supervisor observes
    |
    +--> review comments routed to the persistent coder window; gate republishes
    |
    +--> monotonic combo PR labels kept in sync on GitHub
    |
    v
ready_for_merge
    |
    v
human merge -> supervisor auto-closure -> combo_closed
```

## What Makes It Different

- **A journal, not vibes.** Every run has `journal.jsonl`. Status is derived
  from events, not from terminal scrollback or agent memory.
- **Fixed role boundaries.** Coder, gatekeeper, reviewer, director, and human
  are separate roles. The reviewer cannot be the coder. The capsule engine runs
  in tmux pane 0, alongside the journal, director, coder, gatekeeper, and
  reviewer role windows; there is no director-watch window, and the
  coder-response target defaults to the persistent coder window.
- **Publish boundary.** Coders leave local commits. The gatekeeper is the normal
  publisher.
- **Visible PR state.** Monotonic GitHub labels track the combo workflow
  (`combo:working` → `combo:ready` → `combo:merged`, with `combo:conflict` as
  the exception), so an operator can read the timeline without inspecting tmux
  scrollback or journal files.
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
# Optional free-form reviewer instructions injected into the local review loop.
# prompt = "Apply my local review process."

[ready]
# Dogfood default: CodeRabbit must be present with SUCCESS before READY.
required_checks = ["CodeRabbit"]

[external_comments]
# External comment/noise filters only; not approval and not READY checks.
agents = ["coderabbitai"]

[reviewer.claude]
command = "claude --permission-mode auto {prompt}"

[director]
# Promptable interactive director window; the in-process supervisor owns
# deterministic observation.
command = "claude --permission-mode auto {prompt}"

# [team] declares the expected effective identity per role. Overture resolves each
# tool's actual config and fails on mismatch. Undeclared: current behavior, noted
# in the checklist. Uncomment and tune for each role you want to pin.
# [team.coder]
# binary = "npx"
# agent = "gnhf/codex"
# model = "gpt-5.5"
```

The reviewer runs locally inside the capsule's review loop and writes a
schema-versioned `verdict-<round>.json` artifact in the run directory; it never
posts to GitHub. Verdict code 0 pins the local LGTM to the reviewed changeset's
SHA and patch-id.
`[ready].required_checks` names GitHub status contexts/check runs that must be
present with exact `SUCCESS`; the runtime default is empty, and the example
dogfood config above opts into `CodeRabbit`. A skipped CodeRabbit review is not
a READY success. These external checks are not reviewer approval.
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
thread with the configured resume command (default
`codex --ask-for-approval never --sandbox workspace-write resume {thread_id}`)
through the persistent `coder` tmux window.
The recommended
`codex --ask-for-approval never --sandbox workspace-write --profile sitter --no-alt-screen resume {thread_id}`
keeps tmux scrollback visible and the session resumable/auditable without
changing the underlying default. Custom `resume_command` templates remain
supported for local wrappers or other agents.

If combo-chen later adds a direct noninteractive Codex runner, it must keep
`-C {worktree}` explicit, use the role's explicit tool budget, emit
parseable events with `--json`, and capture the final answer with
`-o {run_dir}/final.md`.
`--search` stays opt-in per issue. Normal project agents should keep project
rules and user config enabled and avoid `--ephemeral`. Permission prompts are
captured as learning signals and escalated into the allowlist convergence loop;
they are never left blocking a pane.

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
- The installed CLI is self-contained: runtime dependencies are bundled into
  `dist/cli.mjs`, so extracted archives run without `node_modules` or sibling
  `dist` chunks.
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
Existing capsule engines, gatekeepers, and reviewers remain under human
control; when an operator intentionally wants a live capsule to pick up the
new install, park and resume that combo:

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
combo-chen decide -n <combo-id> <retry|skip|take_over|ignore> [--note <text>]
combo-chen closure -n <combo-id>
combo-chen recap
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
  `closure_pending` until the supervisor (or a manual
  `combo-chen closure -n <combo-id>`) records `combo_closed`. If a non-terminal
  combo no longer has its tmux session, status journals `tmux_missing` so it is
  shown as needing human attention instead of looking supervised.
- `combo-chen closure -n <combo-id>` is the canonical merged happy-path cleanup
  command. The supervisor auto-triggers closure on merge detection; the manual
  command remains as a fallback. Status can record or report the merge fact,
  but the closure logic owns resource convergence.
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
  When no terminal outcome is journaled, a dead pre-PR coder triggers
  capsule-owned recovery: the capsule sequencer pane is relaunched and
  re-derives its phase from the journal, up to the configured recovery
  budget. Stalled post-PR coder-response surfaces are recreated and
  re-prompted under the same budget. After the budget is exhausted a
  `needs_human` event is journaled.
- Worker permission prompts: the monitor journals `permission_prompt_detected`
  with the role, tool, and command, then creates a `needs_human` decision card.
  Grant it, add the tool to that role's `allowed_tools`, and retry the turn.
  Prompts are learning signals and are never silently approved or left blocking.
- Reviewer auth failures: fix the configured reviewer GitHub auth/login, then
  rerun reviewer activation or prompt the reviewer without changing the coder
  branch.
- Gate lease contention: for same-branch conflicts, inspect the lease owner in
  `status`, then resolve stale/conflicting ownership before retrying the gate.
- Post-merge closure: the supervisor auto-triggers `closure`
  after GitHub reports `MERGED`; the manual `combo-chen closure -n <combo-id>`
  remains as a fallback. Status may record the merge fact, but the
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
- `config.snapshot.json`: frozen launch-time config (`runEngine: "capsule"`); prevents runtime drift when repo TOML changes. Frozen pre-v1 artifacts migrate to capsule deterministically on read/resume.
- `loop-state.json`: persisted review-loop position (rounds, fingerprint survival, guard state).
- `verdict-<round>.json`: schema-versioned local reviewer verdict artifacts.
- `review-<round>-<sha12>.md`: deterministic review dossiers projected from the verdicts.
- `exit-summary.md`: permanent run summary emitted at closure.
- `work-plan.md`: normalized work-plan artifact; the canonical source of work-item intent for reviewer, gatekeeper, and forensics.
- `park-handoff.md`: local summary created by `park`.

Shared cross-combo state lives under:

- `~/.combo-chen/gate-leases.lock/<encoded-branch>/lease.json` — each branch
  gets its own atomic lease directory, so different branches can gate
  concurrently while the same branch remains single-owner.
- `~/.combo-chen/passive-update-cache.json` — quiet passive update check
  cache; written by normal public CLI commands and reused for 24 hours.
  Set `COMBO_CHEN_DISABLE_PASSIVE_UPDATE_CHECKS=1` to skip it entirely.

Do not hand-edit `journal.jsonl`. The capsule, gate, and supervisor write every
event through the binary; when the journal missed a real-world fact, repair it
with `combo-chen reconcile [--apply]` or `combo-chen resume -n <combo-id>`.

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
  that removes clones. The `no-shell-in-ts` rule enforces the v1 contract that
  no shell loops, traps, or parsers live in TS strings or template literals;
  the only shell reaching tmux is a static one-liner window entry command.
- `pnpm slop:report` — verbose jscpd clone listing for non-test source plus
  the same `sg scan`, for reading warning output in full while a cleanup is
  in flight.
- `pnpm surface` — ast-grep structure outline of all functions across `src/`,
  used by the coder preflight when the target repo exposes the script.

## Status

Active development.

v1 implements the work-item-to-PR loop with the capsule as the only engine. The
v0 shell substrate (generated `runner.sh`, `director-watch-loop.sh`, and all 22
shell gate templates) is retired: the gate runs in-process, the event-driven
supervisor observes from inside the capsule pane, and the only shell that
reaches tmux is a static one-liner window entry command.

Highlights: deterministic overture launch runway with declared team identity
checks; coder/gnhf with safety validation (pinned gnhf with `--max-iterations`,
`--stop-when`, stdin closed); local reviewer verdict files with machine-readable
codes (0-3) and the bounded V-C-V review loop (fingerprint survival and no-op
fix turn guards); in-process initial gate with automatic retry and no-mistakes
config propagation; patch-id LGTM carry-over with the four-leg deterministic
READY fold; monotonic GitHub PR label projection (`combo:working` →
`combo:ready` → `combo:merged`, `combo:conflict` as the exception) with
mutation journaling; capsule pane topology (pane 0 engine plus journal,
director, coder, gatekeeper, and reviewer windows; no director-watch window;
coder-response targets the persistent coder window); capsule-owned pre-PR dead
coder recovery with bounded relaunches; stalled coder-response recovery and
configurable permission-prompt recovery; `decide` for answering pending
`needs_human` escalations; `park`/`resume` with deterministic v0-snapshot
engine migration; the parallel capsule dashboard (`status`), `recap`,
`forensics` with `--record-outcome`, and `needs-human-report`; branch-scoped
gate leases for parallel capsules; the Ink/React TUI fleet home; and anti-slop
surface probes (`pnpm slop:check`, `pnpm slop:report`, `pnpm surface`).

Deferred: glance pane, forge connectors, automerge, issue preflight scoring,
counterfactual automerge logs, and ACP role driving.

## License

MIT.
