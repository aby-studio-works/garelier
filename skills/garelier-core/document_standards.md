# Document standards (canonical index)

One place that says, for every document Garelier produces, **which established
standard it follows** and **where its canonical format lives** (DEC-051). It does
not re-document each format — it points to the authoritative template/contract.

> **Non-mandatory layer (DEC-051).** Format enforcement runs only inside
> Garelier's own operation (driver/roles validate their outputs) + opt-in human
> hooks + the framework's own `ci.sh`. It is never a repo-global git hook or a
> shared-CI gate in a target project; a Garelier-using repo stays fully usable
> with plain `git`/build/test by non-Garelier / other-skill contributors, and
> merges never impose Garelier enforcement on them.

## Index

| Document family | Established standard | Garelier canonical format |
| --- | --- | --- |
| Commit messages | Conventional Commits 1.0.0 + bound item ID | `commit_convention.md` |
| Decisions (ADR) | ADR / MADR / Nygard | `control_contract.md` §Decision; template `control_scaffold/templates/decision.md` |
| Backlog | JIRA / Redmine issue fields | `control_contract.md` §Backlog (`W-NNN`) |
| Roadmap / milestones | Agile roadmap / epic | `control_contract.md`; template `control_scaffold/templates/milestone.md` |
| Risks | ISO 31000 risk register | `control_contract.md` §Other dashboard (`R-NNN`) |
| Quality gates / tests | ISTQB / JSTQB · IEEE 829 lineage | `control_scaffold/project_dashboard/quality_gates.md`; report = `templates/report.md` §gate |
| Changelog | Keep a Changelog + SemVer | `CHANGELOG.md` |
| PM history (decision log) | Structured event log | `skills/garelier-pm/templates/history_entry.md` (fixed schema, reason-code enum) |
| ID numbering (all `<prefix>-NNN`) | zero-pad min-3, unbounded, numeric | `control_contract.md` §ID numbering |
| Blueprints (specs) | Product spec / user story + dispatch-package plan | `skills/garelier-pm/templates/blueprint.md`; `driver/src/pipeline_packages.ts` validates/renders `Pipeline packages` |
| Assignments | Work ticket | `templates/assignment.md` + per-role `*_assignment.md` |
| Lens registry / packs | Focus profile registry (non-authority metadata) | `templates/lens_registry.toml`, `templates/lenses/*.toml`; `driver/src/lenses.ts` validates and renders `## Equipped lens` |
| Plant-Crust descriptors | Environment / container lockfile | `templates/crust.toml`, `templates/container.lock.toml`; `driver/src/plant.ts` resolves control vs target roots |
| Reports (worker/smith/…) | Completion / test-summary report | `templates/report.md` + `report.json` (JSON schema) |
| Inspections (scout) | Investigation report | `templates/inspection.md` + `inspection.json` |
| Verdicts (guardian/observer/review) | Security gate / peer review | `*_report.md` + `guardian_report.json` / `review.json` |
| Concierge report | Deployment/operation log | `concierge_report.md` + `.json` |
| Manifest / STATE | Live status / FSM log | `templates/manifest.md` / `templates/state.md` |
| Knowledge docs / index / runbook | Wiki / runbook / playbook | `skills/garelier-librarian/templates/*` + `knowledge_contract.md` |
| Registries (source/routine/role/git) | Provenance / capability matrix | `*.toml` templates (DEC-048) |
| Requests / scheduled jobs | Federated request / cron schema | `control_scaffold/request_intake/request_schema.md` / `scheduled_jobs/` |
| Promote / data-change | Release notes / change-mgmt | `skills/garelier-pm/templates/promote.md`; `control_scaffold/operations/data_change_policy.md` |

## Enforced standards (validators)

The Garelier env requires Bun, so format validators are Bun/TS (fast,
cross-platform). They follow the ID-numbering rule (unbounded `-[0-9]{3,}`,
numeric sort):

- `skills/garelier-core/scripts/lint_commits.ts` — commit-message shape.
- `skills/garelier-core/scripts/lint_history.ts` — PM history fixed-schema.
- `skills/garelier-core/driver/src/status_control.ts` — dashboard tables (existing).

Wired into the framework's own `ci.sh`; offered to projects via the opt-in
`skills/garelier-core/scripts/install_hooks.sh` (local `commit-msg` hook,
never `core.hooksPath`); a no-op where the relevant Garelier artifacts are absent.

## Navigation

Roles reach the right standard with minimal reads via the by-role
`role_index.toml` knowledge index (`read_first` / `on_demand`) and the
task router in `skills/garelier-core/navigation.md` — no full-file scans.
