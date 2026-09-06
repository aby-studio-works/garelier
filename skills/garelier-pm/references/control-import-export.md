# Import and Export Workflow

## Clean control bundle

Use the full Garelier bundle scripts. They support `_workshop` and full PM ids:

```bash
garelier control export --project <root> --pm-id <id> --to <dest>
garelier control import --project <root> --pm-id <id> --from <bundle>
garelier control import --project <root> --pm-id <id> --from <bundle> --apply
# Only after reviewing a current self-authored bundle's persistent support files:
garelier control import --project <root> --pm-id <id> --from <bundle> --apply --trust-persistent-authority
```

Import is dry-run and no-overwrite by default. Export includes tracked
`control/` only. Import never copies the source bundle's `control.toml` identity
into another namespace: it preserves an existing destination marker or creates
a destination-specific `control_only` marker.

The `garelier_control_bundle_v2` manifest format records the schema-3
ControlModel revision plus per-file SHA-256, bytes, entity identity, and entity
revision where applicable. Manifests classify provenance and mark persistent
support as `review_required`.

Export validates schema-3 Control and includes the complete tracked plan graph
and mixed Dashboard authority:
Roadmaps, Milestones, Backlogs and archives, Backlog Views, Current,
Checkpoints and archives, Notes, relations including retired edges, Decisions,
Blueprints, Risks, gates, evidence, tombstones, purge manifests, and unknown
front-matter fields/bodies. Runtime sessions, claims, locks, journals, and
caches remain excluded. Import strict-loads the staged graph, verifies
owner-local relation identities and lifecycle paths, then uses the same atomic
swap/rollback protocol.
Before apply, import freezes every verified source into a read-only
same-filesystem snapshot and re-hashes it immediately before and after each
copy. A bundle that changes during import is rejected. Imported persistent
support (`operations/`, inspections,
observations, reports, delegation, request intake, scheduled jobs, and
templates) is review-required and goes to `runtime/import/quarantine/` by
default; it has no authority and is never executed. It enters `control/` only
when a current, fully verified self-authored bundle is applied with the
explicit `--trust-persistent-authority` review grant.

Every bundle manifest declares `schema_version`, storage kind, source `pm_id`,
entity inventory/counts, canonical relative paths, byte length, and SHA-256 for
each member. Runtime files are excluded. Import
verifies the manifest and hashes before parsing any authority and rejects path
escape, symlink, schema/storage mismatch, duplicate entity IDs, revision
regression, or a relation whose selected closure is incomplete.

- A v3 bundle contains canonical plan-graph Markdown plus its tracked mixed
  Dashboard and archives; generated marker-external text must round-trip byte
  for byte.
- Schema 1 and schema 2 bundles are rejected explicitly.
- Import/apply and any normalized promotion run through the control
  transaction. Normal operation never copies files directly into canonical
  authority paths.

## Messy external import

1. Put raw input under `__garelier/<pm_id>/runtime/import/raw/`.
2. Write an inventory/provenance/ambiguity report under
   `runtime/import/reports/`.
3. Map source concepts to canonical entities and relations. Do not preserve
   source structure merely because it exists.
4. Draft normalized artifacts under `runtime/import/drafts/` using
   `control/templates/`.
5. Resolve obvious duplicates by references; surface semantic ambiguity to the
   user instead of guessing.
6. Dry-run collisions, validate formats, and review the derived graph.
7. Promote only approved durable entities through the schema write policy.
   Schema v3 direct authoring must strict-validate; shared/automated multi-file
   changes use the CLI transaction.
8. Commit normalized control files only; leave raw/drafts/reports transient.

## Clean export

1. Validate the schema-3 control tree (`doctor --profile strict`) and reconcile
   Git/evidence where applicable.
2. Run commit-hygiene and inspect for secrets, PII, and unlicensed external text.
3. Export to an explicit empty destination.
4. Review the bundle manifest and derived graph before sharing.
5. Leaving the sandbox still follows the project's external-operation policy.
