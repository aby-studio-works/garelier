# Librarian reference: storage layout and knowledge bundles

Detail for `garelier-librarian` §2. Covers the tracked-vs-local-only storage
split (DEC-038) and knowledge bundle export/import (DEC-048). The SKILL keeps
the hard invariant: **never commit raw external content** (unknown license,
size, or PII risk).

## Storage: tracked (committed) vs local-only (working) — DEC-038

Keep the two strictly separated — the Librarian's analogue of control/runtime:

- **Tracked (committed, shared)** — curated, shareable knowledge:
  the `<category>/*.md` knowledge trees (engineering / quality / review / system /
  security / external_operations), the `runbooks/` and
  `manuals/` knowledge trees, and the knowledge registries — all under the
  `__garelier/` knowledge layers. The project's own `docs/rules/` rules tree is a
  separate project-visible deliverable the bundle carries alongside (not part of
  the `__garelier/` knowledge store). These land via a `shelf` branch + Dock
  review.
- **Local-only (gitignored, machine-local, NEVER committed)** —
  `__garelier/<pm_id>/runtime/librarian/`: `raw/` (raw external pulls before
  review), `cache/` (per-source sync caches), `drafts/` (pre-publication drafts).

Work in `runtime/librarian/` (fetch → cache → draft), then **promote** only the
generalized, license-clean result into the tracked tree — by default into THIS
pm's per-pm layer (`__garelier/<pm_id>/knowledge/`, the seeded working home);
write to the shared `__atmos` layer only when the user has explicitly decided
the topic is project-wide (the `__atmos` tier is created on demand). Never commit raw
external content — unknown license, size, or PII risk (see
`commit_hygiene_policy.md`, `license_policy.md`, and
`provenance_rights_policy.md`).

`garelier-control-library` is the standalone Garelier Control form of this
discipline. It uses the same tracked trees, working area, contract, templates,
graph, and bundle scripts, but has no shelf branch or Dock review. Do not create
an alternate format for it.

## Knowledge bundles: export / import (DEC-048)

Move curated knowledge between Garelier projects with `scripts/knowledge_export.sh`
and `scripts/knowledge_import.sh` (input/output are mandatory explicit args; the
Git Bash wrappers run the TypeScript implementations):

- **Export** (`--to <dest>`) emits ONLY the **tracked, license/PII-clean** curated
  knowledge — both layers (shared `__atmos` + per-pm): the knowledge trees +
  `knowledge/*.toml` registries + runbooks/manuals — plus the project's own
  `docs/rules` rules tree, with a `knowledge_bundle_manifest.toml` (per-file content id +
  provenance). It **never** exports the local-only `runtime/librarian/{raw,cache,
  drafts,reports}` (DEC-038). Publishing a bundle outside the sandbox is Concierge +
  Guardian (DEC-024 / DEC-025).
- **Import** (`--from <bundle>`) is **not a free adoption**. It **stages** the
  bundle into `runtime/librarian/raw/imported-<name>/` (local-only, gitignored)
  and emits a conservative `source_registry` stub (`license = "unknown"`, `use =
  "inspiration-only"`). You then, **on a `shelf` branch**: confirm the license,
  register the source, generalize into original wording with provenance, **BLOCK +
  escalate to PM on any rule conflict**, and promote only the reviewed,
  license-clean result through Dock review. The scripts never write the
  tracked trees directly.
