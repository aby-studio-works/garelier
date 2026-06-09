---
knowledge_id: quality.coverage_evidence_policy
title: Coverage Evidence Policy
category: quality
status: active
owners:
  - pm
consumers:
  - smith
  - artisan
source_ids:
  - project-original
last_reviewed_at: 2026-06-08
review_cycle: on-change
---

# Coverage Evidence Policy

What "coverage" means in Garelier. It is broader than a line-coverage percentage:
it is the evidence that the **assignment** is covered. Original wording.

## Principles

- Coverage = assignment coverage, not just a coverage tool's number.
- Every acceptance criterion carries an **evidence pointer**.
- Show evidence as: a test command, an output artifact path, a commit, a diff
  range, or a `path:line` — not a pasted log (see `../engineering/evidence_policy.md`).
- Avoid a PASS with no evidence.
- A line-coverage number is supporting evidence, not proof that the requirement
  is met.

## Mapping

For each acceptance criterion, record:

- what proves it (test name / artifact / pointer),
- where the artifact is,
- and, if it is not directly testable, the alternative evidence and why.

Do not paste large coverage reports into a handoff; reference the report path.

Generalized project knowledge, Librarian-maintained under PM approval.
