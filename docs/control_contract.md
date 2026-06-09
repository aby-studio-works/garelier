# Garelier Control Contract

This is the canonical contract for persistent project management used by both
full Garelier and `garelier-control-project`.

Together with `garelier-control-library`, bundle tooling, validation, and
derived graphs, this forms **Garelier Control**: a standalone management plane.
The small starter is its minimum deployment mode. Full Garelier adds execution
roles, lanes, branches, runtime, and driver without replacing this control
plane.

## Location and identity

Persistent authority lives at:

```text
__garelier/<pm_id>/control/
```

Every control tree has `control.toml`:

```toml
schema_version = 1
kind = "garelier_control"
pm_id = "<pm_id>"
mode = "full" # full | control_only
```

`_workshop` is the default `pm_id` for a single-user project. It is valid for
both the small starters and full Garelier, including Artisan and dock lanes.
Full setup upgrades an existing `_workshop` control-only namespace in place.
Shared or multi-user projects must choose an explicit unique `pm_id`. Do not
use `_workspace`; `workspace` is a deprecated alias for `runtime`.

Sibling `__garelier/<pm_id>/runtime/` is transient and gitignored. Never put
durable authority there.

## Canonical layout

```text
control/
├── control.toml
├── README.md
├── project_dashboard/
│   ├── README.md
│   ├── current.md
│   ├── roadmap.md
│   ├── backlog.md
│   ├── decisions.md
│   ├── risks.md
│   ├── quality_gates.md
│   └── notes.md
├── milestones/<slug>.md
├── blueprints/<slug>.md
├── decisions/DEC-NNN-<slug>.md
├── operations/
├── inspections/
├── observations/
├── reports/
│   ├── handoffs/
│   └── diagnostics/
├── delegation/
├── request_intake/
├── scheduled_jobs/
└── templates/
```

The canonical scaffold and artifact templates live at
`skills/garelier-core/templates/control_scaffold/`. Use them; do not invent a
session-local format.

## Authority and hot-file rules

Authority, highest first:

1. explicit user instruction;
2. `operations/` safety policy and `project_dashboard/quality_gates.md`;
3. accepted `decisions/` records;
4. active milestone, blueprint, and dashboard state;
5. `project_dashboard/notes.md`.

Dashboard files are short current-state surfaces:

- `current.md`: active focus, next actions, blockers. No completion log.
- `roadmap.md`: direction and links to canonical milestone files.
- `backlog.md`: open work only. Never retain completed/checkmarked items.
- `decisions.md`: index of canonical decision files, not a second decision body.
- `risks.md`: active risks only; remove closed risks in the resolving commit.
- `notes.md`: temporary scratch; promote or delete promptly.

Git history is the archive for deleted completed backlog items and prior hot-file
states.

Dashboard schemas are deliberately smaller than JIRA or Redmine, but preserve
the fields needed to import, export, sort, and resume work without guessing.
The canonical scaffold defines the exact headings and table headers. Existing
projects may migrate incrementally: the validator reports non-standard
dashboard structure as warnings, while missing required files and completed
backlog entries remain errors. A parallel `docs/project_dashboard/` is also
reported as migration debt; `docs/` may explain the project but is not a second
management authority. Decision bodies belong under `control/decisions/`, never
under a parallel `docs/decisions/`.

## Artifact formats

### Milestone

Path: `milestones/<slug>.md`. Required identity fields:

```markdown
# Milestone: <title>

## Identity

- Slug: `<slug>`
- Status: planned | active | shipped | abandoned
- Started: YYYY-MM-DD | -
- Target: YYYY-MM-DD | -
- Shipped: YYYY-MM-DD | -
```

Use the canonical milestone template for the remaining required sections.

### Decision

Path: `decisions/DEC-NNN-<slug>.md`. Required identity fields:

```markdown
# DEC-NNN: <title>

- Date: YYYY-MM-DD
- Status: proposed | accepted | superseded | rejected
- Scope: <boundaries>
- Supersedes: <decision id or none>
- Related: <paths or none>
```

The body must contain `## Context`, `## Decision`, and `## Consequences`.

### Backlog

`project_dashboard/backlog.md` uses one open-work table:

```markdown
| ID | Type | Priority | Status | Owner | Milestone | Outcome | Acceptance | Detail |
```

- ID: stable `W-NNN` (see *ID numbering* below); never recycle an ID.
- Type: `feature | bug | maintenance | research | decision | docs`.
- Priority: `critical | high | normal | low`.
- Status: `triage | ready | blocked | deferred`.
- Owner: accountable role or person, or `-` while unassigned.
- Milestone: canonical milestone slug/path, or `-`.
- Outcome: concise result, not an activity description.
- Acceptance: pointer to acceptance criteria, issue, blueprint, or `-`.
- Detail: exact path, issue URL, commit SHA, or other stable pointer.

Do not use completed `[x]` rows. When work completes, delete its row in the
same commit.

### ID numbering

All sequential IDs — `DEC-NNN`, `W-NNN` (backlog), `R-NNN` (risks), `J-NNN`
(scheduled jobs), PM history `#NNN`, and the merge-gate `<seq>` — share one rule
so tooling stays correct as counts grow large:

- `NNN` is a decimal counter **zero-padded to a minimum of 3 digits** that grows
  naturally beyond three (`-009`, `-099`, `-100`, `-1000`, `-100000`). There is
  **no fixed width and no upper bound**.
- IDs are **monotonic and never recycled**.
- **Match** with an unbounded pattern (`-[0-9]{3,}` or `-\d+`) — never a fixed
  count like `-\d{3}`, which silently misses 4+ digit IDs.
- **Sort and compare numerically** (`sort -t- -k2 -n`, or `parseInt`) — never
  lexicographically, where `-1000` would order before `-999`.
- **Format** with non-truncating min-width padding (`String(n).padStart(3,"0")`).

Scripts, lints, and the driver follow these rules, so large ID counts do not
break matching, padding, or ordering.

### Other dashboard files

- `current.md`: `Active focus`, `Next actions`, `Blockers`, and `Read first`.
- `roadmap.md`: `Direction`, `Active milestones`, `Planned milestones`, and
  `Out of scope`; milestone detail lives under `control/milestones/`.
- `decisions.md`: `Decision index` table with `ID | Status | Title | Record`.
- `risks.md`: `Active risks` table with
  `ID | Severity | Likelihood | Risk | Trigger | Mitigation | Owner | Detail`.
- `quality_gates.md`: `Required commands` table with
  `ID | Scope | Command | Required`, plus reusable `Review conditions`.
- `notes.md`: temporary `Scratch` table with
  `ID | Note | Promote to | Review by`.

Use `-` for an intentionally empty field. Keep cross-file IDs and pointers
stable so dashboard state can be migrated to issue trackers without rewriting
the underlying canonical artifacts.

## AI operating contract

When an AI is asked to manage the project:

1. Resolve the requested `pm_id`; use `_workshop` only when none is specified
   and no other active control namespace is evident. If multiple namespaces
   exist, list their ids/modes and ask the user which one to manage; never
   silently choose the first or `_workshop`.
2. Read `control.toml`, this contract, `project_dashboard/README.md`, then the
   relevant hot files and canonical artifacts.
3. Update durable control state whenever a decision or plan must survive the
   session. Keep runtime staging transient.
4. Use pointers instead of pasted context.
5. Validate the control tree before claiming a management/import/export task is
   complete.

## Control-only handoff and diagnosis

`garelier-control-project` includes compact handoff and control-only diagnosis
as project-control procedures. They are not separate skills, roles, lanes, or
driver features.

- Compact handoff updates `project_dashboard/current.md` as the resume surface
  and may place longer durable handoff reports under `reports/handoffs/`.
- Control-only diagnosis checks the health of the control tree and may place
  durable diagnostic reports under `reports/diagnostics/`.
- Neither procedure starts roles, creates worktrees, takes `lane.lock`,
  approves promote, or dispatches Concierge.

## Upgrade to full Garelier

A control-only namespace is an intentional starting state, not a partial or
failed full setup. Running the `garelier-pm` fresh setup wizard with the same
`pm_id`:

1. preserves existing `control/` artifacts and project knowledge;
2. adds full runtime, role homes, branches, configuration, and lanes;
3. changes only `control.toml` mode from `control_only` to `full`.

After upgrade, the driver and both lanes continue to use the same `pm_id`.

## Consolidation and splitting

Control authority may be reorganized between PM namespaces without changing the
canonical format:

- consolidation stages multiple source controls into one destination for
  semantic reconciliation;
- splitting stages an explicit subset from one source into another destination.

Both operations preserve source namespaces, write first to destination runtime
staging, avoid automatic overwrite, and require validation plus review before
durable promotion. They reorganize `control/` authority only; full-PM runtime,
roles, branches, worktrees, and lanes need a separate explicit migration.

## Import and export

Clean control bundles use `control_export` / `control_import`. Runtime is always
excluded. Import does not transplant the source `control.toml`: it preserves an
existing destination marker or creates a destination-specific `control_only`
marker, so imported authority never claims the wrong `pm_id`.

For messy external input:

1. Stage raw data in `__garelier/<pm_id>/runtime/import/raw/`.
2. Inventory sources and ambiguities in `runtime/import/reports/`.
3. Normalize drafts in `runtime/import/drafts/` using canonical templates.
4. Dry-run collision and validation checks.
5. Move only reviewed, durable artifacts into `control/`.
6. Commit the normalized control change; never commit raw input by default.

## Commit checkpoints

Commit after each coherent, reviewable, revertible durable outcome:

- include implementation, relevant tests, and matching control updates together;
- remove completed backlog rows in that same commit;
- run the relevant quality gate first;
- avoid timestamp-only, formatting-only, broken, and WIP commits unless the user
  explicitly requests a checkpoint;
- keep unrelated outcomes in separate commits.
