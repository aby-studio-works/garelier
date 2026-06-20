---
knowledge_id: external_operations.rollback_policy
title: Rollback / Recovery Policy (Garelier default — edit per project)
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

# Rollback / Recovery Policy (Garelier default — edit per project)

> Librarian-owned; Concierge applies it (DEC-025). Installed at
> the `external_operations/rollback_policy.md` knowledge file.

Every external operation records how to undo it. The Concierge report's
**Rollback / recovery** section is mandatory.

## Promote rollback

- **Not yet pushed:** `git reset --hard <target_before_sha>` on `<target>`, and
  delete the local tag (`git tag -d v<version>`). Nothing left the machine.
- **Already pushed:** prefer a **forward fix** — `git revert -m 1 <merge_sha>`
  then a new user-instructed promote. Do **not** force-push a shared `<target>`
  to "remove" the merge without explicit user instruction; rewriting shared
  history is itself a destructive external operation that needs its own approval.
- A pushed tag is only moved/deleted on the remote with explicit user instruction.

## General rules

- Capture `before`/`after` SHAs **before** acting, so rollback targets are known.
- If rollback would itself be a destructive external write (force-push, remote
  tag deletion, remote branch deletion), it requires the same user-instruction +
  PM-approval gate as the original operation.
- When uncertain whether an undo is safe, BLOCK and return to PM.
