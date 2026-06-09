# Phase Breakdown: {{blueprint_slug}}

<!--
  Path: __garelier/<pm_id>/runtime/backlog/<blueprint_slug>_phases.md
  Owner: Dock
  Readers: Dock (re-reads to track progress), PM (consults via
           runtime manifest), audit history.

  Generated when a blueprint is phase-decomposed (not workflow-expanded).
  The document records Dock's planning so the user (via PM) can
  understand and challenge the decomposition.
-->

## Identity

- Blueprint: `__garelier/<pm_id>/control/blueprints/{{blueprint_slug}}.md`
- Linked milestone: `{{milestone_slug}}`
- Decomposed at: {{ISO8601_timestamp}}
- Decomposed by: Dock
- Status: {{planning | dispatching | in_progress | complete | abandoned}}

## Rationale

{{One paragraph. Why this blueprint was phase-decomposed instead of
  expanded as a single workflow. Reference the blueprint's structure
  (number of functional requirements, breadth of subsystems touched,
  acceptance criteria spread, etc.).}}

## Phases

### Phase 1 — {{phase_name}}

- Status: {{planned | dispatching | in_progress | complete}}
- Parallel: {{true | false — assignments within this phase may run in parallel}}
- Goal: {{one sentence}}

Assignments:

| Task ID | Slug                       | Role   | Agent (if pinned) | Depends on                |
| ------- | -------------------------- | ------ | ----------------- | ------------------------- |
| #001    | {{slug_1}}                 | Worker | any               | -                         |
| #002    | {{slug_2}}                 | Worker | any               | -                         |

Phase exit criteria:

- All assignments above are MERGED.
- Quality gate passes on garelier/<target-slug>/<pm_id>/studio after the last merge in this phase.

### Phase 2 — {{phase_name}}

- Status: {{planned}}
- Parallel: {{true | false}}
- Goal: {{...}}

Assignments:

| Task ID | Slug         | Role   | Agent | Depends on |
| ------- | ------------ | ------ | ----- | ---------- |
| #003    | {{slug_3}}   | Worker | any   | #001, #002 |

Phase exit criteria:

- {{specific_criterion}}

(Add more phases as needed.)

## Cross-phase notes

{{Any caveats, fallback plans, or coordination notes that apply
  across multiple phases. For example: "If phase 2 reveals that the
  approach in phase 1 was wrong, abandon and re-decompose."}}

## Audit trail

- {{ISO8601}} — Decomposition created
- {{ISO8601}} — Phase 1 dispatched
- {{ISO8601}} — Phase 1 complete
- {{ISO8601}} — Phase 2 dispatched
- ...

## Final status

(Filled in when the blueprint is complete.)

- Closed at: {{ISO8601}}
- Result: {{shipped | abandoned | merged-into-other-blueprint}}
- Total assignments: {{N}}
- Total Worker hours (estimated): {{N}}
- Notes: {{post-mortem if applicable}}
