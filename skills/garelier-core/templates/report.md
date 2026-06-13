# Completion Report

<!--
  Written by Worker or Smith upon completion. Read by Dock during review.
  Path: __garelier/<pm_id>/_workers/<id>/report.md OR __garelier/<pm_id>/_smiths/<id>/report.md
  Compact handoff: one fact per line; point to commits, files, and test
  output instead of narrating process. See garelier-core/compact_handoff.md.
-->

## Identity

- Task ID: #{{ID}}
- Agent: {{agent_id}}
- Role: {{worker | smith}}
- Reported at: {{ISO8601_timestamp}}
- Branch: `garelier/{{target_slug}}/{{pm_id}}/{{workbench_or_anvil}}/#{{ID}}/{{slug}}`
- Last commit: {{commit_sha}}

## Summary

result: {{one-line outcome}}

## Smith coverage window (Smith only)

<!-- Omit for Worker reports. Later Worker merges after studio_tip_at_dispatch are outside this report. -->

- Studio base commit: {{studio_base_commit}}
- Studio tip at dispatch: {{studio_tip_at_dispatch}}
- Covered Worker merges: {{space-separated `#<task_id>@<merge_sha>` tokens}}
- Later studio merges observed: {{none | list; outside coverage}}

## Changes

<!-- path -- effect. Group only when it reduces repetition. -->

### Added
- {{path/to/new_file.rs}} — {{purpose}}

### Modified
- {{path/to/file.rs}} — {{nature_of_change}}

### Deleted
- (none)

## Acceptance criteria checklist

<!-- Copy each criterion from assignment.md; attach short evidence. -->

- [x] {{criterion_1}} — {{evidence_or_brief_note}}
- [x] {{criterion_2}}
- [x] `cargo check --workspace --locked` -- pass -- {{short evidence}}
- [x] `cargo test --workspace --locked` -- pass -- {{N}} tests
- [x] Project quality gate passes
- [x] (Smith, if applicable) Integration/system checks cover the assigned post-merge risk
- [x] (Smith, if the merge touched paired/mirrored artifacts) Cross-artifact consistency checked — {{path:line evidence}}

## Completion Coverage Audit

<!--
  Worker §6.6 / Smith result. Confirms the assignment was fully covered,
  not just that tests pass. Dock's Assignment Coverage Review reads
  this. Use `pass` + short evidence per line; never check a line you
  could not verify.
-->

- Goal: pass — {{evidence}}
- Do items: pass — {{summary: N of N processed}}
- Acceptance criteria: pass — see checklist above
- Functional requirements: pass — {{evidence / blueprint section}}
- Non-functional requirements: pass — {{evidence}}
- Out of scope: pass — {{not touched}}
- Inputs reviewed: pass — {{files}}
- Extra touched files: {{none | list each with reason}}

## Tests added or modified

<!-- New or changed tests only. -->

- `tests/{{path}}.rs::{{test_name}}` — {{what_it_verifies}}

## Decisions made during implementation

<!-- Only decisions that affect behavior, risk, or future maintenance. -->

- {{decision_1}} -- chose {{option}}; reason: {{rationale}}

## Context pack gaps

<!-- DEC-071 feedback loop: facts you had to rediscover that the assignment
     or blueprint should have carried — exact paths, invariants, verify
     commands, gotchas. "none" when the context pack sufficed. The retro
     digest aggregates these; recurring gaps become PM planning knowledge. -->

- {{rediscovered_fact_or_none}}

## Data-change evidence (required if assignment had Data-change guards)

<!--
  Mirror the assignment's Data-change guards section. Omit if the task
  was not data-changing.
-->

- Dry-run output: {{paste or link the dry-run output}}
- Before counts: {{table or list}}
- After counts: {{table or list}}
- Sample changed records: {{3-10 representative rows}}
- Rollback verified: {{yes/no — describe how}}
- User approval reference: {{__garelier/<pm_id>/_pm/history.md entry #}}

## Known limitations

<!-- Be direct. Use "none" if none. -->

- {{limitation_1}}

## Backlog / deferred scope (Smith only)

<!-- Existing backlog items intentionally not duplicated. Omit for Worker reports. -->

- {{backlog_item_or_none}}

## License / security / compliance (Smith only)

<!-- Enforce project-decided policy; escalate undecided policy. Omit if not applicable. -->

- {{finding_or_none}}

## Web searches performed (optional)

<!-- Search terms + why only. -->

- "{{search_term}}" — referenced for {{what}}.

## Questions for Dock

<!-- Final clarifications, if any. Use only for matters too small to have
     escalated to BLOCKED. -->

- (none)

## Self-assessment

{{Confident | Partial | Risky}} -- {{short reason}}
