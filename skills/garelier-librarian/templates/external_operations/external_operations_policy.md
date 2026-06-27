---
knowledge_id: external_operations.external_operations_policy
title: External Operations Policy (Garelier default — edit per project)
category: external_operations
status: active
owners:
  - pm
consumers:
  - concierge
  - librarian
source_ids:
  - project-original
last_reviewed_at: 2026-06-08
review_cycle: on-change
---

# External Operations Policy (Garelier default — edit per project)

> This is **durable external-operation knowledge** the Concierge applies
> (DEC-025). **PM / release owner** owns it; **Librarian** maintains it;
> **Concierge** reads and applies it — Concierge never edits this tree.
> Shipped as a general-purpose starting point; change and extend it per project.
>
> Installed location in a target project: the `external_operations/` knowledge tree.

## Scope

Concierge executes PM-approved operations that **leave Garelier's local
sandbox**. Phase 1 (this default set) covers the promote: merging `studio` into
`<target>`, tagging, and pushing `<target>`. Phase 2 (added deliberately per
project) covers pull requests, releases, tickets, artifact publication, and
remote sync.

## Hard rules (every external operation)

- **Explicit user instruction.** No external write happens without an explicit
  user instruction behind the PM assignment — even in autonomous mode.
- **PM approval + fixed method.** Concierge runs only what a PM `assignment.md`
  fixed (refs, target, tag, gate verdicts). It does not invent or widen scope.
- **Guardian first.** A passing Guardian verdict (`promote_gate` / `final_gate`,
  not stale) is required before any external write.
- **`garelier/*` is local-only.** Never push a `garelier/*` branch. Remote-
  visible work uses the `allowed_external_branch_prefixes` (`publish/`, `pr/`,
  `release/`) — never `garelier/*` (see `git_remote_policy.md`).
- **No force-push, no blind `git pull`.** Use `git fetch` + an explicit,
  assignment-named merge/rebase if one is required.
- **Redacted output.** A report / PR body / ticket / release note must never
  contain a secret, token, or PII value (point at paths / URLs / SHAs).
- **Never implement code.** If an operation turns out to need source changes,
  hand back to PM → PM dispatches a Worker.

## Files in this tree

Phase 1 (promote — enabled by default when a Concierge is configured):

- `external_operations_policy.md` (this file)
- `git_remote_policy.md`, `promote_policy.md`, `rollback_policy.md`
- `runbooks/promote_target.md`
- `templates/promote_record.md`

Phase 2 (external platform — **default-disabled**, enabled per
`allowed_operation_kinds`; each degrades to NO_OP/BLOCK when its platform CLI is
unavailable):

- Pull request: `pull_request_policy.md`, `runbooks/create_pr.md`,
  `templates/pull_request_body.md`
- Release: `release_policy.md`, `runbooks/create_release.md`,
  `runbooks/publish_public_export_release.md`, `templates/release_note.md`
- Ticket: `ticket_policy.md`, `runbooks/update_ticket.md`,
  `templates/ticket_update.md`
- Remote sync: `runbooks/sync_remote.md` (read-only tier is Phase 1; the
  merge/rebase/push write tier is Phase 2, explicit-assignment only) — see
  `git_remote_policy.md`
- CI / artifact: added incrementally (`ci_policy.md`, `artifact_policy.md`,
  their runbooks, and templates).
