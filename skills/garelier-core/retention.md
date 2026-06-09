# Garelier Retention Policy

This file defines the default high-volume operating policy. It prevents
daily reports, Scout inspections, runtime archives, and PM history from
becoming the first context every role has to reread.

Projects may override the numeric defaults in
`__garelier/<pm_id>/_pm/setup_config.toml` `[retention]`. If the section
is absent, use the defaults below.

## Defaults

```toml
[retention]
history_hot_entries = 120
history_archive_granularity = "month"
inspection_path_granularity = "month"
inspection_monthly_summary = true
runtime_archive_keep_days = 30
runtime_archive_keep_files = 300
merge_gate_archive_keep_days = 14
role_local_archive_keep_days = 30
```

## PM-owned tracked state

PM owns `_pm/history.md` and `control/`.

- Keep `_pm/history.md` as the hot index: active entries plus the most
  recent `history_hot_entries` completed entries.
- Move older completed entries to
  `_pm/history/archive/YYYY-MM.md`. Preserve headings, entry numbers,
  outcomes, and notes exactly.
- Keep `<!-- Next entry number: N -->` only in the hot file. Archive
  files never contain that marker.
- Add or maintain an `## Archived history` section in the hot file with
  month ranges and entry-number ranges.
- Re-execution search reads the hot file first, then
  `_pm/history/archive/*.md` when needed.

PM also owns accepted inspection commits:

- For high-volume or daily outputs, use date partitions:
  `control/inspections/<category>/YYYY/MM/YYYY-MM-DD-<topic>.md`.
- Do not commit raw dumps, full logs, generated caches, or bulk input
  snapshots as inspections. Commit a summary with source paths, sample
  records, counts, and reproduction commands.
- When `inspection_monthly_summary = true`, prefer a monthly rollup at
  `control/inspections/<category>/YYYY/MM/summary.md` for status/daily
  report streams. PM and users read the summary first; individual daily
  inspections remain available by path.
- `control/project_dashboard/current.md` stays a rolling window. Move
  durable decisions to `decisions.md`, risks to `risks.md`, and longer
  narrative to `notes.md` or a dated inspection/report.

## Dock-owned runtime state

Dock owns `runtime/manifest.md`, `runtime/backlog/`, and its inbox
archives.

- Keep `runtime/manifest.md` recent activity to the template's last 10
  events. Older detail belongs in `runtime/backlog/done/` or a PM-owned
  report/inspection.
- Keep `runtime/backlog/done/` small enough for status scans. When the
  number of files exceeds `runtime_archive_keep_files` or files are
  older than `runtime_archive_keep_days`, compact old done entries into
  `runtime/backlog/archive/YYYY-MM.md` and remove the individual old
  runtime files.
- Never prune `pending.md`, `in_flight.md`, active inbox files, active
  merge-gate requests/results, locks, or agent STATE files.

## Driver / local-only archives

Runtime and role-local archives are gitignored machine-local state.

- `runtime/merge_gate/archive/` may be pruned after
  `merge_gate_archive_keep_days` once no active merge-gate lock exists.
- `runtime/driver/usage/YYYY-MM.jsonl` (Output Control usage summary, DEC-028)
  is month-partitioned; old months may be pruned/archived with the same
  `runtime_archive_keep_days` policy once their trend has been consumed.
- `runtime/driver/logs/` JSONL are size-rotated by the driver itself
  (`driver_log_max_bytes` / `driver_log_keep_files`, DEC-028); rotated `.N`
  files beyond the keep count are dropped automatically.
- `_workers/<id>/archive/`, `_scouts/<id>/archive/`,
  `_smiths/<id>/archive/`, `_librarians/<id>/archive/`,
  `_observers/<id>/archive/<request_id>/`, and
  `_artisan/archive/` (including stale `_artisan/checkpoint.md` once the
  task is reported and merged) may be pruned after
  `role_local_archive_keep_days` only after the agent is `IDLE` and no
  active assignment references the archived task.
- `runtime/observer/results/` entries may be pruned with the same policy
  once the requester has consumed (ACKed) them.
- Prefer dry-run summaries before deleting local archives:
  counts, oldest/newest timestamps, and sample paths.
