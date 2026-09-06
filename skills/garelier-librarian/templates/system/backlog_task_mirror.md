---
knowledge_id: system.backlog_task_mirror
title: Backlog → Task-List Mirror
category: system
status: active
owners:
  - pm
consumers:
  - pm
  - dock
source_ids:
  - project-original
last_reviewed_at: 2026-08-02
review_cycle: on-change
---

# Backlog → Task-List Mirror

Give the user a live, per-item view by mirroring canonical open Backlog/Work into
a provider Task surface when the current runtime exposes one. **Mirror-only** —
the schema-selected ControlModel remains authority; a provider Task list is a
session view (DEC-092). Provider names and historical tool names are examples,
not evidence that a mutation capability is present or absent.

## Mechanical engine — do not hand-craft it

The mirror is COMPUTED by a script, never hand-assembled. Run
`bun garelier-core/driver/src/dispatch/task_mirror.ts --pm-id <id> --project <root>`:

> **Scope (W-141) — default is the ACTIVE BAND, not the whole backlog.** DEC-092
> originally mirrored EVERY open row; on a large backlog (276 open rows measured
> 2026-07-18) that is 276 × TaskCreate and destroys the session. The default
> `--scope active` mirrors only the **active band** = in-flight `_crew/dispatch<N>`
> tasks + the schema-selected ControlModel's current/next projection
> (execution queue / next action / blocker), capped at `--max` (default 40);
> the JSON/ops output carries a `truncated` count when the band overflows the cap.
> `--scope all` restores the full-backlog mirror for a deliberate full sweep.
> Narrowing NEVER completes an out-of-band task — a Task is completed only when its
> id is gone from the WHOLE backlog (merged/removed), not merely outside the band.

- `--format markdown` → an agent-agnostic queue view for providers, humans, or a console;
- `--format ops --current <TaskList JSON>` → the minimal create / update / complete
  ops vs the current harness Task list, plus a `warn` op class and a top-level
  `foreign` count (W-027). An adapter whose runtime exposes provider Task
  mutation applies create/update/complete with that surface — the ONLY
  agent-side step, and it is judgment-free (the adapter does not decide content;
  it applies what the script computed). `warn`
  (`{op:"warn", reason:"completed_but_in_flight", taskId, dispatch}`) is
  non-destructive — surface it to the user, never call a Task tool for it; it
  means the Task list shows completed but `_crew/dispatch<dispatch>` is still actually
  running the item. `foreign` counts current Task-list entries that carry another
  project's own W-NNN id (e.g. a different repo's own backlog numbering on the
  same session Task list) — the mirror leaves them untouched rather than
  completing/overwriting them just because a number happened to collide;
- `--format json` → the raw derived model.
- `--sync-pending` (composable with any format; or `--format sync-pending`) →
regenerate `runtime/backlog/pending.md` FROM the schema-3 Backlog so the **Status
  Web** ACTIVE/FUTURE QUEUE shows the same open work as the Task mirror.
  `pending.md` is read ONLY by the status display (`buildQueue` / `dock_status`),
  never by dispatch, so regenerating it is display-only and safe.

The script reads ONLY canonical schema-3 sources — ControlModel Backlog and
Current plus live
`_crew/dispatch<N>` containers — and never guesses from prose. A runtime without a
provider Task mutation surface uses the markdown view. Thus **one computation
feeds all applicable surfaces** — provider Task operations, the Status Web queue
(`--sync-pending`), and the markdown view — and no agent hand-crafts the mirror.

## Provider apply and acknowledgement

Computing, displaying, logging, or emitting an operation is not a provider
mutation. The adapter acknowledges an operation only after it invokes the real
provider mutation and observes success in the returned object or a fresh
provider read. Until then, retain `external_sync_pending`; this is a normal
recoverable state, not permission to fabricate an acknowledgement. An adapter
without a callable mutation surface may render the desired operations but must
not ack them.

Apply each operation idempotently and bind its acknowledgement to the operation
identity and intended state. A provider error, timeout, rate limit, or ambiguous
response keeps the operation pending and records that outcome separately. Every
provider/subprocess call has a finite, operation-appropriate timeout; report a
timeout as a timeout, not as a control-state or code failure.

## When

When the PM works a backlog — a drain, an autonomous loop, or any multi-item
dispatch session. Skip it for a single-item session (not worth the setup).

## Display format (standard)

One Task per active-band backlog item (see Scope above; `--scope all` for all open items).

**Subject** (one scannable line): `<id>: <short title> [<class-head>]`

`<class-head>` is the LEADING token of the class (W-141): a prose status such as
`ready (2026-07-18 実測 3 回 — …)` shows as `[ready]`, not the whole note, so the
Task title stays scannable; the full status/class prose stays in the description.

`<class>` is the dispatchability — so the user reads the list and sees *why* an
item is or is not being auto-dispatched:

| class       | meaning                                                            |
| ----------- | ------------------------------------------------------------------ |
| `ready`     | bounded, dispatchable now (worker)                                 |
| `ready·tdd` | `ready` + test-discipline `tdd` (red→green expected)               |
| `blueprint` | needs a blueprint authored before dispatch                         |
| `design`    | needs Wanderer / DEC-076 design review before dispatch             |
| `verify`    | PM / Scout verification (not a code worker)                        |
| `run`       | needs a windowed RUN (PM; not headless-drainable)                  |
| `gated`     | blocked on a gate (engine-complete / explicit user decision)       |
| `idle`      | on-demand umbrella; not proactively drained                        |

The class is the Work `state`/dispatch classification, passed through faithfully — only the
generic `ready` is refined (to `ready·tdd` / `needs-blueprint` / `research`) from
the blueprint's Test discipline, blueprint presence, and item type. The script
never guesses a class from prose; a wrong class is fixed in the backlog `status`
(the canonical field), not in the mirror. The vocabulary is extensible — a PM who
sets an explicit gated/run/blueprint/design classification sees exactly that.

**Description** (fixed fields, in order):

```
Backlog: <id> · <type>/<priority>/<status>
Class: <class> — <one-line why>
Blueprint: <relative path or —>
Dispatch: <none | #<N> WORKING|REPORTING|BLOCKED | merged <sha>>
Notes: <test discipline / phase / prereqs>
```

**activeForm** (spinner when in_progress): `Draining <id> <short title>`

**Status mapping**:
- `pending` — not yet dispatched (incl. blueprint/design/verify/run/gated/idle that are not yet startable).
- `in_progress` — has a live `_crew/dispatch<N>`, OR is actively being worked (e.g. the PM is authoring its blueprint).
- `completed` — merged AND removed from the backlog.

A role's automatic completion notification changes none of these statuses
by itself. Report acceptance, proxy/local commit, Guardian/Observer review,
formal gate, exact `studio` merge, and land aftercare are separate states with
separate artifacts. The mirror derives its desired Task state only from the
canonical control/runtime state named above, then records provider apply
separately.

## Refresh timing (self-healing — never rely on remembering every update)

The mirror is a **DERIVED view**, re-synced from canonical state at defined
anchors, so a forgotten event-update is corrected at the next refresh — drift
cannot accumulate silently.

**Truth sources** (what the mirror is re-derived from):
- open Backlog/Work from the schema-selected ControlModel,
- in-flight roles `__garelier/<pm_id>/_crew/dispatch<N>/STATE.md` (WORKING / REPORTING / BLOCKED),
- done = item removed from the backlog (its work merged to studio).

**Refresh anchors** (when to reconcile the Task list to the derived truth):
1. **Initial** — at the start of backlog work (build the mirror).
2. **Event** — on dispatch (→ `in_progress`), on merge + backlog-removal (→ `completed`), on BLOCKED/parked (annotate `Dispatch:` + keep `in_progress`).
3. **Periodic re-sync (the drift backstop)** — re-derive and reconcile at each of:
   - every dispatch-loop iteration boundary (before selecting the next item),
   - **any user status query** ("現在の状態 / 順調?" / "what's running") — re-sync *then* report, so the user always sees current truth,
   - after every merge,
   - on session resume / after context compaction (state may have advanced while away).

**Reconciliation rule** (mechanical, drift-proof — this is what makes forgotten
updates self-correct):
- for each OPEN backlog item: ensure a Task exists (create if missing); set
  `in_progress` iff it has a live `_crew/dispatch<N>`, else `pending`; refresh its
  `Dispatch:`/`Class:` fields;
- for each Task whose item is **no longer in the backlog**: set `completed`;
- for each **new** backlog item: create a `pending` Task.

Mechanically, every refresh is just: run `task_mirror.ts --format ops --current
<TaskList JSON>` and apply the ops it returns when a real provider mutation
surface exists (or read `--format markdown`). Verify mutation before ack as
specified above. The reconciliation is event- and anchor-driven; do not poll a
provider Task list merely to reconfirm an automatic child-completion event.

## Boundary

Schema-3 Control is canonical; the Task list is a session view. Never
edit a Task in place of an authorized Control transaction, and never treat the
Task list as the source of truth. If a view disagrees, schema-3 Control wins and the mirror is
re-synced.

Generalized framework knowledge, Librarian-maintained under PM approval.
