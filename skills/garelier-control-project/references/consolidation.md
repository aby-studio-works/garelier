# Control Consolidation

Consolidation combines durable management authority from multiple control
namespaces into one destination namespace. The destination may be a new
`pm_id`, an existing full/control-only id, or `_workshop`.

It does **not** combine or retire full-Garelier runtime, roles, worktrees,
branches, lane locks, or setup configurations. Those remain owned by their
source PMs until a separate, explicitly approved operational migration.

## Safety model

1. Require the user to name every source `pm_id` and the destination `pm_id`.
2. Preserve every source namespace unchanged.
3. Run the consolidation helper without `-Apply` / `--apply` first.
4. Apply only to stage source snapshots and a collision report under the
   destination's gitignored `runtime/import/consolidation/<batch>/`.
5. Treat the destination's existing `control/` as the base authority.
6. Normalize semantics into `drafts/`; never copy conflicting hot files or
   canonical records directly over the destination.
7. Ask the user to resolve incompatible decisions, policies, ownership, or
   milestone intent. Do not guess.
8. Promote reviewed results into destination `control/`, validate the graph,
   and commit one coherent consolidation outcome.

## Stage

```bash
garelier control-consolidate \
  --project <root> \
  --from-pm-id pm-a,pm-b \
  --to-pm-id _workshop

garelier control-consolidate \
  --project <root> \
  --from-pm-id pm-a,pm-b \
  --to-pm-id _workshop \
  --apply
```

When the destination does not exist, apply initializes a canonical
`control_only` namespace. When the destination already exists, its mode and
curated files are preserved.

## Reconciliation rules

- Dashboard hot files: rebuild concise destination summaries from current
  truth; do not concatenate.
- Backlog/risks: retain only open items, deduplicate by outcome, and preserve a
  source pointer in the draft report.
- Milestones: keep separate unless their outcomes and success criteria are
  genuinely the same.
- Decisions: never silently merge incompatible decisions. Keep both with new
  destination IDs or record an owner-approved superseding decision.
- Operations/quality gates: destination policy wins until the owner explicitly
  approves a change.
- Blueprints/reports/inspections: preserve provenance and rename collisions
  deterministically.

After a successful control consolidation, source PMs may continue operating.
Collapsing full PM identities is a separate migration, not part of this skill.
