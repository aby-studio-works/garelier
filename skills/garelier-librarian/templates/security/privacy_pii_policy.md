---
knowledge_id: security.privacy_pii_policy
title: Privacy / PII Policy (Garelier default — edit per project)
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

# Privacy / PII Policy (Garelier default — edit per project)

No **customer data / PII / real production data** in source, fixtures, logs,
samples, or commit history. Use sanitized fixtures
(`templates/sanitized_fixture.md`).

## BLOCK

- a detected PII value (`registries/pii_patterns.toml`) not covered by a
  recorded sanitized-fixture exception;
- real customer/production data in a fixture, log, sample, or seed;
- a private key / credential belonging to a person or customer.

## Evidence

Redacted / pointer-only. A PII value must **never** appear in a
`guardian_report.md`, an inspection, a commit message, or a log.

## Jurisdiction note

Tune `registries/pii_patterns.toml` for the data you actually handle (e.g. JP My
Number, EU personal data, payment-card data). The defaults are a starting point,
not a compliance guarantee.
