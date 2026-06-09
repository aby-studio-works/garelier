# Webhook Policy

This document defines what the webhook receiver (typically Jenkins,
optionally any other CI / job runner) is responsible for, and what it
must not do.

The receiver's job is to **trigger**, not to **decide**. It performs
mechanical validation, fetches the request branch, and hands off to the
project's request_intake handler. PM is the only role that interprets
the request's meaning.

## Must do

1. **Verify the webhook itself.** Require a signed payload (HMAC) or
   a provider-issued secret. Reject unsigned / unverified webhooks.
2. **Verify the source.** Only accept webhooks from Git providers
   listed in the project's webhook configuration (GitHub Enterprise
   instance, internal GitLab, etc.). Reject everything else.
3. **Filter by ref prefix.** Process only refs that start with
   `refs/heads/garelier/request/`. Ignore everything else, including
   pushes to `studio`, `workbench/*`, and the target branch.
4. **Ignore delete events.** Branch deletion is part of the cleanup
   protocol, not an intake event. Drop delete events at the receiver.
5. **Fetch and validate structure.** Pull the branch, check that
   `.garelier/request.toml` and `.garelier/request.md` exist, and
   that the branch name parses against
   `^garelier/request/<target_pm>/<source_pm>/<request_id>-<short_uid>$`.
6. **Detect duplicates.** Compare the request commit SHA against
   the receiver's recent-commit log. If the same SHA was processed
   already, drop the event (no-op, no error). If a different SHA
   appears with the same `request_id`, hand off normally — intake
   will reject the second one and write a rejected-report.
7. **Invoke request_intake.** Call the project's intake handler with
   the branch checkout path. Capture stdout/stderr and exit code into
   a job log.
8. **Persist the job log.** Store the receiver-side log somewhere
   the user can audit (Jenkins build log, log directory under
   `__garelier/<pm_id>/runtime/requests/`, or both).

## Must not do

1. **Do not interpret request content.** The receiver does not read
   the `kind` field to decide what to run. The receiver does not
   short-circuit allowed kinds. It hands the entire payload to
   `request_intake`.
2. **Do not invoke Worker / Scout / Smith / Dock directly.** All paths
   go through PM. The receiver does not have credentials to invoke
   an agent shell, and even if it did, the policy forbids it.
3. **Do not execute arbitrary shell from the request file.** The
   request schema forbids `command` / `script` / `shell` / etc.
   fields, but the receiver also enforces this: it inspects the
   parsed TOML and refuses to invoke intake if any forbidden field
   is present.
4. **Do not push to the target branch.** The receiver does not run
   `git push origin <target>` for any reason. Promote is local PM
   only, user-instructed.
5. **Do not delete branches it did not validate.** Cleanup happens
   only after intake (and PM, for delegated requests) completes.

## Webhook secrets and credentials

- Webhook secret is stored in the receiver's credentials store, not
  in Garelier's `control/`.
- Git push credentials used by the receiver should have minimum
  scope:
  - Fetch from the repo: yes.
  - Push to `garelier/request/...` to clean up: yes.
  - Push to `studio`, `<target>`, or any other branch: no.
  - Tag creation / deletion: no.
- Credentials rotate on the project's normal schedule.

## Failure semantics

| Receiver-side failure | Action                                                                              |
| --------------------- | ----------------------------------------------------------------------------------- |
| Signature invalid     | Drop. Log to receiver job log. Do not contact request_intake.                       |
| Branch name parse fail | Drop. Log. Do not delete the branch (PM will see it on next manual sweep).         |
| Missing TOML/MD       | Invoke intake with `--strict` (which writes a rejected-report) then delete branch.  |
| Intake exit nonzero   | Write a `failed`-state record under `__garelier/<pm_id>/runtime/requests/failed/`. Retain the branch per `webhook_policy.md` TTL. |
| Intake exit zero      | Optionally delete the request branch immediately, or wait for PM to delete after completion (project policy). |

## Cleanup TTL

The default cleanup TTL for failed requests is 7 days, configurable
in the receiver's per-project configuration (not in `control/` —
this is operational tuning):

```toml
[request_branch_cleanup]
completed = "delete_after_report"          # PM (or receiver) deletes once control-report exists
rejected  = "delete_after_report"          # deleted immediately after rejected-report
failed    = "keep_for_days"
failed_keep_days = 7
```

Per-project tuning lives in the receiver's configuration. Garelier
does not invent a clock; the receiver's TTL sweep is itself a
scheduled job (registered under
`__garelier/<pm_id>/control/scheduled_jobs/` if Garelier owns the
sweeper).
