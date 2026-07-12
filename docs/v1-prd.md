# combo-chen v1 PRD

Status: draft for review. Owner: Javier. Source: architecture sessions 2026-07-11.

Relation to `docs/spec.md`: spec.md is the constitution of the currently
implemented system (what this PRD calls v0) and stays authoritative for the
code that exists today. This PRD supersedes it in design; spec.md gets
rewritten to conform when v1 lands.

## 1. Vision

combo-chen is a deterministic combinator of tools. It takes a work item (GitHub
issue or plan file) and returns a merged PR, by sequencing three products that
each do one job: gnhf (coder loop), a local review loop (new in v1), and
no-mistakes (gate and only publisher). The human owns merge.

v1's defining principle: **all agent coordination happens locally, through
typed files on disk. The PR is a read-only projection, born already reviewed.**

Operational goal: launch and forget. The operator launches a combo and is only
interrupted by real decisions. Coming back hours later, one command answers
"what happened, what needs me".

## 2. Why v1 (v0 lessons, with evidence)

- **The PR was the message bus.** Reviewer posted verdicts as comments, the
  director parsed them, labels mutated per tick. Result on real PRs: 12+
  reviews (some empty), three agent identities under one login, 69 label
  mutations, humanly unfollowable threads (PR #282, #294).
- **The review-invalidation treadmill.** PR #294 spent 18h cycling: READY was
  journaled 6 times and torn down 6 times; 9 external review requests; 7 gate
  runs of 30-40m each; 23 director LLM prompts mostly re-making the same
  policy decision. Root cause: review happened after publish, on a moving
  head, with an LLM re-litigating a deterministic freshness rule.
- **Reviewer findings were discarded by routing.** The Opus reviewer found the
  same defects CodeRabbit later flagged (sometimes earlier, with file:line)
  but triaged them as non-blocking notes inside code-0 verdicts; the pipeline
  only reads codes, so the findings died in prose while CodeRabbit's identical
  "actionable" copies each triggered a full cycle.
- **Sequencing lived in 22 generated shell templates** with logic in heredocs,
  tested only end to end. Worker babysitting (director + external capataz)
  existed to compensate for state living in tmux panes.

## 3. The v1 loop

```
work item
  -> overture (deterministic runway checks)
  -> treehouse lease, isolated worktree, combo branch
  -> CODER: gnhf runs, leaves local commits            (coder_done)
  -> REVIEW LOOP (local, pre-publish):
       V0 reviews changeset -> verdict file
       code 1 -> harness prompts coder "fix this" -> commit -> re-review
       ... repeats ...
       invariant: the loop opens and closes with a verdict, never a coder turn
       no-progress guard: same finding fingerprint surviving 2 rounds, or a
       no-op coder turn, escalates needs_human instead of iterating
       code 0 -> proceed        code 2/3 -> needs_human
  -> GATE: no-mistakes validates the approved changeset and publishes the PR
  -> GITHUB: CodeRabbit auto-reviews on push (majors and criticals only).
     Findings route to the same coder path, are re-reviewed locally, and the
     gate republishes. No LLM writes to the PR conversation.
  -> READY: local lgtm (carried across gate rebase by patch-id equivalence)
     + CI green + CodeRabbit green on head
  -> human merges (auto-merge available as opt-in config, default off)
  -> director-watch detects merge, auto-converges resources, journals closure
```

Verdict codes (unchanged from v0): 0 lgtm, 1 mechanical fix to coder,
2 ambiguous to director/human, 3 needs_human.

New calibration contract: the reviewer prompt carries a list of this repo's
critical surfaces (journal integrity, coder_done trust signals, role
boundaries, publishing). Any finding on a critical surface is minimum code 1,
even if pre-existing and even if the happy path avoids it. Real-but-deferable
findings ship in a machine-readable follow-ups block that the harness
harvests (to the coder pre-merge or to issues post-merge); prose notes are
never the only home of a finding.

## 4. Role contract: command + prompt + observable outputs

The atomic unit of every role is a binary invocation. A role is:

```toml
[roles.coder]
command = "npx gnhf --agent codex --current-branch {prompt}"  # harness default
# command = "codex exec --cd {worktree} {prompt}"             # bare binary: also valid

[roles.reviewer]
command = "claude {prompt}"

[roles.gate]
command = "no-mistakes axi run --yes"
```

- Harnesses (gnhf, no-mistakes) are recommended defaults, not architecture.
  Anything that satisfies the role's observable-output contract is a valid
  role implementation.
- Completion is judged only by observables: exit code, git state (new commits
  on the branch), and the expected artifact at its well-known run-dir path
  (verdict file for reviewer, open PR at expected head for gate).
- Completion contracts are harness-neutral: coder done = exit 0 + commits.
  gnhf's iteration JSONL becomes optional enrichment, never a requirement
  (v0's coder_done hard-required it; that coupling is removed).
- Handoff is via git and files, never via sessions or screens. No role reads
  another role's pane.
- Every artifact declares the identity (model, runtime) that produced it.
- Agent-model commodity swapping happens inside harnesses (gnhf --agent,
  no-mistakes agent config, ACP targets), not in combo-chen.

Agents remain interactive TUIs in tmux windows, by decision: full
auditability, attachable, resumable. The harness never controls or reads
those panes; stall and permission-prompt recovery machinery stays.

## 5. Artifacts: the run dir is the public API

Three tiers, mirroring gnhf's own discipline:

1. **Contract** (JSON, schema-versioned, read by code): combo.json,
   config.snapshot.json, overture.json, journal.jsonl (ground truth),
   runtime-ledger.json, verdict-<round>.json, loop-state.json.
2. **Dossier** (markdown, read by humans): work-plan.md,
   review-<round>-<sha>.md (full reviewer artifact: attack table, checklist,
   not-verified), closure summary.
3. **Debug** (prunable, explicit retention policy): agent stream JSONLs,
   process logs, thread ids.

Dead on arrival in v1: generated .sh scripts, window.log files, .done markers,
loose pid files. They were plumbing for the shell substrate.

PR body projection: when CodeRabbit is green, the harness updates the PR body
with one collapsed <details> block per review round (dossier inside), newest
first, older rounds compacted to their verdict line as the 65,536-char body
limit approaches. No links to external files, no attachments.

Review dossier style rule: every fact lives in exactly one place; the attack
table and checklist reference findings ("see blocker #1"), never restate them.
The human-facing summary is exceptions-only: findings, follow-ups,
not-verified. Clean rows cost zero visible lines.

Every closed combo leaves a permanent exit summary (merged what, rounds,
findings fixed and by whom - local reviewer vs CodeRabbit - tokens, duration,
PR url) in the run dir and on stdout.

Optional mirrors by config: La Roca (analytics) for tiers 1-2. Format stays
JSON/markdown for the canonical copies.

## 6. 100% TypeScript

- The 22 shell templates and the generated runner.sh are replaced by
  `combo-chen capsule <run-dir>`: a node process in tmux pane 0 that
  sequences coder, review loop, and gate, reading the pinned snapshot from
  the run dir and emitting journal events via the same API as everything
  else. Unit-tested like the rest of the codebase.
- Gate runs become in-process orchestration (child processes awaited, exit
  codes, no marker files). Events append directly, no __EMIT__ subprocess.
- Criterion: if it has an if, a loop, or parses output, it is TypeScript.
  What tmux needs as a window entry command may remain a plain command
  string.
- pnpm lint:sh leaves the validation set when the last template dies.

## 7. Supervision

- Event-driven, not pane-watching: the watcher sleeps on journal/file events
  and wakes only on decisions (firstmate's model). Polling ticks remain only
  where GitHub state must be sampled.
- The director role shrinks to deterministic routing plus process
  supervision. Policies that v0 asked an LLM to re-decide (READY freshness,
  review-required-at-head) are encoded, not consulted.
- needs_human is the interaction unit, rendered as decision cards: question,
  two lines of context, explicit verbs (retry, skip, take over, ignore).
  Answering writes a decision event to the journal.

## 8. Terminal UI

Navigable mock: `docs/v1-ui-mock.html` (open in a browser; keyboard-driven).
The mock is the visual and interaction reference; this section is the
implementation contract. Design rules frozen with the mock (2026-07-12):
no progress bars for agent work (no known end; use count-up timer + spinner),
per-step checkmarks only where real steps exist (gate), numbers always
labeled with a verb ("2 fixes rejected", never bare trends), review-loop
rounds bounded at 3 before needs_human, Enter/ArrowRight to dive in and
ArrowLeft/Escape/q to back out.

Three surfaces over one substrate (pure fold functions over journal.jsonl,
verdict files, and process liveness; the renderer holds no state the run dir
cannot provide):

1. **Plain subcommands** (scriptable, agent-facing): status, recap ("since
   you left" digest with findings trend), decide, events. Non-TTY safe.
   firstmate and scripts consume these.
2. **The TUI** (human-facing, Ink/React):
   - `combo-chen` anywhere = the home. Idempotent single instance: ensure
     tmux session combo-chen-home exists with the TUI, then switch/attach.
     Machine-wide (run registry is global in ~/.combo-chen).
   - Home = fleet view: capsules sorted needs-you-first, filter tabs
     live/parked/closed, per-row detail line (live actor + round only;
     findings and history live in the dive-in). Empty states are first-class: a doctor +
     onboarding screen when no combos exist; a proud "all quiet, nothing
     needs you" with recent exit summaries when idle.
   - Dive-in = the combo as a thread (the local conversation v1 moved off
     GitHub, rendered back): chronological actor turns, findings inline
     under each verdict with severity and file:line, escalations and human
     decisions as thread entries, live actor last with activity indicator
     and next-event projection. Phases as a one-line breadcrumb.
   - Enter jumps to the live actor's tmux window (switch-client inside
     tmux, suspend+attach outside; prefix-B bound in capsule sessions to
     return). The TUI moves the client only; it never sends keys or reads
     panes.
   - Decision cards as modal over any view.
3. **Glance pane** (v1.1): `combo-chen glance --watch`, a mole-style ambient
   colored pane to park in tmux: fleet health number, per-capsule section
   with threshold-colored gauges (findings convergence), round train, zero
   interaction. Capsule tmux sessions get a status-right one-liner via
   `combo-chen glance --one-line -n <id>`.

## 9. External configuration changes

- CodeRabbit: auto-review on push, majors and criticals only (repo
  .coderabbit.yaml). No more @coderabbitai request comments from agents (v0
  bug class: hallucinated full-review requests, duplicate requests,
  incremental-skip confusion).
- reviewerLogins and GitHub-login-pinned LGTM die. Reviewer identity lives in
  the verdict artifact. Trust boundary is the run dir filesystem.
- Labels projection simplifies (state changes are fewer and monotonic:
  working -> ready -> merged; no churn).

## 10. Out of scope for v1 (deferred to v1.x)

- Treehouse-optional mode (bring-your-own worktrees) and forge connectors
  (GitLab etc.). The layering decision is made; implementation deferred.
- Glance pane (v1.1), fuzzy-jump, launch picker in home ([n] can open docs
  first).
- Slop-lint ruleset expansion (pruning rounds discipline continues as is).
- Second reviewer. If reintroduced, only conditional and with hard isolation
  (no access to the first review; v0 showed verbatim anchoring).

## 11. Breaking changes from v0

- READY contract: local lgtm + patch-id carry-over replaces GitHub-login
  LGTM; reviewer never writes to GitHub.
- coder_done no longer requires gnhf iteration JSONL.
- runner.sh, shell templates, gatekeeper script files, window.log/.done
  markers: removed.
- Journal gains local_review_requested, local_verdict, decision, follow-ups
  events; schema_version added to contract artifacts.
- Config: role commands unify under [roles.*]; reviewerLogins removed.

## 12. Delivery plan

Behind a `local_review` flag so v0 behavior survives mid-migration:

- **PR1 - capsule core**: `combo-chen capsule` subcommand (replaces
  runner.sh), harness-neutral coder_done, gate-on-demand as in-process call.
  Flag off = current behavior via new code path.
- **PR2 - the loop**: local review loop (verdict files, V-C-V invariant,
  no-progress guard, journal events), reviewer prompt with critical-surfaces
  calibration and follow-ups block.
- **PR3 - the contract flip**: flag on by default. New READY, reviewer stops
  posting to GitHub, CodeRabbit majors-only routing, PR body dossier
  projection, label simplification, shell templates deleted.

UI ships incrementally alongside (subcommands first, TUI after PR2; the TUI
renders v0 journals too, so it can ship early).

Each PR passes the standard validation set and its own e2e coverage; PRs
exceed the 1000-line slicing gate with a recorded exception and a
module-by-module review plan.

## 13. Open questions

- Round cap as a safety net on top of the no-progress guard, or guard only.
- Retention policy numbers for tier-3 artifacts (days? prune command only?).
- Auto-merge opt-in shape (config key, per-combo flag, or label).
- Reviewer command default (claude with which skill packaging) and whether
  the review prompt ships in-repo as a versioned template.
- Whether `combo-chen capsule` also hosts the post-publish loop (CodeRabbit
  rounds) or that stays in director-watch.
