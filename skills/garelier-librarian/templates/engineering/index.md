# Engineering Knowledge Index

Durable implementation and debugging knowledge for this project. Reference
knowledge a role reads when it needs it — not a role's action spec.

- Owner: PM / engineering owner
- Maintainer: Librarian (applies PM-approved updates)
- Consumers: Worker, Artisan, Observer, Smith, Dock
- Location (in target projects): `docs/garelier/engineering/`

## Canonical files

| Topic | File | Primary consumers |
| --- | --- | --- |
| Implementation principles | `implementation_principles.md` | Worker, Artisan |
| Debugging principles | `debugging_principles.md` | Worker, Artisan, Observer |
| Change isolation | `change_isolation_policy.md` | Worker, Artisan, Smith |
| Change propagation (consumer census / closure / old-behavior verify) | `change_propagation_policy.md` | Worker, Artisan, Smith, Observer |
| Large-scale refactoring (target/triage → baseline → graph map → strangler steps → enforcement) | `refactoring_playbook.md` | PM, Worker, Artisan, Smith, Observer |
| Evidence standards | `evidence_policy.md` | Worker, Artisan, Observer, Smith |
| Agent-document robustness (mid-tier models) | `mid_tier_model_robustness.md` | Librarian, Worker, Artisan, Observer |
| Dispatch worktree build cache | `dispatch_worktree_build_cache.md` | Worker, Smith, Artisan, Dock |

## Consumption rules

| Role | When to read | May edit? |
| --- | --- | --- |
| Worker | bug fix, refactor, unclear implementation path, repeated quality failure, cross-module behavior change, dependency/build/CI effect | no |
| Artisan | every non-trivial implementation task and every bug fix | no, unless the assignment explicitly includes knowledge work |
| Observer | direction advice and implementation-risk review | no |
| Smith | integration-only repair and hardening design | no |
| Librarian | when assigned to update this tree | yes, with Dock shelf review |

This tree is generalized project knowledge. It is never a copy of an external
skill, guide, or checklist, and it never names a specific public tool's phrasing.
