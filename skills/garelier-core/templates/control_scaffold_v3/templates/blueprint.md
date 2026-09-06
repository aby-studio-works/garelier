+++
schema_version = 3
kind = "garelier_blueprint"
slug = "{{SLUG}}"
# Change status with `garelier control transition blueprint`; do not edit it directly.
status = "draft"
created = "{{TIMESTAMP}}"
updated = "{{TIMESTAMP}}"
backlog_ids = []
decision_ids = []
acceptance_ids = []
# related accepts a bare W-NNN as backlog:W-NNN shorthand; any other kind
# needs the full kind:id form.
related = []
+++

# Blueprint: {{TITLE}}

## Goal

## Context and constraints

## Functional requirements

## Acceptance criteria

## Output definition

- Artifact kind: {{code | documentation | tests | inspection | control artifact}}
- Format: {{template plus register/commit-plan shape, or none}}
- Mandatory elements: {{required fields/evidence}}
- Destination kind: {{verdict file | inspection | Backlog/row body | register}}
- Concrete path: resolved by the dispatch prompt/task file; not recorded here.

## Plan-graph effects

## Migration and compatibility

## Quality gates

## Out of scope
