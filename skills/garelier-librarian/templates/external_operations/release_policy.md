---
knowledge_id: external_operations.release_policy
title: Release Policy (Garelier default — edit per project)
category: external_operations
status: active
owners:
  - pm
consumers:
  - concierge
source_ids:
  - project-original
last_reviewed_at: 2026-06-08
review_cycle: on-change
---

# Release Policy (Garelier default — edit per project)

> Librarian-owned; Concierge applies it (DEC-025, Phase 2). Installed at
> the `external_operations/release_policy.md` knowledge file. **Default-disabled** —
> runs only when `allowed_operation_kinds` lists `create_release` /
> `update_release` / `publish_artifact`. The release is the **strongest** gate.

## Preconditions (all required — a release is irreversible-ish and public)

- Explicit user instruction + a PM `assignment.md`.
- A **fixed** `tag` (e.g. `v1.2.0`) and a **fixed** `target_sha` (the exact
  commit to release) — never "latest".
- A passing Guardian gate (`final_gate` / `promote_gate`, `PASS` /
  `PASS_WITH_NOTES`, not stale) covering the released tree.
- An **artifact manifest** (the exact files to publish) and a passing artifact
  scan (no secret / forbidden file in the artifact) — if the scanner is
  unavailable and policy requires it, BLOCK.
- A **release note** generated from `templates/release_note.md` (pointer-only,
  no secret / PII / internal runtime detail).
- A **rollback / recovery** note (a release is hard to unpublish — see below).
- The platform CLI is available (`gh release` / `glab release`); else NO_OP/BLOCK.

## Branch / tag rules

- The tag points at the fixed `target_sha`. Push the tag with
  `git push origin <tag>` — never force, never a `garelier/*` ref.
- A release branch, if used, is `release/<version>` (an allowed prefix), never
  `garelier/*`.

## Stop conditions (BLOCKED / FAILED / NO_OP)

- Guardian BLOCK / missing / stale; artifact scan fail or required-scanner missing.
- Tag or `target_sha` not fixed; the tag already exists on the remote (no clobber).
- The platform CLI is unavailable or auth is missing.
- The note / artifact would expose a secret / PII / internal runtime detail.

## After

Report the release URL, the tag, the tag SHA, and the artifact hashes in
`concierge_report.md` (pointer-only). A published release is **not** silently
deleted on rollback — see `rollback_policy.md` (prefer a follow-up patch
release; deleting a public release/tag needs explicit user instruction).
