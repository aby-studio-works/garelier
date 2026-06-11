# Garelier Dock State and Escalation Reference

Backlog, manifest, escalation, templates, and autonomous per-iteration invocation.

Extracted from the previous role `SKILL.md`; legacy section numbers are intentionally preserved for cross-references.

## §9. Backlog management

`__garelier/<pm_id>/runtime/backlog/` structure:

```
__garelier/<pm_id>/runtime/backlog/
├── pending.md          Assignments waiting for IDLE agents
├── in_flight.md        GENERATED view of currently executing work (W-011,
│                       DEC-064 §3 — rewritten by dispatch_event.{sh,ps1}
│                       from the live _dispatch<N> containers; never hand-edit)
├── next_id             Single integer for the next task ID
├── done/               Archived assignment + report pairs
│   └── <task_id>-<slug>.md
├── archive/            Compacted old done entries
│   └── YYYY-MM.md
├── requeued/           PM-created WIP audit for retire-and-requeue
│   └── <timestamp>-<task_id>-<agent_id>/
└── <blueprint_slug>_phases.md   Phase breakdown documents (one per blueprint)
```

`pending.md` is a list of assignments that couldn't be dispatched
(no IDLE agent of the required role, blocked on a dependency, or
returned by PM's retire-and-requeue workflow).

When Smith hardening is needed but all Smiths are busy, keep a single
coalesced Smith batch in `pending.md` instead of blocking Worker merges.
Append new eligible Worker merge ids / merge SHAs to that batch until a
Smith becomes IDLE. When dispatching the Smith, freeze the batch's
coverage as `studio_base_commit` → `studio_tip_at_dispatch`; later Worker
merges remain eligible and start the next batch.

Use this compact, parseable form for a pending Smith batch:

```text
- [P2 normal] #<smith_task_id> smith-hardening-batch
  role: smith
  smith_window: <studio_base_commit>..<pending_or_studio_tip>
  smith_targets: #<worker_task_id>@<merge_sha> #<worker_task_id>@<merge_sha>
  smith_focus: integration|release|policy|spec|mixed
  promote_gate: required
```

`smith_targets` is load-bearing: `status.{sh,ps1}` counts these tokens
to show remaining Smith hardening targets. When a Smith is dispatched,
copy the same token list to `assignment.md` as `Covered Worker merges`.
If PM/user explicitly waives remaining Smith work, set
`promote_gate: waived <history_or_resolution_ref>` and remove the waived
targets from the remaining count only after recording that waiver.

Only when a Worker assignment is explicitly blocked by Smith hardening,
keep the Worker row in `pending.md` with a compact
`blocked_on: smith #<task_id> <reason>` line. Re-check it whenever the
referenced Smith task reaches MERGED, REWORK, BLOCKED, or ABORTED.

When a Worker, Scout, or Smith becomes IDLE, scan `pending.md` for the oldest
assignment matching that role and dispatch it (move from `pending.md` to
`<container>/assignment.md`; record the dispatch with
`dispatch_event.{sh,ps1} --kind start` — it appends the event and regenerates
the `in_flight.md` view; never hand-edit it). The role's container is
`__garelier/<pm_id>/_<role>/<id>/` for the default **in-project** layout
(DEC-036) — write there; ONLY when **exile** is opted in resolve it from
`__garelier/<pm_id>/runtime/workspace_paths`
(`<role-singular>.<id>=<absolute container>`), falling back to the in-project
path when absent — see `references/main-loop-and-routing.md` §4.3 step 6.
If the pending row already has a task id because PM requeued an
in-flight assignment, reuse that id. Do not allocate a new `next_id`
value for requeued work.

When an assignment completes (merged for Worker/Smith, accepted inspection
for Scout), archive it to `done/<task_id>-<slug>.md` along with the final
report and record it with `dispatch_event.{sh,ps1} --kind complete` (the
`in_flight.md` view drops the row automatically when the producer's
container/STATE goes away).

### §9.1 Runtime backlog retention

Apply `garelier-core/retention.md` after ordinary backlog updates, not
before active work:

1. Read `[retention]` from `_pm/setup_config.toml` or use defaults.
2. If `runtime/backlog/done/` exceeds `runtime_archive_keep_files` or
   contains files older than `runtime_archive_keep_days`, compact old
   done entries into `runtime/backlog/archive/YYYY-MM.md`.
3. Remove only the old individual files that were copied into the
   archive. Never remove `pending.md`, `in_flight.md`, active inbox
   files, merge-gate locks, or agent STATE files.
4. Add one compact manifest activity line:
   `<timestamp> -- Dock -- retained backlog -- archived N old done entries`.

`next_id` is a simple counter. Read, increment, write back. Two
Dock invocations should not happen simultaneously (only one
Dock per project), but if they do, the counter file may need
locking. For v2.0, no locking — assume serial Dock sessions.

## §10. Manifest updates

`__garelier/<pm_id>/runtime/manifest.md` is the live runtime index. Update
it after every action that changes state:

- Worker, Scout, or Smith state transition
- Assignment dispatched
- Blueprint moved from inactive to active
- Phase completed
- Escalation opened or resolved
- Base-tracking merge run (note clean / resolved-conflicts in
  Recent activity)
- Promote shipped (PM updates this for studio → target merges,
  but you reflect it in the milestone status)

The manifest is the file PM reads to know "what is happening right
now." Keep it current. Stale manifests cause PM to make bad decisions.
Keep the Recent activity section to the template's last 10 events; move
older detail to backlog done/archive or PM-owned reports.

This file is the **runtime manifest**, not a project dashboard. The
project dashboard is `__garelier/<pm_id>/control/project_dashboard/`, owned
by PM.

Use `../../garelier-core/templates/manifest.md` as the
structural reference. Do not invent new sections.

In `## Backlog summary`, keep `Smith hardening targets remaining` current.
It is the operator-facing capacity signal: `remaining = pending + active`,
where pending comes from queued `smith_targets` in `pending.md` and active
comes from Smith `assignment.md` coverage lists. A non-zero value means PM
must not present the slice as promote-ready unless a user waiver is
recorded.

### §10.1 Recent activity entries — compact form (LOAD-BEARING)

Each entry MUST be **a single line, ≤ 150 characters**. This is a
hard ceiling, not guidance. The status helper truncates at 160
chars; longer entries become unreadable narratives. The manifest is
a runtime index, not a journal — full reasoning belongs in
`_pm/history.md`, blueprint notes, or `archive/<task_id>/report.md`.

Format:
```
<ISO timestamp> -- <actor> -- <verb> #<id> [<extra ≤ 80 chars>]
```

`<verb>` is one of: `dispatched`, `merged`, `failed`, `conflict`,
`aborted`, `requeued`, `review_pass`, `review_fail`, `assigned`,
`escalated`, `closed`, `iter` (no-action), `base-track`.

**Good (in spec):**
```
- 2026-05-27T07:00:00Z -- Dock -- dispatched #9 merge_request seq=8
- 2026-05-27T04:30:00Z -- Dock -- merged #24 → 5819fb4c (1464s, 7 gate ✅)
- 2026-05-27T04:00:00Z -- Dock -- review_pass #9 (4/4 AC ✅, dispatch deferred post #24)
- 2026-05-26T23:15:00Z -- worker-02 -- REPORTING → MERGED via merged.md
- 2026-05-26T22:50:00Z -- Dock -- iter (no action: inbox ∅, results ∅)
```

**Bad (out of spec — never write):**
```
- 2026-05-27T07:00:00Z -- Dock -- iteration: §8.1.A async merge gate
  dispatch for #9 (worker-02 drift resync REPORTING 06:30Z): drift gate
  verify pass (workbench 926f4c85..studio 5819fb4c = 0 commit = studio
  fully in workbench; studio..workbench = 8 commit ... [continues 2500+
  chars with full reasoning, file paths, ge verbose tracebacks]
```

If you need to record the full reasoning, write it where it
belongs: `under_review.md` / `review.md` / `merged.md` for
per-task detail; PM inbox escalation for cross-task concerns;
`_pm/history.md` for autopilot audit (PM writes this, not you).

### §10.2 Retention — Recent activity stays small

Keep at most **10 entries** in `## Recent activity`. When you add an
11th, remove the oldest (don't archive — it was already low-value
narrative; the per-task `done/`, `merged.md`, `report.md`,
`history.md` carry the real audit trail).

## §11. Escalation to PM

When you cannot resolve an issue from existing context, escalate.

### §11.1 When to escalate

- Blueprint has internal contradictions or ambiguous acceptance
  criteria.
- Blueprint depends on a decision that the user hasn't made (Open
  questions in blueprint are unresolved).
- A Worker, Scout, or Smith is BLOCKED with a question that requires user
  judgment.
- Quality gate fails repeatedly with no clear cause.
- Two blueprints request conflicting changes to the same file.
- Resource exhaustion (no Worker available for an urgent assignment).
- Base-tracking conflict where the resolution is genuinely ambiguous
  from blueprint and code context (§8.0 abort path).
- Data-change guards missing or incomplete on a blueprint that
  appears to mutate external data.

### §11.2 How to escalate

1. Generate an escalation ID: `ESC-<YYYYMMDD>-<NNN>` where NNN is a
   3-digit counter.
2. Write the escalation file to
   `__garelier/<pm_id>/runtime/dock/escalation/ESC-<...>.md` using
   `../../garelier-core/templates/escalation.md`. Include:
   - Symptom (what you observed)
   - Context (which blueprint, which agent, what they were doing)
   - What you tried (so PM doesn't suggest the same thing)
   - Suggested resolutions (your best guesses, ordered by preference)
3. Notify PM by writing to
   `__garelier/<pm_id>/runtime/pm/inbox/<YYYYMMDD-HHMMSS>-dock-<topic>.md`
   with a one-paragraph summary and a link to the escalation file.
4. If the escalation is blocking active work, note that in the inbox
   message ("blocking Worker worker-01, started 14:00").
5. Wait. Do not proceed past the blocking item until PM responds.

### §11.3 Receiving resolutions

When `__garelier/<pm_id>/runtime/pm/resolutions/ESC-<...>.md` appears:

1. Read it.
2. Apply the resolution: update the relevant assignment, send a note
   to the affected Worker/Scout/Smith via their inbox marker, etc.
3. Move the escalation to
   `__garelier/<pm_id>/runtime/dock/escalation-archive/`.
4. Update manifest to clear the open escalation.

### §11.4 Periodic status summaries

Even without escalations, write a status summary to
`__garelier/<pm_id>/runtime/pm/inbox/<YYYYMMDD-HHMMSS>-dock-status.md`
using `templates/status_summary.md` whenever:

- A milestone completes or its scope changes
- A phase completes
- A long-running Worker/Smith has been BLOCKED for more than ~24 hours
- Multiple parallel assignments completed in a batch
- A base-tracking conflict required notable resolution

PM reads these between user sessions to stay informed. Do not write
them so frequently that they become noise.

Status summaries are compact: counts first, exceptions second, no
chronological diary. Link detailed reports instead of duplicating them.

## §12. Templates

| File                       | Source                              | Used for          |
| -------------------------- | ----------------------------------- | ----------------- |
| `assignment.md`            | garelier-core                      | Dispatching work  |
| `manifest.md`              | garelier-core                      | Runtime index     |
| `status_summary.md`        | garelier-core                      | PM status report  |
| `escalation.md`            | garelier-core                      | Escalation file   |
| `inbox_notification.md`    | garelier-core                      | (read from agents) |
| `phase_breakdown.md`       | garelier-dock                 | Phase decomposition record |
| `review.md`                | garelier-dock                 | Worker review feedback |

When generating any of these, copy the template and fill placeholders.
Never invent the format.

## §12.5 Per-iteration invocation (autonomous mode)

When `__garelier/<pm_id>/_pm/setup_config.toml` has
`[autonomy] enabled = true`, Dock is invoked by the dispatch loop as
a fresh configured-provider process (`claude -p` or `codex exec`)
**every poll interval**. Each invocation runs one iteration of the §3
main loop and exits. There is no long-lived Dock session in
autonomous mode — context is recovered from files on every cold start.

Implication for your behavior:

- **Do not poll inside your iteration.** The orchestrator loop re-invokes you; you
  respond to the current state in one pass.
- **Trust the files.** You don't carry state between invocations.
  Re-read `runtime/manifest.md`, `STATE.md` files, and pending inbox /
  resolutions every time.
- **Exit promptly when there's nothing to do.** If the main loop
  finds no inbox items, no state transitions, no new blueprints, and
  no manifest staleness, do not write filler — just stop. The loop
  will invoke you again next interval.
- **Don't try to be clever about context windows.** No `/compact`,
  no `/clear`, no session-level lifecycle. Each invocation is
  bounded by the work needed for one iteration.

When `[autonomy] enabled = false`, Dock is started by the user
in a terminal as in v1.0, and your loop is driven by the user
nudging the session forward.
