# Artisan Report: {{task_title}}

<!--
  Written by the Artisan when the task is merged into studio. Read by PM.
  Path: __garelier/<pm_id>/_artisan/report.md
  Compact handoff: point to commits, files, and gate output; do not narrate.
-->

## Summary

result: {{1-5 line outcome}}

## Branch

- Work branch: `{{satchel_branch}}`
- Integration branch: `{{studio_branch}}`
- Merge commit: `{{commit_sha}}`

## Completed items

- [x] {{item}}
- [x] {{item}}

## Coverage audits

<!-- The §7 self-review results. -->

- Completion Coverage Audit (worker references/working-and-reporting.md §6.6): pass — {{evidence}}
- Assignment Coverage Review (dock references/review-and-merge.md §7.1.1): pass — {{evidence}}
- Goal / Do items / Functional / Non-functional / Inputs / Out-of-scope: {{summary}}

## Quality gate

- {{command}} — pass — {{short evidence}}

## Files changed

- `{{path}}` — {{reason}}

## Knowledge work (if any)

<!-- Registries/runbooks/rules touched, per garelier-librarian. Omit if none. -->

- {{none | path — what changed}}

## Notes for PM

- {{decisions, residual risk, follow-ups, anything PM must know}}

## Self-assessment

{{Confident | Partial | Risky}} — {{short reason}}
