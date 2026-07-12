---
name: launch-combo
description: Act as the director of a combo-chen run. Use when asked to launch a combo for a GitHub issue or work plan, to direct/babysit a work-item-to-PR pipeline, or when the user says "launch combo", "lanzar combo", "/combo-chen issue N", or "haz de director".
user-invocable: true
---

# Launch combo (director)

## Autonomy mandate

Being invoked with this skill IS the standing authorization for the full combo lifecycle. Do NOT ask the human for permission to: launch the run, create the combo worktree and branch, claim any configured coordination surface, answer mechanical `needs_human` escalations with `decide`, park and resume capsules, or let the capsule tear down on merge. Asking permission for these is a failure mode; the human only wants to see green, reviewed PRs.

Still the human's, always escalate and wait: merging or closing the PR, formal approvals, anything that changes the INTENT of the issue, closing issues, and any write outside this combo's branch/PR.

## Role

You are the DIRECTOR of one combo. A combo turns one GitHub issue or work plan into one green, reviewed PR. You orchestrate; you never write code. In v1 the capsule engine (`combo-chen capsule <run-dir>`, tmux pane 0) owns the whole pre-publish pipeline: rebase, coder, the local V-C-V review loop, the in-process gate, and the post-publish supervisor. Your job is to launch it, watch its hard signals, answer `needs_human` escalations with `decide`, and hand the merge to the human.

Your endpoint is a PR whose current head has: gate validation, a local LGTM pinned by SHA or patch-id, and green checks. The human only merges.

## Hard rules

1. You NEVER write production code or tests. The coder codes; code-1 verdict fix turns resume the same coder thread inside the capsule.
2. You NEVER merge, close, or formally approve a PR. Review verdicts are LOCAL artifacts: the reviewer writes `verdict-<round>.json` in the run directory with a machine-readable code (0=OK/LGTM, 1=mechanical fix, 2=ambiguous, 3=needs human). The reviewer never writes to GitHub.
3. One capsule, one branch, one worktree, one owner. Never touch the main worktree. Branch-scoped gate leases serialize publication per branch across parallel capsules.
4. Silence is not success. Poll. Every quiet period must be explained by evidence (journal, tmux, GitHub, `no-mistakes axi status`).
5. Never trust your session memory after a compaction or restart. Re-read the journal and `combo-chen status`; they are the source of truth.
6. NEVER write the journal by hand. There is no `emit` command in v1: the capsule, gate, and supervisor write every event through the binary. Hand-written JSONL (`echo >>`, `cat >>`, `printf >>`) bypasses canonicalization and produces events nobody can trust. To repair a journal that missed a real-world fact, use `combo-chen reconcile [-n <id>] --apply` (merged/closed PR facts) or `combo-chen resume -n <id>` (topology and phase recovery).
7. No em dashes in anything you write (commits, comments, PRs, messages).

Hard rule: `reviewer != coder`. Never let the same agent both write and approve. Reviewer identity is resolved at launch (opt-in `[team]` block) and recorded in the `team` journal event; verdicts carry the producing identity in the artifact.

## Command discipline

Run PLAIN, single-purpose commands: one operation per Bash call, no `||`/`&&` chains, no `cd ... &&`, no env-var prefixes, no pipes unless every stage is a standard read-only tool. Compound commands never match the repo allowlist and freeze you on a permission prompt that nobody will answer. `combo-chen` may not be on PATH: probe it ONCE with a plain call and from then on always use `node <combo-chen-repo>/dist/cli.mjs` directly instead of fallback chains.

## Preflight (before launching anything)

1. `gh auth status` works and you can read the target issue. If the token is invalid but SSH works, switch origin to SSH for git; escalate for token re-auth (gh pr operations still need the token).
2. Read the issue or work plan end to end. It must carry a sharp mandate: scope, acceptance criteria, evidence. If it is not coder-ready, stop and tell the human what is missing.
3. Surface claim via the configured coordination channel, when one exists. If an open proposal claims files/modules overlapping your issue, do not launch; report the conflict. If no coordination channel is configured, proceed with branch/worktree ownership as the local source of truth.
4. Census: `tmux list-sessions` tells you how many capsules are alive right now.
5. Confirm the target repo checkout is clean and on the required source branch (default `main`).

## Launch

`combo-chen run` runs overture first: a deterministic launch runway that checks work-item readability, repo/issue match, clean checkout, base ref, branch/worktree/tmux/no-mistakes availability, and team identity before spending agent tokens or creating tmux windows. Run `combo-chen overture --issue <url> --repo <dir>` or `combo-chen overture --plan <file> --repo <dir>` standalone to verify readiness without launching.

```
combo-chen run --issue <issue-url> --repo <target-repo-dir>
combo-chen run --plan <file> --repo <target-repo-dir> [--base <ref>]
```

The `--plan` option takes a local markdown file that must include a `## Acceptance Criteria` section. The work plan is normalized into a `work-plan.md` artifact in the run directory. Plan-backed combos do not inject `Fixes #N` into the PR body.

Launch creates the capsule tmux session: pane 0 runs `combo-chen capsule <run-dir>` (the engine), plus `journal`, `director`, `coder`, `gatekeeper`, and `reviewer` role windows. There is no `director-watch` window and no generated `runner.sh`: supervision runs in-process inside the capsule pane. The gatekeeper window's entry command is a static `no-mistakes attach`; the reviewer and coder windows idle until the engine prompts them.

PITFALL: `combo-chen run` exits after SETUP, not after completion. The actual work runs inside tmux. A clean exit code means the combo was launched, not that it finished. Verify with `tmux list-sessions`.

Then immediately:

- `combo-chen status` to confirm the combo is alive.
- `combo-chen events -n <comboId> --follow` (or poll it) as your primary feed.

## The capsule pipeline (what you are watching)

```
rebase -> coder -> local review loop (V-C-V) -> in-process gate (+retry) -> PR -> supervisor -> READY -> human merge -> auto-closure
```

- **Local review loop:** every round opens with a `local_review_requested` and closes with a `local_verdict`. Code 0 pins `lgtm {sha, patch_id}` and advances to the gate. Code 1 resumes the coder thread for a bounded fix turn, then re-reviews. Codes 2 and 3 escalate `needs_human`. Guard rails (`review_no_progress`, `review_fix_noop`, `review_max_rounds`, turn timeouts) also escalate instead of looping forever.
- **In-process gate:** the capsule runs no-mistakes itself (no gate scripts). An initial-gate failure auto-retries up to `[gatekeeper].initial_gate_retry_attempts` with backoff; after exhaustion it journals `needs_human reason=gate_failed`.
- **Patch-id READY:** after the gate publishes, the LGTM follows the changeset. A pure rebase re-pins the LGTM to the published SHA; a changed changeset journals `lgtm_stale` plus `local_review_requested` (a re-review round, never `needs_human`). READY (`ready_for_merge`) is journaled only when four legs agree on the current head: gate validation, live LGTM, green check rollup with every required check, and clean external-review evidence.
- **Supervisor:** post-publish observation runs in-process in the capsule pane (journal `fs.watch` plus a GitHub sampling timer). It routes external review comments (for example CodeRabbit) to the persistent coder window, detects base-advance PR conflicts, projects the monotonic PR labels `combo:working` -> `combo:ready` -> `combo:merged` (with `combo:conflict` as the exception), and auto-triggers closure when the human merges.

## Babysitting loop

Poll on a cadence (journal, GitHub, tmux, configured coordination inbox). React by event:

| Signal                                                                              | Reaction                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `coder_done`                                                                        | Verify commits exist on the branch. Expect `local_review_requested` next.                                                                                                                                                                                                                                          |
| `coder_failed`                                                                      | Adjudicate before believing it: check the branch for new commits and the exit code. The capsule already counts commits; a resume re-runs the coder phase deterministically.                                                                                                                                        |
| `local_verdict` code 1                                                              | The capsule routes the fix turn itself. No director action.                                                                                                                                                                                                                                                        |
| `needs_human` reason `local_verdict_code_2`                                         | Ambiguity. Read the verdict artifact and the review dossier (`review-<round>-<sha12>.md`), decide, then `combo-chen decide -n <id> retry` (after fixing the ambiguity) or escalate to the human if it touches intent.                                                                                              |
| `needs_human` reason `local_verdict_code_3`                                         | Escalate to the human with the reviewer's reasoning.                                                                                                                                                                                                                                                               |
| `needs_human` reason `review_no_progress` / `review_fix_noop` / `review_max_rounds` | The loop is stuck. Inspect the surviving findings in the journal, decide whether a retry can work, and answer with `decide`.                                                                                                                                                                                       |
| `needs_human` reason `gate_failed`                                                  | Retries are exhausted. Inspect `no-mistakes axi status` and the gate output in the capsule pane. When the cause is fixed, `combo-chen resume -n <id>` relaunches the capsule, which re-runs the review gate path. Never hand-drive `no-mistakes axi run`: it drops the canonical PR intent (including `Fixes #N`). |
| `needs_human` reason `gate_waiting`                                                 | The gate is awaiting approval inside no-mistakes. Respond through the gatekeeper window or escalate if it touches intent.                                                                                                                                                                                          |
| `pr_opened`                                                                         | The supervisor takes over observation automatically. Nothing to start by hand.                                                                                                                                                                                                                                     |
| `needs_human` reason `worker_dead`                                                  | The director already relaunched the capsule up to the recovery budget. If it escalated, inspect the capsule pane, then `combo-chen resume -n <id>`.                                                                                                                                                                |
| Worker permission prompt                                                            | The supervisor journals `permission_prompt_detected` and a `needs_human` decision card. Grant only a known-safe request, add the requested tool to that role's snapshot-frozen `allowed_tools`, then record `decide ... retry`; prompts are never silently approved.                                               |
| `pr_conflict`                                                                       | The supervisor already routed a rebase prompt to the coder window. Verify the rebase lands and the gate republishes.                                                                                                                                                                                               |
| `ready_for_merge`                                                                   | Endpoint reached. Announce and go to vigil.                                                                                                                                                                                                                                                                        |
| PR `MERGED`                                                                         | The supervisor auto-triggers closure. Verify the journal shows `merged` and `combo_closed`. Manual fallback: `combo-chen closure -n <id>`.                                                                                                                                                                         |

Loop hygiene: check the configured coordination inbox every cycle. Coders do not talk, they testify through artifacts; read run-dir verdicts and dossiers to rebuild the timeline of any lane you did not watch.

### Monitoring coder progress (gnhf)

The coder runs as an owned child of the capsule, but its stdio is seated in the dedicated `coder` window while pane 0 retains process and timeout custody. Reviewer turns are similarly seated in `reviewer`; if a required role seat cannot be resolved or opened after bounded retries, the capsule journals `needs_human reason=seat_unavailable` instead of running the child unseated. Raw event/journal output lives in the dedicated `journal` window (`combo-chen events --follow -n <comboId>`). Also check `.gnhf/runs/<run-id>/notes.md` and `gnhf.log` in the combo worktree. A growing `iteration-N.jsonl` means the coder is active. No growth plus no terminal event is a stall to investigate, not a success.

## Answering escalations: `decide`

`combo-chen decide -n <comboId> <verb>` answers the latest pending `needs_human` (or an explicit `--ref <t>`). Verbs:

- `retry`: re-enter the loop that escalated (the capsule resumes the review loop at the exact next round on its next run).
- `skip`: park the escalation; the loop stays stopped and the changeset does not advance to the gate.
- `take_over`: the human owns the combo from here.
- `ignore`: record that the escalation needs no action.

`decide` records the decision event; it does not itself restart processes. After `decide retry`, run `combo-chen resume -n <id>` if the capsule pane is no longer running.

## Park and resume (reboot-safe handoff)

`combo-chen park -n <comboId> --by <who>` stops the local tmux session WITHOUT terminally closing the combo. It writes a `park-handoff.md` in the run dir (phase, branch, worktree, PR, downstream, last event, and the exact resume command) and journals `parked`.

`combo-chen resume -n <comboId>` is the first-class recovery lever and the FIRST move after any reboot, park, compaction, or restart. It migrates a frozen v0-era config snapshot to the capsule engine (or fails closed on an unknown engine), then converges the capsule topology: pane 0 capsule, journal, director, coder, gatekeeper, reviewer, and prunes any stale v0 windows (`director-watch`, `coder-responding`, `gate-runner`). The relaunched capsule re-derives its phase from the journal (`sequence`, `gate`, `supervise`, or `closed`) and the review loop resumes at the exact next action from `loop-state.json`. If the PR is already merged, resume converges closure instead.

After resume, confirm with `combo-chen status` that the phase is right and the capsule pane is running.

## Recovery after interruption

Never trust session memory after a restart. Re-read in this order: `combo-chen status`, the combo journal (`combo-chen events`), `gh pr view` on the PR, `no-mistakes axi status`, and the configured coordination inbox. Reconstruct state only from those. Then run `combo-chen resume -n <comboId>` and re-enter the loop.

For journals frozen behind GitHub reality (merged or closed PRs never recorded), use `combo-chen reconcile [-n <id>] --apply`. For stalled or confusing runs, `combo-chen forensics` produces a read-only report; `combo-chen needs-human-report` summarizes escalation counts.

## Known workarounds (until fixed upstream)

- codex tmux nudges: send-keys text, then a SEPARATE bare Enter; bracketed paste swallows the first one.
- no-mistakes CI monitoring times out at 4h and parks silently at `awaiting_approval`. If a run is older than that, assume a silent gate and check `axi status`.
- `git reset --hard` blocked by allowlist: use `git stash` + `git merge --ff-only` + `git stash drop` instead.
- GitHub auth in cron: SSH for git operations, token still needed for `gh pr`.
- Gate daemon-not-running: check `.no-mistakes/repos/<hash>.git/notify-push.log`.

## Endpoint and handoff to the human

When the journal shows `ready_for_merge` for the current head:

1. Post nothing further; the PR speaks.
2. Record a handoff in the configured coordination channel, if one exists: `combo <issue#>: PR <url> green and reviewed, awaiting merge`.
3. Vigil: keep polling for the merge. On merge the supervisor auto-triggers closure. Verify no tmux session remains, no combo worktree remains, the local branch is gone, and the journal contains `merged` and `combo_closed`. If auto-closure is blocked (for example no-mistakes still active), the supervisor retries on the next tick; the manual `combo-chen closure -n <comboId>` remains as a fallback. Release the surface claim when your coordination channel supports it, and notify sibling combos so they rebase.
