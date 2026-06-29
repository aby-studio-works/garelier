# Import and Export Workflow

## Clean control bundle

Use the full Garelier bundle scripts. They support `_workshop` and full PM ids:

```bash
garelier control-export --project <root> --pm-id <id> --to <dest>
garelier control-import --project <root> --pm-id <id> --from <bundle>
garelier control-import --project <root> --pm-id <id> --from <bundle> --apply
```

Import is dry-run and no-overwrite by default. Export includes tracked
`control/` only. Import never copies the source bundle's `control.toml` identity
into another namespace: it preserves an existing destination marker or creates
a destination-specific `control_only` marker.

## Messy external import

1. Put raw input under `__garelier/<pm_id>/runtime/import/raw/`.
2. Write an inventory/provenance/ambiguity report under
   `runtime/import/reports/`.
3. Map source concepts to canonical artifacts. Do not preserve source structure
   merely because it exists.
4. Draft normalized artifacts under `runtime/import/drafts/` using
   `control/templates/`.
5. Resolve obvious duplicates by references; surface semantic ambiguity to the
   user instead of guessing.
6. Dry-run collisions, validate formats, and review the derived graph.
7. Move only approved durable artifacts into `control/`.
8. Commit normalized control files only; leave raw/drafts/reports transient.

## Clean export

1. Validate the control tree and remove stale/completed hot-file entries.
2. Run commit-hygiene and inspect for secrets, PII, and unlicensed external text.
3. Export to an explicit empty destination.
4. Review the bundle manifest and derived graph before sharing.
5. Leaving the sandbox still follows the project's external-operation policy.
