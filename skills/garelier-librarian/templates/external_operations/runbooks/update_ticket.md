# Runbook: update_ticket (Garelier default — edit per project)

> Librarian-owned runbook the Concierge follows (DEC-025, Phase 2). Installed at
> `docs/garelier/external_operations/runbooks/update_ticket.md`. See
> `ticket_policy.md`. Default-disabled; runs only when `allowed_operation_kinds`
> includes `update_ticket`. **Investigate-then-execute.**

## Inputs (from assignment.md, fixed by PM)

`provider` (jira|github|gitlab|redmine|…), `ticket_id` (e.g. `PROJ-123`), the
approved **method** (the transition / comment / fields to set), and any
`link_pr` / `link_commit` references.

## Steps (Concierge)

1. **Provider check (parity-safe).** `command -v jira` / `gh` / `glab` (per
   provider). Absent → `NO_OP` report naming the missing CLI + BLOCK.
2. **Investigate (PREPARING).** Read the ticket and its current state:
   - Jira: `jira issue view <ticket_id>`
   - GitHub: `gh issue view <ticket_id>`
   - GitLab: `glab issue view <ticket_id>`
   Resolve the concrete steps the approved method maps to. If the ticket needs
   **source changes**, STOP and hand back to PM (do not implement).
3. **Lock.** Acquire the target-scoped lock `runtime/concierge/locks/ticket__<ticket_id>.lock` (SKILL §5).
4. **Build the update.** Generate the comment / field text from
   `templates/ticket_update.md` (pointer-only; no secret / PII / customer data /
   internal `__garelier/` path).
5. **Execute the approved update** (only what the method fixed):
   - Comment: `jira issue comment add <id> <file>` / `gh issue comment <id> -F <file>` / `glab issue note <id> -m ...`.
   - Transition: `jira issue move <id> "<state>"` / `gh issue {close|reopen} <id>` / `glab issue {close|reopen} <id>`.
6. **Verify + report.** Capture the ticket URL + new state; write
   `concierge_report.md` (pointer-only) with a rollback note. Release the lock; →
   REPORTING.

## On any stop

Leave the ticket unchanged past the last safe point, release the lock, BLOCK to
PM with the reason. Never widen scope beyond the fixed method, never implement code.
