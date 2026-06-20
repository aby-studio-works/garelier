---
name: garelier-control-library
requires: garelier-core ~2.6
description: >-
  Garelier-only — fire only in a Garelier project (`__garelier/<pm_id>/` tree
  exists) or on explicit Garelier/control-library invocation, never on generic
  knowledge/registry wording. Teach the running Claude Code or Codex session to
  retrieve, curate, standardize, import/export, and maintain project knowledge in
  Garelier's knowledge trees, role/source/routine registries, provenance,
  runbooks, and derived knowledge graph. A standalone library / knowledge-management
  starter or paired with garelier-control-project; stages to
  __garelier/<pm_id>/runtime/librarian/ without the Librarian role, shelf branches,
  Dock, or driver.
---

# Garelier Library Control

This skill turns the **currently running AI** into a project librarian. It uses
the same curated knowledge trees, registries, provenance/import-export rules,
templates, and graph as full Garelier's Librarian, without enabling roles,
shelf branches, Dock, or driver.

It composes with `garelier-control-project`: project control manages durable
project authority under `__garelier/<pm_id>/control/`;
`garelier-control-library` manages curated knowledge in two tracked layers
(DEC-077) — the shared, project-wide `__garelier/__atmos/knowledge/` tier plus
the additive per-pm `__garelier/<pm_id>/knowledge/` layer.

Together they form the standalone **Garelier Control** management plane. Full
Garelier can be added later, but is not required to keep using this plane.

## Activation

1. Read `../garelier-librarian/knowledge_contract.md`.
2. Read the `knowledge.toml` knowledge marker and the relevant indexes and
   registries when present.
3. Resolve the staging `pm_id`:
   - use the id explicitly named by the user;
   - otherwise use the sole evident control/full-PM namespace;
   - if multiple namespaces exist, list them and ask which staging/management
     context to use; never silently choose one;
   - otherwise default to `_workshop`.
4. Treat the shared `__garelier/__atmos/knowledge/` tier and the per-pm
   `__garelier/<pm_id>/knowledge/` layer as tracked curated knowledge, and
   `__garelier/<pm_id>/runtime/librarian/` as local-only working data.

Knowledge has two tracked layers (DEC-077): the shared, project-wide
`__garelier/__atmos/knowledge/` tier and an additive per-pm
`__garelier/<pm_id>/knowledge/` layer. So choosing a `pm_id` selects both the
staging/management context AND that pm's additive knowledge layer — resolution
is shared-priority + per-pm-additive (same `knowledge_id` → shared wins by
default; the per-pm layer ADDs ids absent from shared, and overrides a shared
topic only via an explicit, auditable `override_shared: true` opt-in).
This skill remains usable from a separately launched AI after full Garelier
starts.

## Initialize

```powershell
garelier library-init -Project <project-root> -PmId _workshop
```

```bash
garelier library-init --project <project-root> --pm-id _workshop
```

Initialization is no-overwrite. It creates the knowledge marker, registry
templates, an empty project category/index, and gitignored staging directories.
It does not seed all full-Garelier policies unless the user asks for them.

## Retrieve

- Never bulk-read the knowledge trees. Full-tree loading is a context-budget defect.
- Start from `role_index.toml` when the question belongs to a known role.
- Otherwise start from the relevant category `index.md`.
- Use graph/registry metadata to narrow candidates, search headings/terms, then
  read only the necessary section of the smallest candidate set.
- Open a complete topic only when the full rule set is needed.
- Follow source/routine relationships and return compact `path:line` pointers
  with one-line conclusions. Stop once authoritative pointers answer.
- If curated knowledge does not answer, say `not covered` and identify the
  correct next step. Do not invent or silently adopt external information.

## Curate

- Use `garelier-librarian/templates/knowledge_document.md` for new/materially
  updated topics and `knowledge_index.md` for category indexes.
- Register external sources before adoption and keep original project wording.
- Keep index, role, source, routine, and runbook references consistent.
- The user/knowledge owner decides rule meaning and exceptions; this AI
  organizes and applies those decisions.
- Read `references/library-management.md` for the detailed workflow.

## Import / export

Read `references/import-export.md`.

- Clean bundles use `garelier-librarian/scripts/knowledge_import` and
  `knowledge_export`.
- Messy input is staged, inventoried for provenance/rights/conflicts,
  normalized into canonical documents, graph-validated, and only then promoted
  into tracked knowledge.

## Validate and graph

```bash
garelier knowledge-graph --project <root> --pm-id <pm_id> --validate
```

Use `--format mermaid` or `--format json` for the derived graph. Full Garelier's
Status Web Knowledge page uses the same graph. The graph contains metadata and
pointers only; it deliberately does not embed topic bodies.

## Boundaries

- This skill curates knowledge only. If the request actually needs code
  execution or project-management state, route per
  `../garelier-core/references/entry_routing.md`.
- Do not treat unregistered external content as authoritative.
- Do not change a rule's meaning or approve an exception without the owner.
- Do not commit/export raw data, secrets, PII, unknown-rights content, or
  unresolved conflicts.
- Do not write durable curated knowledge into `runtime/librarian/`.
