# Garelier Dock Assignment Authoring Reference

## §5. Assignment authoring details

### §5.1 The assignment template

Preferred path: render `assignment.md` from a Pipeline package with
`garelier-core/driver/src/pipeline_packages.ts render-assignment` or, for
commit-producing dispatch containers, by passing `--pipeline-package PP-N` to
`dispatch_prepare`. Legacy path: use
`../../../garelier-core/templates/assignment.md`. Never invent the format. If the
template is missing a field you need, update the template (in coordination with
the user via PM if needed), do not bolt on ad-hoc fields.

Assignments must be compact: `Goal` is one outcome, `Inputs` are exact
paths/sections, `Do` is action list, acceptance criteria are checkboxes,
and `Notes from Dock` is at most five bullets. Put long background
in the blueprint and link it.

### §5.2 Acceptance criteria narrowing

The blueprint's acceptance criteria may cover multiple assignments.
When you write an assignment, include only the criteria that *this*
assignment is responsible for. If criterion 5 is "the merged work
ships," that's a Dock-level criterion (post-merge), not a
Worker-level one. Don't put it in the Worker's assignment.

### §5.3 Inputs section

List specific files. "Read the codebase" is not an input; "read
`src/foo.rs`, `src/bar.rs`, and `__garelier/<pm_id>/control/blueprints/inventory.md`"
is.

### §5.4 Notes from Dock

Use this section to share context that is not in the blueprint but is
useful for execution: stylistic preferences, recent decisions made by
PM, related work that just merged, known pitfalls. This section is
where Dock adds value beyond the blueprint.

### §5.5 Test discipline

Blueprints may select a Worker/Artisan test mode under `## Test discipline`.
Dock treats that section as PM-authored scope:

- `standard`: write normal project tests according to `quality/test_strategy.md`.
- `tdd`: require `quality/test_driven_development.md` and red/green/refactor
  evidence in the report.
- `test-first-waived`: allowed only with the blueprint's waiver reason copied
  into the assignment.

Do not infer TDD from personal preference, and do not remove TDD because it
looks inconvenient. If the section contradicts acceptance criteria or allowed
write paths, escalate to PM before dispatch. Do not copy this section into
Scout or Smith assignments unless a future role contract explicitly adds TDD
support for that role.
