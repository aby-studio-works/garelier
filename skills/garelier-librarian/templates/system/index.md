# Garelier System Knowledge Index

Durable, system-level principles for how Garelier itself is governed. This is
reference knowledge every role may consult — it is NOT a role's action spec.

- Owner: PM / system owner
- Maintainer: Librarian (applies PM-approved updates; never silently re-decides)
- Consumers: all roles
- Location: the `system/` knowledge tree

## Canonical files

| Topic | File | Primary consumers |
| --- | --- | --- |
| Governed autonomy | `governed_autonomy_principles.md` | all roles |
| Role boundary matrix | `role_boundary_matrix.md` | PM, Dock, all roles |
| Escalation policy | `escalation_policy.md` | all roles |
| Decision authority | `decision_authority.md` | PM, Dock, Guardian, Concierge, Artisan |
| Runtime-capability-aware subagent execution | `subagent_execution.md` | PM, Dock, producing and reviewing roles |
| Codex provider transport boundary and diagnosis | `codex_provider_transport.md` | all roles |
| Backlog → Task-list mirror | `backlog_task_mirror.md` | PM, Dock |

## Consumption rules

| Role | When to read | May edit? |
| --- | --- | --- |
| Any role | role boundary / authority / escalation / system-level consistency is unclear | no |
| Any role | assignment may use independent agents, parallel work, completion events, or explicit waiting | no |
| Any role | Codex provider transport, outer-host TLS/auth, outbound context, or inner sandbox/seat authority is unclear | no |
| PM / Dock | routing, waivers, authority questions | no (PM approves changes; Librarian applies) |
| PM / Dock | working a backlog or applying provider Task operations → refresh the mirror and verify real provider mutation per `backlog_task_mirror.md` | no |
| Librarian | assigned to update this tree | yes, with Dock shelf review |

## How to use

Read the relevant file when a decision is about *who is allowed to do what*, not
about the code itself. Do not invent authority because it is convenient. If the
answer is not here, escalate per `escalation_policy.md` rather than guessing.

This tree is generalized project knowledge. It is never a copy of an external
skill, guide, or checklist; updates are authored in original wording from
PM-approved registered sources only (see the `source_registry.toml` knowledge index).
