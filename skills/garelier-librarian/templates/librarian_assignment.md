# Librarian Assignment: {{title}}

<!--
  Written by Dock. Read by the assigned Librarian.
  Path: __garelier/<pm_id>/_librarians/<id>/assignment.md
  Compact handoff: point to sources/files, do not paste long context.
-->

## Identity

- Task ID: #{{ID}}
- Assigned to: {{librarian_id}}
- Assigned at: {{ISO8601_timestamp}}
- Branch: `garelier/{{target_slug}}/{{pm_id}}/shelf/#{{ID}}/{{slug}}`
- Branched from: `garelier/{{target_slug}}/{{pm_id}}/studio`

## Source (for external-info sync; omit for pure routine work)

- Source ID: `{{source_id}}`            <!-- must be registered in source_registry.toml -->
- Source type: `{{sharepoint | url | local_file | repo_file}}`
- Source path/url: `{{url_or_path}}`

## Goal

{{what to internalize or standardize, in one sentence}}

## Do

- [ ] Confirm the source is registered (sync tasks).
- [ ] Fetch / read the source or current procedure.
- [ ] Transform into internal Markdown WITH project-specific augmentation.
- [ ] Update source_registry.toml / routine_registry.toml as needed.
- [ ] Create/update runbook or manual as needed.
- [ ] Stamp provenance (source_id, last_synced_at, transform, …).
- [ ] Report to Dock.

## Target files

- `{{path}}`
- `{{path}}`

## Constraints

- Do not adopt an unregistered source.
- Do not change the meaning of a rule (augmentation is OK).
- No feature code; no free investigation; no QA.

## Acceptance criteria

- [ ] Target Markdown updated with provenance front matter.
- [ ] `last_synced_at` updated (sync tasks).
- [ ] Registry entries consistent with the Markdown / runbook.
- [ ] Runbook reusable at a repeatable granularity (routine tasks).
- [ ] Diff reason recorded in report.
