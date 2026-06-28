# Artisan Assignment: {{task_title}}

<!--
  Written by PM. Read by the Artisan.
  Path: __garelier/<pm_id>/_artisan/assignment.md
  The Artisan performs the WHOLE task end to end (plan, implement, harden,
  any knowledge work, self-review, Guardian + Observer, merge to studio).
  fact per line; point to source files instead of pasting context.
-->

## Identity

- Task ID: #{{ID}}
- Assigned to: {{artisan_id}}
- Assigned at: {{ISO8601_timestamp}}
- Lane: artisan
- Target branch: `{{target_branch}}`
- Studio branch: `garelier/{{target_slug}}/{{pm_id}}/studio`
- Satchel branch: `garelier/{{target_slug}}/{{pm_id}}/satchel/#{{ID}}/{{slug}}`

## Goal

{{one outcome; one sentence}}

## Inputs

<!-- Read first. Path plus section/line hints. -->

- {{path_or_blueprint}} (sections: {{section_refs}})

## Do

<!-- The full scope. Include whichever parts apply: implementation,
     hardening, knowledge/registry/runbook work. -->

- {{action_1}}
- {{action_2}}

## Test discipline

<!-- Copy from the blueprint when present. The rules live in
     `quality/test_driven_development.md`; this section only selects mode. -->

- Mode: {{standard | tdd | test-first-waived}}
- Knowledge: {{`quality/test_driven_development.md` when Mode is `tdd`; otherwise `quality/test_strategy.md` or N/A}}
- Waiver reason: {{required only when Mode is `test-first-waived`; otherwise "-"}}

## Acceptance criteria

<!-- Concrete, verifiable. One check per line. -->

- [ ] {{criterion_1}}
- [ ] Project quality gate passes (see `AGENTS.md` §2)
- [ ] (if Test discipline Mode is `tdd`) TDD evidence is recorded: failing test
      first, final green run, and refactor status
- [ ] Completion Coverage Audit passes (garelier-worker/references/working-and-reporting.md §6.6)
- [ ] Assignment Coverage Review passes (skills/garelier-dock/references/report-review.md §7.1.1)
- [ ] Merged into `garelier/{{target_slug}}/{{pm_id}}/studio`

## Out of scope

- {{out_of_scope_1}}

## Data-change guards (required if this task mutates external data)

<!-- Same rules as any role: dry-run, rollback, before/after counts,
     user approval. Omit if read-only or commit-only. -->

- {{guards_or_N/A}}

## Notes from PM

{{max 5 bullets; only facts the Artisan needs}}
