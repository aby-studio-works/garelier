---
knowledge_id: quality.integration_hardening_views
title: Integration Hardening Views (Smith window pass)
category: quality
status: active
owners:
  - pm
consumers:
  - smith
  - artisan
  - dock
source_ids:
  - project-original
last_reviewed_at: 2026-06-12
review_cycle: on-change
---

# Integration Hardening Views (Smith window pass)

The ordered perspectives a Smith applies to an ACCUMULATED WINDOW of merges
(`smith_window = <last hardened sha>..<studio tip>`). Per-merge review and
the quality gate already cover each merge alone; the window pass exists for
what only shows up ACROSS merges. Run the views in order; record per-view
findings (or an honest "clean") in the report — an unexamined view is an
open item, not a pass.

## V1. Interaction map first

Build the overlap map before reading any code: which merges in the window
touched the same files / modules / resources? Individually-green changes
break each other exactly at these intersections (two merges each adjusting
the same scheduling, gating, or buffer logic). Deep-read ONLY the
intersections — the disjoint remainder was already reviewed per-merge.

## V2. Contract drift at window scale

For every definition the window changed (type, schema, file format, public
fn), re-run the consumer census (`../engineering/change_propagation_policy.md`)
against the WINDOW-END tree, compiling the FULL surface: workspace-wide
with all targets / feature-union, so test-gated, feature-gated, and
example/bench consumers actually compile. Per-merge gates can each pass
while the union breaks (feature unification, cfg(test) literals).

## V3. Init, ordering, and lifecycle collisions

New resources / systems / hooks added by different merges: double-init,
init missing in one bundle variant, ordering assumptions that two merges
made independently (two new run-conditions starving each other, two
writers to one resource). Search for the window's new registrations and
read their shared schedules.

## V4. Determinism and budget over the window

Run the project's parity / determinism gate ONCE at the window tip (not
just per merge) and compare performance counters against the WINDOW START,
not the previous merge — five 2% regressions hide as noise per-merge and
land as 10% per window. Record start/end numbers in the report.

## V5. Claims vs reality sweep

Docs, specs, comments, and config examples that describe behavior the
window changed: list what the window touched vs what the documentation
still claims (stale counts, renamed terms, removed flags). Fix in-scope
doc drift on the anvil branch; report out-of-scope drift to PM.

## V6. Dependency and license window audit

Diff the lockfile(s) across the whole window: new transitive dependencies
arrive silently through several merges. Check additions against
`../security/dependency_policy.md` / `license_policy.md`; flag anything
undecided (P2 of the constitution).

## V7. Test-debt audit

For the window: tests added vs surfaces touched (which merges shipped
logic with no test?), any weakened / skipped / deleted assertions (P3
audit), and any new flaky markers. Fix integration-level gaps yourself;
return unit-level gaps to PM as backlog candidates, not silent debt.

## Scope discipline

The Smith fixes integration / system / release-tooling / spec-consistency
findings ON the anvil branch (commits allowed). Product feature changes,
new behavior, and policy decisions stay out of scope — report them. A
window verdict of "clean" with the views' evidence is a fully successful
pass; never manufacture findings.
