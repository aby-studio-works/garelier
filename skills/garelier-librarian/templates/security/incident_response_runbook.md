---
knowledge_id: security.incident_response_runbook
title: Incident Response Runbook (Garelier default — edit per project)
category: security
status: active
owners:
  - pm
consumers:
  - guardian
source_ids:
  - project-original
last_reviewed_at: 2026-06-08
review_cycle: on-change
---

# Incident Response Runbook (Garelier default — edit per project)

When Guardian finds a **real** secret / credential already committed:

1. **Treat it as compromised.** Rotate the credential immediately at its source
   (API console / IdP / KMS). Deleting the file is NOT enough — assume it leaked.
2. **Remove it from the working tree.** For shared history, plan a history scrub
   (`git filter-repo`) and coordinate with PM before rewriting shared branches.
   For a local-only Garelier branch, removing + rotating is usually enough.
3. **Record the incident (redacted)** under
   `__garelier/<pm_id>/control/reports/` — what, where (pointer), rotated y/n,
   follow-ups. Never the secret value.
4. **Improve the rule.** If detection missed it or over-matched, raise a
   `knowledge_update_request` to adjust `secret_patterns.toml` /
   `false_positive_exceptions.toml`.

For PII / customer-data leaks, follow the same shape plus any
jurisdiction-required notification (out of Garelier's scope — escalate to PM).
