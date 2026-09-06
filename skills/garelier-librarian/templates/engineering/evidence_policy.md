---
knowledge_id: engineering.evidence_policy
title: Evidence Policy
category: engineering
status: active
owners:
  - pm
consumers:
  - worker
  - smith
  - artisan
  - dock
  - observer
source_ids:
  - project-original
last_reviewed_at: 2026-08-02
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
- Bind lifecycle claims to the artifact that proves that exact state. An agent
  completion event proves only that its turn returned; it does not prove report
  acceptance, a proxy/local commit, Guardian/Observer approval, a formal gate,
  a `studio` merge, or land aftercare. Use the exact commit SHA, gate request and
  result, merge result, and terminal aftercare journal as applicable, and never
  infer a later state from an earlier event.
- A claimed observable runtime effect needs a project-defined actual run in the
  intended runtime or a representative configured environment. Helper output,
  unit tests, mocks, compilation, and test-only wiring are supporting evidence;
  they do not alone prove that the production path is connected and observable.
- Every external command/subprocess evidence record includes its finite timeout
  boundary and distinguishes success, non-zero failure, timeout, and unavailable
  execution authority.
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
