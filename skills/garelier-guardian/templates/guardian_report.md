# Guardian Report

<!--
  Written by the Guardian. Read by the requester (Dock / PM / Artisan).
  Path: __garelier/<pm_id>/_guardians/<id>/guardian_report.md
  REDACTION RULE: evidence is pointer-only. NEVER paste a secret, token,
  private key, or PII value here — the report must not become the leak.
  `doctor` enforces this: an unredacted secret-like value in this report is a
  blocking P0 finding (`guardian-report-leak`, G-14).
  Output register: garelier-core/output_control.md § Inter-agent compressed
  register — never applies to a redacted finding, verdict, or required action.
-->

verdict: {{PASS | PASS_WITH_NOTES | BLOCK | NO_OPINION}}
kind: {{preflight | delta_gate | final_gate | promote_gate}}
request_id: GDN-{{ID}}
base_ref: {{ref}}
head_ref: {{ref}}
review_sha: {{sha}}
checked_at: {{ISO8601}}

## Review context

<!--
  Required on BLOCK / NO_OPINION / failed scanner or failed setup. Keep paths
  pointer-only and absolute when possible so PM can resume or re-run the exact
  gate without rediscovery. Do not paste source, scanner payloads, secrets, or
  long logs here.
-->

- Task: {{task_id_or_slug}}
- Review target: {{workbench/anvil/shelf/satchel branch or promote target}}
- Container: {{absolute path to guardian container}}
- Checkout: {{absolute path to gavel checkout, or "checkout=false"}}
- Assignment: {{absolute path to assignment.md}}
- Producer report: {{absolute path or none}}
- Context / brief: {{absolute path to context.json/review brief or none}}
- Re-run hint: {{exact safe command or short next step}}

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
