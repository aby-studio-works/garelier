# Escalation to PM

<!--
  Written by Dock when a Worker/Scout/Smith question requires
  blueprint-level interpretation or user input.
  Path: __garelier/<pm_id>/runtime/dock/escalation/<YYYYMMDD-HHMMSS>-<topic-slug>.md
  Compact handoff: translate to PM terms; no agent process diary.
-->

## Identity

- Escalation ID: {{ESC-YYYYMMDD-N}}
- Originating task: #{{ID}}
- Originating agent: {{agent_id}}
- Escalated at: {{ISO8601_timestamp}}
- Originating state: BLOCKED

## Why escalating

{{why Dock cannot decide locally}}

## The question (rephrased for PM)

{{question in blueprint/user terms}}

## Options on the table

A. {{option_a — explained in blueprint terms}}
B. {{option_b}}
C. {{option_c}}

## What hangs on this

- Affected tasks: #{{ID}} ({{agent_id}})
- Other tasks that may be affected later: {{list_or "none currently"}}
- Estimated urgency: {{low | medium | high}}
- Workaround available?: {{yes — describe | no}}

## Dock's recommendation

{{option letter}} -- {{short reason}}

## Next step after resolution

When PM resolves, Dock will:
1. Read `__garelier/<pm_id>/runtime/pm/resolutions/{{ESC-ID}}.md`
2. Forward to {{agent_id}} as `__garelier/<pm_id>/_{{workers_or_scouts_or_smiths}}/<id>/answers.md`
3. Update `__garelier/<pm_id>/runtime/manifest.md` to remove this from "Open escalations"
4. Move this file to `__garelier/<pm_id>/runtime/dock/escalation-archive/`
