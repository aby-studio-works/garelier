# {{role}} {{id}} — State

<!--
  Written by the agent itself. Read by all roles.
  Path: __garelier/<pm_id>/_workers/<id>/STATE.md  OR  __garelier/<pm_id>/_scouts/<id>/STATE.md  OR  __garelier/<pm_id>/_smiths/<id>/STATE.md

  Update this file on EVERY state transition. The status field must match
  your actual state at all times.
  Compact handoff: short status facts only; no diary.
-->

## Status

{{IDLE | ASSIGNED | WORKING | REPORTING | REVIEWING | MERGED | REWORK | BLOCKED | ABORTED}}

## Current branch

{{branch_name | (none — detached HEAD on garelier/<target-slug>/<pm_id>/studio)}}

## Current task

{{Task #{{ID}}: short summary | (none)}}

## Last activity

{{ISO8601_timestamp}} -- {{action_summary}}

## Recent log (last 10 entries, most recent first)

- {{ISO8601_timestamp}} -- {{action}}
- {{ISO8601_timestamp}} -- {{action}}

## Blockers (only when status is BLOCKED)

<!-- When BLOCKED, describe what's needed to unblock. Otherwise leave empty. -->

- {{blocker_description}}
- See: `questions.md`

## Next planned action

{{next single action}}
