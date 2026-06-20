---
knowledge_id: security.provenance_rights_policy
title: Provenance & Rights Policy
category: security
status: active
owners:
  - pm
consumers:
  - librarian
  - guardian
source_ids:
  - project-original
last_reviewed_at: 2026-06-08
review_cycle: on-change
---

# Provenance & Rights Policy

Operational policy for importing, summarizing, exporting, or publishing external
knowledge. This is a risk-control rule, not legal advice. If the allowed use is
unclear, BLOCK and escalate to PM / owner.

## Core rule

Curated Garelier knowledge must be original project wording with provenance.
Never commit raw external text, copied checklist structure, screenshots, PDFs,
or large excerpts into the knowledge trees, the project's `docs/rules/` rules
tree, runbooks, reports, or knowledge bundles.

## Source registry requirements

Every external `source_registry.toml` entry (`source_type = "url"` or
`"sharepoint"`) must record:

- `authority`: `official`, `recognized`, `internal`, or `third-party`
- `license`: `confirmed`, `unknown`, or `not-adoptable`
- `use`: `internal-policy-source`, `allowed-summary`, or `inspiration-only`
- `last_reviewed_at`: when PM / owner last confirmed the rights basis

Use rules:

- `license = "confirmed"` plus `use = "internal-policy-source"` or
  `"allowed-summary"` may be generalized into tracked project knowledge.
- `license = "unknown"` is inspiration-only: keep raw material in
  `runtime/librarian/raw|cache|drafts`, do not export it, and do not make it an
  authoritative project rule.
- `license = "not-adoptable"` must not be adopted, exported, or published.

## Transform rules

- Prefer facts, decisions, and project-specific actions over source wording.
- Keep only short, necessary quotations when PM / owner explicitly approves the
  use and the quote is required to preserve meaning.
- Preserve attribution by `source_id`, title, source type, transform, owner, and
  `last_synced_at` front matter in the target Markdown.
- If faithful use requires copying expressive wording or the source's structure,
  stop and ask for permission or a different source.

## Export / publication

Knowledge export is allowed only for git-tracked, clean, secret/PII-clean
curated files. Any `license = "unknown"` or `license = "not-adoptable"` in the
exported provenance or source registry is a hard stop. Publishing the bundle,
release notes, PR body, ticket update, or other external text still goes through
Concierge + Guardian.
