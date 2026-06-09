---
knowledge_id: quality.flaky_test_policy
title: Flaky Test Policy
category: quality
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

# Flaky Test Policy

How to handle non-deterministic test failures without hiding real ones. Original
wording; project-specific. See also `../engineering/debugging_principles.md`.

## Rules

- Re-run a suspected flake **exactly once**. **Two consecutive failures are a
  real failure** — treat them as such, never as a flake.
- Do not mark a flaky test PASS for convenience, and do not delete or skip it to
  go green.
- Do not "stabilize" a flake by adding sleeps, broad retries, or swallowed errors
  that mask the real timing/ordering/resource issue.
- A genuinely flaky test is a defect: record it (quarantine with a tracked
  reason, or fix the root cause), do not pretend it passed.

## Smith / Worker stance

- Smith does not convert a flaky failure into a PASS to clear a merge.
- A quarantined flake stays visible in `backlog` / risk with its reason and a
  follow-up, until fixed.

Generalized project knowledge, Librarian-maintained under PM approval.
