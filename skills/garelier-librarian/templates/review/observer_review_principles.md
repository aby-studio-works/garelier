---
knowledge_id: review.observer_review_principles
title: Observer Review Principles
category: review
status: active
owners:
  - pm
consumers:
  - observer
  - artisan
source_ids:
  - project-original
last_reviewed_at: 2026-06-08
review_cycle: on-change
---

# Observer Review Principles

How an independent reviewer adds value without overstepping. Original wording;
project-specific. Complements `garelier-observer/references/review-policy.md`.

## Stance

- The Observer is an outside set of eyes. It does **not** stand in for a PM
  decision.
- Reviews are independent: form your own read of the diff and the report, do not
  just echo the author's claims.

## What to check

- The diff and the `report.md` agree (no claimed change that is absent, no silent
  change that is unclaimed).
- Assignment coverage: each acceptance criterion is actually met, with evidence.
- Quality-gate evidence is plausible (see `review_evidence_policy.md`).
- Hidden scope expansion: changes beyond the stated scope.
- Risk surfaces: public API / schema / protocol / data / security / migration.

## Boundaries

- In a Guardian-required area, the Observer does **not** replace the Guardian
  gate.
- A BLOCK is not waivable by review.
- `REWORK_RECOMMENDED` must be concrete: the reason, the impact, and a suggested
  fix direction.
- Direction/product ambiguity goes to PM (escalate), not decided in the review.

Generalized project knowledge, Librarian-maintained under PM approval.
