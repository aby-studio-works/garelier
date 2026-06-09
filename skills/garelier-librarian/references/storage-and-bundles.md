# Librarian reference: storage layout and knowledge bundles

Detail for `garelier-librarian` §2. Covers the tracked-vs-local-only storage
split (DEC-038) and knowledge bundle export/import (DEC-048). The SKILL keeps
the hard invariant: **never commit raw external content** (unknown license,
size, or PII risk).

## Storage: tracked (committed) vs local-only (working) — DEC-038

Keep the two strictly separated — the Librarian's analogue of control/runtime:

- **Tracked (committed, shared)** — curated, shareable knowledge:
  `docs/garelier/<category>/*.md` (engineering / quality / review / system /
  security / external_operations), `docs/garelier/runbooks/`,
  `docs/garelier/manuals/`, `docs/rules/`, and the registries under
  `docs/garelier/knowledge/`. These land via a `shelf` branch + Dock review.
- **Local-only (gitignored, machine-local, NEVER committed)** —
  `__garelier/<pm_id>/runtime/librarian/`: `raw/` (raw external pulls before
  review), `cache/` (per-source sync caches), `drafts/` (pre-publication drafts).

Work in `runtime/librarian/` (fetch → cache → draft), then **promote** only the
generalized, license-clean result into the tracked tree. Never commit raw
external content — unknown license, size, or PII risk (see
`commit_hygiene_policy.md`, `license_policy.md`, and
`provenance_rights_policy.md`).

`garelier-control-library` is the standalone Garelier Control form of this
discipline. It uses the same tracked trees, working area, contract, templates,
graph, and bundle scripts, but has no shelf branch or Dock review. Do not create
an alternate format for it.

## Knowledge bundles: export / import (DEC-048)

Move curated knowledge between Garelier projects with `scripts/knowledge_export.{sh,ps1}`
and `scripts/knowledge_import.{sh,ps1}` (input/output are mandatory explicit args):

- **Export** (`--to <dest>`) emits ONLY the **tracked, license/PII-clean** curated
  knowledge (`docs/garelier/*` trees + `knowledge/*.toml` + runbooks/manuals +
  `docs/rules`) with a `knowledge_bundle_manifest.toml` (per-file content id +
  provenance). It **never** exports the local-only `runtime/librarian/{raw,cache,
  drafts}` (DEC-038). Publishing a bundle outside the sandbox is Concierge +
  Guardian (DEC-024 / DEC-025).
- **Import** (`--from <bundle>`) is **not a free adoption**. It **stages** the
  bundle into `runtime/librarian/raw/imported-<name>/` (local-only, gitignored)
  and emits a conservative `source_registry` stub (`license = "unknown"`, `use =
  "inspiration-only"`). You then, **on a `shelf` branch**: confirm the license,
  register the source, generalize into original wording with provenance, **BLOCK +
  escalate to PM on any rule conflict**, and promote only the reviewed,
  license-clean result through Dock review. The scripts never write the
  tracked trees directly.
