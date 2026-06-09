---
knowledge_id: security.commit_hygiene_policy
title: Commit Hygiene Policy & Runbook (no secrets / PII / customer data in commits)
category: security
status: active
owners:
  - pm
consumers:
  - worker
  - artisan
source_ids:
  - project-original
last_reviewed_at: 2026-06-08
review_cycle: on-change
---

# Commit Hygiene Policy & Runbook (no secrets / PII / customer data in commits)

> Durable security knowledge **every committing role must follow** before each
> commit. This is the FIRST line of defense; the Guardian gate (DEC-024) is the
> backstop, not a substitute. A secret that reaches a commit is already
> compromised — even if a later commit removes it, git history retains it.
>
> Owner: PM / security owner. Maintainer: Librarian. Applies to: Worker, Smith,
> Artisan, Librarian, Concierge — and PM / Dock whenever they commit.
> Installed location in a target project: `docs/garelier/security/`.

## The rule

Never stage or commit:

- A secret, token, API key, password, private key, or credential — real or
  realistic. Use a placeholder (`{{PLACEHOLDER}}`, `EXAMPLE_...`) instead.
- Customer data, real PII, or production data — in source, fixtures, snapshots,
  logs, test output, or sample files. Use sanitized fixtures
  (`templates/sanitized_fixture.md`).
- A `.env` (or equivalent) holding real values. Commit a `.env.example` with
  placeholders only; keep the real file gitignored.
- A connection string, internal hostname, or private endpoint that exposes
  infrastructure.

The same applies to the **commit message** and **branch name** — no secret / PII
values there either.

## Pre-commit runbook (run before every commit)

1. **Review the staged diff, not the working tree.** Inspect exactly what will be
   committed: `git diff --staged` (or `--cached`). Read it; do not commit blind.
2. **Scan for secrets / PII.** Match the staged diff against the project patterns
   in `registries/secret_patterns.toml` and `registries/pii_patterns.toml`
   (see `scanner_runbook.md` for the project scanner command, if configured).
   Look especially for: long random-looking strings, `KEY`/`TOKEN`/`SECRET`/
   `PASSWORD`/`PRIVATE` assignments, `-----BEGIN ... PRIVATE KEY-----`, email
   addresses / names / phone numbers / IDs in fixtures, and real-looking data in
   logs or snapshots.
3. **Check new/changed config & fixture files** specifically — they are the most
   common leak source.
4. **Confirm ignore coverage.** Anything that legitimately holds real values must
   be gitignored, not committed.
5. **Only then commit.**

## If you find a secret / PII

- **Not yet committed:** remove or redact it from the staged change. Replace real
  values with placeholders or sanitized fixtures. Re-run the runbook.
- **Already committed locally (not pushed):** treat the value as **compromised**.
  Do not "fix it in the next commit" — the value is in history. Remove it from
  the change, and **flag for rotation** (the credential/data must be rotated by
  the owner). Record a redacted pointer (never the value) and raise it.
- **Already pushed:** stop. This is an incident — follow
  `incident_response_runbook.md`, notify the owner, and rotate immediately. (Note:
  `garelier/*` branches are local-only and never pushed; external pushes are the
  Concierge's job and pass the Guardian gate first.)
- Never paste the secret/PII value into a report, inspection, commit message,
  log, or knowledge file — use a redacted pointer.

## Per-role notes

- **Worker / Smith / Artisan:** run the runbook before every commit; redact real
  data out of fixtures and logs.
- **Concierge:** in addition, an external write that publishes/deploys/releases
  must pass the Guardian gate; a secret/PII finding is a hard stop before any
  external operation.
- **Librarian:** never let a secret/PII value into a knowledge file, registry, or
  source-sync target; store redacted pointers only.
- **Guardian:** applies this as the gate backstop and BLOCKs on a finding; it does
  not replace per-role pre-commit hygiene.

## When unsure

If you are unsure whether something is sensitive, treat it as sensitive: do not
commit it, and escalate (`../system/escalation_policy.md`) or raise a
`knowledge_update_request.md`. A false alarm costs a question; a leak costs a
rotation and an incident.
