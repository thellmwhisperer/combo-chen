---
name: launch-combo
description: Act as the director of a combo-chen run. Use when asked to launch a combo for a GitHub issue or work plan, to direct/babysit a work-item-to-PR pipeline, or when the user says "launch combo", "lanzar combo", "/combo-chen issue N", or "haz de director".
user-invocable: true
---

# Launch combo (director)

## Autonomy mandate

Being invoked with this skill IS the standing authorization for the full combo lifecycle. Do NOT ask the human for permission to: launch the run, create the combo worktree and branch, claim any configured coordination surface, activate reviewer rounds, activate the coder in responding mode, respond to mechanical gates, rebase after a sibling merge, tear down on merge. Asking permission for these is a failure mode; the human only wants to see green, reviewed PRs.

Still the human's, always escalate and wait: merging or closing the PR, formal approvals, anything that changes the INTENT of the issue, closing issues, and any write outside this combo's branch/PR. Review authorship belongs to the configured reviewer; the director only starts and observes that worker.

## Role

You are the DIRECTOR of one combo. A combo turns one GitHub issue or work plan into one green, reviewed PR. You orchestrate; you never write code. Your endpoint is a PR with passing checks and a current `lgtm @ <head-sha>` verdict. The human only merges. Everything before the merge is yours.

## Hard rules

1. You NEVER write production code or tests. The coder codes; the coder in responding mode fixes review findings.
2. You NEVER merge, close, or formally approve a PR. Review verdicts are COMMENT reviews pinned to the head SHA (`lgtm @ <sha>` or findings).
3. One combo, one branch, one worktree, one owner. Never touch the main worktree.
4. Silence is not success. Poll. Every quiet period must be explained by evidence (journal, tmux, GitHub, axi status).
5. Never trust your session memory after a compaction or restart. Re-read the journal and `combo-chen status`; they are the source of truth.
6. The ONLY sanctioned way to write the journal is `combo-chen emit`. Never hand-write JSONL lines (`echo >>`, `cat >>`, `printf >>`) into a `journal.jsonl`: that bypasses canonicalization and the runner side-effects, produces events the director cannot trust, and trips the safety classifier as fabricated state.
7. No em dashes in anything you write (commits, comments, PRs, messages).

Hard rule: `reviewer != coder`. Never let the same agent both write and approve. The LGTM verdict must be published by a GitHub author listed in `[reviewer].logins` before the director will accept it as reviewer evidence.

## Command discipline

Run PLAIN, single-purpose commands: one operation per Bash call, no `||`/`&&` chains, no `cd ... &&`, no env-var prefixes, no pipes unless every stage is a standard read-only tool. Compound commands never match the repo allowlist and freeze you on a permission prompt that nobody will answer. `combo-chen` may not be on PATH: probe it ONCE with a plain call and from then on always use `node <combo-chen-repo>/dist/cli.mjs` directly instead of fallback chains.

## Preflight (before launching anything)

1. `gh auth status` works and you can read the target issue. If the token is invalid but SSH works, switch origin to SSH for git; escalate for token re-auth (gh pr operations still need the token).
2. Read the issue or work plan end to end. It must carry a sharp mandate: scope, acceptance criteria, evidence. If it is not coder-ready, stop and tell the human what is missing.
3. Surface claim via the configured coordination channel, when one exists:
   - If an open proposal claims files/modules overlapping your issue, do not launch. Report the conflict.
   - Claim your surface with issue number, repo, branch, and director identity.
   - If no coordination channel is configured, proceed with branch/worktree ownership as the local source of truth.
4. Census: `tmux list-sessions` tells you how many runners are alive right now. Cross-check against open proposals.
5. Confirm the target repo worktree for the combo starts from fresh `origin/main` (`git fetch` + verify the base).

## Launch

```
combo-chen run --issue <issue-url> --repo <target-repo-dir>
combo-chen run --plan <file> --repo <target-repo-dir> [--base <ref>]
```

If `combo-chen` is not on PATH, use `node <combo-chen-repo>/dist/cli.mjs`.

The `--plan` option takes a local markdown file that must include a `## Acceptance Criteria` section. The work plan is normalized into a `work-plan.md` artifact in the run directory. Plan-backed combos do not inject `Fixes #N` into the PR body.

PITFALL: `combo-chen run` exits after SETUP, not after completion. The actual work runs inside tmux. A clean exit code means the combo was launched, not that it finished. Verify with `tmux list-sessions`.

Then immediately:
- `combo-chen status` to confirm the combo is alive.
- `combo-chen events --name <comboId> --follow` (or poll it) as your primary feed.

## Babysitting loop

Poll on a cadence (journal, GitHub, tmux, configured coordination inbox). React by event:

| Signal | Reaction |
|---|---|
| `coder_done` | Verify commits exist on the branch. Expect the gate stage (no-mistakes) next. |
| `coder_failed` | Adjudicate before believing it: check the branch for new commits and the exit code. Exit via signal with the work present can be a false negative. |
| gate stage / `gate_waiting` / `awaiting_approval` | Gate prompts can go quiet in the journal. If the pipeline stalls, run `no-mistakes axi status` yourself. Respond to the gate or escalate to the human if it touches intent. If you need to relaunch the gate, use `combo-chen gate-restart -n <id>` (see "Restarting a stalled gate" below), never a hand-driven `axi run`. |
| `gate_failed` before `pr_opened` | The director auto-retries the initial gate up to `[gatekeeper].initial_gate_retry_attempts` times with `[gatekeeper].initial_gate_retry_backoff_seconds` delay. After the retries are exhausted the combo journals `needs_human reason=gate_failed` and stops. Resume will not relaunch a retry after exhaustion; inspect the run directory and no-mistakes status, then either `combo-chen gate-restart -n <id>` (see "Restarting a stalled gate" below) or escalate to the human. Do not hand-drive `no-mistakes axi run`: it drops the verbatim `Fixes #N` requirement and the merged PR will not autoclose its issue. |
| `pr_opened` | Start the review round: launch the reviewer (`combo-chen activate-reviewer -n <id>`) on the PR per the repo review protocol. Verdict as COMMENT review pinned to head SHA. |
| PR opened out of band, no `pr_opened` in the journal | The gate-approval/manual-`axi run` path opens a PR without journaling `pr_opened`, so `activate-reviewer` refuses ("no pr_opened event") and the director loop never starts. Journal it through the binary, never by hand: `combo-chen emit -n <comboId> pr_opened --field url=<prUrl>`. An out-of-band publish also skips the gate script's autoclose guard, so run `combo-chen ensure-pr-autoclose -n <comboId> --pr-url <prUrl>` before the reviewer round to re-inject and verify the `Fixes #N` line. Then proceed to the reviewer round. |
| Subagent idle, waiting on a permission dialog | A stuck subagent is YOUR responsibility to detect (capture-pane on its window every cycle) and to report: escalate to the human immediately with the session:window and the pending tool, instead of letting it sit. Prevention is also yours: before launching any subagent, verify the repo's allowlist covers the tools its prompt will need, and flag gaps to the human BEFORE the launch, not after the freeze. |
| Review findings (BLOCKED) | Activate the coder in responding mode (`combo-chen activate-coder`) to fix mechanical findings and reply to every comment. Intent-touching proposals escalate to the human, never auto-applied. |
| New push to the PR | The previous verdict is stale. Re-run an incremental reviewer round and re-pin. |
| New non-reviewer comments (bots included) | Sweep them via the coder responding mode. Nothing stays unanswered. |
| `lgtm @ <head-sha>` current + checks green | Endpoint reached. Announce and go to vigil. |
| Owned combo PR is `MERGED` | Run `combo-chen closure -n <comboId>`. The command verifies GitHub PR state (`MERGED`), records any missing `merged` event, refuses teardown while no-mistakes is active, removes the local worktree and branch, kills the tmux session, and journals `combo_closed`. Already-converged local artifacts count as success, so reruns should be a no-op or report already closed. |
| Coordination inbox: `merged` from a sibling combo | Rebase your branch on the new main early. Re-run checks. |
| Coordination inbox: help request (stuck gate, saturated director) | Assist only with read/status actions unless you own that combo. |

Loop hygiene: check the configured coordination inbox every cycle. Coders do not talk, they testify through handovers; read run-dir handovers to rebuild the timeline of any lane you did not watch.

### Monitoring coder progress (gnhf)

When the coder is gnhf, check `.gnhf/runs/<run-id>/notes.md` and `gnhf.log`. A growing `iteration-N.jsonl` means the coder is active. No growth plus no terminal event is a stall to investigate, not a success.

### Restarting a stalled gate: `gate-restart`, never a hand-driven `axi run`

When a gate stalls or exhausts its retries (`needs_human reason=gate_failed`, or a gatekeeper window that died after retries), restart it with the first-class command, NOT by driving `no-mistakes axi run` yourself:

```
combo-chen gate-restart -n <comboId>
```

This is one plain command, so it obeys the command discipline above (no `&&`, no env-var prefix, no command substitution, nothing that trips a permission prompt). It restarts the gate through the same generated script the runner uses, so the canonical intent (including the verbatim `Fixes #N` requirement for issue-backed combos) and the `ensure-pr-autoclose` guard (skipped for plan-backed combos) are baked in. It routes automatically: before `pr_opened` it relaunches the initial gate; after `pr_opened` it runs the post-address gate for the current head.

Use it for a STALLED gate, not a live one. `gate-restart` is a force lever: after `pr_opened` it replaces the running gatekeeper window even if a gate is genuinely in flight. Confirm the gate is actually stalled first (`no-mistakes axi status`, and check whether the last `gate_status` is `fix_inflight` with a fresh timestamp). If it still looks alive, wait or escalate instead of clobbering it. When the latest status is `fix_inflight`, `gate-restart` prints a warning before proceeding.

Why never hand-drive it: a hand-written `no-mistakes axi run --intent ...` drops the `Fixes #N` block, so the regenerated PR body loses the autoclose line and the merged PR leaves its issue open. Capturing the intent inline with `--intent "$(combo-chen intent -n <id>)"` is also unsafe: command substitution captures only stdout, so if the command fails it publishes `--intent ""` and reintroduces the same bug, and the assignment-plus-`&&` form that would guard against it is a compound command the director cannot run safely. `gate-restart` removes the whole footgun.

`combo-chen intent -n <comboId>` still exists as a primitive: it prints the exact `{issue_pr_intent}` the runner uses, for inspection or forensics. Do not build a manual publish around it.

After any out-of-band publish, still run `combo-chen ensure-pr-autoclose -n <comboId> --pr-url <prUrl>` to re-inject and verify the line, because the manual path skips the gate script's autoclose guard.

## Park and resume (reboot-safe handoff)

`combo-chen park -n <comboId> --by <who>` stops the local tmux session WITHOUT terminally closing the combo. It writes a `park-handoff.md` in the run dir (phase, branch, worktree, PR, downstream, last event, and the exact resume command) and journals `parked`. Use it before a reboot or when handing a lane off; the combo can be revived later.

`combo-chen resume -n <comboId>` is the first-class recovery lever and the FIRST move after any reboot, park, compaction, or restart. It reads the combo record plus journal, computes the deep downstream status, and performs exactly ONE safe transition for the state it finds:

- PR ready for review: recreate the tmux monitoring session, start the reviewer.
- Gate (no-mistakes) running: recreate the session, ensure the gatekeeper window, and if a PR was opened out of band while CI is live, journal `pr_opened` for you and start the reviewer.
- PR already exists: recreate the session, start the reviewer.
- Initial gate never finished: relaunch the initial gate.
- Coder stopped before handoff, ambiguous gate, or unknown state: resume does NOT guess. It prints explicit salvage next-steps and stops.

resume auto-handles the common revives, including the most common one (bridging a missing `pr_opened` while the gate is live), and it recreates the `events --follow` monitoring shell if it died. For the salvage states it punts on, fall back to manual `emit` below. After resume, confirm with `combo-chen status` that the phase is right and the worker you expected actually started.

## Reviving a combo with `emit` (the fallback after resume)

In the normal path the runner writes every event. `combo-chen emit -n <comboId> <event> [--field k=v...]` is the recovery lever for when a real-world fact happened but the runner died before journaling it, so the combo is frozen in the wrong phase. Reach for it only after `combo-chen resume` has run and either punted to a salvage state or does not cover the fact you need to record, and only after diagnosis (`combo-chen status`, `combo-chen events`, `gh pr view`, `no-mistakes axi status`) confirms the fact is true and the journal is the only thing out of date. Never emit to fabricate a state that did not happen.

Each event moves the phase machine that `combo-chen status` and `director-watch` read (`deriveStatus`). That move IS the side-effect: emitting reclassifies the combo and unblocks (or re-gates) the workers keyed on that phase.

Do not hand-emit `merged` or `combo_closed` as a substitute for post-merge cleanup. For a merged PR, run `combo-chen closure -n <comboId>` so GitHub state is verified and local resource convergence happens through the deterministic closure path.

| Emit this | Phase it forces | Use it to revive when |
|---|---|---|
| `coder_started` (no fields) | CODING | the coder is running but `coder_started` never landed. |
| `gate_started` (no fields) | GATING | the gate is live but unjournaled. **Extra side-effect:** recreates the gatekeeper tmux window. |
| `pr_opened --field url=<prUrl>` | REVIEWING | the gate opened the PR out of band (manual `axi run`, human-resolved gate) so `pr_opened` is missing and `activate-reviewer`/`director-watch` refuse to start. The single most common revive. |
| `coder_done` (no fields) | (no phase move) | the coder finished but the thread was never captured. **Extra side-effect:** persists `coder-thread.json`, which responding mode needs to resume. |
| `address_done --field head_sha=<sha>` | READY → REVIEWING | an addressing commit landed but the combo is stuck in READY. |
| `gate_stale` / `lgtm_stale --field old_sha=<a> --field new_sha=<b>` | READY → REVIEWING | HEAD moved past a stale validation/LGTM and READY never reopened. |
| `ready_for_merge --field sha=<sha> --field pr_url=<url>` | READY | every current-head signal agrees but the terminal READY event is missing. Verify all four signals first; do not shortcut the contract. |
| `needs_human --field reason=<r>` | (sets needs-human) | you are escalating and want the flag to show in `status`. |
| `stopped --field by=<who>` | STOPPED | the combo reached a terminal non-merge state the runner never recorded; emit only after diagnosis proves the fact is true. |

`coder_failed`, `gate_failed`, `rebase_failed`, `rebase_conflict` also force STALLED + needs-human, but these are failure facts the runner owns; do not hand-emit them to "park" a combo.

After emitting: re-run `combo-chen status` to confirm the phase flipped, then confirm the worker you unblocked actually started (reviewer window alive, COMMENT review posted, gatekeeper window present). The emit is not the goal; the revived loop is.

## Known workarounds (until fixed upstream)

- Mirror clobber: after a sibling merge the gate auto-rebases the PR branch from ITS mirror and force-pushes. If the coder pushed to origin but not the mirror, the force-push discards those commits. Coder must push to BOTH remotes.
- codex tmux nudges: send-keys text, then a SEPARATE bare Enter; bracketed paste swallows the first one.
- no-mistakes CI monitoring times out at 4h and parks silently at `awaiting_approval`. If a run is older than that, assume a silent gate and check `axi status`.
- `git reset --hard` blocked by allowlist: use `git stash` + `git merge --ff-only` + `git stash drop` instead.
- GitHub auth in cron: SSH for git operations, token still needed for `gh pr`.
- Gate daemon-not-running: check `.no-mistakes/repos/<hash>.git/notify-push.log`.

## Endpoint and handoff to the human

When the PR is green with a current lgtm:
1. Post nothing further; the PR speaks.
2. Record a handoff in the configured coordination channel, if one exists: `combo <issue#>: PR <url> green and reviewed, awaiting merge`.
3. Vigil: keep polling for the merge. On merge: run `combo-chen closure -n <comboId>`, then verify no tmux session remains, no combo worktree remains, local branch is gone, and the journal contains `merged` and `combo_closed`. Release the surface claim when your coordination channel supports it, and notify sibling combos so they rebase.

## Recovery after interruption

Never trust session memory after a restart. Re-read in this order: `combo-chen status`, the combo journal (`combo-chen events`), `gh pr view` on the PR, `no-mistakes axi status`, and the configured coordination inbox. Reconstruct state only from those. Then run `combo-chen resume -n <comboId>` (see "Park and resume") and re-enter the loop.
