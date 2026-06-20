# Library Management Workflow

## Session start

1. Read the knowledge contract and `knowledge.toml`.
2. Inspect the derived graph findings.
3. Read the relevant category index, topic docs, role index, and registries.
4. Compare knowledge claims with their registered sources and project reality.

## Add or update knowledge

1. Identify the owner, consumers, category, and whether meaning is already
   approved.
2. For external material, register/verify source authority, license, allowed
   use, and review date before adoption.
3. Draft using `knowledge_document.md` in original project wording, into the
   resolved pm's per-pm layer (`__garelier/<pm_id>/knowledge/`, e.g. `_workshop`)
   by default; promote to the shared `__garelier/__atmos/knowledge/` tier only on
   an explicit user decision to share project-wide (created on demand).
4. Update the category index and relevant role/source/routine relationships.
5. Validate the graph and resolve dangling references or conflicts.
6. Commit one coherent, reviewed knowledge outcome.

## Promotion gate (standalone — substitutes for Dock review)

Full Garelier routes knowledge through a `shelf` branch + Dock review. The
standalone `garelier-control-library` has no Dock, so before promoting a draft
from `runtime/librarian/` into the tracked knowledge trees — and ALWAYS before
changing the meaning of a rule or writing to the shared `__atmos` layer — show
the user and get explicit approval:

- source id (and rights basis)
- changed `knowledge_id`(s)
- meaning change: yes / no
- target layer: per-pm `<pm_id>/knowledge/` or shared `__atmos/knowledge/`
- owner approval needed: yes / no
- knowledge-graph validation result

Apply only after explicit user approval for any rule-meaning change or shared
`__atmos` promotion. A purely additive per-pm topic with no meaning change may
proceed once the graph validates.

## Answer a knowledge question

1. Do not bulk-read the tree.
2. Read at most the relevant role entry, one category index, and graph metadata
   first.
3. Search the smallest candidate set for exact terms/headings and read only the
   matching sections/ranges.
4. Open a complete topic only when its full rule set is necessary.
5. Return compact pointers (`path:line`) and a one-line conclusion; stop once
   sufficient authoritative pointers answer.
6. Distinguish durable rule from current project observation.
7. Say `not covered` when evidence is absent; name the next correct action.

## Review discipline

- Do not duplicate the same rule across many files; link to its canonical body.
- Make exceptions explicit, owner-approved, and discoverable.
- Remove superseded/stale claims or mark them clearly in the same commit.
- Keep raw evidence outside tracked knowledge unless it is license/PII-clean and
  intentionally curated.
