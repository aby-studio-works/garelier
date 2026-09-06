# Control Consolidation

Consolidation combines durable management authority from multiple control
namespaces into one destination namespace. The destination may be a new
`pm_id`, an id whose control.toml mode is `full` or `control_only`, or `_workshop`.

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
   canonical records directly over the destination. Schema-v3 shared/automated
   multi-file changes use a revision-checked control transaction.
7. Ask the user to resolve incompatible decisions, policies, ownership, or
   milestone intent. Do not guess.
8. Promote reviewed results through the destination CLI transaction, strict
   reload the resulting ControlModel, validate the graph, and commit one
   coherent consolidation outcome.

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

`--apply` is staging-only. Whether or not the destination `control/` exists, it
writes only source snapshots and reports under the destination pm_id's
gitignored `runtime/import/consolidation/<batch>/`; it never initializes or
writes the destination `control/`.

## Reconciliation rules

Schema v3 planning loads each source through ControlModel and compares typed
references, Markdown/body hashes, immutable relation identities, lifecycle
paths, archive/tombstone state, and curated Dashboard regions. Current is
reconstructed from reviewed Checkpoints; Notes are preserved and linked, never
concatenated then deleted. Multiple Roadmaps and many-to-many
Roadmap↔Milestone↔Backlog edges remain explicit.

The deterministic `plan.json` separates path conflicts from `incoming-newer`,
`incoming-stale`, same-revision, and identity/path conflicts. Strict source
validation proves each source's relation closure before staging; a collision
remains a review item and is never resolved by source order. Schema v1/v2 and
unknown formats are rejected explicitly.

Reconcile by canonical entity identity, revision, integrity, and relation — not
by filenames, Markdown rows, or whole-directory overwrite. Build a source and
destination ControlModel first. The proposed set is the entity union plus its
dependency closure; a missing dependency is a review finding, not permission to
drop the relation.

- Schema-v3 Current/Checkpoint: derive a bounded destination Current from
  reviewed active Checkpoints while preserving non-conflicting standing
  instructions and Notes.
- Backlog/Risk: preserve IDs when unique. ID collisions compare canonical content
  and revision; identical entities deduplicate, divergent entities require an
  explicit deterministic remap and every inbound/outbound relation is rewritten
  in the same transaction. Never deduplicate merely by similar outcome text.
- Milestones: keep separate unless their outcomes and success criteria are
  genuinely the same; merge metadata relation sets explicitly.
- Decisions: never silently merge incompatible decisions. Keep both with new
  destination IDs (rewriting relations) or record an owner-approved superseding
  decision.
- Operations/quality gates: destination policy wins until the owner explicitly
  approves a change.
- Blueprints/reports/inspections: preserve provenance and rename collisions
  deterministically. Schema-3 Decision/Blueprint helper updates bind the expected
  Control revision and canonical `updated` timestamp (`--expect-revision
  <updated-ms>`), preserve omitted fields, and strict-validate the complete staged
  model before writing.

Only schema-3 source and destination namespaces are accepted; unsupported
schema/storage pairs fail before staging. Consolidation has no cross-schema
migration path and never silently upgrades a live source.

After a successful control consolidation, source PMs may continue operating.
Collapsing full PM identities is a separate migration, not part of this skill.
