---
knowledge_id: review.review_evidence_policy
title: Review Evidence Policy
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

# Review Evidence Policy

What a reviewer relies on, and how a review records its own evidence. Original
wording; project-specific.

## What a review trusts

- The diff, the `report.md`, the quality-gate artifacts, and the relevant
  official files — not the author's narrative alone.
- Evidence as pointers (artifact path, commit, `path:line`, test name), not
  pasted bodies (`garelier-core/compact_handoff.md`).

## How a review records evidence

- For each finding, give a concrete pointer to what supports it (file, line,
  diff range, gate output path).
- Distinguish a confirmed problem from a question or a hunch; label them.
- A verdict (PASS / REWORK_RECOMMENDED / BLOCK where applicable) cites the
  findings that drive it.

## Plausibility, not re-execution

- The Observer judges whether the presented evidence is plausible and sufficient,
  and flags gaps; it is not required to re-run the whole gate.
- If the evidence is missing or implausible, that is itself a finding.

Generalized project knowledge, Librarian-maintained under PM approval.
