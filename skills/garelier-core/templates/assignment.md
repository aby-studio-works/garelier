# Assignment

<!--
  Written by Dock. Read by the assigned Worker, Scout, or Smith.
  Path: __garelier/<pm_id>/_workers/<id>/assignment.md  OR  __garelier/<pm_id>/_scouts/<id>/assignment.md  OR  __garelier/<pm_id>/_smiths/<id>/assignment.md
  Compact handoff: one fact per line; point to source files instead of
  pasting context. See garelier-core/compact_handoff.md.
-->

## Identity

- Task ID: #{{ID}}
- Assigned to: {{agent_id}}
- Assigned at: {{ISO8601_timestamp}}
- Milestone: {{milestone_name}}
- Phase: {{phase_n}} — {{phase_name}}
- Type: {{worker | scout | smith}}

## Equipped lens

<!--
  Lens affects focus and judgment within the existing Role Contract only.
  It cannot change permissions, write paths, MUST BLOCK conditions, or handoff
  format. Dock copies the resolved role Lens from blueprint `## Lens selection`
  or `[lenses.defaults]`.
-->

- Role: {{worker | scout | smith}}
- Lens Group: {{`worker.implementation:minimal_patch` | `scout.investigation:source_first` | `smith.integration:compatibility` | N/A}}
- Source: {{blueprint §Lens selection | setup_config.toml [lenses.defaults] | N/A}}
- Contract override: forbidden

## Branch (Worker / Smith only)

- Branch name: `garelier/{{target_slug}}/{{pm_id}}/{{workbench_or_anvil}}/#{{ID}}/{{slug}}`
- Branched from: `garelier/{{target_slug}}/{{pm_id}}/studio`
- Smith coverage window: {{N/A for Worker/Scout OR `studio_base_commit`..`studio_tip_at_dispatch`}}
- Covered Worker merges (Smith only): {{N/A OR space-separated `#<task_id>@<merge_sha>` tokens}}

(Workers use `workbench`; Smiths use `anvil`; Scouts leave this section as `N/A`.)

## Goal

{{one outcome; one sentence}}

## Allowed / forbidden write paths (contract)

<!-- Write ONLY under allowed_write_paths and NEVER under forbidden_write_paths.
     Touching anything else, or a protected path, without recorded approval is a
     boundary violation — BLOCK first (correct_operation.md). -->

allowed_write_paths:
- {{src/**}}
- {{tests/**}}

forbidden_write_paths:
- `__garelier/**`
- `.env*`
- `infra/**`, `deploy/**`, `.github/workflows/**`
- `migrations/**`
- {{other protected paths}}

## Inputs

<!-- Read first. Use path plus section/line hints. -->

- `__garelier/<pm_id>/control/blueprints/{{blueprint_filename}}.md` (sections: {{section_refs}})
- {{additional_inputs}}

## Do

- {{action_1}}
- {{action_2}}

## Test discipline (Worker only)

<!-- Copy from the blueprint when present. The rules live in the
     Librarian-owned quality knowledge tree; this section only selects the
     mode for this assignment. Omit for Scout and Smith assignments; Artisan
     uses its own assignment template. -->

- Mode: {{standard | tdd | test-first-waived}}
- Knowledge: {{`quality/test_driven_development.md` when Mode is `tdd`; otherwise `quality/test_strategy.md` or N/A}}
- Waiver reason: {{required only when Mode is `test-first-waived`; otherwise "-"}}

## Acceptance criteria

<!-- Concrete, verifiable. One check per line. Each completed criterion needs an
     EVIDENCE pointer (commit sha / test output / file) — a claim is not
     evidence (correct_operation.md). -->

- [ ] {{criterion_1}}
- [ ] {{criterion_2}}
- [ ] (Worker/Smith) `cargo check --workspace --locked` passes
- [ ] (Worker/Smith) `cargo test --workspace --locked` passes
- [ ] (Worker/Smith) Project-specific quality gate passes (see `AGENTS.md` §2)
- [ ] (Worker, if Test discipline Mode is `tdd`) TDD evidence is recorded:
      failing test first, final green run, and refactor status
- [ ] (Smith, if the merge touched paired/mirrored artifacts) Cross-artifact
      consistency checked (the `quality/cross_artifact_consistency.md` knowledge doc)

## Stop if (MUST BLOCK)

<!-- Conditions under which you MUST stop and escalate instead of proceeding.
     See your role SKILL's "MUST BLOCK IF" and correct_operation.md. -->

- {{out_of_scope_1}}
- Acceptance criteria are missing or contradictory.
- A required input or source file does not exist.
- The change would need a forbidden / protected path or a production-data write.
- An acceptance criterion cannot be met without scope expansion.
- The quality-gate command is undefined.
- Your branch / checkout does not match this assignment.
- Modifications outside the listed Inputs are required; escalate to BLOCKED first.

## Data-change guards (required if this task mutates external data)

<!--
  REQUIRED when the work writes to a database, mutates filesystem state
  destructively, calls a write-side external API in production, mutates
  payment/accounting state, sends real notifications, or destroys cloud
  resources. See __garelier/<pm_id>/control/operations/data_change_policy.md.
  Omit this section entirely if the task is read-only or commit-only.
-->

- Dry-run mode: {{describe --dry-run support OR "N/A — not a data-change task"}}
- Before/after counts: {{required content of the report}}
- Sample records to include in report: {{describe}}
- Rollback plan: {{describe OR "irreversible — user must explicitly approve"}}
- User approval ledger: {{filename in __garelier/<pm_id>/_pm/history.md for the approval entry}}

## References

<!-- Pointers only. Do not paste long context. -->

- Past similar task: #{{related_ID}} → `__garelier/<pm_id>/_workers/{{worker_id}}/archive/{{related_ID}}/`
- Blueprint: `__garelier/<pm_id>/control/blueprints/{{filename}}.md`
- Existing similar implementation: `{{path/to/file.rs}}`

## Estimated effort

{{2h | 1d | other}}

## Notes from Dock

{{max 5 bullets; only facts needed by assignee}}

## Outputs (evidence required)

<!-- What this assignment must leave behind as proof of correct completion. -->

- {{commit(s) on your branch}} (Worker / Smith / Librarian / Artisan — Scouts
  and Observers produce no commits)
- `report.md` (Worker / Smith / Librarian) / inspection draft (Scout) /
  `report.md` verdict (Observer)
- For each completed acceptance criterion: an **evidence pointer** (commit sha /
  test-output path / file) that proves it. A claim without evidence is
  incomplete (`correct_operation.md`).

## Questions accepted

If the goal or acceptance criteria are ambiguous, write to
your local `questions.md` and transition to BLOCKED.
Do not guess — silent assumptions cause rework.
