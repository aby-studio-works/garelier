# Compact Handoff

Garelier always uses compact handoff for role-to-role state. The goal is
lower context cost without losing operational facts.

## Scope

For schema v3, durable project-control handoff is deterministically derived
from Current, primary/ordered Checkpoints, referenced Backlog resume fields,
typed blockers/relations, Note sections, and Reports through the shared
ControlModel. `control session-open/context --resume` returns the bounded
packet. Current and Checkpoints remain tracked authority; do not replace them
with a parallel summary or copy artifact bodies.

Schema v1/v2 and unknown Control formats are rejected explicitly.

Applies by default to (these `_crew/<role>/<id>/` paths are in-project by default; when
exile is opted in they resolve to a machine-local home outside the project — the
compact-handoff rule applies wherever the file resolves, DEC-036):

- `__garelier/<pm_id>/runtime/manifest.md`
- `__garelier/<pm_id>/runtime/*/inbox/*.md`
- `__garelier/<pm_id>/_crew/workers/<id>/assignment.md`
- `__garelier/<pm_id>/_crew/workers/<id>/report.md`
- `__garelier/<pm_id>/_crew/workers/<id>/questions.md`
- `__garelier/<pm_id>/_crew/scouts/<id>/assignment.md`
- `__garelier/<pm_id>/_crew/scouts/<id>/questions.md`
- `__garelier/<pm_id>/_crew/smiths/<id>/assignment.md`
- `__garelier/<pm_id>/_crew/smiths/<id>/report.md`
- `__garelier/<pm_id>/_crew/smiths/<id>/questions.md`
- `__garelier/<pm_id>/_crew/librarians/<id>/assignment.md`
- `__garelier/<pm_id>/_crew/librarians/<id>/report.md`
- `__garelier/<pm_id>/_crew/librarians/<id>/questions.md`
- `__garelier/<pm_id>/_crew/artisan/assignment.md`
- `__garelier/<pm_id>/_crew/artisan/report.md`
- `__garelier/<pm_id>/_crew/artisan/questions.md`
- `__garelier/<pm_id>/_crew/artisan/checkpoint.md`
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
- For successful-land aftercare, hand off only `request_id`, authenticated journal
  pointer, terminal local state, `external_sync_pending`, and `physical_gc_pending`.
  The envelope cache is not authority. `container_retired` is logical: never infer
  physical cleanup from an absent worktree/branch or claim the retained container
  was moved/deleted by automatic aftercare. Point to the authenticated logical-
  retirement marker when another role needs to explain why retained coordination
  files are excluded from live dispatch/claim scans.
- Remove narrative, praise, apology, process diary, and rationale not
  needed for the next role's decision.
- Use bounded lists. If more than 10 items, group by area and point to
  the full source.
- Expand only the lines where ambiguity would cause wrong action.
- Never compress by hiding risk. If a risk exists, name it directly.
- A schema-v3 handoff flush updates the affected Backlog and Checkpoint, then
  Current only when global focus/order/blockers/baseline changed. Use
  `begin-action` before interruptible target work and `finish-action` before a
  different action or user reply. Shared/automated changes use the bound
  lifecycle transaction.

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

For a new schema-v3 session, read only Current, ordered Checkpoints, blockers,
and `read_set`, then expand referenced Backlogs and their nearby plan graph. Do
not scan the control tree. Before ending or replying while unfinished, flush
Backlog/Checkpoint/Current as applicable, run strict doctor and the relevant
gate, release claims, and close the session. Schema 3 follows the same bounded
pattern through its adapter.
