# W6d / W7d file-overlap waiver

The v1 migration audit for the W6d deletion sweep requested a zero-file-overlap
check against W7d (the TUI dive-in slice). The result is not zero; this note
records the single overlap explicitly so the audit can certify it as reviewed
and waived.

## The overlap

Exactly one path is touched by both slices:

```
src/app/lifecycle/lifecycle-handlers.ts
```

Computed as `comm -12` over the W7d changed paths (`00f0f79..b9f4387`, the
integration base range) and the W6d branch changed paths (`b9f4387..HEAD`).

## What each slice changed in that file

- **W7d** added the `DECISION_VERBS` export (single source of truth shared by
  the `decide` handler and the TUI decision-card fold) and the `decide`
  routing it anchors.
- **W6d** removed the retired v0 substrate from the same file: the watcher
  import, inline poll parsing for `events --follow`, the gate refresh call
  adaptation, and (in the continuation fix round) the dead `emitComboEvent`
  handler plus its `event-fields` helper module, which had no CLI caller after
  the hidden `emit` endpoint was deleted.

## Why the overlap is safe

- The hunks are disjoint: W6d never edits `DECISION_VERBS`,
  `decideComboEscalation`, or any line W7d introduced.
- W6d is rebased on top of the W7d integration base (`b9f4387`, which already
  contains W7d), so there is no merge race: `git merge-tree --write-tree`
  against `main-v1` reports no conflicts.
- The shared file is the lifecycle command adapter; both slices touching it is
  structural (W7d consumes the decision verbs it exposes, W6d deletes the v0
  handlers it hosted), not semantic coupling.

## Waiver

The literal zero-overlap constraint is waived for
`src/app/lifecycle/lifecycle-handlers.ts` on the grounds above. Any future
audit of the W6d branch should treat this documented single-file overlap as
the expected result.
