+++
# Machine face. Every value sits under a [section] / [[array]] table; no VALUE is
# read from the prose below the closing +++, so parentheses, backticks and quotes
# in a finding are ordinary characters. Use '''...''' for anything multi-line.
# (One thing there is read: a line starting uncovered_dimension: /
# uncovered_cause: / uncovered_tracking_row: / alternate_confidence_basis: is the
# retired disclosure form and refuses the verdict, table or no table.)

[verdict]
result = '{{PASS | PASS_WITH_NOTES | BLOCK | NO_OPINION}}'
review_sha = '{{sha}}'
role = 'guardian'
# The bound branch. The PM's authority-rebind check reads THIS value, so a
# verdict without it cannot be used as rebind evidence at merge time.
branch = '{{bound branch}}'
kind = '{{preflight | delta_gate | final_gate | promote_gate}}'
request_id = 'GDN-{{ID}}'
base_ref = '{{ref}}'
head_ref = '{{ref}}'
checked_at = '{{ISO8601}}'

# One [[uncovered]] table per dimension this verdict could NOT cover; omit them
# entirely when nothing is uncovered. All four fields are required when present.
# [[uncovered]]
# dimension = 'secret_pii'
# cause = '''why it could not be covered'''
# tracking_row = 'W-000'
# alternate_confidence_basis = '''what the confidence rests on instead'''
+++

# Guardian Report

<!--
  Written by the Guardian. Read by the requester (Dock / PM / Artisan).
  Path: __garelier/<pm_id>/_crew/guardians/<id>/guardian_report.md
  REDACTION RULE: evidence is pointer-only. NEVER paste a secret, token,
  private key, or PII value here — the report must not become the leak.
  `doctor` enforces this: an unredacted secret-like value in this report is a
  blocking P0 finding (`guardian-report-leak`, G-14).
  Output register: garelier-core/output_control.md § Inter-agent compressed
  register — never applies to a redacted finding, verdict, or required action.
-->

- Role: Guardian
- Reviewed SHA: `{{sha}}`

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
- Role report: {{absolute path or none}}
- Dock final accounting: {{absolute path to lane/final_accounting.md, or not-applicable with non-Dock route}}
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
