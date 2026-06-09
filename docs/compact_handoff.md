# Compact Handoff

> Operational source: `skills/garelier-core/compact_handoff.md`. This file is
> the human-readable explanation. Keep both in sync.

Garelier always uses compact handoff for internal role-to-role state.
This reduces repeated context load while preserving the facts needed for
PM, Dock, Worker, Scout, Smith, Artisan, Librarian, and Observer
decisions.

## Scope

Compact handoff applies to runtime state, inbox notifications,
assignments, reports, questions, answers, reviews, manifest activity,
and backlog handoff files.

It does not automatically rewrite user-facing replies, public docs,
source code, shell commands, error messages, identifiers, URLs, paths,
data-change evidence, or warnings where compression would create
ambiguity.

## Rules

- One fact per line.
- Prefer references over pasted context: `path:line`, task id, commit
  SHA, report path.
- **Never paste an artifact body** (a diff, a full report, a blueprint,
  an inspection, an Observer report, a `result.json`) into a handoff or
  inbox file. Carry the conclusion + a `read:` pointer; the body stays in
  its official file. Embedding a body wastes tokens (every reader
  re-ingests it) and makes a second, non-authoritative copy.
- Keep canonical terms exact: `target`, `studio`, `workbench`, `anvil`,
  `blueprint`, `inspection`, `promote`, `control`, `runtime`.
- Keep code symbols, paths, commands, URLs, error text, numbers, dates,
  and commit SHAs exact.
- Remove process diary, praise, apology, and rationale the next role
  does not need.
- Expand only where compression would change action, risk, order, or
  responsibility.
- Never hide risk to save tokens.

## Preferred Shapes

Assignment:

```text
goal: <one outcome>
read:
- <path> (<section or lines>)
do:
- <action>
AC:
- [ ] <checkable criterion>
stop:
- <condition requiring BLOCKED>
out:
- <expected file/commit/report>
```

Report:

```text
result: <one-line outcome>
diff:
- <path> -- <effect>
AC:
- [x] <criterion> -- <evidence>
QG:
- `<command>` -- pass|fail -- <short evidence>
risks:
- none | <remaining risk>
next:
- none | <follow-up>
```

Inbox:

```text
from/to: <sender> -> <recipient>
type: <state|question|escalation|status|request|schedule>
task: #<id> | N/A
read: <path>
ask: <single requested action>
urgency: low|normal|high
```

Receiver test: the next role must be able to act after reading the
compact handoff plus referenced source files.

Reading rule (where the savings are realized): a supervisory reader
(PM, Dock) acts on the conclusion + pointer and opens the referenced
artifact only when the decision needs its content; a doer reader opens
only the artifacts its current task requires; act on the current handoff,
not already-consumed ones.
