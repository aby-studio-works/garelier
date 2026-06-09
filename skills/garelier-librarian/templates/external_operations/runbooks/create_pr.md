# Runbook: create_pr / update_pr (Garelier default — edit per project)

> Librarian-owned runbook the Concierge follows (DEC-025, Phase 2). Installed at
> `docs/garelier/external_operations/runbooks/create_pr.md`. See
> `pull_request_policy.md` for policy and `rollback_policy.md` for recovery.
> Default-disabled; runs only when `allowed_operation_kinds` includes `create_pr`.

## Inputs (from assignment.md, fixed by PM)

`provider` (github|gitlab), `source_ref` + `source_sha`, `base_ref` (PR target),
`title`, `body_template`, the passing `guardian_report_path` (+ verdict), and the
remote-visible head prefix (default `pr/<pm_id>/<slug>`).

## Steps (Concierge, in its own worktree)

1. **Provider check (parity-safe).** Confirm the platform CLI exists:
   `command -v gh` (GitHub) or `command -v glab` (GitLab). If absent, write a
   `NO_OP` report explaining the missing CLI and BLOCK — do **not** push anything.
2. **Gate check.** Guardian verdict `PASS`/`PASS_WITH_NOTES`, `review_sha` ==
   `source_sha` (not stale). Required Observer verdict if any. Else BLOCK.
3. **Lock.** Acquire the target-scoped lock `runtime/concierge/locks/pr__<head-slug>.lock` (SKILL §5).
4. **Build the body.** Generate the PR body from
   `templates/pull_request_body.md`. Redact: no secret / token / PII /
   runtime-internal path / long log — pointers only.
5. **Push the head (remote-visible, never garelier/\*).**
   `git push origin <source_sha>:refs/heads/pr/<pm_id>/<slug>` (no force).
6. **Idempotency check (crash-safe).** Before creating, check whether an open PR
   for this head already exists — `gh pr list --head pr/<pm_id>/<slug>` /
   `glab mr list --source-branch pr/<pm_id>/<slug>`. If one exists (e.g. a prior
   run created it but crashed before reporting), **update** it instead of opening
   a duplicate.
7. **Open / update the PR.**
   - GitHub: `gh pr create --base <base_ref> --head pr/<pm_id>/<slug> --title "<title>" --body-file <body>` (or `gh pr edit` when step 6 found one).
   - GitLab: `glab mr create --source-branch pr/<pm_id>/<slug> --target-branch <base_ref> --title "<title>" --description <body>`.
8. **Verify + report.** Capture the PR/MR URL + head SHA; write
   `concierge_report.md` (pointer-only) with the URL, remote head, gate verdicts,
   and a rollback note. Release the lock; → REPORTING.

## On any stop

Leave the remote unchanged past the last safe point (if the head was pushed but
the PR failed, record the pushed branch so it can be cleaned up), release the
lock, and BLOCK to PM. Never silently retry, never force-push.
