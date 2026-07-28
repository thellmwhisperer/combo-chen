# Bash v1 mounted chain architecture and operator guide

This document is the normative architecture, runtime contract, and operator
guide for the mounted Bash v1 product. It describes the implementation reached
through `bin/cb-plan.sh` and `bin/cb-run.sh`, not the earlier long-running v0
capsule loop described elsewhere in [the protocol spec](spec.md).

The mounted product has one state machine, five visible tmux endpoints, and a
provider-neutral step boundary:

```text
combo.config/v1
      |
      v
  cb-plan.sh  -----> immutable combo.run-plan/v1
                            |
                            v
                       cb-run.sh
                  mounts five endpoints
                            |
                            v
                      cb-chain.sh
                            |
          Launcher -> Coder <-> Reviewer* -> Gate
              |                                  |
              +------------> Cleaner <-----------+
```

`Reviewer*` means zero or more configured Reviewer members and zero or more
complete review rounds. It does not mean zero visible Reviewer endpoints: the
single Reviewer endpoint is always mounted.

## 1. Scope and authority

The mounted stack separates orchestration from role implementations:

- `cb-plan.sh` validates configuration and freezes the ordered run plan.
- `cb-run.sh` owns endpoint visibility, dispatch, receipt attestation, terminal
  presentation, and process status.
- `cb-chain.sh` is the only product state machine. It owns ordering and routing.
- `cb-step.sh` owns the universal process and artifact boundary.
- Role adapters own provider-specific execution and normalize their outcome.
- Mechanical Launcher and Cleaner scripts own Treehouse acquisition and return.

The state machine never routes on pane text, adapter stdout, adapter stderr,
provider output, or journal prose. It routes only on a validated
`combo.step-output/v1` exit class and the single role-specific event inside a
completed result.

The canonical entry point for a mounted run is:

```sh
bin/cb-run.sh "$run_id"
```

Running `cb-chain.sh` directly omits the dispatcher unless the caller supplies
the internal `CB_CHAIN_DISPATCHER` contract. That direct mode is useful for
contract tests, but it is not the visible mounted product.

The run plan and all published result or custody artifacts are collision-safe
records. Operators must not edit them to repair a run. A configuration change
requires a new run because an existing `plan.json` is never replaced.

## 2. Runtime layers and ownership

The product has three runtime layers:

| Layer | Owner | Responsibility |
| --- | --- | --- |
| Plan | `cb-plan.sh` | Validate adapter bindings and freeze order, argv, and opaque config. |
| Chain | `cb-chain.sh` | Route Launcher, Coder, Reviewer rounds, Gate, and Cleaner. |
| Mount | `cb-run.sh` | Keep five endpoints visible and dispatch every step through its endpoint. |

Role ownership remains narrow:

| Role | Owns | Does not own |
| --- | --- | --- |
| Launcher | Exact runway acquisition and immutable custody facts. | Candidate changes, publication, or cleanup. |
| Coder | A clean local candidate commit descended from the prior candidate. | Ordinary publication or merge. |
| Reviewer | An exact-SHA `lgtm` or `needs_change` member result. | Candidate mutation or publication. |
| Gate | No-Mistakes delivery, exact PR identity, and optional merge authority. | Worktree release. |
| Cleaner | Exact custody-path release after terminal Gate evidence. | Routing, publication, or tmux teardown. |

The Gate is the trusted publisher. The Coder adapter installs a PATH-level Git
guard that rejects ordinary `git push`, but the guard is an accident-prevention
measure rather than a same-user security boundary. Publication authority comes
from routing all successful candidates through Gate.

The run-local directory is the evidence boundary. With the default
`CB_RUNS_DIR`, one run lives at:

```text
~/.combo-chen/runs/<run-id>/
```

Important children are:

```text
plan.json
chain-result.json
agents/
  launcher.meta
  launcher.ownership.json
  coder.meta
  reviewer.meta
  gate.meta
  cleaner.meta
  cleaner.ownership.json
dispatch/
  jobs/
  <step>-attempt-<n>.receipt.json
dispatch-log.jsonl
steps/
  <ordinal>-<step>/attempt-<n>/
artifacts/
  gate/
```

The absence of an artifact is meaningful. In particular, an early Gate
rejection does not fabricate No-Mistakes, PR, merge, or terminal evidence for a
stage that was never reached.

## 3. Immutable configuration and run plan

`cb-plan.sh <runId> --config <path>` accepts `combo.config/v1`. The top-level
configuration contains:

- an adapter registry;
- Launcher, Coder, Gate, and Cleaner bindings;
- a possibly empty ordered Reviewer array;
- an optional Reviewer degradation policy.

Each adapter registry entry has exactly an argv array and a non-empty set of
compatible roles. Each role binding selects an adapter and supplies an opaque
configuration object. The plan compiler does not interpret providers, models,
or tool-specific flags.

The Coder binding may be a single binding or an ordered `invocations` array.
Coder attempt 1 uses the first invocation, attempt 2 uses the second, and so on.
Once attempts exceed the configured array, the final invocation is reused for
later correction rounds.

Every Reviewer member has a unique member id. A Reviewer adapter id may not
equal any configured Coder invocation adapter id. This is the enforced
`reviewer != coder` boundary at plan publication.

The compiler produces this fixed plan order:

```text
launcher
coder
reviewer/<member-1>
...
reviewer/<member-N>
gate
cleaner
```

An abridged field map of `combo.run-plan/v1` follows. The empty `steps` value is
only a placeholder; a valid plan always contains the fixed role sequence.

```json
{
  "schema": "combo.run-plan/v1",
  "run_id": "<run-id>",
  "paths": {
    "run_dir": "<canonical-run-dir>",
    "artifacts_dir": "<canonical-run-dir>/artifacts",
    "steps_dir": "<canonical-run-dir>/steps"
  },
  "reviewer": {
    "degraded": "fail"
  },
  "reviewer_count": 0,
  "steps": []
}
```

`steps` contains the full ordered bindings. `reviewer.degraded` is `fail` by
default and may be set to `skip`.

The compiler reads the caller's config through a contained snapshot, validates
it, writes a staged plan, changes the plan mode to `0444`, and publishes it with
a non-replacing hard link. It refuses an existing `plan.json`; no resume path
recompiles or mutates the plan.

## 4. Universal step ABI

For each invocation, `cb-step.sh` creates:

```text
steps/<ordinal>-<safe-step>/attempt-<n>/
  input.json
  stdout.log
  stderr.log
  adapter-output.json   # adapter-owned and optional on adapter failure
  result.json
```

The input is an immutable `combo.step-input/v1` containing:

- run, step, role, adapter, and attempt identity;
- canonical run, artifact, step, invocation, input, and output paths;
- the current candidate SHA or `null`;
- the selected opaque adapter configuration;
- validated references to prior run-local artifacts.

The adapter argv is executed as an array without `eval`. `cb-step.sh` appends
`--input <path> --output <path>`, closes stdin, bounds the child with `timeout`,
and records stdout and stderr without reading either for product routing.

An adapter may publish `adapter-output.json`. `cb-step.sh` accepts it only when
its schema, identity, event, candidate, and artifact references match the
selected role and attempt. Otherwise it publishes a normalized technical or
cancelled `result.json`. Missing adapter output is therefore evidence of an
adapter failure, not an untyped state.

Every normalized result uses one of three exit classes:

| Exit class | Events | Required detail |
| --- | --- | --- |
| `completed` | Exactly one role event with code 0 or 1. | Role-specific payload. |
| `technical_error` | None. | One or more `errors`. |
| `cancelled` | None. | One or more `reasons`. |

Completed role events are:

| Role | Code 0 | Code 1 |
| --- | --- | --- |
| Launcher | `launch_ready` | `launch_not_ready` |
| Coder | `coder_ready` | `coder_not_ready` |
| Reviewer | `lgtm` | `needs_change` |
| Gate | `gate_ok` | `gate_failed` |
| Cleaner | `cleaned` | `clean_failed` |

`result.json` is made `0444` and published without replacement. The chain
consumes only that normalized file.

Prior artifacts are run-contained immutable references:

```json
{
  "id": "gate-terminal",
  "path": "artifacts/gate/terminal.json"
}
```

Paths outside `artifacts/`, dot traversal, symlinks, missing regular files, and
duplicate artifact ids are rejected.

## 5. Five visible tmux endpoints

Every mounted run has exactly one tmux session:

```text
combo-<run-id>
```

It has exactly five canonical endpoint windows:

| Endpoint role | Window | Mode |
| --- | --- | --- |
| Launcher | `cb-<run-id>-launcher` | shell |
| Coder | `cb-<run-id>-coder` | TUI |
| Reviewer | `cb-<run-id>-reviewer` | TUI |
| Gate | `cb-<run-id>-gate` | shell |
| Cleaner | `cb-<run-id>-cleaner` | shell |

The temporary `_cb_boot` window used to create a new session is disposable and
is removed when the first endpoint is established. It is not a sixth endpoint.

All five endpoints exist even when the plan has zero Reviewer members. In that
case the Reviewer endpoint remains visible and steerable but receives no
Reviewer job, creates no Reviewer attempt, and invokes no Reviewer tool.

Configured Reviewer members do not get additional windows. Every
`reviewer/<member>` step in every round is dispatched sequentially through the
one Reviewer endpoint.

Each endpoint has `agents/<role>.meta`, including its exact tmux window id and
canonical window name. Resolution accepts the recorded id only while that id is
still the live expected window inside the exact `=combo-<run-id>` session. A
name fallback may resolve only the same canonical role window.

For one step, `cb-run.sh`:

1. Publishes an immutable `combo.endpoint-job/v1` under `dispatch/jobs/`.
2. Sends one `cb-run.sh --endpoint-job ...` command to the owning endpoint.
3. Verifies that the command is executing in the window recorded for that role.
4. Runs `cb-step.sh` with stdin closed.
5. Publishes a `combo.endpoint-receipt/v1` with pane id, window id, status, and
   result path.
6. Revalidates the receipt against the original dispatch before returning the
   result to `cb-chain.sh`.

Job and receipt names are bare validated names. They cannot contain traversal,
slashes, backslashes, dot prefixes, or nested destinations. A dispatch never
adopts a stale receipt.

Pane capture is a human/debug surface. `cb-peek.sh` and the composer check used
by `cb-send.sh` may inspect pane text, but no pane text is a product decision.

Cleaner releases the worktree; it does not tear down the tmux session or erase
run evidence. The five endpoints remain visible after convergence.

## 6. State machine and Reviewer routing

The only routing order is:

```text
Launcher -> Coder -> all Reviewer members -> [Coder -> all Reviewers]* -> Gate
                                                                    |
                                                                    v
                                                                 Cleaner
```

Launcher runs first. A nonzero completed event, technical error, cancellation,
or invocation failure becomes the product terminal state.

On Coder success, the chain replaces the current candidate with the exact SHA
from `coder_ready`. The Coder adapter itself obtains worktree, branch, and base
facts from Launcher custody; those runtime facts do not leak into the plan's
opaque Coder config.

One review round has these rules:

1. Every configured member receives the same candidate SHA.
2. Every member receives the same artifact snapshot captured at round start.
3. Member artifacts are aggregated after each result without exposing one
   member's same-round findings as another member's input.
4. `lgtm` contributes no correction request.
5. Any `needs_change` records its immutable findings artifact and requests one
   more Coder attempt.
6. After that Coder produces a new candidate, every configured Reviewer member
   runs again in a complete new round.

There is no separate Addressing role or endpoint. Correction is another Coder
attempt in the same chain.

When every member returns `lgtm`, or when the Reviewer array is empty, the
candidate proceeds to Gate.

The default maximum is 20 complete review rounds. A positive
`CB_CHAIN_MAX_REVIEW_ROUNDS` may override it. Reaching the limit while changes
are still requested terminates with the technical error
`review_round_limit`.

Reviewer degradation applies only to normalized member technical errors:

- `fail` records all member failures in the chain result, completes the current
  member pass, and terminates before another Coder or Gate invocation.
- `skip` records the member as skipped and allows the remaining members and
  normal needs-change routing to continue.

A Reviewer cancellation terminates immediately. A dispatcher or step
invocation failure is a chain technical error rather than a degradable member
result.

## 7. Launcher custody and Coder consumption

The mounted Launcher adapter accepts only the Treehouse configuration schema.
It publishes run-local readiness and mechanical configuration once, then calls
`cb-launcher.sh`.

Before acquisition, the mechanical Launcher aggregates:

- required `git`, `jq`, `tmux`, and `treehouse` availability;
- repository and base-ref validity;
- branch and custody-record collisions;
- every required seat's harness availability and non-interactive auth check.

It calls:

```sh
treehouse get --lease --lease-holder "$run_id"
```

The returned path must be the sole absolute response and Treehouse status must
prove that the same run id holds that exact path. The worktree must share the
repository's Git common directory and be clean.

The mounted branch is:

```text
combo/<run-id>
```

Launcher resolves the configured base to an exact commit, records custody, and
creates the branch at that commit. The Treehouse custody record has exactly
seven keys:

```json
{
  "base_sha": "<full-sha>",
  "branch": "combo/<run-id>",
  "lease_id": "<run-id>",
  "repo_dir": "<canonical-repository>",
  "run": "<run-id>",
  "runway_kind": "treehouse",
  "worktree": "<canonical-leased-path>"
}
```

The record is published at:

```text
agents/launcher.ownership.json
```

It is `0444`, canonical, run-contained, and non-replacing. On a supported
resume, the Launcher adapter validates this same seven-key record rather than
acquiring a second lease. A different or mutable record is a failure; it is
never rewritten into agreement.

The Coder adapter consumes the custody record directly and verifies:

- the repository and leased worktree still share one Git common directory;
- the recorded branch is checked out;
- the recorded base exists and is an ancestor;
- the worktree is clean;
- the current HEAD equals the base for the first Coder attempt, or equals the
  incoming candidate for a correction attempt.

Direct-agent and GNHF tools run in the leased worktree with closed stdin and an
allowlisted environment. The adapter adds only the selected environment plus:

```text
COMBO_CODER_ADAPTER_ID
COMBO_CODER_STEP_INPUT
COMBO_CODER_WORKTREE
```

A successful Coder must leave a new commit, preserve the branch, advance
history without rewriting it, change the tree, remain descended from the
Launcher base, and leave a clean worktree. Only then is `coder_ready` emitted.

## 8. Gate admission, publication, and replay

The Gate adapter validates one exact candidate and a
`combo.gate.no-mistakes/v1` configuration. Important configured authority
includes:

- No-Mistakes binary, runtime, model, arguments, intent, approval, and review;
- expected local base branch and exact expected base SHA;
- optional allowed path prefixes;
- manual or auto merge mode;
- bounded No-Mistakes, GitHub, polling, and merge-wait durations.

### New-arm admission order

Gate uses this order for a new delivery:

1. Validate the universal envelope and contain every path.
2. Validate immutable Launcher custody.
3. Require configured `expected_base_sha` to equal Launcher `base_sha`.
4. Require the recorded branch, exact candidate HEAD, and clean worktree.
5. If `allowed_paths` is configured, require a non-empty base-to-candidate diff
   and require every changed path to start with an allowed prefix.
6. Replay a valid existing terminal seal, if present.
7. For a fresh arm, resolve only
   `refs/heads/<expected_base_branch>^{commit}` in the source repository.
8. Require that local head to equal `expected_base_sha` and require the base to
   be an ancestor of the candidate.
9. Verify and seal the effective No-Mistakes identity and argv.
10. Acquire the host-global No-Mistakes lease, invoke once, and seal the
    receipt.
11. Release No-Mistakes custody before any GitHub-only merge wait.
12. Verify the exact PR and normalize the terminal Gate outcome.

This ordering has an intentional replay distinction. Immutable custody,
candidate identity, and allowed-path scope are still checked on every Gate
attempt. Once a valid terminal Gate seal exists, it is replayed before checking
whether the mutable local expected-base branch has advanced. A completed
delivery therefore remains replayable after base advance. A fresh delivery
does not.

The expected branch is a bare branch name. Values such as
`refs/heads/main` are invalid configuration, and resolution is explicitly
scoped to local `refs/heads/`; tags, remote-tracking refs, and ambiguous names
cannot satisfy it.

Early admission failures are normalized `gate_failed` events:

| Reason | Meaning |
| --- | --- |
| `candidate_head_changed` | Branch, exact HEAD, or worktree cleanliness changed. |
| `candidate_diff_empty` | Configured path scoping found no candidate changes. |
| `candidate_path_outside_allowed_scope` | At least one candidate path is outside the configured prefixes. |
| `expected_base_sha_mismatch` | Configured SHA disagrees with immutable Launcher custody. |
| `expected_base_branch_unresolved` | The configured local head does not resolve. |
| `expected_base_branch_mismatch` | The current local head advanced or otherwise differs. |
| `expected_base_not_ancestor` | The exact expected base is not an ancestor of the candidate. |

These rejections occur before a publication-shaped No-Mistakes or GitHub call.

### No-Mistakes invocation

Gate checks the effective No-Mistakes config, runtime, model, version, doctor,
and `axi` help surface before sealing `artifacts/gate/invocation.json`.
Configured arguments may not take over reserved intent, approval, or merge
authority.

`review: false` is translated exactly:

- with no configured skips, Gate appends `--skip=review`;
- with configured skips, Gate combines them and review in one
  `--skip=<configured>,review` argument.

`review: true` forbids a configured review skip. `approval: auto` appends
`--yes`. Merge authority is not passed to No-Mistakes: `--auto-merge` is
forbidden and auto merge is handled separately through authenticated GitHub
state.

The No-Mistakes lease is host-global. Its owner record binds run, branch,
worktree, candidate, attempt, process, token, and acquisition time. A heartbeat
keeps live custody fresh; bounded dead-owner recovery is evidence-backed. Each
reached attempt publishes its own immutable lease record and receipt.

### PR and merge authority

A passed or checks-passed No-Mistakes receipt must identify the recorded branch
and candidate. Gate resolves exactly one GitHub PR and verifies its full URL,
head branch, and head SHA.

Manual merge mode is mutation-free after PR verification and normalizes to:

```text
gate_ok outcome=validated
```

Auto merge mode explicitly runs authenticated:

```sh
gh pr merge <exact-pr-url> --auto --rebase
```

It seals strict target-branch required-check policy, observes all paginated
check-run and commit-status evidence for the exact candidate, and waits within
the configured bound. It never treats a different head or a changed required
check policy as equivalent.

Durable Gate terminal outcomes include:

| Normalized outcome | Result class/event | Typical evidence |
| --- | --- | --- |
| `validated` | completed, code 0 `gate_ok` | Manual mode, exact PR verified. |
| `merged` | completed, code 0 `gate_ok` | Auto mode, exact PR merged with required checks satisfied. |
| `failed` | completed, code 1 `gate_failed` | No-Mistakes failure, required-check failure, or merge wait timeout. |
| `cancelled` | cancelled, no event | No-Mistakes cancellation, PR closure, or auto-merge cancellation. |

The canonical terminal seal is:

```text
artifacts/gate/terminal.json
```

It binds run, branch, worktree, candidate, invocation, lease, No-Mistakes run
and receipt, PR, merge evidence, normalized outcome, and normalized result.
Terminal replay validates all referenced evidence and republishes a new
attempt's step result without another No-Mistakes or GitHub effect.

## 9. Exact Cleaner behavior

`cb-chain.sh` invokes Cleaner after every terminal path, including Launcher,
Coder, Reviewer, or Gate failure. Product truth and cleanup truth are stored
separately.

Invocation does not imply release. If no Gate attempt produced a terminal
`result.json`, Cleaner fails closed and preserves custody for diagnosis.

The mounted Cleaner adapter accepts only
`combo.cleaner/treehouse/v1`. Before release it requires:

1. The exact immutable seven-key Treehouse Launcher custody record.
2. Exactly one canonical Gate step directory.
3. One or more Gate attempt directories named with positive integers and no
   leading zero.
4. A contiguous attempt inventory from 1 through the numeric latest attempt.
5. A canonical, regular, `0444`, strictly valid `result.json` in that latest
   attempt.
6. A terminal Gate result: completed `gate_ok` or `gate_failed`,
   `technical_error`, or `cancelled`.

Latest means numeric latest, so attempt 10 is newer than attempt 2. Directory
count must equal the highest attempt number; gaps and noncanonical names fail
closed.

Cleaner snapshots the identity of every Gate attempt directory plus the latest
result's identity and normalized content. It rechecks that full snapshot before
release and again before publishing success. A replaced, added, removed, or
rewritten Gate terminal cannot authorize cleanup.

The mechanical Cleaner then revalidates custody against runtime configuration,
Git repository identity, checked-out branch, base commit, and exact Treehouse
lease holder. The mounted adapter supplies an idle custody check; it does not
guess Gate state from processes or panes.

Immediately before release it proves that the same run still holds the exact
recorded path, then calls:

```sh
treehouse return "<exact-recorded-worktree-path>"
```

The call is path-only and non-forcing. Cleaner does not search for another
worktree, return a guessed holder, delete an arbitrary branch, or fall back to
another release mechanism.

A zero exit from `treehouse return` is provisional. Cleaner immediately
re-observes Treehouse status:

- holder absent confirms release;
- the same holder still present records `treehouse:release_unconfirmed`;
- an unverifiable observation records `treehouse:release_unverified`.

Only confirmed absence publishes an immutable
`agents/cleaner.ownership.json` with `released: true` and an empty reasons
array.

Cleaner seal replay is exact:

- a valid immutable `released: true` seal replays `cleaned` without another
  return;
- a valid immutable `released: false` seal may be retried after Gate and seal
  snapshots are revalidated;
- a malformed, mutable, mismatched, or replaced seal is rejected;
- a successful mechanical call must leave a new exact success seal before the
  adapter can report `cleaned`.

Cleaner releases the Treehouse lease only. It does not remove run artifacts,
kill the five tmux endpoints, or change the chain's product terminal record.

## 10. Replay and interruption semantics

There are three distinct replay surfaces.

### Incomplete chain

If `chain-result.json` does not exist, `cb-run.sh` drives `cb-chain.sh` again.
When mounted dispatch artifacts already occupy an attempt number, the chain
selects the next unused number across the step directory, endpoint job, and
endpoint receipt.

This collision-free mechanism supports evidence-preserving continuation. For
example, after interruption immediately following Launcher, the next run
replays immutable Launcher custody instead of acquiring again, then uses fresh
attempt names for later roles.

It does not authorize deletion or reuse of a stale job or receipt. A stale
artifact is skipped, not adopted.

### Gate terminal replay

A valid Gate terminal seal is authoritative for the same run, custody,
candidate, invocation, and supporting artifacts. A later Gate attempt emits an
equivalent normalized result that references the original evidence and performs
no new No-Mistakes or GitHub action.

This replay survives a later local expected-base branch advance because that
freshness check applies to new arms. It does not survive candidate or custody
drift.

### Completed chain replay

Once immutable `chain-result.json` exists, `cb-run.sh` does not re-enter
`cb-chain.sh`. It mounts or verifies the five endpoints, validates the existing
result, and presents terminal truth. No Launcher, Coder, Reviewer, Gate, or
Cleaner step is dispatched again.

This means terminal replay does not duplicate Treehouse acquisition,
No-Mistakes delivery, GitHub mutation, or Treehouse return.

## 11. Terminal truth and process status

`combo.chain-result/v1` preserves both:

- `terminal`: the product role, exit class, event/code, reasons, and errors;
- `cleanup`: the Cleaner exit class, event/code, reasons, and errors.

Cleaner runs even when product routing has already failed. A cleanup failure
does not erase the earlier product failure, and a successful product result
does not erase a cleanup failure.

Process status uses this exact precedence:

1. Cleanup `cancelled` -> 130.
2. Cleanup `technical_error` -> 70.
3. Product terminal `cancelled` -> 130.
4. Product terminal `technical_error` -> 70.
5. Cleanup code 1 or product terminal code 1 -> 1.
6. Otherwise -> 0.

`cb-run.sh` prints exactly one human-facing line:

| Trusted Gate terminal | Stdout |
| --- | --- |
| `validated` | `validated` |
| `merged` | `merged` |
| Anything else | `failed` |

Printing `validated` or `merged` requires the one canonical
`artifacts/gate/terminal.json` reference, a regular canonical `0444` file,
stable file identity while read, the exact run and candidate, and a complete
successful Gate result. Missing, mutable, malformed, relocated, or
identity-invalid terminal evidence prints `failed`.

If the chain result would otherwise exit 0 but Gate presentation cannot be
trusted, `cb-run.sh` upgrades the process status to 70. Conversely, a trusted
`validated` or `merged` line does not hide cleanup failure: stdout may show the
trusted Gate outcome while the process exits 1, 70, or 130 because cleanup has
higher status precedence.

Operators must check both stdout and `$?`, then inspect `terminal` and `cleanup`
in `chain-result.json`.

## 12. Operator guide

### Prepare and compile

Use an absolute run root and a lowercase run id that does not begin with a
hyphen and otherwise contains only letters, digits, and hyphens:

```sh
export CB_RUNS_DIR="$HOME/.combo-chen/runs"
run_id=my-run
config_path=/absolute/path/to/combo.config.json

mkdir -p "$CB_RUNS_DIR/$run_id"
bin/cb-plan.sh "$run_id" --config "$config_path"
```

Compilation prints the canonical `plan.json` path. Treat any existing plan as a
different immutable run; do not remove it merely to reuse the id.

### Run, resume, or replay

The same command starts a fresh mounted run, continues a supported incomplete
run, or presents a completed result:

```sh
bin/cb-run.sh "$run_id"
status=$?
```

Keep the exit status. The single stdout word is not sufficient to establish
cleanup success.

### Observe

Machine-readable advisory status:

```sh
bin/cb-status.sh "$run_id"
bin/cb-status.sh "$run_id" reviewer
```

The status command reports journal phase, exact session liveness, metadata,
endpoint resolution, and current pane command. Pane command is a hint, not
workflow truth.

Human/debug pane capture:

```sh
bin/cb-peek.sh "$run_id" coder 80
bin/cb-peek.sh "$run_id" reviewer 80
```

`cb-run.sh` uses `cb-send.sh` internally. An operator can steer a live endpoint
explicitly when recovery calls for it:

```sh
bin/cb-send.sh "$run_id" coder "<literal prompt or command>"
```

This is low-level input injection. It does not publish a product event or
replace the endpoint job/receipt contract.

Direct tmux attachment with the default tmux server:

```sh
tmux attach-session -t "=combo-$run_id"
```

`CB_TMUX_SOCKET` and `CB_TMUX_CONF` are Combo wrapper variables, not native tmux
environment controls. Translate them when invoking tmux directly.

With a custom socket:

```sh
tmux -L "$CB_TMUX_SOCKET" \
  -f "${CB_TMUX_CONF:-/dev/null}" \
  attach-session -t "=combo-$run_id"
```

With only a custom config:

```sh
tmux -f "$CB_TMUX_CONF" attach-session -t "=combo-$run_id"
```

The helper scripts perform this translation automatically, so the same
`CB_TMUX_SOCKET` and `CB_TMUX_CONF` exports are sufficient for
`cb-run.sh`, `cb-status.sh`, and `cb-peek.sh`.

### Inspect terminal evidence

Show product and cleanup truth:

```sh
jq '{
  exit_class,
  candidate_sha,
  terminal,
  reasons,
  errors,
  cleanup
}' "$CB_RUNS_DIR/$run_id/chain-result.json"
```

Show immutable Launcher custody:

```sh
jq . "$CB_RUNS_DIR/$run_id/agents/launcher.ownership.json"
```

Show a reached Gate terminal seal:

```sh
jq . "$CB_RUNS_DIR/$run_id/artifacts/gate/terminal.json"
```

Show endpoint dispatch order without consulting pane text:

```sh
jq -R 'fromjson? | {
  role,
  step_id,
  attempt,
  window_id,
  receipt
}' "$CB_RUNS_DIR/$run_id/dispatch-log.jsonl"
```

### Diagnose without rewriting evidence

Use this order:

1. Save the `cb-run.sh` exit status and stdout.
2. Read `chain-result.json` when present.
3. Inspect the relevant latest `steps/.../attempt-.../result.json`.
4. Inspect role custody or Gate artifacts referenced by that result.
5. Use `cb-status.sh` for endpoint liveness and `cb-peek.sh` only for human
   context.
6. Rerun `cb-run.sh` only when the immutable artifacts still describe the same
   run and candidate.

Do not repair a run by editing `plan.json`, endpoint jobs, receipts, step
results, Launcher custody, Gate seals, Cleaner seals, or `chain-result.json`.
Their collision and identity checks are part of the product contract.

Common safe interpretations are:

| Evidence | Interpretation |
| --- | --- |
| No `chain-result.json`, Launcher custody present | An incomplete run may be resumable with fresh attempt names. |
| `gate_failed` with expected-base reason | No new publication arm was admitted. |
| `gate_failed` plus successful cleanup | Product failed, exact worktree release succeeded. |
| `gate_ok` plus failed cleanup | Publication truth is preserved, but operator action is required for custody. |
| Existing `chain-result.json` | `cb-run.sh` will present it without another role effect. |

Run evidence and the five tmux endpoints deliberately survive convergence.
Retention or session teardown is an outer operator lifecycle decision, not a
Cleaner side effect.
