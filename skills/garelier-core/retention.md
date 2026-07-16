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
role_local_archive_keep_days = 30
scratch_keep_days = 14
```

`archive/` under `runtime/merge_gate/` is retained by
`[merge_gate] archive_keep_days` (default 14), not by this `[retention]`
block — see "Driver / local-only archives" below for why it lives next to
`results_keep` instead.

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

- `runtime/merge_gate/archive/` (one `<stem>.request.json` per resolved merge
  request) is pruned automatically at WRITE time, not read time — every
  result write deletes archived requests older than `[merge_gate]
  archive_keep_days` (default 14) and protects any stem still referenced by a
  queued request or the active lock. No manual maintenance needed (W-038).
- `runtime/merge_gate/results/` (one `.json` + one `.summary.json` per merge
  request) is pruned automatically at WRITE time, not read time — every
  result write keeps only the most recent `[merge_gate] results_keep`
  request stems (default 40) and protects any stem still referenced by a
  queued request or the active lock. No manual maintenance needed (W-030).
- `runtime/merge_gate/logs/` (one `<stem>.log` per merge request) is pruned the
  same way — every result write keeps only the most recent `[merge_gate]
  logs_keep` logs (default = `results_keep`) and protects the in-flight /
  active-lock stem. Previously this had no delete path and grew without bound
  (a live target project reached 137MB / 120 files) — the "write a log forever"
  disk-filler class. No manual maintenance needed (W-030 fix). The COUNT cap
  leaves the per-file BYTE size open (one runaway build streams an arbitrarily
  large single log), so each retained log is also capped to `[merge_gate]
  log_max_bytes` (default 8 MiB, above a normal ~4-5 MiB gate log; `<= 0`
  disables) at the same write-time trigger — the middle is dropped behind a
  marker, keeping the head (request header) and tail (errors + verdict); the
  in-flight / active-lock log is never rewritten (W-030 residual, byte axis).
- `runtime/driver/usage/YYYY-MM.jsonl` (Output Control usage summary, DEC-028)
  is month-partitioned; old months may be pruned/archived with the same
  `runtime_archive_keep_days` policy once their trend has been consumed.
- `runtime/driver/logs/` JSONL are size-rotated by the driver itself
  (`driver_log_max_bytes` / `driver_log_keep_files`, DEC-028); rotated `.N`
  files beyond the keep count are dropped automatically.
- `runtime/dispatch/events.jsonl` is size-capped by `dispatch_event.sh`
  (DEC-088 Group E): the append-only dispatch log rolls to `events.jsonl.1` (one
  prior generation) once it crosses `dispatch_events_max_bytes` (default 5 MiB;
  override via `[retention] dispatch_events_max_bytes` or the
  `GARELIER_DISPATCH_EVENTS_MAX_BYTES` env var). The live in-flight view derives
  from `_dispatch<N>/STATE.md`, not from history, so a rolled tail is safe; an
  older `.1` may be pruned.
- `_workers/<id>/archive/`, `_scouts/<id>/archive/`,
  `_smiths/<id>/archive/`, `_librarians/<id>/archive/`,
  `_observers/<id>/archive/<request_id>/`, and
  `_artisan/archive/` (including stale `_artisan/checkpoint.md` once the
  task is reported and merged) may be pruned after
  `role_local_archive_keep_days` only after the agent is `IDLE` and no
  active assignment references the archived task.
- `runtime/observer/results/` entries may be pruned with the same policy
  once the requester has consumed (ACKed) them.
- `runtime/scratch/<lane>/` holds a **producer's per-lane intermediate output**
  (dispatch_prompt_craft.md §1.8: "中間 = `runtime/scratch/<lane>/`") — build
  logs, extracted samples, throwaway working files a dispatch produces but does
  not commit. Unlike `runtime/pm/scratch/` (below), it is keyed by lane slug and
  has an **automatic** reclaim path: `dispatch_cleanup.sh --sweep` (already run on
  every new dispatch, and manually re-runnable) removes any `runtime/scratch/<slug>`
  whose dispatch container is gone, while preserving a slug an active
  `_dispatch<N>` still owns. This closes the retention gap that let a finished
  lane's scratch survive its checkout — a live project measured a single lane's
  1.8GB scratch persisting 8 days after cleanup (W-084). Size/age cap: treat each
  lane dir as ephemeral and expect the orphan sweep to reclaim it within one
  dispatch cycle; a lane dir that survives its container is a bug in the sweep,
  not an entry to age-prune. As a soft ceiling, a single live lane's scratch over
  **~2GB or 14 days** is an anomaly worth inspecting (rationale: producer
  intermediates are logs + samples, not build trees — anything larger means a
  tool wrote a build/output dir into scratch instead of `target/` or an explicit
  `--output-path`). The manual audit + reclaim entry point is the PM
  cleanup-audit reference ("Stray + scratch reclaim", `garelier-pm/references/runtime/cleanup-audit.md`).
- `runtime/pm/scratch/` holds an attended PM's (and the agents it drives)
  manual verify logs, screenshots, and throwaway working files. It is
  agent-owned ephemeral state that grows without bound and was the one runtime
  path with no prune route (a live target reached 32MB). Entries older than
  `[retention] scratch_keep_days` (default 14; `0` disables) may be age-pruned,
  but — unlike the merge-gate prunes — there is **no automatic driver hook**: a
  running PM may hold an in-use scratch file, so this is a deliberately manual,
  dry-run-first action. Preview, then delete with:
  `bun skills/garelier-core/driver/src/scratch_retention.ts --project <root>
  --pm-id <id>` (dry-run: prints the candidates + byte cost); add `--apply`
  to actually remove them.
- Prefer dry-run summaries before deleting local archives:
  counts, oldest/newest timestamps, and sample paths.

## Showcase deliverables (W-085)

`__garelier/<pm_id>/showcase/` is the default drop-zone for user-facing
deliverables with no fixed destination yet (screenshots, audio previews, render
comparisons). It is **gitignored** and follows the same transient discipline as
`runtime/`:

- Files always live in a subfolder (`showcase/<topic>/…`), never directly under
  `showcase/`.
- Retention mirrors `runtime/`: treat it as ephemeral, age-prune with the same
  `[retention] scratch_keep_days` posture (dry-run first; no automatic driver
  hook — a running producer may hold an in-use file).
- Promotion `showcase/` → `gallery/` is by the user's explicit request only.
  `gallery/` is TRACKED (binaries via Git LFS) and is NOT subject to this
  retention policy — it holds deliverables the user chose to keep.
