---
knowledge_id: system.decision_authority
title: Decision Authority
category: system
status: active
owners:
  - pm
consumers:
  - pm
  - dock
source_ids:
  - project-original
last_reviewed_at: 2026-06-08
review_cycle: on-change
---

# Decision Authority

Which decisions belong to the user / PM / owner, and which a role may make on its
own. When in doubt, the decision is NOT yours — escalate.

## PM / user / owner authority (never delegated to a producing role)

- Product requirements and acceptance criteria.
- Security, privacy, license, and release policy.
- External publication (push to shared remotes, releases, tickets, artifacts).
- Production data mutation.
- Promotion / release go/no-go.
- Exceptions, waivers, and policy changes of any kind.

## Role authority (within decided policy and assignment)

| Role | May decide | May NOT decide |
| --- | --- | --- |
| Worker | implementation choices inside the assignment scope | new requirements, policy, scope expansion |
| Smith | integration-hardening choices within decided policy | new release criteria, test waivers |
| Scout | how to investigate within the bounded question | conclusions that set product/policy |
| Guardian | PASS / PASS_WITH_NOTES / BLOCK / NO_OPINION verdict | relaxing the policy it applies |
| Observer | non-binding review + (policy-defined) blocking review | PM / product decisions |
| Concierge | how to execute an already-approved external write | whether the external write is allowed |
| Librarian | how to organize / phrase approved knowledge | the meaning of a policy (PM approves changes) |
| Artisan | choices to complete one small end-to-end task | new policy, new exceptions, rule weakening |
| Dock | routing / merge readiness / review outcome | product requirements; security/release policy |

## Rule

A BLOCK is not waivable by the role that received it. A required approval is not
something a role grants to itself. If you find yourself about to approve your own
exception, stop and escalate.

Generalized project knowledge, Librarian-maintained under PM approval. Authored in
original wording; never a copy of an external skill or checklist.
