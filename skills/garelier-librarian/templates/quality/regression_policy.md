---
knowledge_id: quality.regression_policy
title: Regression Policy
category: quality
status: active
owners:
  - pm
consumers:
  - worker
  - smith
source_ids:
  - project-original
last_reviewed_at: 2026-06-08
review_cycle: on-change
---

# Regression Policy

How fixes become durable instead of one-off. Original wording; project-specific.

## Rules

- A bug fix records its **reproduction conditions** (what input/state triggers
  it).
- A fix is not done when the symptom disappears — it is done when a test or
  durable evidence would **detect the failure again**.
- A previously failed scenario becomes a **named regression case**, kept so it is
  re-run going forward.
- A known but unfixed regression stays visible in `backlog` / risk notes with its
  impact — never silently dropped.

## In practice

- After a fix, add the regression test next to the relevant suite (see
  `test_strategy.md`).
- Reference the original failure (report path, commit, or issue) from the
  regression case so the link survives.
- If you cannot add an automated regression test, record why and what manual
  evidence stands in for it.

Generalized project knowledge, Librarian-maintained under PM approval.
