# Guardian Report

<!--
  Written by the Guardian. Read by the requester (Dock / PM / Artisan).
  Path: __garelier/<pm_id>/_guardians/<id>/guardian_report.md
  REDACTION RULE: evidence is pointer-only. NEVER paste a secret, token,
  private key, or PII value here — the report must not become the leak.
  `doctor` enforces this: an unredacted secret-like value in this report is a
  blocking P0 finding (`guardian-report-leak`, G-14).
-->

verdict: {{PASS | PASS_WITH_NOTES | BLOCK | NO_OPINION}}
kind: {{preflight | delta_gate | final_gate | promote_gate}}
request_id: GDN-{{ID}}
base_ref: {{ref}}
head_ref: {{ref}}
review_sha: {{sha}}
checked_at: {{ISO8601}}

## Checks

- secrets_scan: {{PASS | BLOCK | NO_OPINION}}
- pii_scan: {{PASS | BLOCK | NO_OPINION}}
- dependency_scan: {{PASS | PASS_WITH_NOTES | BLOCK | NO_OPINION}}
- license_scan: {{PASS | PASS_WITH_NOTES | BLOCK | NO_OPINION}}
- {{sast_scan | ci_deploy_review}}: {{PASS | PASS_WITH_NOTES | BLOCK | NO_OPINION}}

## Blocking findings

<!-- Redacted / pointer-only. -->

- id: GDN-{{NNN}}
  category: {{secret | pii | customer_data | dependency | license | ci_deploy | auth}}
  path: {{path}}
  evidence: {{redacted scanner finding / pointer only — NOT the value}}
  required_action: {{remove; rotate if real; rerun Guardian}}

## Notes (non-blocking)

- id: GDN-{{NNN}}
  category: {{dependency | license}}
  evidence: {{scanner summary / pointer}}
  action: {{update package OR record exception via knowledge_update_request}}

## Knowledge update requests

- {{path that may need a durable update, or "none"}}

## Evidence pointers

- scanner output: {{path}}
- diff: {{command or file}}
