# Combo Chen Bash v1 mounted chain

This document is the normative architecture, runtime specification, and
operator guide for the Bash v1 product. It covers the checked-in
`cb-plan.sh` → `cb-chain.sh` path and its native Launcher, Coder, Gate, and
Cleaner adapters. The broader director protocol and historical decisions
remain in [the protocol spec](spec.md).

The Bash chain is deliberately small in authority:

- `cb-plan.sh` compiles one immutable plan.
- `cb-chain.sh` is the only product state machine and entry point.
- `cb-step.sh` is the only adapter process and normalization boundary.
- `cb-tmux.sh` and `cb-send.sh` manage the five visible tmux endpoints.
- Adapters own tool-specific behavior; routing sees only normalized artifacts.

There is no second orchestration loop and no pane-text decision path.

## 1. Architecture at a glance

```text
combo.config/v1
      |
      v
  cb-plan.sh ---------------------> plan.json (0444, write once)
                                          |
                                          v
                                      cb-chain.sh
                                          |
        Launcher -> Coder -> Reviewer round (zero or more members)
                      ^          |
                      | needs_change
                      +----------+
                                 |
                       all current / skipped
                                 v
                               Gate -> Cleaner
                                          |
                                          v
                                  chain-result.json
```

The chain never routes on adapter stdout, stderr, terminal text, or
append-only step logs.

### Component ownership

| Component | Owns | Does not own |
| --- | --- | --- |
| `cb-plan.sh` | Config validation, role order, immutable plan publication | Runtime facts or execution |
| `cb-chain.sh` | Traversal, step dispatch, terminal presentation, replay | Provider or tool behavior |
| `cb-step.sh` | Attempt directories, universal envelope, timeouts, normalized output | Interpretation of tool logs |
| `cb-tmux.sh` / `cb-send.sh` | Tmux session and window lifecycle, pane dispatch | Product transitions |
| Native adapters | Role-specific validation and effects | Cross-role routing |
| Mechanical Launcher/Cleaner | Exact runway acquisition/release | Plan compilation or Gate policy |

## 2. Five visible execution endpoints

Every mounted run has exactly one tmux session named `combo-<runId>` and these
five endpoint windows:

| Role | Window | Mode | What executes there |
| --- | --- | --- | --- |
| Launcher | `cb-<runId>-launcher` | shell | Launcher `cb-step.sh` invocation |
| Coder | `cb-<runId>-coder` | TUI-capable shell | Every Coder attempt |
| Reviewer | `cb-<runId>-reviewer` | TUI-capable shell | Every configured Reviewer member |
| Gate | `cb-<runId>-gate` | shell | Gate attempt |
| Cleaner | `cb-<runId>-cleaner` | shell | Cleaner attempt |

All five windows are mounted even when `reviewer_count` is zero. Reviewer
cardinality belongs to the plan; it does not change the visible topology.
Multiple Reviewer members execute serially through the one Reviewer endpoint.

`agents/<role>.meta` records each endpoint's immutable tmux window id plus its
expected name. Before dispatching a command, `cb-send.sh` proves that:

1. it is executing inside tmux;
2. `TMUX_PANE` belongs to the recorded window id;
3. that window still has the canonical role name inside the exact run session;
4. its pane is live.

A renamed, reused, dead, or cross-session window cannot satisfy dispatch.
`cb-status.sh` and `cb-peek.sh` use the same metadata, but their phase and pane
output is advisory. Neither command feeds the state machine.

## 3. Immutable plan and universal step ABI

### Plan order

`cb-plan.sh <runId> --config <path>` accepts `combo.config/v1` and publishes
one read-only `combo.run-plan/v1` at `runs/<runId>/plan.json`. Its step order is
always:

```text
launcher
coder
reviewer/<member-id> ...  # zero or more
gate
cleaner
```

The plan records `reviewer_count`, the Reviewer degradation policy, the
run-local paths, and each adapter's argv plus opaque config. It contains no
worktree, branch, lease, candidate, PR, or other post-launch fact. The
compiler refuses to replace an existing plan.

The Coder binding may contain one adapter invocation or an ordered invocation
list. Attempt 1 selects invocation 1, attempt 2 selects invocation 2, and so
on; attempts beyond the configured list reuse the last invocation. Reviewer
adapter ids must differ from every configured Coder adapter id.

### Step input

For each attempt, `cb-step.sh` creates:

```text
steps/<ordinal>-<step-id>/attempt-<N>/
  input.json
  stdout.log
  stderr.log
  adapter-output.json  # present only when the adapter publishes it
  result.json
```

It appends `--input <input.json> --output <adapter-output.json>` to the
configured argv and closes process stdin. `input.json` is
`combo.step-input/v1` and carries:

- run, step, role, adapter, and attempt identity;
- canonical run, artifact, step, invocation, input, and output paths;
- the current candidate SHA or `null`;
- the step's opaque config;
- validated references to prior run-local artifacts.

The adapter's stdout and stderr go only to the attempt logs. A nonzero adapter
exit, timeout, missing output, invalid schema, unsafe path, or invalid artifact
reference becomes a normalized `technical_error` or `cancelled` result.

### Step output

Every accepted `combo.step-output/v1` has one of three exit classes:

| Exit class | Required shape |
| --- | --- |
| `completed` | Exactly one role-specific code 0 or 1 product event |
| `technical_error` | No events and at least one error |
| `cancelled` | No events and at least one reason |

The completed event vocabulary is fixed:

| Role | Code 0 | Code 1 |
| --- | --- | --- |
| Launcher | `launch_ready` | `launch_not_ready` |
| Coder | `coder_ready` | `coder_not_ready` |
| Reviewer | `lgtm` | `needs_change` |
| Gate | `gate_ok` | `gate_failed` |
| Cleaner | `cleaned` | `clean_failed` |

`result.json` is the normalized authority consumed by the chain. An adapter's
own output is never trusted directly by another role.

## 4. Step invocation protocol

`cb-chain.sh` invokes each step through `cb-step.sh` directly:

1. selects an unused effective attempt number for the step;
2. calls `cb-step.sh <runId> <stepId> <attempt> [--candidate-sha <sha>] [--prior-artifacts <json>]`;
3. `cb-step.sh` creates `steps/<stepId>/attempt-<N>/`, writes `input.json`,
   executes the configured adapter argv with stdin closed, and publishes
   `result.json`;
4. `cb-chain.sh` validates the result path, schema, and identity before
   accepting it.

`cb-step.sh` runs the adapter in the current process; it does not dispatch
through tmux. The chain and step boundary own process I/O, timeouts, path
containment, and normalized exit classes. Adapter stdout and stderr are
captured in attempt logs only.

## 5. Product routing

### Launcher

Launcher runs once logically. A successful result establishes the candidate
workspace and then the chain enters the Coder loop. Any Launcher code 1,
technical error, cancellation, or invocation failure becomes the terminal
product result.

### Coder and Reviewer rounds

Each Coder success supplies a new exact local candidate SHA. The chain then
runs one complete Reviewer round:

- all configured Reviewer members receive the same candidate SHA;
- all members receive the same artifact snapshot from the start of that round;
- their output artifacts are aggregated only after each independent result;
- one or more `needs_change` events route to the next Coder attempt after the
  full round completes;
- a round with only `lgtm` results advances to Gate;
- a zero-member round advances directly to Gate.

`CB_CHAIN_MAX_REVIEW_ROUNDS` bounds correction rounds (default 20). Reaching
the limit after a `needs_change` round terminates with
`review_round_limit`.

`reviewer.degraded` controls normalized Reviewer technical errors:

- `fail` (the default) records every member failure, completes the round, and
  then terminates the chain as a Reviewer technical error;
- `skip` records the member as skipped and lets the other members and routing
  continue.

An endpoint/invocation failure is not a degradable Reviewer opinion; it
terminates immediately. Cancellation also terminates. The final chain result
retains all normalized Reviewer member failures.

### Gate and Cleaner

Gate runs once after a current Reviewer round, or immediately after Coder when
there are no Reviewer members. Gate never routes back to Coder or Reviewer.

Cleaner is invoked after every terminal chain path. The native Cleaner can
release custody only when a latest, immutable Gate attempt result exists.
Consequently, a pre-Gate Coder or Launcher termination still produces a
Cleaner result, but cleanup is refused and any existing custody is retained
for typed recovery.

## 6. Immutable Launcher custody

The mounted native Launcher adapter accepts only
`combo.launcher/treehouse/v1`. It publishes run-local readiness and mechanical
configuration, invokes `cb-launcher.sh`, and normalizes its result. The
mechanical Launcher:

1. validates required harness and authentication checks;
2. resolves the configured base ref;
3. acquires a Treehouse lease held by the run id;
4. publishes exact custody;
5. creates `combo/<runId>` at the resolved base SHA;
6. optionally copies the tracked `.no-mistakes.yaml` and runs setup;
7. emits `launch_ready`.

The custody authority is the read-only, write-once
`agents/launcher.ownership.json`:

```json
{
  "run": "<runId>",
  "runway_kind": "treehouse",
  "repo_dir": "/canonical/source/repository",
  "worktree": "/canonical/leased/worktree",
  "branch": "combo/<runId>",
  "base_sha": "<full lowercase commit>",
  "lease_id": "<runId>"
}
```

The key set is exact. The native adapter rejects a different runway kind,
branch, lease identity, repository, mode, or rewritten record. On a resumed
Launcher attempt, existing custody is validated and returned; the lease is not
acquired again and `plan.json` is not changed.

The lower-level mechanical Launcher retains a separately configured explicit
Git-worktree mode. That is not part of the mounted native adapter contract,
which is Treehouse-only.

### Coder consumption

`cb-agent-run.sh` reads custody out of band. Before starting either the
`direct-agent` or `gnhf` adapter it proves:

- source repository and worktree are canonical and share one Git common dir;
- the recorded branch is checked out;
- the recorded base commit exists and is an ancestor of the current HEAD;
- the supplied candidate, when present, equals HEAD;
- the worktree is clean.

The configured tool runs in an allowlisted `env -i` environment in the leased
worktree with stdin closed. A PATH-level Git wrapper rejects ordinary
`git push`; it is an accident guard, not a same-user security boundary. A
successful Coder result requires a new, clean, forward local commit with a
nonempty changeset. Publication remains Gate authority.

## 7. Gate admission, publication, and replay

The native Gate consumes the candidate plus the same Launcher custody. Its
admission order is intentional.

### Before any publication-shaped command

Gate first validates the universal envelope and then:

1. validates the exact read-only Launcher custody record;
2. requires `config.expected_base_sha == custody.base_sha`;
3. requires the worktree branch and HEAD to equal custody and candidate facts;
4. when `allowed_paths` is configured, requires a nonempty
   `expected_base_sha..candidate_sha` diff whose every path starts with one of
   those relative directory prefixes;
5. replays an existing valid Gate terminal seal, if present;
6. for a new Gate arm, resolves and validates the expected base branch and
   candidate ancestry.

Steps 1–6 precede No-Mistakes execution and every GitHub command. A mismatch
is a normalized `gate_failed`; unsafe or malformed local state is a technical
contract failure.

`expected_base_branch` is a local branch name, not an arbitrary Git revspec.
For a fresh arm Gate resolves exactly:

```text
refs/heads/<expected_base_branch>
```

It must resolve to `expected_base_sha`, and that SHA must be an ancestor of the
candidate. A remote-tracking name is not implicitly resolved under
`refs/remotes/`. Operators should verify the exact local ref before compiling:

```bash
git -C /path/to/repo show-ref --verify \
  "refs/heads/<expected_base_branch>"
```

Terminal replay deliberately happens before this fresh-arm branch-freshness
check. A previously sealed Gate result remains replayable after the local base
branch advances, but a new Gate effect cannot start against the stale SHA.

### No-Mistakes boundary

For a new arm Gate freezes:

- the effective No-Mistakes runtime and model from its config;
- `no-mistakes --version`, `doctor`, and the supported `axi` help surfaces;
- the canonical binary and exact argv;
- the candidate, branch, worktree, merge mode, and initial attempt.

The installed `axi run` surface must not expose base selection or auto-merge.
Gate owns both policies. Configured arguments cannot smuggle `--intent`,
`--yes`, or `--auto-merge`; `approval:auto` appends `--yes`. With
`review:false`, Gate reserves the `review` skip and either emits
`--skip=review` alone or composes configured skip values and `review` into one
`--skip=<configured>,review` argument.

One host-global lease serializes the shared No-Mistakes invocation. Its
owner/evidence is recorded before execution, stale dead ownership has bounded
recovery, and a heartbeat keeps live ownership current. Gate captures a
read-only receipt and releases that lease before any GitHub merge operation.

Before any normalization, the No-Mistakes receipt must provide the expected
run id and branch, a valid candidate-head prefix, and a recognized outcome.
`passed` and `checks-passed` receipts additionally require an exact GitHub PR
identity match. Failed and cancelled receipts are normalized without treating
any PR URL they carry as authenticated evidence.

### Manual and auto merge modes

| Mode | Gate authority | Successful normalized outcome |
| --- | --- | --- |
| `manual` | Validate and publish an exact candidate PR; do not arm merge | `validated` |
| `auto` | Require strict protected checks; arm auto-rebase and observe a bounded authenticated result | `merged` |

Auto mode arms exactly `gh pr merge <pr> --auto --rebase`.

Auto mode can instead seal typed cancellation, required-check failure, or
timeout outcomes. It verifies the exact candidate SHA, PR branch, repository,
base branch, branch-protection requirements, paginated check runs, and commit
statuses. Gate does not treat pane text or an unauthenticated PR URL as proof.

### Gate seals

Gate evidence accumulates under `artifacts/gate/` and may include:

- `invocation.json`;
- per-attempt host-lease evidence;
- the No-Mistakes receipt;
- optional merge-arm and merge-outcome evidence;
- `terminal.json`.

Every artifact that is published is read-only and cannot be replaced.
Admission and verification rejections return a normalized Gate result without
manufacturing evidence for stages they did not reach, so `terminal.json` is
not guaranteed. When a terminal seal exists, a later Gate attempt with the
same candidate validates the seal and its referenced evidence, then emits a
new normalized step result without rerunning No-Mistakes or GitHub effects.

## 8. Exact Cleaner behavior

The native Cleaner adapter accepts only `combo.cleaner/treehouse/v1`. It does
not infer custody from the plan, current directory, branch names, or tmux.

Before release it:

1. validates the exact seven-key, read-only Launcher custody;
2. requires exactly one `steps/*-gate` directory;
3. inventories every `attempt-N` directory and requires a contiguous `1..N`
   sequence with no malformed, duplicate, symlinked, or missing attempt;
4. selects the numerically highest attempt, not lexical order;
5. requires that attempt's `result.json` to be read-only and a complete valid
   Gate terminal result;
6. snapshots the attempt-directory identities and selected result identity
   plus normalized content;
7. rechecks that snapshot immediately before and after release.

Cleaner refuses an older successful Gate result while a newer Gate attempt is
in flight or invalid. It also refuses a replaced result or changed attempt
inventory.

`cb-cleaner.sh` then revalidates repository, worktree, branch, base, lease
holder, and Git common-directory identity. For Treehouse it performs exactly:

```text
treehouse return <recorded-absolute-worktree>
```

It checks the recorded holder immediately before that path-only, non-forcing
return. A zero exit is provisional: Cleaner immediately re-observes Treehouse
status and seals success only when the exact path/holder pair is no longer
visible. A still-visible pair records `treehouse:release_unconfirmed`; an
unobservable status records `treehouse:release_unverified`. Either outcome
seals `released:false` for a later exact retry.

There is no guessed path, force flag, branch fallback, or plain-Git fallback
in the mounted adapter.

The mechanical result is sealed at `agents/cleaner.ownership.json` with the
custody facts, `released`, and `reasons`:

- a valid `released:true` seal is replayed as `cleaned` without another
  backend call;
- a later adapter invocation may retry only from an exact valid
  `released:false` seal, after revalidating Gate and custody;
- a malformed, foreign, mutable, or replaced seal is refused.

Cleanup never overwrites the product terminal. `chain-result.json` stores
terminal and cleanup outcomes in separate objects. Process status reports
cleanup cancellation or technical failure, product cancellation or technical
failure, and then either code 1 before it can report overall success.

## 9. Replay and interruption

There are two replay levels.

### Incomplete run

When `chain-result.json` does not exist, running `cb-chain.sh <runId>` traverses
the chain again. It chooses fresh attempt numbers by avoiding every existing
step attempt directory. Adapter seals decide whether a
logical effect is validated, retried, or reused:

- Launcher validates write-once custody instead of leasing again.
- Gate validates a terminal seal instead of republishing.
- Cleaner replays a successful release seal or permits a typed failed-release
  retry.

An interruption immediately after Launcher therefore produces a fresh
Launcher attempt on resume while preserving the same custody bytes.

### Terminal run

When `chain-result.json` exists, `cb-chain.sh` validates the existing result
and reprints its terminal presentation. It does not publish new step attempts
or duplicate Launcher, Coder, Gate, GitHub, or Cleaner effects.

Do not delete attempt directories, step artifacts, custody records, or
seals to manufacture a retry. They are replay evidence.

## 10. Terminal result and process status

`chain-result.json` is read-only `combo.chain-result/v1`. It records:

- the product `exit_class`, candidate SHA, and terminal role/code/event;
- accumulated artifact references;
- Reviewer degradation policy and member failures;
- product reasons and errors;
- a separate Cleaner exit class, code/event, reasons, and errors.

`cb-chain.sh` prints the absolute path to `chain-result.json` and exits with a
status code that encodes the combined outcome:

| Status | Meaning |
| --- | --- |
| `0` | Product completed code 0 and cleanup completed code 0 |
| `1` | Normalized product code 1 or cleanup code 1 |
| `70` | Technical error (product or cleanup) |
| `130` | Product or cleanup cancellation |

## 11. Operator guide

### Compile one run

Use one absolute run root and pre-create the run directory:

```bash
export CB_RUNS_DIR=/absolute/path/to/combo-runs
run_id=my-combo-run
mkdir -p "$CB_RUNS_DIR/$run_id"

bash bin/cb-plan.sh \
  "$run_id" \
  --config /absolute/path/to/combo.config.json
```

The config must be a regular, non-symlink file. The compiler prints the
canonical plan path. Treat the plan as a one-time operation: recompiling the
same run is a collision, not an update mechanism.

At minimum, `combo.config/v1` must provide:

- an adapter registry whose argv arrays are compatible with declared roles;
- bindings for Launcher, Coder, Gate, and Cleaner;
- a `reviewers` array, which may be empty;
- native Launcher config with repository, base ref, setup, and readiness;
- a direct-agent or GNHF Coder config;
- Gate config with exact expected local base branch/SHA and publication policy;
- `{ "schema": "combo.cleaner/treehouse/v1" }` for native Cleaner.

Before compilation, resolve and record the same base commit in both Launcher
and Gate policy:

```bash
base_sha=$(
  git -C /absolute/path/to/repo rev-parse \
    "refs/heads/<expected_base_branch>^{commit}"
)
printf '%s\n' "$base_sha"
```

Launcher `base_ref` may use any resolvable ref, but its resolved SHA must equal
Gate `expected_base_sha`. Gate `expected_base_branch` remains the exact local
branch name described in §7.

### Mount or resume

```bash
CB_RUNS_DIR="$CB_RUNS_DIR" bash bin/cb-chain.sh "$run_id"
```

The same command handles first run, incomplete-run replay, and terminal
replay. It can be invoked from another current directory because the
chain resolves its checked-in executable and sibling scripts, but the
executable must remain canonical, regular, and executable.

### Observe

```bash
CB_RUNS_DIR="$CB_RUNS_DIR" sh bin/cb-status.sh "$run_id"
CB_RUNS_DIR="$CB_RUNS_DIR" sh bin/cb-peek.sh "$run_id" reviewer 80
tmux attach-session -t "=combo-$run_id"
```

If `CB_TMUX_SOCKET` or `CB_TMUX_CONF` was set for the run, use the same values
for status and peek. For direct attachment, translate those wrapper variables
to tmux options:

With a custom socket, use the configured file or `/dev/null` by default:

```bash
tmux -L "$CB_TMUX_SOCKET" -f "${CB_TMUX_CONF:-/dev/null}" \
  attach-session -t "=combo-$run_id"
```

With only a custom config:

```bash
tmux -f "$CB_TMUX_CONF" attach-session -t "=combo-$run_id"
```

`CB_TMUX_SOCKET` and `CB_TMUX_CONF` are Combo Chen variables, not native tmux
environment settings. Pane capture is for human diagnosis only.

Inspect machine truth directly:

```bash
jq . "$CB_RUNS_DIR/$run_id/chain-result.json"
jq . "$CB_RUNS_DIR/$run_id/agents/launcher.ownership.json"
jq . "$CB_RUNS_DIR/$run_id/agents/cleaner.ownership.json"
```

The runner and Cleaner do not tear down the tmux session. Retain it for
inspection or remove it explicitly after machine-readable terminal and custody
evidence has been collected.

### Diagnose by authority

| Question | Read |
| --- | --- |
| What was compiled? | `plan.json` |
| Which endpoint executed a step? | `agents/<role>.meta` |
| What did an adapter say? | attempt `result.json` |
| Which workspace is owned? | `agents/launcher.ownership.json` |
| What publication was authenticated? | `artifacts/gate/terminal.json` and referenced evidence |
| Was exact custody released? | `agents/cleaner.ownership.json` and `chain-result.json.cleanup` |
| What should the operator report? | stdout together with process status and `chain-result.json` |

Use stdout/stderr logs and `cb-peek.sh` only to explain an authoritative result,
never to replace one.

## 12. Runtime artifact map

```text
runs/<runId>/
  plan.json
  config.env
  launcher-readiness.json
  journal.jsonl
  agents/
    launcher.meta
    coder.meta
    reviewer.meta
    gate.meta
    cleaner.meta
    launcher.ownership.json
    cleaner.ownership.json
  steps/
    <ordinal>-<step>/attempt-<N>/
      input.json
      stdout.log
      stderr.log
      adapter-output.json  # when the adapter publishes one
      result.json
  artifacts/
    gate/
      invocation.json
      no-mistakes-lease-attempt-<N>.json
      no-mistakes-attempt-<N>.toon
      merge-arm.json
      merge-outcome.json
      terminal.json        # only after a sealed Gate terminal outcome
  chain-result.json
```

Optional merge artifacts exist only when the configured mode and observed
outcome require them. Attempt directories and evidence are append-only by
collision refusal. `launcher.ownership.json`, Gate evidence, normalized step
results, and the chain result are read-only authorities; endpoint metadata and
the Cleaner failure seal have narrowly defined recovery/replacement behavior
described above.
