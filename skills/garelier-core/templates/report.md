+++
# W-668 / F-18: the machine face lives HERE, inside the front matter — never as an
# HTML comment above it. `bind_review_sha` (and every other machine reader) treats
# a file whose FIRST line is not `+++` as the retired body-regex form and refuses
# it, so a report that opens with `<!-- garelier-control-v3 … -->` cannot be bound
# to a review SHA at all. `land_pipeline.ts` transcribes a producer register into
# this shape automatically; write it this way by hand and the binder accepts it.
#
# Values are TOML strings: parentheses, backticks, quotes and newlines are ordinary
# characters that need no escaping. Use '''...''' for anything multi-line.

[gate]
# `branch` is yours. Everything else in this table is DRIVER-OWNED (W-709):
# `bind_review_sha` derives `review_sha` (the checkout's HEAD),
# `declared_base_sha` (the dispatch binding's pickup base) and `gate_log` (the
# log named for that review SHA) and writes them at review time. Do not type
# them: a value you write here is overwritten and reported back as
# `driver_overwrote=…`, and the round it used to cost you (`declared_base_sha
# changes from … to …`) no longer exists. Describe the base-track in prose.
#
# There is NO gate_run_id field (W-711). The Dock's seal binds the run its own
# review record already names over these exact log bytes, so a run id copied
# into the register proved nothing and cost a round whenever it was missing or
# mistyped. Quote run ids in prose freely; nothing reads them.
branch = '{{branch}}'

[control]
# The control binding dispatch_prepare used to write as an HTML comment header.
schema_version = '3'
work_id = '{{W-NNN}}'
session_id = '{{control_session_id}}'
+++

# Completion Report

<!--
  Written by Worker or Smith upon completion. Read by Dock during review.
  Path: __garelier/<pm_id>/_crew/workers/<id>/report.md OR __garelier/<pm_id>/_crew/smiths/<id>/report.md
  Compact handoff: one fact per line; point to commits, files, and test
  output instead of narrating process. See garelier-core/compact_handoff.md.
  Output register: garelier-core/output_control.md § Inter-agent compressed register.
  Register-canonical variant (W-019): when the harness blocked writing this file,
  the compact REGISTER message is the canonical record — the PM transcribes it here
  with `dispatch_cleanup.ts --report-from-file`, so a report.md that opens with a
  "transcribed from the role register" comment IS the register, not a template.
-->

## Identity

- Task ID: #{{ID}}
- Agent: {{agent_id}}
- Role: {{worker | smith}}
- Reported at: {{ISO8601_timestamp}}
- Branch: `garelier/{{target_slug}}/{{pm_id}}/{{workbench_or_anvil}}/#{{ID}}/{{slug}}`
- Last commit: {{commit_sha}}
- Role binding: {{binding_id / generation / digest}}
- Launch acknowledgement: {{transport / exact provider session id}}
- Final instruction chain: {{chain hash; ledger N/N consumed}}
- Close receipt: {{pending admission-controller | canonical close path/digest}}

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
- {{path/to/new_file}} — {{purpose}}

### Modified
- {{path/to/file}} — {{nature_of_change}}

### Deleted
- (none)

## Acceptance criteria checklist

<!-- Copy each criterion from assignment.md; attach short evidence. -->

- [x] {{criterion_1}} — {{evidence_or_brief_note}}
- [x] {{criterion_2}}
- [x] The project's check command (per `[quality_gate]`) -- pass -- {{short evidence}}
- [x] The project's configured test command -- pass -- {{N}} tests
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

- `tests/{{path}}::{{test_name}}` — {{what_it_verifies}}

## Test discipline evidence (required when assignment mode is `tdd`)

<!-- Omit when assignment mode is `standard` or the task is not code-producing. -->

- Mode: {{standard | tdd | test-first-waived}}
- Focused test: `{{path}}::{{test_name}}`
- Red evidence: {{command + short expected failure summary}}
- Green evidence: {{command + short pass summary}}
- Refactor status: {{none needed | done, tests still green | blocked}}
- Waiver: {{none | PM/Dock-approved reason}}

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
- User approval reference: {{typed Evidence ref on the Backlog record}}

## Known limitations

<!-- Be direct. Use "none" if none. -->

- {{limitation_1}}

## Role recovery evidence (only for `role_recovery`)

- Superseded binding digest: {{digest}}
- Current authority/base/Lens/Knowledge re-audit: {{evidence}}
- Dependencies re-audited: {{pass + evidence}}
- Acceptance criteria re-audited: {{all IDs + evidence}}
- Preserved WIP inventory: {{path / content hash list}}
- Destructive action or permission expansion: none

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
