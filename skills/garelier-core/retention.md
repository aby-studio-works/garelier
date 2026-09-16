# Garelier Retention Policy

This file defines the default high-volume operating policy. It prevents
daily reports, Scout inspections, runtime archives, and PM history from
becoming the first context every role has to reread.

Projects may override the numeric defaults in
`__garelier/<pm_id>/_crew/pm/setup_config.toml` `[retention]`. If the section
is absent, use the defaults below.

## Defaults

```toml
[retention]
inspection_path_granularity = "month"
inspection_monthly_summary = true
runtime_archive_keep_days = 30
runtime_archive_keep_files = 300
role_local_archive_keep_days = 30
scratch_keep_days = 14
preserved_artifact_max_bytes = 65536
```

`archive/` under `runtime/merge_gate/` is retained by
`[merge_gate] archive_keep_days` (default 14), not by this `[retention]`
block — see "Driver / local-only archives" below for why it lives next to
`results_keep` instead.

## PM-owned tracked state

PM owns `control/`.

- Terminal Backlog and Checkpoint records move under
  `control/backlog/archive/YYYY/` and `control/checkpoints/archive/` through the
  atomic terminal+archive plan; they are never rotated by hand.

### Retired: the `_crew/pm/history.md` journal (W-667 F-10)

A separate PM history file used to be the hot index of dispatched blueprints,
rotated into `_crew/pm/history/archive/YYYY-MM.md`. It is retired. It duplicated
what Control already holds — the Checkpoint carries the current position and the
exact next action, the Backlog record carries typed Evidence and its own
archive, and each dispatch register is captured in its container — and in
practice it went stale: the file that carried the contract stopped being
appended while the work kept shipping. Nothing reads or writes it any more; the
wizard does not create it, `blueprint_ship` does not edit it, and there is no
history lint. Existing files are inert: keep or delete them as the project
prefers.

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
- In schema 3, Backlog resume and Current remain bounded; move durable judgment
  to Decisions, typed Risks, and longer narrative to an attached dated
  inspection/report through the control CLI.

## Dock-owned runtime state

Dock owns `runtime/manifest.md`, `runtime/backlog/`, and its inbox archives.

Fixed directories under `runtime/control/locks/recovery_epochs/` are the
recovery election ledger. The current/highest epoch is never deleted. An older
released epoch is eligible for pruning only when its strict `owner.json` and
`released.json` agree on epoch, token, PM, journal generation/hash, operation,
and result. An older unreleased epoch is eligible only when its strict owner is
dead on the same host, is bound to the same PM and journal, and the exact stale
namespace-token lineage has already been inherited by the current epoch. A
separate recovery-audit file is not retention authority and is not required for
epoch pruning.

Retention first atomically moves an eligible older epoch into
`runtime/control/locks/recovery_epoch_staging/`, never the highest epoch, and
then removes the verified moved directory. This creates election room at the
count boundary and leaves a crash during recursive cleanup outside the
authoritative ledger. Gaps are valid and the next election always uses
`max(epoch)+1`. Crash-left election, release-marker, and prune staging entries
are not election authority; they may be removed only after proving that they
are not a canonical epoch and are not owned by a live recovery process.

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

- `runtime/merge_gate/archive/` retains the exact `<stem>.request.json` /
  `<stem>.result.json` authority pair. It is pruned automatically at WRITE time,
  not read time — every result write deletes pairs older than `[merge_gate]
  archive_keep_days` (default 14), except stems referenced by a queued request,
  the active lock, or any aftercare journal evidence. Aftercare-pinned pairs
  remain until attended GC coordinates removal of the retained container,
  marker, and closed journal authority (W-038/W-337).
- `runtime/merge_gate/results/` (one `.json` + one `.summary.json` per merge
  request) is pruned automatically at WRITE time, not read time — every
  result write keeps only the most recent `[merge_gate] results_keep`
  request stems (default 40) and protects any stem still referenced by a
  queued request or the active lock. Before a full result leaves this live
  window, its exact bytes are published beside the archived request (W-030/W-337).
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
- `runtime/gate/preserved_raw/dispatch<N>/` and `runtime/gate/run_records/`
  share one automatic WRITE-time retention owner. `gate_runner` runs it after a
  run-record write, and both preservation publishers run it after publishing
  raw evidence. The denominator is the set of unpinned regular files across
  both subtrees: files older than `runtime_archive_keep_days` or outside the
  newest `runtime_archive_keep_files` are retired. Evidence referenced by an
  existing `_crew/dispatch<N>/` container or by a non-terminal land-aftercare
  journal is pinned and excluded from both limits. An unreadable/malformed
  journal or run record makes the sweep keep evidence rather than guess that it
  is disposable. The trigger, denominator, and pins are therefore identical
  for PM-step raw logs, oversized raw artifacts, and gate run records.
- `runtime/driver/usage/YYYY-MM.jsonl` (Output Control usage summary, DEC-028)
  is month-partitioned; old months may be pruned/archived with the same
  `runtime_archive_keep_days` policy once their trend has been consumed.
- `runtime/driver/logs/` JSONL are size-rotated by the driver itself
  (`driver_log_max_bytes` / `driver_log_keep_files`, DEC-028); rotated `.N`
  files beyond the keep count are dropped automatically.
- `runtime/dispatch/events.jsonl` is size-capped by `dispatch_event.ts`
  (DEC-088 Group E): the append-only dispatch log rolls to `events.jsonl.1` (one
  prior generation) once it crosses `dispatch_events_max_bytes` (default 5 MiB;
  override via `[retention] dispatch_events_max_bytes` or the
  `GARELIER_DISPATCH_EVENTS_MAX_BYTES` env var). The live in-flight view derives
  from `_crew/dispatch<N>/STATE.md`, not from history, so a rolled tail is safe; an
  older `.1` may be pruned.
- `_crew/workers/<id>/archive/`, `_crew/scouts/<id>/archive/`,
  `_crew/smiths/<id>/archive/`, `_crew/librarians/<id>/archive/`,
  `_crew/observers/<id>/archive/<request_id>/`, and
  `_crew/artisan/archive/` (including stale `_crew/artisan/checkpoint.md` once the
  task is reported and merged) may be pruned after
  `role_local_archive_keep_days` only after the agent is `IDLE` and no
  active assignment references the archived task.
- `runtime/observer/results/` entries may be pruned with the same policy
  once the requester has consumed (ACKed) them.
- `runtime/scratch/<lane>/` holds a **role's per-lane intermediate output**
  (dispatch_prompt_craft.md §1.8: "中間 = `runtime/scratch/<lane>/`") — build
  logs, extracted samples, throwaway working files a dispatch produces but does
  not commit. Unlike `runtime/pm/scratch/` (below), it is keyed by lane slug and
  has an **automatic** reclaim path: `dispatch_cleanup.ts --sweep` (already run on
  every new dispatch, and manually re-runnable) removes any `runtime/scratch/<slug>`
  whose dispatch container is gone, while preserving a slug an active
  `_crew/dispatch<N>` still owns. This closes the retention gap that let a finished
  lane's scratch survive its checkout — a live project measured a single lane's
  1.8GB scratch persisting 8 days after cleanup (W-084). Size/age cap: treat each
  lane dir as ephemeral and expect the orphan sweep to reclaim it within one
  dispatch cycle; a lane dir that survives its container is a bug in the sweep,
  not an entry to age-prune. As a soft ceiling, a single live lane's scratch over
  **~2GB or 14 days** is an anomaly worth inspecting (rationale: role
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
- **Never `git add`/`commit` a showcase file.** It is gitignored precisely so it
  stays out of history; a CI detective (`showcase_tracked_lint`) fails on any
  tracked showcase file. A raw dump / full log / scratch note that you want to
  keep does NOT belong in `showcase/` under version control — leave a **summary +
  source path + repro** in an inspection (`control/inspections/…`) instead.
- Retention mirrors `runtime/`: treat it as ephemeral, age-prune with the same
  `[retention] scratch_keep_days` posture (dry-run first; no automatic driver
  hook — a running role may hold an in-use file).
- Promotion `showcase/` → `gallery/` is by the user's explicit request only.
  `gallery/` is TRACKED (binaries via Git LFS) and is NOT subject to this
  retention policy — it holds deliverables the user chose to keep.

<a id="role-artifact-destinations"></a>

## Where each role's output goes (role → artifact → path → format)

This is the answer to "where do I put my result, and in what shape?" — the one
question every role has to answer before it can finish. Read the row for your
own role. **You never choose the path**: it is either handed to you by
`dispatch_prepare` (in your prompt / `context.json`) or derived by the driver
after your work lands. Writing the same artifact somewhere else means the
downstream reader does not find it, and the artifact does not exist as far as
the mechanism is concerned.

Three columns to read together: `path` says where the file lives, `format` says
what shape the *reader* refuses without, and `written by` says whether you write
it or the driver does. **An artifact whose `written by` is the driver must not be
hand-authored** — hand-writing it puts a file at the canonical path that the
driver will then refuse or overwrite.

| role | artifact | path | format | written by |
| :-- | :-- | :-- | :-- | :-- |
| **every dispatched role** | completion register | **you write `__garelier/<pm_id>/_crew/dispatch<N>/lane/register.md`** — one path (W-735). `…/report.md` is the DRIVER's leaf on the same container: dispatch_prepare scaffolds it, the launcher captures your final response into it, and `land_pipeline` transcribes your register into it, so admission reads `lane/register.md` first and falls back to that capture. The preference is asymmetric existence, not taste: `report.md` is scaffolded, so its existence proves no authorship, while nothing but you writes `lane/register.md` — **for the CURRENT generation only**: after a `--recover-role`, a `lane/register.md` left by the previous generation is ignored and named in the refusal (W-782). A codex lane's captured leaf IS its producer leaf (`lane/result.md`), so the one-path rule holds there unchanged | `+++` TOML front matter with `[lane] state = 'REPORTING'` or `'BLOCKED'`, then prose. Bare `STATE=`, lower-case state, or a heading above the front matter all fail the contract — **including the machine header `<!-- garelier-control-v3 … -->`, which the scaffold now carries as a typed `[control]` table instead. The landed report's `[control]` is taken from `context.json`, so a `[control]` table you write into the register is dropped, never committed as provenance** | you (the launcher captures it) |
| **every dispatched role** | your own run logs | `__garelier/<pm_id>/_crew/dispatch<N>/lane/logs/…` — any names you like, nested as deep as you like | free | you. Disposable with the container; **a log at the lane ROOT (`lane/<name>.log`) is unknown scratch and stops cleanup** (W-782) |
| **every dispatched role** | instruction ledger | `__garelier/<pm_id>/_crew/dispatch<N>/instructions.md` | every `[[instruction]]` table set to `checked = true` with non-empty `consumed = '''…'''`, **inside the `+++` front matter**, not appended to the end of the file | you, before REPORTING |
| **dispatched role on a provider-SUBPROCESS transport (after `--recover-role`)** | provider session record + result | `__garelier/<pm_id>/_crew/dispatch<N>/lane/recovery.session.json` and `…/lane/recovery.result.md` | as above; **these are the LIVE pair after a recovery** — the pre-recovery `session.json` / result leaf are history, and `ready.json`'s `resume_cmd` is rewritten to point here (W-687) | the launcher captures the result; `dispatch_prepare --recover-role` rewrites the pointers |
| **dispatched role on the attended-agent transport (after `--recover-role`)** | completion register — **no session record and no recovery result leaf** | `__garelier/<pm_id>/_crew/dispatch<N>/lane/register.md` (capture: `…/report.md`), the same leaves a non-recovered attended lane uses | as the register row above. An attended lane has no provider subprocess, so nothing ever writes `lane/recovery.session.json`; the recovery's launch authority is `__garelier/<pm_id>/runtime/dispatch/bindings/<binding_id>/generation-<n>/launch.json` (the `--ack-launch` acknowledgement), and `ready.json` after `--recover-role` carries **no `session_record` key at all** (W-687 AC-5) | you (the parent captures the register); `dispatch_prepare --recover-role` publishes the pointer, `--ack-launch` writes the launch record |
| **every dispatched role** | transient artifact (screenshot, preview, throwaway log) | `__garelier/<pm_id>/showcase/<topic>/…` — a named subfolder, never directly under `showcase/` | free | you. **Gitignored — never `git add`.** See "Showcase deliverables" above |
| **Worker / Artisan** | required-gate delegation | inside your register | `=== REQUIRED GATE (Dock-run) ===` … `=== END REQUIRED GATE ===`, bare project commands one per line. A register without this block is refused as `required_gate_block_missing` = RED | you |
| **Worker / Artisan** | code | your workbench / satchel branch, in your own checkout only | commit subject ends `[#N]`; blank line; `Garelier: <pm_id> worker#N <W-N>` trailer verbatim | you |
| **Scout** | inspection | `__garelier/<pm_id>/control/inspections/<category>/YYYY/MM/YYYY-MM-DD-<topic>.md` | summary + source path + count + sample + repro command. **Not a raw dump** | you write the draft; **PM commits it** |
| **Guardian** | verdict | `__garelier/<pm_id>/runtime/guardian/results/<branch-slug>-guardian.md` | front matter `[verdict] result = 'PASS' \| 'PASS_WITH_NOTES' \| 'BLOCK' \| 'NO_OPINION'` **and** a `## Verdict` section — both, because two readers parse it | you |
| **Guardian** | diff scan result | `__garelier/<pm_id>/_crew/dispatch<N>/lane/secret-scan.md` | JSON whose `scan_state` is `complete` and whose `scope.base_ref` / `scope.head_ref` bind the reviewed base and HEAD | `guardian_scan.ts`, run by `review_prepare.ts` — **not you** |
| **Guardian** | canonical scanner evidence | `__garelier/<pm_id>/_crew/dispatch<N>/lane/scanner-<review-sha-12>.md` plus its `.md.json` sibling | the JSON binds `generated_by`, `base`, `head`, `exit`, `scanner_command`, `cwd`. Raw scanner stdout placed at this path is refused as the wrong shape | `scanner_evidence.ts`, run by `review_prepare.ts` — **not you** |
| **Observer** | observation report | `__garelier/<pm_id>/runtime/observer/results/<branch-slug>-observer.md` | same two-face marker as Guardian; verdict vocabulary adds `REWORK_RECOMMENDED` | you |
| **Smith** | hardening result | your Anvil branch + the register | register as above; integration tests live in the branch | you |
| **Librarian** | synced knowledge / registry | your shelf branch under `__garelier/<pm_id>/knowledge/…`, `source_registry.toml`, `routine_registry.toml` | Markdown with provenance; registries are TOML | you |
| **Concierge** | external-operation report | `__garelier/<pm_id>/runtime/concierge/…/concierge_report.md` | prose report naming the external target, the approval, and the exit state | you |
| **Wanderer** | peer advice | the peer-channel inbox under `__garelier/<pm_id>/runtime/peer/<channel>/` | free-form advisory; **never a verdict** (Wanderer decides nothing) | you |
| **Dock** | gate log | the `--log <path>` you were handed | `gate_runner.ts` markers: `GATE_START` / `LOCK_ACQUIRED` / `RESULT GREEN\|RED` / `GATE_END`. Never append two runs to one log file | `gate_runner.ts` — **not you** |
| **PM** | Work / risk / decision row | `__garelier/<pm_id>/control/backlog/open/W-NNN-<slug>.md` and siblings | schema-3 typed front matter + `## Acceptance criteria` | you |
| **PM** | blueprint | `__garelier/<pm_id>/control/blueprints/<slug>.md` | typed front matter + body | you |
| **— (driver)** | durable review / merge evidence | `control/reports/reviews/<W-N>/…` and `control/reports/merge/<W-N>/…` | content-hashed copies of the Guardian / Observer / role reports, written during settlement | `recordMergeControlOutcome` at land time — **never hand-authored** |
| **— (driver)** | PM-step gate summary | `control/reports/gates/<W-N>/dispatch<N>/gate-step4-<sha12>.log`; raw at `runtime/gate/preserved_raw/dispatch<N>/…` | tool-neutral summary of `gate_runner` STEP / exit / timestamp / RESULT / coverage markers plus the last 200 lines of each RED step. Tail lines pass preservation admission; rejected lines become `[redacted: <class>]` and the summary records count/classes. `[retention].preserved_artifact_max_bytes` bounds the tracked artifact (default 64 KiB; minimum 256 bytes); a truncated summary retains the raw runtime path | `land_pipeline` stage 10 / `dispatch_cleanup` — **never hand-authored** |
| **— (driver)** | preserved dispatch artifact | `control/reports/gates/<W-N>/dispatch<N>/artifacts/<encoded-path>/payload`, `…/run_records/<encoded-name>/payload`, `…/declared/<encoded-path>/payload`, plus `security_admission.json` | one security-admitted batch: exact bytes of unrecognised container files and the landed candidate's exact-review-SHA or Dock-sealed identical-engine-tree gate run record, plus only project-declared `[quality_gate].preserved_paths`. Old-round and legacy run records are journaled as preservation skips and remain under runtime age/count retention. Declared oversized files become a bounded generic summary + raw runtime pointer; the driver does not parse their tool/language format. No declaration means no declared-path copy | `land_aftercare` — **never hand-authored** |

**The last row is the one people get wrong.** Guardian and Observer write their
verdict to `runtime/<role>/results/`, which is transient. The durable copy under
`control/reports/reviews/<W-N>/` is produced by the landing path from the file
you wrote; it is content-addressed, so a hand-placed file there is not the same
artifact and will not bind to the row. If the durable copy is missing after a
land, the fix is `land_aftercare.ts apply --request-id <id>`, not writing the
file yourself.

**The preserved-artifact row is where "unknown" goes now (W-713 / DEC-100
ruling 5).** Aftercare used to REFUSE a container holding a file outside its
allowlist, and that refusal landed after `merge_land` had already succeeded — so
the container stayed active, its claim stayed held, and an operator moved one
file aside and re-ran, once per file. It preserved nothing and destroyed
nothing; it just stopped. Now every such file enters one batch admission before
tracked publication. The admission reuses the Guardian secret / PII /
prompt-injection registries and also rejects binary or control-obscured text,
customer-data markers, and provenance states the rights policy forbids. A
missing, empty, or malformed pattern registry also refuses admission instead
of silently reducing scan coverage. A
REDACTED deterministic record is written under
`runtime/land_aftercare/preservation_admissions/`; a clean record is also stored
as `security_admission.json` beside the admitted evidence. Any non-clean
artifact refuses the whole batch without deleting a source. Clean bytes are
copied here, each on its own `land_aftercare: PRESERVED …` line, and the
container is retired with the rest. Existing destinations are reused only when
their bytes are identical; different evidence is never overwritten. This is
not automatic repair: what aftercare recognises has not changed, and nothing
disappears without being named. **Symlinks and reparse points are still refused
outright** (W-380) — those are boundary violations, not evidence.

**What a `lane/` entry IS has exactly one definition** (W-547 AC-4):
`isKnownLaneEntry` in `driver/src/dispatch/gate_step_artifacts.ts`. Every route
that removes a container reads it — the aftercare walk, `land_pipeline` stage 10,
and `dispatch_cleanup` through both — so a name one route starts accepting is
accepted by all of them the same day. Two spellings is how `lane/session.json`
came to be accepted by one cleanup route and refused by the other (#43) while
the container's claim stayed held. The set covers the artifacts the framework
itself emits or asks a lane for, INCLUDING the producer register leaf
`lane/register.md` (W-780 / W-735) and the `lane/logs/` subtree, which is recognised by
containment because the producer names the files in it. Everything else in
`lane/` — a stray `.log` at the lane root, a round's scratch report, an
arbitrary `--result` leaf — is still unknown and still goes through the
preserved-artifact admission above. The dispatch's
gate run records pass through the same admission and move here too: they are the
P-9 evidence a sealed run rests on, so deleting them is wrong, and until this
row they had no owner and simply accumulated under `runtime/gate/run_records/`.
W-741's convention-owned `gate-step4-<sha12>.log` remains on its dedicated
pre-aftercare preservation path, but its tracked face is now the W-810 summary
and its raw bytes live under runtime retention. Project-declared review records
or host summaries enter the same admission through `[quality_gate].preserved_paths`;
their paths are explicit PM/project declarations, never inferred from an
extension or tool output.
