---
knowledge_id: quality.test_strategy
title: Test Strategy
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

# Test Strategy

How to choose the right kind of test for the risk and change surface — especially
for Smith integration hardening. Original wording; project-specific.

## Test kinds and when they fit

| Kind | Fits |
| --- | --- |
| Unit | local logic, pure functions, small boundaries |
| Contract | API / schema / serialized format / protocol compatibility |
| Integration | module interaction, merged studio state |
| System / end-to-end | a user-visible path or a whole subsystem path |
| Smoke | the minimum release-confidence path |
| Regression | a previously failed scenario or a reproduced bug |
| Property / fuzz | inputs with a large space (parsers, validators, encoders) |
| Snapshot / golden | stable serialized output (formats, generated text, UI) |
| Cross-artifact consistency | paired/mirrored artifacts that must agree — spec↔code, schema↔consumer, two-OS scripts, enumerations, references (`cross_artifact_consistency.md`) |

## How to choose

- Match the test kind to the **risk** and the **change surface**, not to a habit.
  A one-line pure-function fix does not need an end-to-end test; a cross-module
  contract change does.
- Do not demand every kind of test for every change.
- Smith looks for what unit-level success hides: cross-module breakage after
  merge, contract drift, release-tooling regressions, and **cross-artifact
  drift** — references, mirrors, dual-OS scripts, enumerations, and
  declaration↔consumer pairs left stale by the merge (`cross_artifact_consistency.md`).
- Smith does **not** fill missing feature scope with new feature implementation —
  that is Worker/Artisan work; route it back.

## When something cannot be tested

State the reason and provide alternative evidence (see
`coverage_evidence_policy.md`). Do not imply coverage you do not have.
