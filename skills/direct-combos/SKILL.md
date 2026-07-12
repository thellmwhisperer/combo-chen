---
name: direct-combos
description: Direct fleets of combo-chen capsules across repositories. Use when an external agent must turn bounded ship work into work items, decide which items belong in combos, and supervise multiple independent combos without taking over their coder, reviewer, or gatekeeper roles.
user-invocable: true
---

# Direct combos (fleet director)

## Role and boundary

You are the external DIRECTOR of a fleet, not a worker inside any capsule. You shape ambiguous goals into bounded work items, dispatch eligible items, supervise durable signals, route decisions, and report outcomes upward. The capsule owns implementation, local review, publication, and post-publish convergence for one work item.

For the lifecycle of one already-shaped work item, also read [`../launch-combo/SKILL.md`](../launch-combo/SKILL.md). This skill owns the higher altitude: deciding what to dispatch and coordinating several independent capsules.

## 1. Decide whether to dispatch

Dispatch well-formed ship work only. A repository is combo-enabled when it has `combo-chen.toml`, or when it has `.no-mistakes.yaml` and the `combo-chen` binary is reachable. Probe the target checkout before promising a launch.

| Candidate work                                                                       | Repo probe                                             | Dispatch? | Director action                                                                        |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------ | --------- | -------------------------------------------------------------------------------------- |
| Bounded implementation with testable acceptance criteria                             | `combo-chen.toml` exists                               | Yes       | Author or verify the work item, then launch a combo.                                   |
| Bounded implementation with testable acceptance criteria                             | `.no-mistakes.yaml` exists and the binary is reachable | Yes       | Author or verify the work item, then launch a combo.                                   |
| Investigation, audit, research, or reproduction with no committed ship change        | Any                                                    | No        | Perform or delegate the investigation first; dispatch only a resulting bounded change. |
| Fuzzy scope, unresolved product intent, or acceptance criteria that cannot be tested | Any                                                    | No        | Resolve the ambiguity and rewrite the work item before launch.                         |
| Implementation work in a repo without either supported gate probe                    | Neither probe passes                                   | No        | Establish the repository's validation and publication contract outside the combo.      |

Do not use a combo merely to discover what the task is. A combo is the execution envelope after the director has made the work item coder-ready.

## 2. Author a coder-ready work item

Write the plan as Markdown with exactly the information a coder and reviewer need to determine completion:

```markdown
# <short outcome title>

## Problem

<Current behavior, affected user or operator, and why it matters.>

## Scope

<The bounded behavior or artifact that must change.>

## Acceptance Criteria

1. <Observable, testable outcome.>
2. <Regression or validation evidence.>

## Non-goals

- <Explicitly excluded adjacent work.>
```

Quality bar:

- Each acceptance criterion must be observable and testable, not an implementation preference.
- Scope must identify one reviewable outcome and exclude unrelated cleanup.
- Non-goals must name tempting adjacent work so the capsule does not expand its mandate.
- Product or intent decisions must be resolved before dispatch, never delegated implicitly to the coder.

### Worked example

```markdown
# Reject unknown engines when resuming a persisted combo

## Problem

Persisted combo snapshots may contain an engine value this release cannot run. Resuming such a snapshot must not guess a compatible engine because that can launch the wrong topology.

## Scope

Validate the persisted engine before changing tmux topology. Continue migrating missing and `v0` engine values to `capsule`, but fail closed for every other unknown value.

## Acceptance Criteria

1. Resuming a snapshot with engine `future-engine` exits non-zero before any tmux mutation.
2. A regression test proves missing and `v0` values still migrate to `capsule`.
3. The focused resume tests and the full local validation suite pass.

## Non-goals

- Adding another runtime engine.
- Changing launch behavior for new combos.
- Reworking unrelated snapshot fields.
```

Save a local plan before launch. The execution command is `combo-chen run --plan <file>`; issue-backed work may instead use a GitHub issue once it carries the same contract.

## 3. Launch and identify the capsule

Launch from the target repository or pass it explicitly:

```bash
combo-chen run --plan <file> --repo <target-repo>
combo-chen run --issue <url> --repo <target-repo>
```

Supply exactly one of `--plan` and `--issue`. `run` performs overture before it leases a worktree, starts tmux, or spends agent tokens. Read every overture line: `OK` passed, `WARN` is advisory, and `X` blocks launch.

Fix inputs and director-owned stale resources when the evidence is clear: select the correct repository or base ref, make the source checkout clean, provide a reachable work item, or remove a stale branch, worktree, run directory, or tmux session that this director owns. Never delete an occupied or foreign resource merely to make overture pass. Route configuration, unsafe role-command, team-identity, missing Treehouse, and no-mistakes runway failures to the repository or fleet owner unless you already own that configuration. Re-run the same launch command after the blocking condition is resolved; do not bypass overture.

Capture identity from the launch output, not by guessing from the title:

- `overture <combo-id>` gives the durable combo id used by later `-n` commands.
- `artifact <run-dir>/overture.json` gives the persisted overture artifact; its parent is the run directory.
- The final `🥢 combo-chen-<combo-id>` line confirms that the tmux capsule was created. A zero exit means setup succeeded, not that the work finished.

Keep the combo id and run directory in the fleet record, then move immediately to journal-first supervision.

## 4. Supervise from the journal

Treat the append-only journal as the source of truth. Do not capture or scrape tmux panes: panes are human observability surfaces, while journal events and the derived status are the durable machine contract.

Use the reporting surfaces at different cadences:

- `combo-chen status` is the cheap fleet scan. It shows actionable capsules by default, including phase, pending human reason, gate lease, and PR.
- `combo-chen status --deep` adds downstream no-mistakes and GitHub probes. Use it to investigate a suspicious or apparently stalled row, not as the tight polling loop.
- `combo-chen recap` is the since-you-left digest across persisted combos. Narrow it with `combo-chen recap -n <combo-id>` or use `--since <ISO-8601>` when handing a fleet between directors.
- `combo-chen events --follow -n <combo-id>` streams one capsule's raw JSONL journal when an event-by-event feed is useful. The non-following form, `combo-chen events -n <combo-id>`, is suitable for scripts and exits after the current journal.

### What to surface upward

Wake the captain only for a transition that changes ownership, exposes an outcome, or needs a decision:

| Journal or status signal             | Meaning for the external director                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `needs_human` / decision pending     | A durable escalation is awaiting an explicit answer; surface its combo id, reason, and timestamp. |
| `pr_opened`                          | Publication succeeded; surface the PR URL once.                                                   |
| `ready_for_merge` / READY            | Current-head agreement is complete; surface the PR as ready for the human merge decision.         |
| `merged`                             | GitHub merge is observed; report the outcome and let closure converge resources.                  |
| `failed` state or a `*_failed` event | Autonomous convergence stopped; surface the failing phase, reason, and last durable evidence.     |

Absorb routine progress such as coder starts and completion, local-review rounds, gate starts and validation, label projection, worker recovery, review-comment routing, and ordinary GitHub sampling. Keep the fleet record current, but do not turn those transitions into captain notifications.

### Polling bridge

When the caller cannot keep a follow stream open, use a cursor per combo and print at most one line for newly observed captain-relevant events. This bridge prints nothing on routine progress:

```bash
#!/usr/bin/env bash
set -euo pipefail

id="$1"
cursor="${2:-.tmp/director-${id}.cursor}"
seen="$(test -f "$cursor" && cat "$cursor" || printf '0')"
journal="$(combo-chen events -n "$id")"
count="$(printf '%s\n' "$journal" | awk 'NF { n += 1 } END { print n + 0 }')"

if (( count > seen )); then
  signal="$(printf '%s\n' "$journal" | tail -n "+$((seen + 1))" | jq -r '
    select(
      .event == "needs_human" or .event == "pr_opened" or
      .event == "ready_for_merge" or .event == "merged" or
      (.event | endswith("_failed"))
    ) | "\(.event) combo='"$id"' reason=\(.reason // "-") url=\(.url // .pr_url // "-")"
  ' | tail -n 1)"
  mkdir -p "$(dirname "$cursor")"
  printf '%s\n' "$count" >"$cursor"
  test -z "$signal" || printf '%s\n' "$signal"
fi
```

The cursor advances even when the new events are routine, so the same history does not wake the director later. After a wake, inspect `combo-chen status --deep` and the journal evidence before routing the next action.

## 5. Route decisions durably

A `needs_human` event transfers the named decision to a human; it does not authorize the external director to edit code or improvise product intent. Surface the event's combo id, reason, question or context, and journal timestamp. Obtain the answer from the decision owner, then record it through the lifecycle command:

`combo-chen decide -n <combo-id> <verb>`

Choose one of the four registered verbs:

| Verb        | Use when                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------- |
| `retry`     | The autonomous path may run again after supplying corrected input or a mechanical hint.       |
| `skip`      | The owner explicitly accepts leaving the blocked finding out of this combo.                   |
| `take_over` | A human accepts responsibility for the combo instead of allowing autonomous convergence.      |
| `ignore`    | The owner explicitly ends routing for this escalation without retrying the autonomous action. |

The command answers the latest pending escalation by default. If several are pending, target the exact journal timestamp with `--ref <timestamp>`; add `--note <text>` when the rationale will matter to the next director. Do not issue `skip`, `take_over`, or `ignore` as convenient ways around a blocked gate or uncertain intent: those verbs leave ownership with the human and do not approve an unreviewed changeset for publication.

`decide` appends a durable `decision` event whose `needs_human_ref` points to the answered escalation. The capsule and fleet views fold that journal relationship to clear the pending decision; a `retry` can resume the applicable autonomous loop, while the other verbs keep that loop from proceeding automatically. Never patch state files or treat a chat answer alone as resolution.

## 6. Map the capsule lifecycle

Use lifecycle commands to preserve the capsule's durable state and role ownership:

| Director intent                        | Command                            | Contract                                                                                                                                                                     |
| -------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pause for reboot or operator handoff   | `combo-chen park -n <combo-id>`    | Stops the capsule's local tmux processes, writes `park-handoff.md`, and journals `parked` without terminally closing the run or removing its resources.                      |
| Continue a persisted capsule           | `combo-chen resume -n <combo-id>`  | Rebuilds the frozen capsule topology and resumes at the journal-derived next phase; it does not create a new run or replay completed phases.                                 |
| Converge resources after a human merge | `combo-chen closure -n <combo-id>` | Confirms GitHub reports the PR as MERGED, waits for no-mistakes to be inactive, records terminal facts, returns the worktree lease, and removes the branch and tmux session. |

After `park`, retain the combo id and handoff path in the fleet record. A receiving director should read `park-handoff.md`, inspect `combo-chen status --deep`, then run `combo-chen resume -n <combo-id>`. Resume also detects a merge that happened while parked and routes directly to closure instead of restarting workers.

The in-process supervisor normally triggers closure after observing `merged`; the explicit closure command is the deterministic fallback when convergence is still pending. A refusal is a guardrail, not permission for manual teardown: resolve the reported GitHub, no-mistakes, git, or Treehouse condition and retry the command.

### Director prohibitions

An external director must never:

- edit the combo worktree or create implementation commits;
- write to the PR conversation, answer review threads, approve, merge, or deploy;
- bypass the gate, publish directly, or treat READY as merge authorization;
- hand-edit the journal, runtime ledger, verdict files, or frozen config snapshot;
- kill role processes or delete branches, worktrees, run directories, or tmux sessions outside the lifecycle commands.

Route implementation and review findings back through the capsule's durable signals. The human owns merge and intent decisions; closure owns resource teardown.

## 7. Scale a multi-combo fleet in waves

Treat each capsule as an independent ownership unit: one branch, one worktree, one tmux session, and one runtime ledger. Never assign two capsules to the same branch or let one capsule reuse another capsule's worktree or state directory. Parallel coders and reviewers remain isolated because their capsules own distinct resources.

Branch-scoped gate leases prevent two publishers from owning the same branch; they do not establish that the underlying no-mistakes daemon supports concurrent runs. A conflicting same-branch owner produces a durable lease conflict that the director surfaces and resolves by checking the current owner, never by deleting or overwriting the lease record. Before allowing gates from different branches to overlap, establish the daemon's concurrency capability for that environment; otherwise serialize gate entry while coders and reviewers continue in parallel. Treat an active lease as evidence of gate ownership, not as evidence that the gate is stuck.

Scale by observed waves:

1. Start with 2 live capsules.
2. Increase to 3 live capsules only after the first wave shows clean journal progression and no unrecovered branch, worktree, tmux, or gate-lease conflicts.
3. Increase to 4 to 6 live capsules only after the three-capsule wave meets the same bar. Do not raise the limit merely because prior capsules are quiet; explain quiet from journal and status evidence first.

Record each wave's combo ids, branches, PRs, gate-lease waits or conflicts, recovery actions, and final closure state. Use that evidence to keep, raise, or lower the next wave limit. A `needs_human` burst or unrecovered resource conflict is a reason to hold the wave and converge existing capsules, not to launch more work.

The persisted machine-wide combo registry is the fleet inventory. Read it through supported projections rather than editing its files:

- `combo-chen status` shows actionable capsules and active gate ownership for the routine scan.
- `combo-chen status --all` includes terminal history when auditing a wave or closure coverage.
- `combo-chen status --deep` probes downstream state for selected suspicious rows; avoid using it as the high-frequency fleet loop.
- Bare `combo-chen` on a TTY opens the TUI fleet home, which prioritizes capsules needing attention and lets a human inspect one capsule's journal-derived thread.

Keep dispatch and supervision at fleet altitude. The independent capsule continues to own coding, local review, gate publication, PR convergence, and closure for its work item.
