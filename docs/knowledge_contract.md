# Garelier Knowledge Contract

This is the canonical knowledge-management contract used by full Garelier's
Librarian and the standalone `garelier-control-library` skill.

## Storage

Garelier knowledge is stored in **two tracked layers**, both under
`__garelier/` (DEC-077). Knowledge never lives in the project's own `docs/`.

**Shared layer (tracked) — `__garelier/__atmos/knowledge/`.** The
general-purpose `__atmos` shared tier; knowledge is one tenant under it. This is
the project-wide, pm-independent layer that wins by default on a `knowledge_id`
conflict; it is created ON DEMAND (it does not exist at first setup) when the
user decides to share knowledge project-wide. Registries, categories, and role
trees sit directly under `knowledge/`:

```text
__garelier/__atmos/knowledge/
├── knowledge.toml
├── role_index.toml
├── source_registry.toml
├── routine_registry.toml
├── <category>/
│   ├── index.md
│   └── <topic>.md
├── runbooks/
└── manuals/
```

**Per-pm layer (tracked) — `__garelier/<pm_id>/knowledge/`.** The working
knowledge home, seeded at setup; a sibling of `control/` and `runtime/`, using
the same knowledge shape as the shared layer. "Personal" here denotes SCOPE
(this pm_id vs shared), not privacy: it is git-tracked and reaches `<target>`
via promote just like `control/`.

```text
__garelier/<pm_id>/knowledge/
├── knowledge.toml
├── role_index.toml
├── source_registry.toml
├── routine_registry.toml
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

Use `_workshop` as the default per-pm `pm_id` when `garelier-control-library`
is used without another evident namespace. If multiple namespaces exist, the AI
must list them and ask which staging/management context to use; it never
silently chooses one. Raw/cache/drafts/reports are gitignored and never
exported.

Under `__garelier/`, the `__` (double-underscore) prefix is reserved for shared
/ non-pm namespaces, so `__atmos` is structurally never a pm — pm-ness requires
`_pm/setup_config.toml`, so doctor/status pm-autodetect and within-pm container
scans never enumerate `__atmos` as a pm. A role acting for pm X reads only
`[shared __atmos, this pm]`, never another pm's layer.

Quick reference — where knowledge lives:

| Location | Role |
| --- | --- |
| `__garelier/__atmos/knowledge/` | Project-wide shared knowledge (canonical on conflict). |
| `__garelier/<pm_id>/knowledge/` | This pm's additive knowledge layer. |
| `docs/rules/` | Project-visible rules mirror / deliverable for humans — NOT part of the knowledge store. |

## Layered resolution

Knowledge now carries an additive per-pm layer on top of the shared layer
(DEC-077). Resolution is **shared-priority + per-pm-additive**:

- A role acting for pm X reads the layer list
  `[__garelier/__atmos/knowledge (shared), __garelier/<pm_id-X>/knowledge (pm)]`
  and never another pm's layer.
- `role_index.toml` entries are unioned across the two layers, shared first.
- On a `knowledge_id` (`<category>.<topic>`) conflict the **shared layer wins by
  default**. The per-pm layer is otherwise additive — it ADDs ids absent from the
  shared layer. The one exception is an explicit, auditable per-topic opt-in: a
  per-pm topic whose YAML front matter sets `override_shared: true` wins over the
  shared copy for that one `knowledge_id`. Absent that flag the secondary layer is
  additive, never an override — this is what honors the hard invariant "never
  *silently* change the meaning of a rule".
- The graph validator runs over both layers and warns `shadowed-by-shared` when a
  per-pm id collides with a shared id, except where the per-pm topic sets
  `override_shared: true` (the override is intentional and honored, so no
  warning).
- Knowledge bundles export both layers (the shared `__atmos` layer and the per-pm
  layer) plus the project's own `docs/rules/` rules tree, limited to git-tracked,
  secret/PII-clean content.

## Knowledge identity

`__garelier/__atmos/knowledge/knowledge.toml` identifies the schema (the same
marker file identifies a per-pm layer at
`__garelier/<pm_id>/knowledge/knowledge.toml`):

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
the active rule harder to identify. Retrieve progressively, resolving across
both layers (shared first, then this pm's layer):

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
- Reachability: ship every new doc WITH a read path — an index Consumption-rules
  "when to read" row, plus a narrow `role_index.toml` `[[triggers]]` entry when it
  applies by what the work touches. A doc reachable by neither is an orphan (it
  ships but is never read). Do not promote to `read_first` merely for reach — that
  defeats the token-budget split. See the `role_index.toml` header (DEC-090).
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
6. move only reviewed, license-clean, original-wording knowledge into this pm's
   `__garelier/<pm_id>/knowledge/` layer (the default, seeded working home);
   promote a topic into the shared `__garelier/__atmos/knowledge/` layer only
   when the user explicitly decides it is project-wide shared knowledge,
   creating the `__atmos` tier on demand if absent. This write-target choice is
   separate from the read-time rule that the shared layer wins on a
   `knowledge_id` conflict;
7. commit curated knowledge only.

Export only tracked, reviewed, secret/PII-clean knowledge. Never export runtime
working data.
