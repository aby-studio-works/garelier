---
knowledge_id: system.codex_provider_transport
title: Codex Provider Transport Boundary and Diagnosis
category: system
status: active
owners:
  - pm
consumers:
  - pm
  - dock
  - worker
  - scout
  - smith
  - artisan
  - librarian
  - observer
  - guardian
  - concierge
source_ids:
  - project-original
last_reviewed_at: 2026-08-30
review_cycle: on-change
---

# Codex Provider Transport Boundary and Diagnosis

## Purpose

Use this reference to classify a Codex/OpenAI provider transport failure without
confusing provider availability, the trusted outer host, and the inner Garelier
role boundary. It is advisory diagnostic information: it neither grants
permission nor makes a provider, model, host, or route mandatory.

## Rules

### Trusted outer host boundary

- A trusted outer host covers TLS establishment, credential handling, and the
  execution context of the provider client. "Trusted" means that existing
  project authority permits that host to perform those outer responsibilities;
  it is not a new grant.
- The outer host does **not** broaden the selected model, configured
  destination, prompt contents, attached context, inner role sandbox, allowed
  tools, or write authority. Those remain fixed by their existing configuration,
  assignment, role binding, and project policy.
- A successful outer connection does not prove that an inner role may read,
  execute, or write anything beyond its seat authorization. Conversely, an
  inner sandbox denial does not establish a TLS or provider outage.

### Cloud transport and confidentiality

- Cloud Codex sends the prompt, the context necessary for the request, and
  relevant tool output to the configured OpenAI provider. Authorized request
  data therefore reaches that provider. This transport is not public
  publication and does not authorize any additional recipient, but it is also
  not a guarantee that repository-derived text never leaves the PC.
- Send only context already authorized and necessary for the task. Existing
  confidentiality, secret, credential, customer-data, and PII boundaries remain
  authoritative; transport through a trusted host does not waive them.
- Provider transport is not web-search permission. Project-specific rules still
  decide whether a role may browse, what sources it may use, and what retrieved
  content may enter a prompt or durable artifact.
- This reference makes no claim about provider retention, training, or other
  service data-handling terms. Establish those separately from the applicable
  current provider terms and project decisions when the question matters.

### Three distinct failure domains

| Failure domain | What it covers | What it does not imply |
| --- | --- | --- |
| Provider / service outage | Availability or failure of the configured OpenAI provider service | No automatic change of provider, model, destination, or role authority |
| Outer trusted-host / auth / TLS failure | Provider-client execution context, credential availability or acceptance, and TLS establishment | No defect in the inner role sandbox and no permission to disable it |
| Inner role sandbox / seat authorization | Role binding, sandbox, allowed tools and paths, and write grant | No provider outage and no authority for the outer host to widen the seat |

## Application

1. Record the failing stage and the exact, sanitized error or result pointer.
   Never place credentials, secrets, PII, or unnecessary prompt contents in the
   diagnostic record.
2. Classify the observation into one of the three domains. If the evidence does
   not distinguish them, report the domain as unknown instead of guessing.
3. Keep the remedy inside the same authority boundary. Do not disable a sandbox
   to address TLS, widen prompt contents to address provider availability, or
   treat a successful provider response as a write grant.
4. Use the project's existing routing and escalation rules for retries,
   provider/model choices, credential repair, or seat changes. A failure does
   not authorize automatic privilege elevation, provider switching, or seat
   widening.

## Exceptions and escalation

- There is no exception in this reference that permits sending forbidden
  content, changing the configured destination, weakening the inner sandbox, or
  expanding write authority.
- Escalate to the PM / owner when the failing domain remains unknown, a
  provider or model choice is needed, confidentiality policy does not resolve
  what context may be sent, or a credential / trust decision is required.
- Apply any project-specific provider, confidentiality, or web-search rule when
  it is stricter than this general diagnostic reference.

## References

- `system/decision_authority.md` — who decides provider, policy, and exceptions.
- `system/role_boundary_matrix.md` — inner role and write boundaries.
- `system/escalation_policy.md` — unresolved-domain and authority escalation.
- `security/security_policy.md` and `security/privacy_pii_policy.md` — secret,
  credential, customer-data, PII, trusted-artifact, and redacted-evidence rules
  for source, fixtures, logs, samples, commits, and durable artifacts.
- `garelier-core/references/codex_worker_playbook.md` — managed Codex launch and
  operational troubleshooting details; it does not widen this reference.
