# Quality Knowledge Index

Durable quality, testing, regression, and evidence knowledge for this project.
Reference knowledge, not a role's action spec. The project quality GATE itself
remains canonical in `AGENTS.md`; this tree explains how to reason about quality
around it.

- Owner: PM / quality owner
- Maintainer: Librarian (applies PM-approved updates)
- Consumers: Smith, Worker, Artisan, Dock, Observer
- Location (in target projects): `docs/garelier/quality/`

## Canonical files

| Topic | File | Primary consumers |
| --- | --- | --- |
| Test strategy | `test_strategy.md` | Smith, Worker, Artisan |
| Quality gate policy | `quality_gate_policy.md` | Worker, Smith, Artisan, Dock |
| Regression policy | `regression_policy.md` | Smith, Worker, Artisan |
| Coverage evidence | `coverage_evidence_policy.md` | Worker, Smith, Observer |
| Flaky test handling | `flaky_test_policy.md` | Worker, Smith, Artisan |
| Cross-artifact consistency | `cross_artifact_consistency.md` | Smith, Worker, Artisan, Observer |

## Consumption rules

| Role | When to read | May edit? |
| --- | --- | --- |
| Smith | every hardening assignment | no |
| Worker | when adding/fixing tests or a quality gate fails | no |
| Artisan | before self-review and premerge | no, unless assigned knowledge work |
| Observer | when reviewing test/gate evidence plausibility | no |
| Dock | when judging review/merge readiness | no |
| Librarian | assigned updates only | yes, with Dock shelf review |

Generalized project knowledge; never a copy of an external skill or checklist.
