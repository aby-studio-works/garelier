# Artisan Checkpoint {{NNNN}}: {{phase}}

<!--
  Written by the Artisan at each phase boundary so a long task survives
  compaction/restart. Path: __garelier/<pm_id>/_artisan/checkpoints/{{NNNN}}-{{phase}}.md
  A fresh session reads the latest checkpoint and resumes — it does NOT
  redo completed work. Keep it short and factual.
-->

- Task: #{{ID}} {{task_title}}
- Phase: {{survey | implementation | hardening | knowledge | self-review | merge}}
- Written at: {{ISO8601_timestamp}}
- Branch: `{{satchel_branch}}`
- Last commit: {{commit_sha}}

## Done so far

- {{what is complete}}

## Remaining

- {{what is left in this phase / next phases}}

## State to restore on resume

- {{key facts a fresh session needs: decisions made, files in flight, partial edits}}

## Blocking risk

- {{none | risk that may force a BLOCK / PM escalation}}
