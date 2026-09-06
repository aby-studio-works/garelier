# Guardian Assignment

<!--
  Written by Dock / PM / Artisan. Read by the assigned Guardian.
  Path: __garelier/<pm_id>/_crew/guardians/<id>/assignment.md
  Compact handoff: pointers, not pasted context. See compact_handoff.md.
  `Kind` selects the Guardian carabiner (gate task-form); the enum values are
  unchanged. See garelier-core/references/carabiners.md (DEC-095).
-->

## Identity

- Request ID: GDN-{{ID}}
- Kind: {{preflight | delta_gate | final_gate | promote_gate}}
- Assigned to: {{guardian_id}}
- Target role: {{worker | smith | librarian | artisan}} {{target_role_id}}
- base_ref: `garelier/{{target_slug}}/{{pm_id}}/studio`
- head_ref: `garelier/{{target_slug}}/{{pm_id}}/{{workbench_or_anvil}}/#{{ID}}/{{slug}}`
- review_sha: {{sha}}

## Required gates

<!-- The gates that must PASS for this kind/security_level. -->

- [ ] secrets_scan
- [ ] pii_scan
- [ ] dependency_scan
- [ ] license_scan
- [ ] {{sast_scan | ci_deploy_review}}

## Policy sources (Librarian-owned — read, do not change)

- security/security_policy.md
- security/privacy_pii_policy.md
- security/license_policy.md
- security/dependency_policy.md
- security/registries/secret_patterns.toml
- security/registries/vulnerability_exceptions.toml

## Commands

- secret_scan: {{gitleaks dir . --no-banner --redact --report-format json --report-path - | off}}
- dependency_scan: {{project-specific OR "N/A"}}

`secret_scan: off` is valid only when PM explicitly set
`[guardian_tools].secret_scan = "off"` and
`[guardian_policy].block_when_required_scanner_unavailable = false`. In that
case, Guardian performs a degraded git/Bun/text review and reports the disabled
scanner instead of claiming full secret-scanner coverage.

## Inputs (pointers)

- target assignment: {{path}}
- target report: {{path}}
- Dock final accounting: {{path to lane/final_accounting.md, or "not-applicable (<non-Dock route>)"}}
- quality-gate output: {{path}}
- diff: `git diff {{base_ref}}...{{head_ref}}`

## Stop if (MUST BLOCK)

- secret / private key / credential detected
- PII / customer data detected
- a required (mandatory) scanner is unavailable and PM has not explicitly
  enabled degraded secret-scan mode
- a required policy source is missing
- a Dock-routed candidate's final accounting is missing or does not bind the review SHA, scanner evidence, and gate result
- a critical/high vulnerability is untriaged
- a forbidden license is introduced
- explaining a finding would require revealing a secret or PII value

## Outputs

- `guardian_report.md` (verdict + redacted, pointer-only evidence)
- `knowledge_update_request.md` (only if a durable policy update is needed)
