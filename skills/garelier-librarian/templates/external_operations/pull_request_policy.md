---
knowledge_id: external_operations.pull_request_policy
title: Pull Request Policy (Garelier default — edit per project)
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

# Pull Request Policy (Garelier default — edit per project)

> Librarian-owned; Concierge applies it (DEC-025, Phase 2). Installed at
> the `external_operations/pull_request_policy.md` knowledge file. **Phase 2 is
> default-disabled** — a Concierge runs `create_pr` / `update_pr` / `close_pr`
> only when its `allowed_operation_kinds` lists them AND the policy enables PRs.

## Preconditions (all required before opening / updating a PR)

- Explicit user instruction + a PM `assignment.md` fixing the operation.
- A fixed `source_ref` / `source_sha` and a fixed `base_ref` (the PR target).
- A passing Guardian **safe-to-publish** verdict (`final_gate` / `promote_gate`,
  `PASS` / `PASS_WITH_NOTES`, not stale) — nothing leaves the sandbox un-gated.
- The PR body is generated from `templates/pull_request_body.md`; it must not
  contain a secret, token, PII, runtime-internal path, or a long log.
- The platform CLI is available (`gh` for GitHub, `glab` for GitLab). If it is
  not, the operation is **NO_OP / BLOCK** — never partially push.

## Branch rules (the local-only invariant holds)

- A PR head is a **remote-visible** branch under an allowed prefix
  (`pr/<pm_id>/<slug>` by default — see `allowed_external_branch_prefixes`),
  **never** a `garelier/*` branch (protocol §6.5).
- Push the head with `git push origin <local>:pr/<pm_id>/<slug>` — no force-push.
- `close_pr` closes the PR and may delete the **remote** head only with explicit
  instruction; it never deletes a `garelier/*` ref.

## Stop conditions (BLOCKED / FAILED / NO_OP, never silently retry)

- Guardian is `BLOCK` / missing / stale, or a required Observer verdict is missing.
- The platform CLI is unavailable, or auth is missing.
- The body would expose a secret / PII / internal runtime detail.
- The operation would push a `garelier/*` branch or force-push.
- The task turns out to need source changes → hand back to PM (Worker).

## After

Report the PR URL, the remote head branch, and the head SHA in
`concierge_report.md` (pointer-only). Record a rollback note (how to close the
PR / delete the remote head if it must be undone).
