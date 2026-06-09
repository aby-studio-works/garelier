<!--
  Written by the requester (Dock / Artisan / Worker). Read by the Observer.
  Path: __garelier/<pm_id>/_observers/<id>/assignment.md
  Compact handoff: point to the diff/report/sources, do not paste long context.
  See garelier-observer/SKILL.md §5 + references/review-workflow.md §7, §9.
-->

# Observer Assignment: {{request_id}}

## Identity
- Request ID: {{request_id}}
- Kind: {{merge_review|artisan_premerge_review|direction_advice|architecture_risk_review|policy_consistency_review}}
- Requester: {{dock|artisan|worker:<id>}}
- Target role/task: {{worker:<id>|smith:<id>|librarian:<id>|artisan}}
- PM ID: {{pm_id}}
- Lane: {{dock|artisan}}

## Review target
- Base branch: {{base_branch}}
- Review branch: {{review_branch}}
- Diff command: `{{git_diff_command}}`
- Assignment/report paths:
  - {{assignment_path}}
  - {{report_path}}
- Gate output path: {{gate_output_path_or_none}}

## Question
{{specific_question}}

## Required checks
- [ ] Scope / acceptance coverage
- [ ] Diff matches report
- [ ] Risk areas
- [ ] Protected paths
- [ ] Public API / schema / migration impact
- [ ] Security / data-change concern
- [ ] Tests/gate evidence is plausible

## Out of scope
- Do not modify code.
- Do not commit.
- Do not merge.
- Do not change acceptance criteria.
- Do not make PM/user-level decisions.
