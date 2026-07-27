# slopslint tombstones

Tombstones are permanent incident records for duplication that was found and
removed. They preserve the pattern, cause, and prevention rule after the code
changes, so later contributors do not have to rediscover the lesson.

One record lives in each `T-*.yml` file. `bin/cb-slopslint.sh` validates every
record before scanning. A tombstone never suppresses a current finding:
combo-chen’s committed ceiling is zero, and any duplicate function body blocks
the PR.

Required schema:

```yaml
schema: 1
id: T-UPPERCASE-ID
status: resolved
category: duplication
title: "Short incident title"
created_at: YYYY-MM-DD
incident:
  commit: 40-lowercase-hex-commit
  pattern: >
    General duplication pattern.
  what_went_wrong: >
    Concrete incident.
  root_cause: >
    Why it escaped.
  rule_established: >
    Durable prevention rule.
```
