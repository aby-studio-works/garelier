# Review Knowledge Index

Durable review, user-perspective, and system-impact knowledge. Reference
knowledge, not a role's action spec. The Observer's existing
`garelier-observer/references/` stay valid; this tree is the shared,
Librarian-maintained companion that other roles consult too.

- Owner: PM / review owner
- Maintainer: Librarian (applies PM-approved updates)
- Consumers: Observer, Dock, Artisan, Smith, Worker
- Location (in target projects): `docs/garelier/review/`

## Canonical files

| Topic | File | Primary consumers |
| --- | --- | --- |
| Observer review principles | `observer_review_principles.md` | Observer, Dock, Artisan |
| User-perspective review | `user_perspective_review.md` | Observer, PM, Dock, Artisan |
| System-impact review | `system_impact_review.md` | Observer, Smith, Dock |
| Review evidence | `review_evidence_policy.md` | Observer, Dock |

## Consumption rules

| Role | When to read | May edit? |
| --- | --- | --- |
| Observer | every non-trivial review; always for an Artisan premerge | no |
| Dock | merge decision, waiver, or review routing | no |
| Artisan | before self-review and a premerge request | no |
| Smith | when hardening includes user-visible or system-level impact | no |
| Worker | when asking Observer for direction advice | no |
| Librarian | assigned updates only | yes, with Dock shelf review |

Generalized project knowledge; never a copy of an external skill or checklist.
