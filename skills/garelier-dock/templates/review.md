# Review: Task #{{ID}}

<!--
  Path: __garelier/<pm_id>/_workers/<id>/review.md OR __garelier/<pm_id>/_smiths/<id>/review.md
  Owner: Dock
  Readers: the Worker or Smith being reviewed.

  Written when a Worker or Smith enters REPORTING and the review fails.
  The agent reads this, addresses the items, and re-enters REPORTING.

  Scouts do NOT receive this kind of review feedback. Scout reports
  are immutable once written; if a Scout report is insufficient,
  Dock issues a new follow-up assignment instead (see
  garelier-dock/references/review-and-merge.md §7.2).

  Do NOT use this for praise-only or "looks good" messages. If the
  review passes, proceed directly to the merge gate — no review.md
  needed.
-->

## Identity

- Task ID: #{{ID}}
- Agent: {{agent_id}}
- Role: {{worker | smith}}
- Reviewed at: {{ISO8601_timestamp}}
- Reviewed by: Dock
- Outcome: REWORK
- Re-submission expected: {{yes | no — clarify if not}}

## Summary

{{One paragraph. The headline: what is wrong and what the agent
  needs to fix. The agent should be able to read just this paragraph
  and understand the action required.}}

## Failed acceptance criteria

<!-- List each criterion from the assignment that did NOT pass.
     For each, state what was observed and what was expected. -->

### Criterion {{N}}: {{criterion_text}}

- **Observed**: {{what actually happened}}
- **Expected**: {{what the criterion required}}
- **Evidence**: {{file path, log excerpt, command output —
                  enough that the agent doesn't have to re-discover the issue}}
- **Suggested fix**: {{Dock's best guess at how to address this.
                       The agent may choose a different approach but
                       this gives them a starting point.}}

(Repeat per failed criterion.)

## Missing required content

<!-- Coverage shortfalls from the Assignment Coverage Review
     (garelier-dock §7.1.1): a Do item that was skipped, a blueprint
     functional/non-functional requirement that was missed, or an input
     that was not addressed — even when the listed acceptance criteria and
     quality gate pass. Omit this section (or write "None") if coverage
     was complete and only acceptance criteria / the gate failed. -->

### Item {{N}}: {{missing_item}}

- **Source**: {{assignment.md §Do / §Goal | blueprint Functional/Non-functional requirement | §Inputs}}
- **Observed**: {{current state}}
- **Expected**: {{required state}}
- **Evidence**: {{assignment.md / blueprint / report / code path}}
- **Required action**: {{what the agent must add or change}}

(Repeat per missing item, or "None.")

## Quality gate failures

<!-- If the project quality gate (from AGENTS.md §2) failed,
     summarize here. -->

| Check                          | Status | Output excerpt           |
| ------------------------------ | ------ | ------------------------ |
| `cargo check --workspace`      | {{✗}}  | {{first 5 lines of error}} |
| `cargo test --workspace`       | {{✗}}  | {{failing test names}}     |
| `{{project-specific gate}}`    | {{✗}}  | {{summary}}                |

Full logs: `__garelier/<pm_id>/_{{workers_or_smiths}}/{{id}}/review-logs/{{timestamp}}/`

## Out-of-scope changes detected

<!-- If the Worker/Smith modified files outside the assignment's stated
     scope, list them here. The agent must either revert these or
     justify them. -->

- {{path}}: {{nature of change}} — {{why this is concerning}}

(Or "None observed.")

## Items NOT in scope of this review

<!-- Things you noticed but explicitly chose not to require fixing
     in this round. Helps the agent understand the boundary. -->

- {{noted_but_not_blocking}}

## Re-submission instructions

When you have addressed the items above:

1. Update your code accordingly.
2. Re-run the project quality gate locally:
   ```bash
   {{quality_gate_commands}}
   ```
3. Update `__garelier/<pm_id>/_{{workers_or_smiths}}/{{id}}/report.md` with what you
   changed in response to this review.
4. Transition your STATE.md to REPORTING.
5. Notify Dock via inbox: write
   `__garelier/<pm_id>/runtime/dock/inbox/<YYYYMMDD-HHMMSS>-{{id}}-state-change.md`
   with the new state.

## Notes from Dock

{{Any additional context, gotchas, or clarifications that don't fit
  in the structured sections above.}}
