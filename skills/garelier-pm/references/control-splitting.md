# Control Splitting

Splitting extracts part of one control namespace into another namespace. A
common path is separating one initiative from `_workshop` into a named
`pm_id`.

It does **not** automatically split project-wide knowledge, git history,
runtime, role homes, worktrees, branches, setup configuration, or lane locks.
Those require separate explicit decisions. `__garelier/__atmos/knowledge/` remains shared
project knowledge unless the user is splitting the project itself.

## Safety model

1. Require one source `pm_id`, one distinct destination `pm_id`, and explicit
   entity IDs/control-relative selections.
2. Run the split helper without `-Apply` / `--apply` first.
3. Apply only to stage selected source files under the destination's gitignored
   `runtime/import/split/<batch>/`; never write destination `control/` directly.
4. Preserve the source namespace unchanged.
5. Load the source ControlModel and compute the selected entity closure across
   Roadmap/Milestone/Backlog ownership edges, child Milestones,
   parent/dependency/blocker/supersede, Checkpoint/Current, Note, Blueprint,
   Decision, Risk, gate, evidence, archive, tombstone, and artifact refs.
   Decide whether each boundary relation is:
   copied, rewritten as a cross-PM pointer, duplicated as an approved policy, or
   intentionally left shared.
6. Normalize and review drafts before promoting them through a destination
   control transaction. Schema-v3 direct authoring is valid only after strict
   validation; shared/automated split application is transactional.
7. Validate both source and destination graphs after promotion.
8. Remove moved authority from the source only in a separate user-approved
   commit after the destination is proven complete.

## Stage a split

Selections name canonical entity IDs (preferred) or source-control-relative
artifact paths. Select records, not dashboard summaries. The dry-run manifest
lists the requested set, dependency closure, boundary relations, collisions,
revision/integrity values, and deterministic ID/path rewrite plan.

```bash
garelier control-split \
  --project <root> \
  --from-pm-id _workshop \
  --to-pm-id payments \
  --select milestones/payments.md \
  --select blueprints/payments-api.md \
  --select decisions/DEC-012-payment-provider.md

garelier control-split \
  --project <root> \
  --from-pm-id _workshop \
  --to-pm-id payments \
  --select milestones/payments.md \
  --select blueprints/payments-api.md \
  --select decisions/DEC-012-payment-provider.md \
  --apply
```

When the destination does not exist, apply initializes it as `control_only`.
Run the `garelier-pm` fresh setup wizard later with the same destination id to
upgrade it to full Garelier without changing its identity.

## Reconciliation rules

For schema v3, each `--select` resolves to a typed Markdown record, typed
reference, relation selector `(owner, rel-NNN)`, or allowlisted persistent
support path. Closure preserves shared nodes without inventing ownership and
retains retired edges, archives, tombstones, and purge manifests.

The plan expands the selected schema-3 record dependency closure. `plan.json`
records requested files separately from dependency-added files with SHA-256,
identity, revision, and relation edges in deterministic order. Windows
drive/UNC paths, POSIX absolute paths, backslashes, traversal, symlinks, and
non-portable files are rejected before staging.

- Derive destination Current from selected active Checkpoints,
  preserve selected Notes, and retain multiple Roadmaps/many-to-many edges.
- Copy selected Backlog/Risk plus the reviewed relation closure. Preserve IDs and
  revisions when collision-free; remap collisions deterministically and rewrite
  all affected relations in one transaction.
- Give destination decisions unique IDs where collisions exist and preserve
  provenance to source IDs.
- Treat operations and quality gates as shared project policy by default. Copy
  only when the destination truly needs an independently owned policy.
- Keep source records until destination validation and user-approved cutover
  complete.

Only schema-3 sources and destinations are accepted; unsupported versions fail
before staging.
