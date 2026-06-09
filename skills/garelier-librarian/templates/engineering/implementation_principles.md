---
knowledge_id: engineering.implementation_principles
title: Implementation Principles
category: engineering
status: active
owners:
  - pm
consumers:
  - worker
  - artisan
source_ids:
  - project-original
last_reviewed_at: 2026-06-08
review_cycle: on-change
---

# Implementation Principles

General implementation safety for Garelier producing roles (Worker, Artisan).
Project-specific; authored in original wording, not copied from any public skill.

## Before you change anything

- Fix the goal first: re-read the assignment's purpose and acceptance criteria,
  and the blueprint's functional and non-functional requirements.
- Search for the existing pattern. Reuse the project's existing abstraction
  before introducing a new one.
- Confirm the change surface: which files are in scope, which are not.

## While you change

- Keep the change small and on-topic. Do not fold in unrelated cleanup or
  refactors.
- Do not mix a behavior change and a pure formatting/move change in the same
  commit.
- Match the surrounding code's conventions, naming, and comment density.
- Check external inputs, error paths, boundary values, and backward
  compatibility.
- Re-check the non-functional requirements that matter here (performance,
  security, compatibility) before calling it done.

## When you finish

- Run the project quality gate (it lives in `AGENTS.md`); do not ignore a
  failure.
- In `report.md`, say not only **what you changed** but **what you deliberately
  did not change** and why.
- Leave evidence pointers (see `evidence_policy.md`), not pasted bodies.

## Do not

- Copy a public skill's wording, step names, or abbreviations into your prompt,
  report, or code comments.
- Introduce a language-specific convention that conflicts with the project's.
- Add unverified benchmark numbers or attack payloads.

When the implementation direction is genuinely unclear, escalate
(`../system/escalation_policy.md`) rather than guessing.
