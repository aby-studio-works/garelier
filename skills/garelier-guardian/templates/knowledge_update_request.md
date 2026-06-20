# Knowledge Update Request

<!--
  Written by Guardian when it finds a rule gap, a reusable false positive, or a
  needed exception. Guardian does NOT edit the registry itself — Librarian does,
  after PM / security-owner approval. This separates "apply a rule" from
  "change a rule" (DEC-024).
  Path: __garelier/<pm_id>/_guardians/<id>/knowledge_update_request.md
  (or runtime/librarian/inbox/ for async delivery).
-->

requester: guardian
reason: {{false_positive | new_policy_needed | exception_needed | runbook_gap}}
related_guardian_report: {{path}}

## Proposed durable update

- target: {{security/registries/<file>.toml OR security/<policy>.md}}
- change: {{describe — e.g. "add sanitized-fixture exception for pattern X"}}

## Evidence

- {{redacted pointer only — never the secret/PII value}}

## Required owner decision

- PM / security owner approval required before Librarian updates the registry.
- Until approved, the related finding stays BLOCK / PASS_WITH_NOTES as reported.
