# Questions to Dock

<!--
  Written by a role when transitioning to BLOCKED.
  Path: __garelier/<pm_id>/_crew/<role-container>/questions.md

  Compact handoff: ask the smallest question that unblocks work.
-->

## Identity

- Task ID: #{{ID}}
- Asked by: {{worker_or_scout_id}}
- Asked at: {{ISO8601_timestamp}}
- Current state: BLOCKED

## Recovery map

<!-- Required for Guardian / Observer BLOCKED; useful for every role. Keep paths
     absolute when possible so PM can resume without rediscovery. -->

- Task / review target: {{task_id_or_slug_or_branch}}
- Container: {{absolute path to role container}}
- Checkout: {{absolute path to checkout, or "checkout=false"}}
- Assignment: {{absolute path to assignment.md}}
- Report / role report: {{absolute path or none}}
- Context / brief: {{absolute path to context.json/review brief or none}}
- Re-run hint: {{exact safe command or short next step}}

## Context

{{attempted action; relevant path:line; blocker}}

## Question 1

{{specific yes/no or short-text question}}

### Options I see

A. {{option_a}}
B. {{option_b}}
C. {{option_c — none of the above}}

### My current lean

{{option letter}} -- {{short reason}}

## Question 2 (if applicable)

{{Another question. Repeat the structure.}}

## What I've already tried

<!-- Only attempts relevant to the decision. -->

- {{search_or_attempt_1}} — result: {{outcome}}
- {{search_or_attempt_2}} — result: {{outcome}}

## Impact of waiting

{{hard stop | partial progress possible: <area>}}
