# Scheduled Jobs

This directory defines work that runs on a schedule (weekly summary,
daily data pull, monthly inventory, etc.). The schedule is owned by
Garelier; the **trigger** is owned by an external scheduler (Jenkins,
systemd timer, cron, Windows Task Scheduler).

Garelier is not a clock. AI agents do not poll the wall clock to
decide when to run. The external scheduler fires at the configured
time and notifies PM (typically via the same driver mechanism used for
autonomous mode, but specialized to a single job id). PM then routes
the job through the normal PM -> Dock -> Worker / Scout / Smith chain
according to `owner_role`.

The framework owns the job definition contract and ships a local reference
adapter. Jenkins, cron, systemd timer, Windows Task Scheduler, or another
local scheduler owns the actual clock and credentials, then invokes the
adapter when a job is due.

## Layout

```
__garelier/<pm_id>/control/scheduled_jobs/
├── README.md                              this file
├── templates/
│   └── scheduled_job.toml                 canonical template
├── examples/
│   └── J-001-weekly-dashboard-summary.toml
└── <job_id>.toml                          active job definitions
```

Reports go to `__garelier/<pm_id>/control/reports/scheduled_jobs/<job_id>/<YYYY-MM-DD>.md`.

Runtime locks and per-run state live under
`__garelier/<pm_id>/runtime/scheduled_jobs/`:

```
__garelier/<pm_id>/runtime/scheduled_jobs/
├── locks/                                 one directory per active lock
└── runs/<job_id>/<YYYY-MM-DDTHH-MM-SS>/   per-run scratch
```

## Reference adapter

The local reference implementation lives in the core skill:

```bash
garelier scheduler-adapter \
  --project-root /path/to/project \
  --job-id J-001-weekly-dashboard-summary
```

```powershell
garelier scheduler-adapter `
  -ProjectRoot C:\path\to\project `
  -JobId J-001-weekly-dashboard-summary
```

The adapter assumes the external scheduler has already decided the job is
due. It validates the job file, enforces `allow_promote = false`, creates a
`skip_if_running` lock, writes `runtime/scheduled_jobs/runs/.../run.toml`,
and notifies PM through `runtime/pm/inbox/`. It does not evaluate RRULEs or
execute the job body. PM or the owner role removes the lock after recording a
terminal run status.

## What a scheduled job is

A `.toml` file that records:

- **what** to do (`purpose`, `inputs`, `outputs`)
- **when** to do it (`schedule` as RRULE, `timezone`)
- **who** should execute it (`owner_role`: PM / Scout / Worker / Smith)
- **what is forbidden** (`[safety]`: `allow_commits`, `allow_promote`,
  `allow_production_write`)
- **how to avoid concurrency** (`[lock]`)
- **how to deliver results** (`[email]`, report path)

The `[safety]` block is mandatory. If a job needs to commit or
mutate external data, the relevant flag must be explicitly set true
and the operations policy
(`__garelier/<pm_id>/control/operations/data_change_policy.md`) applies.

## Schedule format

The canonical schedule is **RRULE** (RFC 5545). Examples:

| Intent                                        | RRULE                                                        |
| --------------------------------------------- | ------------------------------------------------------------ |
| Every Wednesday 06:00                         | `RRULE:FREQ=WEEKLY;BYDAY=WE;BYHOUR=6;BYMINUTE=0;BYSECOND=0`  |
| First Monday of each month, 06:00             | `RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1;BYHOUR=6;BYMINUTE=0` |
| Every weekday 09:00                           | `RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0` |
| Daily 03:00                                   | `RRULE:FREQ=DAILY;BYHOUR=3;BYMINUTE=0;BYSECOND=0`            |

`timezone` is **mandatory** and uses IANA format (`Asia/Tokyo`,
`UTC`, `America/Los_Angeles`).

Jenkins/cron expressions are generated artifacts or external
configuration; the canonical schedule stays in RRULE inside the
TOML.

## Safety rules (mandatory)

- `timezone` must be set.
- A `[lock]` block must be present (single instance per `resource`).
- Each run produces a fresh run id and report.
- Production writes default to forbidden. `allow_production_write =
  true` requires the data-change policy guards to be satisfied per
  run.
- `allow_promote = false` is enforced (promote is always
  user-instructed; no autonomy path can flip it).
- External email goes only to addresses in the job's
  `email.recipient_allowlist`, and each delivery is audited under
  `__garelier/<pm_id>/control/reports/notifications/`.
- Jenkins (or any other scheduler) is the **trigger**, not the
  decision-maker. It must not pick which job to run based on its
  own logic; it notifies PM about the one Garelier listed.

## Authoring a job

1. Copy `templates/scheduled_job.toml` to `<job_id>.toml`.
2. Pick a job id with format `J-NNN-<short-slug>` (integer zero-padded to a
   minimum of 3 digits, growing beyond — see control_contract.md "ID numbering";
   kebab-case slug).
3. Fill in `purpose`, `inputs`, `outputs`, `owner_role`,
   `timezone`, `schedule`.
4. Fill in the `[safety]` block (default to all false; turn on
   only what is genuinely needed).
5. Add `[lock]` with a unique `resource` name.
6. Add `[email]` if email delivery is needed.
7. Commit. Wire the external scheduler to invoke the reference adapter, or a
   project-specific equivalent, at the configured time (Jenkins/cron details
   live in the project's ops layer, not here).

## Examples

See `examples/J-001-weekly-dashboard-summary.toml` for the
canonical reference example (weekly project_dashboard summary).
