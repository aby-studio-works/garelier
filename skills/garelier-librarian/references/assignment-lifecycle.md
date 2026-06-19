# Librarian reference: assignment lifecycle (state machine, receive, work, escalate, review)

Detail for `garelier-librarian` §4–§8 and the MUST BLOCK invariant. Covers
the per-assignment flow from receiving an `assignment.md` through reporting,
escalation, and Dock review/merge. The SKILL keeps the role identity,
boundaries, and routing; the step-by-step procedure lives here.

## State machine

Librarian uses the Worker-like flow with `shelf` branches:

```text
IDLE -> ASSIGNED -> WORKING -> REPORTING -> REVIEWING -> MERGED -> IDLE
                      |  ^                  |
                      |  +---- REWORK ------+
                      |
                      +-> BLOCKED -> WORKING
```

`ABORTED` is reachable from any state when `abort.md` appears.

Use the canonical `STATE.md` headers from
`../../garelier-core/templates/state.md`.

## Receiving an assignment

When `assignment.md` appears (shape:
`../templates/librarian_assignment.md`):

1. Read it fully, including the Source section (`source_id`,
   `source_type`, path/url) and Target files.
2. If it references a source, confirm that source is registered in
   `source_registry.toml`. If not, BLOCK (escalation, below) or propose a
   registry addition — do not silently adopt it.
3. Reset to current studio and create the shelf branch:

   ```bash
   git checkout --detach garelier/<target-slug>/<pm_id>/studio
   git reset --hard HEAD
   git checkout -b garelier/<target-slug>/<pm_id>/shelf/#<id>/<slug>
   ```

4. Update `STATE.md` to `WORKING`; notify Dock via
   `runtime/dock/inbox/`.

## Working on the shelf branch

Follow the matching reference (`source-sync.md` for sync,
`registries-and-runbooks.md` for routines). In short:

- **Sync:** fetch the registered source → transform to internal Markdown
  with project augmentation → stamp provenance front matter → update the
  source's `last_synced_at` in `source_registry.toml`. Never overwrite
  good content with stale data on a fetch failure (escalation, below).
- **Routine:** write/update the runbook + manual, register it in
  `routine_registry.toml` with a `default_role`, at a granularity that a
  future run can follow without re-deriving it.

Commit incrementally. Keep registry entries and the Markdown they point at
consistent (same `source_id` / `routine_id`).

Write `report.md` (`../templates/librarian_report.md`) with source mapping,
updated files, registry updates, runbooks/manuals touched, the completion
coverage list, and notes. Then transition to `REPORTING` and notify
Dock. In driver mode, `REPORTING`/`REVIEWING` are marker-waiting
states.

Also write sibling `report.json` from
`../../garelier-core/templates/report.json`. Keep it compact for Dock
routing/status; do not duplicate the Markdown body.

## Escalation (BLOCKED)

Transition to `BLOCKED` and write `questions.md` when:

- A source is unregistered and you cannot confirm it is authoritative.
- A source fetch fails (do **not** update internal docs with stale data —
  record the failure and escalate).
- A registry conflict appears (duplicate `source_id` / `routine_id`) you
  cannot resolve without losing information.
- Reflecting the source would require changing a rule's meaning.
- A security/license/copyright/provenance decision is undecided.

## Review and merge

`review.md` → REWORK on the same shelf branch (Dock's **Librarian
Review** checks provenance, registry consistency, runbook reusability, no
meaning change, no code). `merged.md` → MERGED → archive → reset worktree
to detached studio → IDLE, notify Dock. This mirrors
`garelier-smith` §8.

## MUST BLOCK IF

Stop and escalate if:

- the source is not registered (no free / unregistered sources)
- the source content conflicts with an existing internal rule
- the transformation would change the meaning of the source
- the source's rights basis is unknown or not adoptable for the requested use
- provenance cannot be stamped
- a fetch fails (never overwrite with stale content)
