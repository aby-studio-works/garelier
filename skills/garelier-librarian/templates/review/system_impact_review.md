---
knowledge_id: review.system_impact_review
title: System-Impact Review
category: review
status: active
owners:
  - pm
consumers:
  - observer
source_ids:
  - project-original
last_reviewed_at: 2026-06-08
review_cycle: on-change
---

# System-Impact Review

Whether a change ripples beyond its file into Garelier's wider system. Original
wording; project-specific. Especially relevant when the change touches the
framework itself.

## What to check

- Does the change reach beyond a single file into role flow, driver, setup, docs,
  or gates?
- Is it consistent with state transitions, marker files, leases, branch naming,
  archives, and retention?
- Does one role's convenience encroach on another role's responsibility?
- Are driver / docs / Skill / template / dashboard / setup-wizard kept in sync
  (no one-sided change that leaves the others stale)?
- Is a new setting reflected where it must be: defaults, migration, doctor, and
  the status surface?
- Does it stay consistent with the governed-autonomy stance
  (`../system/governed_autonomy_principles.md`)?

## Output

Record findings in the Observer report's "System impact" section (`Not
applicable` when the change is local and has no system ripple). Name the verdict
impact (does this raise a REWORK or a BLOCK, or is it informational).

Generalized project knowledge, Librarian-maintained under PM approval. See also
`../quality/cross_artifact_consistency.md` for the same drift checked as a Smith
hardening test perspective rather than a review layer.
