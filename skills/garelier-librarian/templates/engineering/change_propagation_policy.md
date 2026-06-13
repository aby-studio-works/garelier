---
knowledge_id: engineering.change_propagation_policy
title: Change Propagation Policy
category: engineering
status: active
owners:
  - pm
consumers:
  - worker
  - artisan
  - smith
  - observer
source_ids:
  - project-original
last_reviewed_at: 2026-06-12
review_cycle: on-change
---

# Change Propagation Policy

The complement of `change_isolation_policy.md`: isolation keeps you from
touching anything UNRELATED; propagation makes you touch EVERYTHING RELATED.
The classic failure this prevents: a definition is changed, the build passes,
and a consumer nobody re-checked breaks later — in a test-only cfg, behind a
feature flag, in a twin script, or in a doc that now lies. Most feature work
on an existing codebase is propagation work; treat the census below as part
of the implementation, not as cleanup.

## Step 1 — Consumer census BEFORE designing the change

A change to any of the following is not designed until you have ENUMERATED
its consumers (search the whole repo, then list them in your working notes):

| You are changing | Consumers to enumerate |
| --- | --- |
| a function / method signature | every call site, trait impls, mocks/fakes in tests |
| a type / struct field / enum variant | every constructor (incl. struct literals in OTHER crates and `cfg(test)` code), match arms, serializers |
| a file format / schema / wire shape | every reader AND writer, fixtures, golden files, migration notes |
| a name (rename / move) | twins and parallels: the sibling `.sh`/`.ps1`, the mirrored doc, configs, CI scripts, string references |
| observable behavior / output text | tests asserting it, docs/README claiming it, downstream parsers |

Rules of the census:

- **Gated code counts.** `cfg(test)`, feature-gated, platform-gated, and
  example/bench code are consumers that a default build never compiles —
  search them explicitly; a green `build` proves nothing about them.
- **Docs and comments are consumers.** A claim about the old behavior that
  survives the change is a bug with a delay.
- **Cross-boundary literals.** Struct literals / constructors in OTHER
  modules and crates break on private-field and field-order changes; find
  them by symbol search, not by compiler optimism.

## Step 2 — Closure rule

The change is complete only when every enumerated consumer is either
**updated** or **explicitly listed as unaffected with a reason** in
`report.md`. An unexamined consumer is an open item, not an assumption.
If the census reveals consumers outside your assignment scope, STOP and
escalate scope (`questions.md`) — do not silently widen, do not silently
skip.

## Step 3 — Verify the OLD behavior, not just the new

Verification asymmetry is the failure mode: producers test what they added
and not what they might have broken.

1. Run the gates at FULL surface: workspace-wide, `--all-targets` (or the
   stack's equivalent that compiles tests/benches/examples), so gated
   consumers actually compile.
2. For refactors and behavior-neutral changes: capture observable behavior
   BEFORE the change (existing test output, a golden/snapshot artifact, a
   targeted before/after diff of the output) and show it is IDENTICAL
   after. "All new tests pass" is not parity evidence.
3. Re-read your own full diff at the end, asking only two questions per
   hunk: "did I intend this?" and "who consumes this line?" — unintended
   hunks and unexamined consumers are removed or resolved before the
   gate, never explained afterwards.

## Relationship to the other policies

- `change_isolation_policy.md` — what NOT to touch (stay on-topic).
- This policy — what you MUST touch (complete the propagation).
- `debugging_principles.md` First moves — when something still breaks,
  classify the layer before fixing.
