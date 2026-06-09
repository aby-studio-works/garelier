---
knowledge_id: external_operations.git_remote_policy
title: Git Remote Policy (Garelier default — edit per project)
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

# Git Remote Policy (Garelier default — edit per project)

> Librarian-owned; Concierge applies it (DEC-025). Installed at
> `docs/garelier/external_operations/git_remote_policy.md`.

## What may be pushed

| Ref | Push? | Who |
| --- | --- | --- |
| `garelier/<target-slug>/<pm_id>/*` (studio, workbench, clipboard, …) | **Never** | — (protocol §6.5) |
| `<target>` (e.g. `main`) + its tags | Only on a user-instructed promote | Concierge |
| `publish/<pm_id>/<slug>` | Phase 2 only, when policy enables it | Concierge |
| `pr/<pm_id>/<slug>` | Phase 2 only, when policy enables it | Concierge |
| `release/<version>` | Phase 2 only, when policy enables it | Concierge |

## Sync (read-only by default)

- OK without extra approval: `git fetch --prune origin`, `git status`,
  `git log`, `git diff`, `git merge-base`.
- Requires an explicit assignment line: `git merge origin/<target>`,
  `git rebase origin/<target>`, `git push`.
- **Forbidden:** `git pull` (it hides an implicit merge/rebase — use
  `fetch` then an explicit, named merge), `git push --force`,
  `git push origin --delete` of any `garelier/*` ref.

## Drift

Before pushing `<target>`, confirm the live `<target>` tip matches the
assignment's `expected_target_sha`. A mismatch (someone else moved the branch)
is **drift** — STOP and return to PM; do not overwrite.
