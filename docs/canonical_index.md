# Canonical Sources / 一次情報の所在

> Garelier keeps two documentation layers (see CLAUDE.md "Two-layer
> documentation"): a human-readable `docs/` summary and the agent-facing
> operational spec under `skills/garelier-core/`. When they disagree, the
> **Primary** column wins — agents act on the Primary source; `docs/` is an
> overview for humans. This index says, for each topic, which file is
> authoritative.

| Topic | Primary (canonical — agents act on this) | Summary (human overview) |
| --- | --- | --- |
| Runtime protocol / file ownership | `skills/garelier-core/protocol.md` | `docs/protocol.md` |
| State machine | `skills/garelier-core/state_machine.md` | `docs/state_machine.md` |
| Compact handoff | `skills/garelier-core/compact_handoff.md` | `docs/compact_handoff.md` |
| Output control | `skills/garelier-core/output_control.md` | `docs/output_control.md` |
| Retention policy | `skills/garelier-core/retention.md` | `docs/retention.md` |
| Pipeline flow | `skills/garelier-core/pipeline_flow.md`, `skills/garelier-core/pipeline_flow.ja.md` | Exact mirrors: `docs/pipeline_flow.md`, `docs/pipeline_flow.ja.md` |
| Status Web Console | `skills/garelier-core/web_console.md`, `skills/garelier-core/web_console.ja.md` | Exact mirrors: `docs/web_console.md`, `docs/web_console.ja.md` |
| Using Garelier (operator guide) | `skills/garelier-core/using_garelier.md`, `skills/garelier-core/using_garelier.ja.md` | Exact mirrors: `docs/using_garelier.md`, `docs/using_garelier.ja.md` |
| Execution backends & token efficiency (DEC-042) | `skills/garelier-core/execution_backends.md`, `skills/garelier-core/execution_backends.ja.md` | Exact mirrors: `docs/execution_backends.md`, `docs/execution_backends.ja.md` |
| Persistent control contract (DEC-044) | `skills/garelier-core/control_contract.md`, `skills/garelier-core/control_contract.ja.md` | Exact mirrors: `docs/control_contract.md`, `docs/control_contract.ja.md` |
| Curated knowledge contract (DEC-044) | `skills/garelier-librarian/knowledge_contract.md`, `skills/garelier-librarian/knowledge_contract.ja.md` | Exact mirrors: `docs/knowledge_contract.md`, `docs/knowledge_contract.ja.md` |
| Garelier Control project skill | `skills/garelier-control-project/SKILL.md`, `skills/garelier-control-project/references/management.md` | `docs/concepts.md` |
| Garelier Control library skill | `skills/garelier-control-library/SKILL.md`, `skills/garelier-control-library/references/library-management.md` | `docs/concepts.md` |
| Role rules | `skills/garelier-<role>/SKILL.md` (+ `references/`) | `docs/concepts.md` |
| Correct operation contract | `skills/garelier-core/correct_operation.md` | (none) |
| Document standards (index of all formats) | `skills/garelier-core/document_standards.md` — maps every produced doc family → established standard → canonical location | (none) |
| Navigation (task → minimal read set) | `skills/garelier-core/navigation.md` — token-efficient routing for PM / Control skills | (none) |
| Commit message convention | `skills/garelier-core/commit_convention.md` — Conventional Commits + bound item ID; non-mandatory layer (Garelier-produced commits enforced, humans opt-in, never a repo-global gate) | (none) |
| PM history entry schema | `skills/garelier-pm/templates/history_entry.md` — fixed-schema record (reason-code enum, bounded Notes) so it does not vary by AI/session | (none) |
| Plant-Crust external management layout | `skills/garelier-core/driver/src/plant.ts`, `skills/garelier-core/templates/crust.toml`, `skills/garelier-core/templates/container.lock.toml`, DEC-085 | `docs/plant_crust.md`, `docs/plant_crust.ja.md` |
| Lens Packs / role judgment focus | `skills/garelier-core/driver/src/lenses.ts`, `skills/garelier-core/templates/lens_registry.toml`, `skills/garelier-core/templates/lenses/*.toml`, DEC-086 | `docs/lens.md`, `docs/lens.ja.md` |
| Role knowledge: security | `security/index.md` (+ files) — Librarian-managed; Guardian applies, all committing roles follow `commit_hygiene_policy.md` | (seeded from `skills/garelier-librarian/templates/security/`) |
| Knowledge provenance / rights | `security/provenance_rights_policy.md` — rules for external-source adoption, knowledge bundles, and public-facing generated text | (seeded from `skills/garelier-librarian/templates/security/provenance_rights_policy.md`) |
| Role knowledge: engineering | `engineering/index.md` — Librarian-managed; Worker/Artisan consume | (seeded from `skills/garelier-librarian/templates/engineering/`) |
| Role knowledge: quality | `quality/index.md` — Librarian-managed; Smith/Worker/Artisan consume | (seeded from `skills/garelier-librarian/templates/quality/`) |
| Role knowledge: review | `review/index.md` — Librarian-managed; Observer/Dock/Artisan consume | (seeded from `skills/garelier-librarian/templates/review/`) |
| Role knowledge: system | `system/index.md` — Librarian-managed; all roles consume | (seeded from `skills/garelier-librarian/templates/system/`) |
| Role knowledge index (by-role axis, DEC-048) | `role_index.toml` — single source of truth for role→docs; every role reads its `read_first` set first, then files a read-only `knowledge_query` when unresolved | (seeded from `skills/garelier-librarian/templates/role_index.toml`; `knowledge_query.md` template alongside) |
| Git command policy (capability invariant, DEC-048) | `git_command_policy.toml` — single source of truth for which git commands roles may run; roles apply it via knowledge-consult (the driver-era env grant and its CI mirror test were removed with the driver, DEC-066) | (seeded from `skills/garelier-librarian/templates/git_command_policy.toml`) |
| Governed autonomy / authority hierarchy | DEC-023 (governed autonomy / correct-operation contract), `skills/garelier-core/protocol.md` §1.10 | `docs/concepts.md` |
| File formats / templates | `skills/garelier-core/templates/`, `skills/garelier-pm/templates/`, `skills/garelier-librarian/templates/` | (none) |
| This repo's project-management decisions | `__garelier/<pm_id>/control/decisions/DEC-NNN-*.md` — internal dogfooding state, NOT shipped in the public package (docs cite DEC numbers as design rationale) | (none) |
| Version | `VERSION` | `CHANGELOG.md` |
| This repo's own project state | `__garelier/<pm_id>/control/` — internal dogfooding state, NOT shipped in the public package | `docs/` contains project/framework explanation only |
| Setup wizard runtime checklist | `docs/setup_wizard_parity_checklist.md` | (same) |
| Operational scenarios | `docs/operational_scenario_validation.md` | (same) |

## Rules

- Change semantics in the **Primary** source first, then sync the summary in
  the same commit (CLAUDE.md: "if you change semantics in one, update the
  other").
- Vocabulary is fixed: `target` / `studio` / `workbench` / `anvil` / `shelf`
  / `satchel` / `spyglass` / `monocle` / `gavel` / `clipboard` / `lane` /
  `control` / `runtime` / `checkout` / `blueprint` / `inspection` /
  `observation` / `gate` / `promote` / `concierge`. The deprecated terms
  (base / develop / feature / workspace / spec / research_report / release)
  appear only in DECs and `CHANGELOG.md` as historical notes — never in
  shipped templates, skills, scripts, or driver code.
- Retired directory layouts (the pre-rename project-state docs location)
  must not resurface in shipped content; `ci.sh` lints for this.
