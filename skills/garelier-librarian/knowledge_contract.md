# Garelier Knowledge Contract

This is the canonical knowledge-management contract used by full Garelier's
Librarian and the standalone `garelier-control-library` skill.

## Storage

Tracked, curated, shared knowledge:

```text
docs/garelier/
├── knowledge/
│   ├── knowledge.toml
│   ├── role_index.toml
│   ├── source_registry.toml
│   └── routine_registry.toml
├── <category>/
│   ├── index.md
│   └── <topic>.md
├── runbooks/
└── manuals/
```

Local-only working data:

```text
__garelier/<pm_id>/runtime/librarian/
├── raw/
├── cache/
├── drafts/
└── reports/
```

Use `_workshop` as the default staging `pm_id` when
`garelier-control-library` is used
without another evident namespace. If multiple namespaces exist, the AI must
list them and ask which staging/management context to use; it never silently
chooses one. Raw/cache/drafts/reports are gitignored and never exported.

## Knowledge identity

`docs/garelier/knowledge/knowledge.toml` identifies the schema:

```toml
schema_version = 1
kind = "garelier_knowledge"
```

## Standard knowledge document

Every new or materially updated curated topic document uses YAML front matter:

```markdown
---
knowledge_id: <category>.<topic>
title: <human title>
category: <category>
status: active
owners:
  - <policy/knowledge owner>
consumers:
  - <role or audience>
source_ids:
  - <registered source id or project-original>
last_reviewed_at: YYYY-MM-DD
review_cycle: on-change
---
```

Required body sections:

```markdown
# <Title>

## Purpose
## Rules
## Application
## Exceptions and escalation
## References
```

Use `source_ids: [project-original]` semantics for original project knowledge
with no external source. External source ids must exist in
`source_registry.toml`; rights/provenance policy still applies.

Index documents use the canonical knowledge-index template and link every
canonical topic in their category. Runbooks use the canonical runbook template
and are registered in `routine_registry.toml`.

## Retrieval

**Do not bulk-read the knowledge tree.** Full-tree reads waste context and make
the active rule harder to identify. Retrieve progressively:

1. `role_index.toml` entry for the active role/audience, when one exists.
   Also match its `[[triggers]]` entries (DEC-067): `when` path-globs /
   keywords against the task text and touched paths — matched `read` docs
   join the read-first set for that task (reviewers match against the diff).
2. Relevant category `index.md`.
3. The derived graph/registries to identify likely topic files and
   relationships. The graph contains metadata/pointers, not document bodies.
4. Search candidate files for exact terms/headings, then read only the relevant
   section/range.
5. Open a full topic document only when its structure or complete rule set is
   necessary for the task.
6. A broad knowledge query over curated indexes/metadata first, then bounded
   topic search, when the normal indexes do not answer.

Return compact pointers (`path:line` plus a one-line conclusion), not pasted
bodies. If curated knowledge does not cover the question, say so; do not invent
an answer or silently adopt an unregistered source.

Retrieval budget:

- Start with at most one role entry, one category index, and graph metadata.
- Expand to the smallest set of candidate topic files that can answer.
- Do not read unrelated categories "for completeness".
- Stop searching once sufficient authoritative pointers answer the question.

## Maintenance

- The knowledge owner decides meaning; the maintaining AI organizes and applies
  approved changes.
- Preserve original project wording. Do not copy external expression or
  structure without an approved rights basis.
- Keep category indexes, `role_index.toml`, source targets, routine manuals, and
  referenced files mutually consistent.
- Use a derived graph/validator to find dangling references and format drift.
- Commit one coherent knowledge outcome with its registry/index updates and
  validation evidence.

## Import and export

Clean bundles use `knowledge_import` / `knowledge_export`.

Messy input:

1. stage under `runtime/librarian/raw/`;
2. inventory provenance, rights, conflicts, and candidate categories;
3. draft under `runtime/librarian/drafts/` using canonical templates;
4. register sources before adoption;
5. validate the knowledge graph and resolve dangling/conflicting references;
6. move only reviewed, license-clean, original-wording knowledge into
   `docs/garelier/`;
7. commit curated knowledge only.

Export only tracked, reviewed, secret/PII-clean knowledge. Never export runtime
working data.
