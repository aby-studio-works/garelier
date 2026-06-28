# Garelier PM Health and Control Bundle Reference

## §14. Optional health check

Garelier does **not** auto-scan agent state on PM startup. Instead,
health check is an explicit user-invoked tool, and only available if
the user has opted in by uncommenting the `[health_check]` section
in `__garelier/<pm_id>/_pm/setup_config.toml`.

### 14.1 Enabling

The wizard generates `__garelier/<pm_id>/_pm/setup_config.toml` with the
section commented out. To enable, the user uncomments and edits
thresholds:

```toml
[health_check]
worker_working_warn_hours = 24
worker_blocked_warn_hours = 12
scout_working_warn_hours = 12
scout_reporting_warn_hours = 6
dock_silent_warn_hours = 24
pending_backlog_warn_hours = 48
```

Any threshold can be omitted to disable that specific check.

### 14.2 Detection

On every session start, after reading `setup_config.toml`, check for
a `[health_check]` section.

- Section absent (commented out): feature is **off**. Do not scan,
  do not mention health.
- Section present: feature is **on**. Tell the user once at session
  start that health check is available ("you can ask 'run a health
  check' to scan for stale work"), but do not run the scan
  automatically.

### 14.3 Running a health check

Triggered by phrases like "health check", "scan for stuck work",
"any agents stalled".

Process:

1. Read `[health_check]` thresholds.
2. For each Worker/Scout/Smith, read STATE.md, extract Status and Last
   activity timestamp.
3. Compute hours-since-last-activity for each.
4. For each agent, if its (Status, hours) exceeds the matching
   threshold, flag it.
5. For Dock, read `__garelier/<pm_id>/_dock/STATE.md` and
   apply `dock_silent_warn_hours`.
6. For pending backlog (blueprints in `__garelier/<pm_id>/control/blueprints/`
   not yet picked up by Dock), apply `pending_backlog_warn_hours`
   against their creation timestamp.
7. Show flagged items with their durations and suggested actions
   (typically: investigate, or stop via §13).

### 14.4 What the check does NOT do

- Does not auto-abort anything.
- Does not modify any files (except optionally appending a recent
  activity line to `__garelier/<pm_id>/runtime/manifest.md`).
- Does not run on a schedule. The user invokes it on demand.

The check is informational only.

### 14.5 Retention maintenance

Triggered by phrases like "rotate history", "archive old history",
"retention cleanup", "履歴整理", or automatically when PM notices
`history_hot_entries` is exceeded during a normal PM-owned update.

PM may maintain only PM-owned tracked state:

- `_pm/history.md`
- `_pm/history/archive/`
- `control/project_dashboard/`
- accepted `control/inspections/` indexes or monthly summaries

PM must not prune `runtime/`, Worker/Scout/Smith worktree archives, or
Dock backlog files; those are owned by Dock/the dispatch loop per
`retention.md`.

Process:

1. Read `[retention]` or defaults from `garelier-core/retention.md`.
2. Rotate `_pm/history.md` per §11.2.A if it exceeds the hot-entry
   threshold.
3. For high-volume inspections, ensure new PM-authored destinations use
   `control/inspections/<category>/YYYY/MM/YYYY-MM-DD-<topic>.md`.
4. For daily/status streams, create or update the monthly summary only
   when it materially reduces future reading. Do not rewrite individual
   immutable inspections.
5. Commit PM-owned retention changes with
   `maintenance: rotate Garelier history` or
   `maintenance: summarize inspections`.

## §14. Control bundles — import / export (DEC-048 / DEC-043)

Snapshot or restore a PM's **tracked `control/` authority** (dashboard,
blueprints, operations, decisions, inspections, …) as a portable, self-describing
bundle. Use it for **backup**, for **seeding a new PM from a template project**,
or for handing planning state to another environment.

The same scripts accept the single-user `_workshop` namespace used by
`garelier-control-project`. Auto-detection recognizes either a full PM
`_pm/setup_config.toml` or a `control/control.toml` marker.

Before export, validate the canonical contract and remove completed backlog/risk
rows. For messy non-bundle input, stage raw material under
`runtime/import/`, normalize it into the canonical control templates, validate,
and commit only the reviewed durable artifacts.

Scripts (sh + ps1, feature parity), under `skills/garelier-pm/scripts/`:

```bash
# Export this PM's control/ into a bundle. --to is MANDATORY (output must be
# explicit); runtime/ is excluded (gitignored, machine-local).
control_export.sh --to <dest-dir> [--pm-id <id>] [--project <root>]

# Import a bundle into a PM's control/. --from is MANDATORY. Default is a DRY RUN;
# add --apply to write. NO-OVERWRITE: existing files are never clobbered — every
# collision is reported for you to reconcile by hand.
control_import.sh --from <bundle-dir> [--pm-id <id>] [--project <root>] [--apply]
```

The bundle carries `control_bundle_manifest.toml` (pm_id, source project,
version, git sha, generated_at, per-file git-blob ids).

**Boundary — who may move a bundle where:**

| Destination | Owner | Gate |
| --- | --- | --- |
| local disk (backup / new-PM template) | **PM-direct** (in-sandbox) | run commit-hygiene; `control/` can hold names/plans |
| outside the sandbox (other repo, push, external store) | **Concierge** executes | **Guardian** gate + redaction (DEC-024 / DEC-025) |
| another PM | **`request_intake/`** | per-PM isolation — never a direct write into another PM's tree (DEC-006) |

Always specify both the input source and the output destination explicitly — the
scripts refuse to run otherwise (no implied scope).
