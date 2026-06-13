# Design options: {{title}}

<!--
  Path: __garelier/<pm_id>/control/blueprints/options/<slug>-options.md
  Owner: PM. Optional pre-blueprint artifact (DEC-067).

  WHEN to use: a non-trivial feature where more than one credible approach
  exists. Diverge BEFORE the blueprint binds: generate 2-3 independent
  approaches (the Workflow judge-panel pattern fits — independent proposers,
  then scoring), record the trade-offs, pick one WITH a reason. The chosen
  option's content feeds the blueprint; the rejected options stay here so
  the next person (or the next session) does not re-litigate them.

  WHEN to skip: the approach is obvious, constrained by an existing DEC, or
  the work is mechanical. This artifact is optional by design — do not
  manufacture options for trivial work.
-->

## Question

{{The design decision in one sentence — what are we choosing between?}}

## Constraints

- {{from AGENTS.md §0 principles / existing DECs / the milestone}}

## Options

### Option A: {{name}}

- Sketch: {{2-4 lines — what changes, where}}
- Pros: {{...}}
- Cons / risks: {{...}}
- Blast radius: {{files/crates/contracts touched}}

### Option B: {{name}}

- Sketch: {{...}}
- Pros: {{...}}
- Cons / risks: {{...}}
- Blast radius: {{...}}

<!-- Option C if genuinely credible; never pad. -->

## Decision

- Chosen: {{A | B | C}}
- Why: {{the deciding factor, 1-3 lines — what made the others lose}}
- Feeds blueprint: `{{blueprint_slug}}`
- Decided by: PM, {{YYYY-MM-DD}}{{ (user confirmed when the choice is user-visible)}}
