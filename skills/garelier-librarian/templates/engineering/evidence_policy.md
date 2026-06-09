---
knowledge_id: engineering.evidence_policy
title: Evidence Policy
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

# Evidence Policy

What counts as proof that a change does what it claims. Shared by engineering and
quality work; see also `../quality/coverage_evidence_policy.md`. Original wording.

## Evidence is a pointer, not a paste

- Show evidence as: a command run, an output artifact path, a commit SHA, a diff
  range, a `path:line` reference, or a test name — not a pasted log/diff/report
  body (that is what `garelier-core/compact_handoff.md` forbids).
- Each acceptance criterion should have at least one evidence pointer.

## Standards

- Prefer reproducible evidence: a command anyone can re-run, with the output
  written to a known path.
- Avoid a PASS with no evidence. "It works" without a pointer is not evidence.
- Never put secrets, PII, tokens, or customer data in evidence. Redact to a
  pointer; if a real secret was exposed, flag it for rotation.
- Exact values matter: reproduce commands, paths, error text, numbers, and commit
  SHAs verbatim — do not abbreviate them to save space.

## In the report

- List evidence pointers grouped by what they prove.
- If a part cannot be tested or evidenced, say so explicitly and give the reason
  and any alternative evidence — do not imply coverage you do not have.

This file is generalized project knowledge, Librarian-maintained under PM
approval.
