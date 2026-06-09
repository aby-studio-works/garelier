# Compact Handoff

Garelier always uses compact handoff for role-to-role state. The goal is
lower context cost without losing operational facts.

## Scope

Applies by default to (these `_<role>/<id>/` paths are in-project by default; when
exile is opted in they resolve to a machine-local home outside the project — the
compact-handoff rule applies wherever the file resolves, DEC-036):

- `__garelier/<pm_id>/runtime/manifest.md`
- `__garelier/<pm_id>/runtime/*/inbox/*.md`
- `__garelier/<pm_id>/_workers/<id>/assignment.md`
- `__garelier/<pm_id>/_workers/<id>/report.md`
- `__garelier/<pm_id>/_workers/<id>/questions.md`
- `__garelier/<pm_id>/_scouts/<id>/assignment.md`
- `__garelier/<pm_id>/_scouts/<id>/questions.md`
- `__garelier/<pm_id>/_smiths/<id>/assignment.md`
- `__garelier/<pm_id>/_smiths/<id>/report.md`
- `__garelier/<pm_id>/_smiths/<id>/questions.md`
- `__garelier/<pm_id>/_librarians/<id>/assignment.md`
- `__garelier/<pm_id>/_librarians/<id>/report.md`
- `__garelier/<pm_id>/_librarians/<id>/questions.md`
- `__garelier/<pm_id>/_artisan/assignment.md`
- `__garelier/<pm_id>/_artisan/report.md`
- `__garelier/<pm_id>/_artisan/questions.md`
- `__garelier/<pm_id>/_artisan/checkpoint.md`
- `STATE.md`, `review.md`, `answers.md`, `under_review.md`, `merged.md`
- runtime backlog and phase breakdown files

Does not automatically rewrite:

- User-facing replies.
- Public documentation written for humans.
- Source code, shell commands, error messages, paths, identifiers.
- Data-change evidence where exact output matters.
- Security, legal, accounting, or production-write warnings when
  compression would make order or responsibility ambiguous.

## Rules

- One fact per line.
- Prefer pointers over pasted context: `path:line`, task id, commit SHA,
  report path.
- **Never paste an artifact body** — a diff, a full report, a blueprint,
  an inspection, an Observer report, or a `result.json` — into a handoff
  or inbox file. Carry the conclusion (verdict / result / one-line
  outcome) plus a `read:` pointer; the body stays in its official file.
  Embedding a body both wastes tokens (every reader re-ingests it) and
  creates a second, non-authoritative copy. The official file is the
  single source of truth; the handoff only points at it.
- Keep canonical terms exact: `target`, `studio`, `workbench`, `anvil`,
  `satchel`, `shelf`, `blueprint`, `inspection`, `promote`, `control`,
  `runtime`, `lane`.
- Keep code symbols, paths, commands, URLs, error text, numbers, dates,
  and commit SHAs exact.
- Remove narrative, praise, apology, process diary, and rationale not
  needed for the next role's decision.
- Use bounded lists. If more than 10 items, group by area and point to
  the full source.
- Expand only the lines where ambiguity would cause wrong action.
- Never compress by hiding risk. If a risk exists, name it directly.

## Preferred Shapes

### Assignment

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

### Completion Report

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

### Inbox Notification

```text
from/to: <sender> -> <recipient>
type: <state|question|escalation|status|request|schedule>
task: #<id> | N/A
read: <path>
ask: <single requested action>
urgency: low|normal|high
```

### Manifest Activity

```text
<timestamp> -- <actor> -- <verb> #<id> -- <state/result>
```

## Review Rule

The receiver must be able to act after reading the compact file plus the
referenced source files. If not, the handoff is too compressed.

## Reading Rule

Read by role, not by habit — this is where the token savings are realized:

- A **supervisory** reader (PM, Dock) acts on the compact note's
  conclusion + pointer and opens the referenced artifact **only when the
  decision needs its content** — a verdict is enough to route or escalate;
  the diff is opened only to actually re-review.
- A **doer** reader (Worker, Smith, Artisan, Librarian, Observer) opens
  exactly the artifacts its current task requires (its `assignment`, the
  diff it must review, the `review.md` it must address) — not unrelated
  history.
- Act on the **current** handoff; do not re-read already-consumed or
  archived handoffs.
