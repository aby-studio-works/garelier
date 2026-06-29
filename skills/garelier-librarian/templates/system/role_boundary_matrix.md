---
knowledge_id: system.role_boundary_matrix
title: Role Boundary Matrix
category: system
status: active
owners:
  - pm
consumers:
  - dock
source_ids:
  - project-original
last_reviewed_at: 2026-06-29
review_cycle: on-change
---

# Role Boundary Matrix

Who is allowed to do what. When a task seems to need an action your role does not
own, the work is misrouted — hand it back to PM / Dock rather than crossing
the line. This mirrors `garelier-core/protocol.md` (authority) and the role
SKILLs; it is the quick-reference, not a re-definition.

| Concern | Owner role(s) | Notes |
| --- | --- | --- |
| User intent → policy, priority, acceptance criteria | PM | The only role that decides *what* and *why* |
| Assignment / routing / integration / merge into studio | Dock | Does not implement source (except base-track conflict resolution) |
| Scoped implementation (commits on a workbench) | Worker | Stays inside the assignment scope |
| Bounded investigation (no commits; an inspection) | Scout | Output is a draft inspection, not code |
| Post-merge hardening / integration / release-tooling | Smith | Repairs integration; does not implement missing feature scope |
| Durable knowledge / registries / runbooks / source sync | Librarian | Maintains approved knowledge; does not decide policy |
| Independent review / user-perspective / system-impact | Observer | Advice + (policy-defined) blocking review; no PM/product decision |
| Security / privacy / dependency / license gate | Guardian | Emits a verdict; never merges; does not maintain the policy |
| External write (push / promote / release / sync / publish) | Concierge | Executes the PM-approved method; never decides it |
| Single-agent end-to-end task under constraints | Artisan | Worker+Scout+Smith+Librarian-like scope (investigation/web research included); cannot approve new policy/exceptions |
| Merge / promote execution | Dock (studio), Concierge (target, PM-approved) | Mechanical; gated |
| Product requirement / release / external publication decision | PM / user / owner | Never delegated to a producing role |

## Rules

- A boundary is crossed the moment a role decides something only PM/owner may
  decide, or writes outside what its role permits.
- Discoveries outside your scope go to `backlog` / `questions.md`, not into your
  current change.
- Gate roles (Guardian, Observer-as-blocker) emit verdicts; they do not perform
  the producing work and do not maintain the knowledge they apply.
- The inverse holds too: a gate verdict is a gate-role artifact, so PM and Dock
  never produce one or perform the gate verification (running the
  validators/tests, or reviewing the diff as the gate) in place of a gate agent.
  A held branch (a producer that returned BLOCKED on a since-repaired base
  failure) or a reworked branch is re-gated by running the `jig_gate_held`
  workflow — gate-role agents, per garelier-core `references/mode_e_jig.md` —
  never by hand-dispatching bare gate agents. A stalled or missing gate is
  recovered by re-running the gate workflow with fresh gate-role agents, or
  escalated to PM as a DECISION; it never falls to PM/Dock verification
  (DEC-090).

Generalized project knowledge, Librarian-maintained under PM approval. Not a copy
of any external source.
