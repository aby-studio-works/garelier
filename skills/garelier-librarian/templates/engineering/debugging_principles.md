---
knowledge_id: engineering.debugging_principles
title: Debugging Principles
category: engineering
status: active
owners:
  - pm
consumers:
  - worker
source_ids:
  - project-original
last_reviewed_at: 2026-06-08
review_cycle: on-change
---

# Debugging Principles

How a producing role isolates a cause and fixes it safely, instead of papering
over a failure. Project-specific; original wording.

## Method

- Reproduce the failure first. A bug you cannot reproduce, you cannot confirm
  fixed.
- Separate expected from actual, and recent-change from pre-existing defect.
- Build the minimal reproduction. Shrink the input/conditions until the failure
  is the smallest thing that still fails.
- When you add logging, never emit secrets or PII. Remove temporary
  `print`/debug code before committing.

## Flaky failures

- Re-run a suspected flake exactly once. **Two consecutive failures are a real
  failure**, not a flake — treat them as such.
- Do not "fix" a flake by adding sleeps, broad `try/catch`, or
  unwrap/`?`-suppression to hide it.

## Fixing

- Do not hide an unknown cause behind a broad catch, a suppressed error, or a
  retry loop.
- If you must take a workaround, record the **residual risk** and a **follow-up**
  in `report.md` (and `backlog`/`questions.md` if it needs PM attention).
- After fixing, add a test or a durable evidence artifact that would catch this
  failure again (see `../quality/regression_policy.md`).

## When the cause stays unknown

Stop and escalate (`../system/escalation_policy.md`) with the minimal
reproduction and what you ruled out. A documented unknown beats a silent
workaround.
