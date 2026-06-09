---
knowledge_id: security.dependency_policy
title: Dependency Policy (Garelier default — edit per project)
category: security
status: active
owners:
  - pm
consumers:
  - smith
  - guardian
source_ids:
  - project-original
last_reviewed_at: 2026-06-08
review_cycle: on-change
---

# Dependency Policy (Garelier default — edit per project)

Prefer maintained, widely-used packages under an allowlisted license
(`license_policy.md`).

## BLOCK

- a **critical / high** vulnerability with no recorded exception
  (`registries/vulnerability_exceptions.toml`);
- a **denylisted package** (`registries/dependency_denylist.toml`);
- a **denylisted license** (`registries/license_denylist.toml`);
- a known-malicious / typosquat package.

## Note (PASS_WITH_NOTES)

- a moderate / low vulnerability with a fix path;
- a new transitive dependency (surface it, don't silently accept);
- an unknown license (raise a `knowledge_update_request`).

## Triggers

Lockfile / manifest changes trigger the dependency gate
(`[guardian_policy].require_for_lockfile_changes` /
`require_for_dependency_changes`). Suggested scanners: `npm audit`,
`cargo audit`, `pip-audit`, `osv-scanner`.
