---
knowledge_id: quality.test_driven_development
title: Test-Driven Development
category: quality
status: active
owners:
  - pm
consumers:
  - worker
  - artisan
source_ids:
  - project-original
last_reviewed_at: 2026-06-26
review_cycle: on-change
---

# Test-Driven Development

How to execute a Worker or Artisan assignment when its blueprint or assignment
sets `Test discipline` mode to `tdd`. This is project knowledge, not a blueprint
field; blueprints select the mode, this document defines the practice.

## Contract

- TDD is required only when the assignment says `Mode: tdd`.
- The agent must write or update a test that expresses the intended behavior
  before changing production code for that behavior.
- The first test may be a unit, contract, regression, snapshot, or integration
  test. Choose the smallest level that proves the acceptance criterion.
- A bug fix starts with a reproduction test or a characterization test that
  fails on the current behavior.
- A refactor with no intended behavior change starts from existing passing
  coverage; if coverage is thin, add a characterization test first.

## Red / green / refactor

1. Red: run the new or changed focused test and capture evidence that it fails
   for the expected reason.
2. Green: make the smallest production change that makes the focused test pass.
3. Refactor: clean up while keeping the focused test and the relevant project
   gate green.

Do not fake the red step by asserting an unrelated failure. If the test cannot
be made to fail first because the behavior already exists, record that fact and
switch to coverage evidence for the remaining acceptance criteria.

## Evidence

The completion report must include:

- test path and name,
- red evidence: command plus short failure summary,
- green evidence: command plus short passing summary,
- refactor status: none needed, done with tests still green, or blocked,
- any waiver approved by PM/Dock.

Do not paste long logs. Point to saved output paths or include short terminal
tails only when they are the evidence.

## Escalation

Go BLOCKED before implementing if:

- `Mode: tdd` is set but the assignment does not identify testable behavior;
- no feasible test harness exists and no waiver is recorded;
- a test-first step would require scope outside allowed write paths;
- the assignment asks for `test-first-waived` without a waiver reason.

Generalized project knowledge, Librarian-maintained under PM approval.
