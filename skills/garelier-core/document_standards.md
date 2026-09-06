# Document standards (canonical index)

One place that says, for every document Garelier produces, **which established
standard it follows** and **where its canonical format lives** (DEC-051). It does
not re-document each format — it points to the authoritative template/contract.

> **Non-mandatory layer (DEC-051).** Format enforcement runs only inside
> Garelier's own operation (driver/roles validate their outputs) + opt-in human
> hooks + the framework's own `ci.ts`. It is never a repo-global git hook or a
> shared-CI gate in a target project; a Garelier-using repo stays fully usable
> with plain `git`/build/test by non-Garelier / other-skill contributors, and
> merges never impose Garelier enforcement on them.

## Index

| Document family | Established standard | Garelier canonical format |
| --- | --- | --- |
| Commit messages | Conventional Commits 1.0.0 + bound item ID + `Garelier:` trailer | `commit_convention.md` |
| Decisions (ADR) | ADR / MADR / Nygard | canonical Markdown body + strict TOML front matter |
| Backlogs | JIRA / Redmine issue fields + resumable execution | `backlog/{open,archive/YYYY}/W-NNN.md` |
| Current / Checkpoints | Bounded current/next queue + resumable checkpoint | `project_dashboard/current.md` + `checkpoints/{active,archive}` |
| Roadmaps | Product roadmap | multiple `roadmaps/*.md` + marker-bounded Dashboard index |
| Milestones | Agile roadmap / epic | `milestones/*.md` with many-to-many plan edges |
| Risks | ISO 31000 risk register | `risks/{open,archive/YYYY}/R-NNN.md` |
| Quality gates / tests | ISTQB / JSTQB · IEEE 829 lineage | schema-3 operations policy + typed evidence/report |
| Changelog | Keep a Changelog + SemVer | `CHANGELOG.md` |
| ID numbering (all `<prefix>-NNN`) | zero-pad min-3, unbounded, numeric | `control_contract.md` §ID numbering |
| Blueprints (specs) | Product spec / user story + dispatch-package plan | canonical Markdown + strict TOML front matter: `skills/garelier-pm/templates/blueprint.md`; `driver/src/pipeline_packages.ts` validates/renders `Pipeline packages` |
| Assignments | Work ticket | `templates/assignment.md` + per-role `*_assignment.md` |
| Lens registry / packs | Focus profile registry (non-authority metadata) | `templates/lenses/lens_registry.toml`, `templates/lenses/*.toml`; `driver/src/lenses.ts` validates and renders `## Equipped lens` |
| Plant-Crust descriptors | Environment / container lockfile | `templates/crust.toml`, `templates/container.lock.toml`; `driver/src/plant.ts` resolves control vs target roots |
| Reports (worker/smith/…) | Completion / test-summary report | `templates/report.md` + `report.json` (JSON schema) |
| Inspections (scout) | Investigation report | `templates/inspection.md` + `inspection.json` |
| Verdicts (guardian/observer/review) | Security gate / peer review | `*_report.md` + `guardian_report.json` / `review.json` |
| Concierge report | Deployment/operation log | `concierge_report.md` + `.json` |
| Manifest / STATE | Live status / FSM log | `templates/manifest.md` / `templates/state.md` |
| Knowledge docs / index / runbook | Wiki / runbook / playbook | `skills/garelier-librarian/templates/*` + `knowledge_contract.md` |
| Registries (source/routine/role/git) | Provenance / capability matrix | `*.toml` templates (DEC-048) |
| Requests / scheduled jobs | Federated request / cron schema | `control_scaffold_v3/request_intake/request_schema.md` / `scheduled_jobs/` |
| Promote / data-change | Release notes / change-mgmt | `skills/garelier-pm/templates/promote.md`; target namespace `control/operations/data_change_policy.md` |

## Authority and mutation

For schema v3, canonical Markdown bodies and strict TOML front matter are
authority. Direct authoring is valid after a strict whole-model reload;
shared/automated multi-file lifecycle changes use revision-checked,
crash-recoverable transactions. Generated Dashboard regions are marker-bounded
and never overwrite curated text.

Control schemas 1 and 2, unknown versions, and storage mismatches are rejected.

## Enforced standards (validators)

The Garelier env requires Bun, so format validators are Bun/TS (fast,
cross-platform). They follow the ID-numbering rule (unbounded `-[0-9]{3,}`,
numeric sort):

- `skills/garelier-core/scripts/lint_commits.ts` — commit-message shape.
- `garelier control doctor --profile strict` — schema-3 plan graph/lifecycle
  invariants.
- `skills/garelier-core/driver/src/status_control.ts` — schema-3 public status
  projection.

Wired into the framework's own `ci.ts`; offered to projects via the opt-in
`skills/garelier-core/driver/src/scripts/install_hooks.ts` (local `commit-msg` hook,
never `core.hooksPath`); a no-op where the relevant Garelier artifacts are absent.

## Source tags (external-platform claims)

A claim about **external platform/tool behavior** — the harness, Claude Code, the
OS, a third-party lib: anything Garelier *consumes* rather than *builds* — carries a
source tag so a reader can tell verified spec from local guesswork. Tag each such
claim inline in a DEC / knowledge doc / report / commit rationale:

- `[official spec]` — from the vendor's official documentation; cite the verbatim
  quote + URL (+ version/date when the behavior is version-specific).
- `[in-repo observation]` — inferred from this repo's own docstrings, comments, or
  code. **Not** a spec — it records what we saw, not what is guaranteed.
- `[session measurement]` — measured empirically this session (a run, a probe). A
  data point, reproducible only under the stated conditions.
- `[inference]` — reasoned from the above, not directly sourced.

A **design decision** that depends on external-platform behavior must rest on
`[official spec]`, not on `[in-repo observation]` / `[session measurement]` alone
(the rule in `references/debugging_discipline.md` §6 for roles and
`references/pm_playbook.md` §9 for PM). This is a non-mandatory layer: it applies
to platform-dependent design decisions, not to everyday small changes.
**Precedent:** `references/role_subagent_dispatch.md` §6 already tags its Agent
Teams claims `[official spec]` with URL + verified-date.

## Navigation

Roles reach the right standard with minimal reads via the by-role
`role_index.toml` knowledge index (`read_first` / `on_demand`) and the
task router in `skills/garelier-core/navigation.md` — no full-file scans.
