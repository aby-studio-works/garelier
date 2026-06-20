---
knowledge_id: external_operations.promote_policy
title: Promote Policy (Garelier default — edit per project)
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

# Promote Policy (Garelier default — edit per project)

> Librarian-owned; Concierge applies it (DEC-025). Installed at
> the `external_operations/promote_policy.md` knowledge file.

## Preconditions (all required before the merge)

- Explicit user instruction + PM-approved promote document.
- PM has base-tracked: `<target>` folded into `studio` (PM owns `studio`).
- A passing Guardian verdict (`promote_gate` or `final_gate`,
  `PASS` / `PASS_WITH_NOTES`) bound to the integration tip and **not stale**.
- Observer verdict `PASS` / `PASS_WITH_NOTES` if the assignment marks it required.
- Smith hardening target count is zero, or an explicit user waiver is recorded.

## Execution (Concierge, in its own worktree)

1. `git fetch origin`; confirm `<target>` tip == `expected_target_sha` (else drift → BLOCK).
2. `git checkout <target>`; `git merge --no-ff --no-commit <studio>`.
3. Run the project quality gate (AGENTS.md §2) **on the merged tree**.
4. Only if it passes: commit the merge, `git tag -a v<version>`, `git push origin <target> --tags`.
5. Resolve conflicts in this `studio`→`<target>` merge yourself; if the merge is
   huge/ambiguous (base-tracking clearly skipped) abort + BLOCK to PM.

## Stop conditions (BLOCK / FAILED, never silently retry)

- Quality gate fails on the merged tree.
- Guardian is `BLOCK` / missing / stale.
- `<target>` drift, or the external lock cannot be acquired.
- The merge would require pushing a `garelier/*` branch or a force-push.

## After

Write the `promote_record` (`templates/promote_record.md`) with
`target_before_sha` / `target_after_sha`, the tag, the gate verdicts, and a
rollback note. PM keeps the persistent record under
`control/reports/promote/`.
