# Field notes — Kun Chen interview (yt 88B6DimMD2g)

What the author of the stack says about his own workflow, distilled to what
shapes combo-chen. Each note: his claim → our consequence.

## 1. Planning is the human phase; plan quality buys autonomous runtime
"How much time we invest in the planning phase affects how long agents can
run autonomously. Short prompt → agent stops quickly. Spec with a measurable
goal → agents can experiment for a long time."

→ **The issue IS the combo's spec.** A combo over a one-liner issue will
stall and burn babysitting. Consequence: `combo-chen preflight --issue`
grades the issue (requirements? acceptance criteria? measurable goal?) and
warns before launch. Cheap, high leverage.

## 2. Fresh context for review is empirically better — not a style choice
"Reviewing in the same session, the agent is biased into believing what was
done was correct — it saw every step. With a fresh context window you catch
a lot more edge cases. I parallel-tested myself against the agents until I
never caught anything the agents didn't."

→ Validates `reviewer != coder` as an empirical rule, not politics. And
sharpens the thread-sitter design: **resumed context is for WRITING
(addressing with intent memory), fresh context is for JUDGING (reviewing
without bias).** Same PR, both modes, never confused.

## 3. no-mistakes findings split: auto-fix vs escalate-and-pause
"Obvious bugs it just auto-fixes without bothering me. When fixing has
product implications, it pauses and asks me."

→ The thread-sitter needs the same two-bucket policy for review comments:
mechanical addresses (rename, guard, doc) are handled and answered
autonomously; intent-touching comments escalate to the human and the combo
pauses that thread. Added to spec §4.

## 4. Status surfacing: see where you're needed without attaching
"I just look at the terminal screen to see what phase each pipeline is at.
If it's waiting for me to make a judgment, the status changes."
"It's like overseeing a very large scope — things escalate to you and you
jump where you're needed most."

→ The director's product surface is exactly this: tmux window titles and
`combo-chen status` must say per combo: phase + NEEDS-HUMAN or cruising.
Five combos = five status lines, zero attaching until escalation.

## 5. Risk assessment routes human attention
"Low risk change: I don't even open the diff, I merge. Medium/high risk:
I go into the diff myself."

→ no-mistakes already emits a risk assessment in the PR body. The
counterfactual log (spec §6) should key on it: automerge trust is earned
PER RISK TIER, low-risk first. Free data, already produced.

## 6. Validation evidence as artifacts
"The test phase presents evidence — screenshots, sometimes video — so I can
look at the artifact and see it's actually working."

→ The READY report links evidence (gate's test artifacts, CI runs), not
just green booleans. Humans merge on evidence, not on checkmarks.

## 7. Not every change deserves the heavy pipeline
"I run no-mistakes on most changes but not every single one — a simple doc
update doesn't justify heavy validation, and it uses my tokens."

→ combo-chen is for issue-sized work. Anti-scope-creep: no `combo-chen` for
typo fixes; that's what direct sessions are for.

## 8. The repo's AGENTS.md is the testing brain, not combo-chen
"In each project's AGENTS.md I have instructions for how to perform tests —
especially end-to-end. Agents by default write shallow unit tests."

→ combo-chen NEVER carries testing knowledge; it inherits the target repo's
AGENTS.md. Preflight may warn when the target repo lacks testing
instructions (predictor of weak validation).

## 9. Protect the director's context window
"I use subagents to avoid blowing up the main session's context — carve out
investigations, get conclusions back."

→ The director consumes EVENTS, never logs. Deep dives (why did the coder
stall?) go to a subagent/fresh session that reports a conclusion.

## 10. Economics: exhaust the subscription, stay out of the loop
"Most of us have subscriptions — make the most out of them. Using more
tokens and more parallel agents forces you to move yourself out of the
loop." (20-40 PRs/day, ~5 sessions, 20-30 agents running.)

→ Validates the 24/7-within-rate-limits stance and the multi-budget role
spread. The bottleneck to design against is HUMAN attention (escalations),
not tokens.
