# Garelier Driver

Autonomous driver for the Garelier multi-agent coordination framework. TypeScript + Bun. Spawns a configured local provider CLI per role iteration: `claude -p` for Claude Code or `codex exec` for Codex CLI. Both use their normal local login stores; no provider API key is managed by the driver.

This driver replaces the previous shell-based driver. The architecture difference:

- **Bun + provider subprocess** (this driver): cross-platform, structured logging, mtime-based pre-check, driver PID plus per-agent leases. Reliable subprocess spawning via `Bun.spawn` — no PowerShell argv re-tokenization, no cwd mismatch, no Job-Object lifetime issues.
- **Previous shell drivers** (deleted): hit nine consecutive bugs that took multiple rebuilds to chase down. The Bun layer fixes the shell-level quirks; using local CLIs keeps it usable with your existing local CLI login.

## Prerequisites

- **Bun** 1.1+: `winget install Oven-sh.Bun` / `irm bun.com/install.ps1 | iex` / `curl -fsSL https://bun.sh/install | bash`
- **At least one provider CLI authenticated**:
  - Claude Code: `claude login` once (uses your existing Claude Code login).
  - Codex CLI: `codex login` once.
- **`ripgrep`** on PATH (Claude uses it for Grep): `winget install BurntSushi.ripgrep.MSVC` / `brew install ripgrep`
- Garelier skills installed (`install.sh` / `install.ps1` from the Garelier repo)

## First-time install

```sh
cd ../driver
bun install
```

(Bun caches `node_modules/` per-directory; `start_driver.{sh,ps1}` will auto-run this if it's missing.)

## Run

### Recommended: use the helper script

```powershell
garelier driver -PmId <pm_id> -ProjectRoot C:\path\to\project
```

```bash
garelier driver --pm-id <pm_id> --project /path/to/project
```

The helper spawns the driver **detached** (Windows hidden process / Unix `setsid`) so it survives the launching shell exiting. Returns immediately; logs go to `<project>/__garelier/<pm_id>/runtime/driver/logs/`.

### Or: run directly (foreground)

```sh
cd /path/to/project
bun run ../driver/src/main.ts --pm-id <pm_id>
```

### CLI flags

```
--pm-id <id>            PM identity to supervise (REQUIRED, unless
                        GARELIER_PM_ID env var is set or cwd is
                        inside __garelier/<pm_id>/...).
--project, -p <path>    Project root (default: cwd)
--once                  Run one poll cycle and exit (for smoke testing)
--poll <seconds>        Override [autonomy] driver_poll_interval_seconds
--spawn-cmd <cmd>       Override provider spawn binary globally. For tests/debug.
--max-budget-usd <n>    Pass --max-budget-usd to Claude Code invocations
--help, -h              Show help
```

The driver supervises **one pm_id per process**. To run multiple PMs in
parallel on the same project (or different projects), launch one driver
per PM — each gets its own `driver.pid` / logs / poll loop under
`__garelier/<pm_id>/runtime/driver/`.

Required config in `__garelier/<pm_id>/_pm/setup_config.toml`:
- `[autonomy] enabled = true`
- `[setup] complete = true` (written by the setup wizard)

Provider config is read at driver start from `[runner]` plus each
`[[workers]]` / `[[scouts]]` / `[[smiths]]` block:

```toml
[runner]
pm_provider = "codex-cli"
pm_model = "gpt-5-codex"
pm_effort = "xhigh"
dock_provider = "codex-cli"
dock_model = "gpt-5-codex"
default_agent_provider = "codex-cli"
default_agent_model = "gpt-5-codex"

[[workers]]
id = "worker-01"
provider = "codex-cli"
model = "gpt-5-codex"
effort = "xhigh"
```

Changing provider/model/effort requires restarting the driver. Agent
pool changes still go through setup wizard diff mode.

## Stop

```powershell
# Graceful — in-flight iterations finish, driver exits within poll interval
& "..\scripts\stop_driver.ps1" -PmId <pm_id> -ProjectRoot <path> -Wait
```

Or three equivalent alternatives:
- `New-Item __garelier/<pm_id>/runtime/driver/stop -ItemType File` (touch the stop file)
- Ctrl-C in the driver terminal (SIGINT trap → graceful)
- `/quit` the **interactive** PM session: SessionEnd hook (configured by setup wizard in `_pm/.claude/settings.json`) touches the stop file automatically. The hook is gated on `GARELIER_DRIVER` being unset, so the driver's own headless PM iterations (`supervise_pm = true`, which sets `GARELIER_DRIVER=1`) do NOT trip it — only a human `/quit` does.

PID is in `__garelier/<pm_id>/runtime/driver/driver.pid`. Removed on graceful exit.
Worker / Scout / Smith iterations already launched by the driver are
detached and may finish after the driver stops. Their leases stay under
`runtime/driver/pids/`; a restarted driver will not duplicate a live
leased iteration.

## What it does

Every `driver_poll_interval_seconds` (default 60, configured in `[autonomy]`):

1. **PM** (if `supervise_pm = true`): run one PM iteration if `runtime/pm/inbox/`, `roadmap.md`, `current.md`, or `manifest.md` changed.
2. **Dock**: run one Dock iteration if `runtime/pm/resolutions/`, `runtime/dock/inbox/`, `control/blueprints/`, `manifest.md`, `_pm/history.md`, or any `_workers/*/STATE.md` / `_scouts/*/STATE.md` / `_smiths/*/STATE.md` changed.
3. **Each Worker** whose state is runnable and whose assignment / review / answers / etc. files changed: launch one detached Worker child iteration if no live Worker lease exists. `REPORTING`, `REVIEWING`, and `BLOCKED` are treated as waiting states until `under_review.md`, `review.md`, `merged.md`, `answers.md`, or `abort.md` appears.
4. **Each Scout** whose state is runnable and whose assignment / answers / committed marker changed: launch one detached Scout child iteration if no live Scout lease exists. `REPORTING` waits for `committed.md`; `BLOCKED` waits for `answers.md`.
5. **Each Smith** follows the Worker-style runnable rules for Anvil work and is launched as a detached child iteration. `REPORTING`, `REVIEWING`, and `BLOCKED` wait for Dock/PM marker files before the provider CLI is spawned again.

Worker / Scout / Smith child iterations are deliberately detached from
the poll loop. The driver writes a JSON lease at
`runtime/driver/pids/<role>-<id>.pid` with `pid`, `assignment_hash`,
`branch`, and `started_at`, then returns to the poll loop. On later
polls it:

- skips duplicate launch while the lease PID is alive;
- consumes a finished lease and records retry/backoff if the child
  reported failure or rate limit;
- clears a dead stale lease and invalidates the role mtime snapshot so
  the work can retry.

PM and Dock still run in the foreground for one iteration because
they own dispatch/review decisions. Long Worker / Scout / Smith turns no
longer block the next PM/Dock poll.

**Concurrency cap + priority tiers (DEC-027 / DEC-031).** Enabling every role is
encouraged, but launching all runnable detached agents at once can exhaust
machine memory. `[concurrency] max_concurrent_agents` (default 4; 0 = unlimited)
bounds how many detached provider CLIs are alive at once. Each poll the driver
counts live leases → `budget = max(0, cap - alive)`, gathers the runnable agents
(probing interest files **without** consuming the change snapshot, so a deferred
agent is re-offered intact next poll), then launches up to `budget` in
`[concurrency] tiers` order — deferring the rest. Within a tier the
longest-waiting agent runs first (FIFO); a candidate deferred `starvation_cycles`
polls in a row (default 3) is promoted to the front so no tier starves. A
per-task `urgent.md` marker jumps an instance above all tiers (never preempting —
it takes the next free slot); Dock can reorder the producer tiers at runtime
via `runtime/dock/tier_order.json`. **PM, Dock, and the merge-gate
subprocess are not counted** — they are the coordination spine and always run.
`status` shows `alive / cap detached agents`. (DEC-031 replaced the original flat
`priority` list with `tiers`; "tier" is launch priority, distinct from the DEC
0017 execution *lanes*.)

**Pre-check by mtime — idle projects cost 0 provider tokens.** A role's provider CLI is only spawned when something it would actually consult has changed since the last iteration. The mtime snapshot is persisted at `runtime/driver/change_tracker.json`, so restart does not cause a no-op PM/Dock/agent cold-start call when nothing changed.

Each spawn:
- `cwd` = the role's worktree (`__garelier/<pm_id>/_dock/` for Dock, `__garelier/<pm_id>/_workers/<id>/` for that worker, etc.)
- `--add-dir <project-root>` and the Garelier skill directory so paths outside cwd are readable
- Provider-specific headless flags:
  - Claude Code: `--dangerously-skip-permissions`, `--append-system-prompt-file`, `--output-format json`
  - Codex CLI: `codex exec --sandbox danger-full-access --ask-for-approval never --json --output-last-message <file>`
- Per-iteration prompt fed via stdin (no argv length / quoting limits)

Authentication is whatever `claude login` or `codex login` set up. The driver itself doesn't touch credentials.

## Hybrid mode

`[autonomy] supervise_pm = false`: driver skips PM, supervises Dock/Workers/Scouts/Smiths only. Run an interactive PM session in `__garelier/<pm_id>/_pm/` yourself with `claude`. See `garelier-pm/references/autonomous-mode.md` §15.8.

## Logs

Two log surfaces under `__garelier/<pm_id>/runtime/driver/logs/`:

- `driver.jsonl` — per-poll-cycle structured log (start/stop, skip reasons, role invocations)
- `<role>.jsonl` — per-role iteration log (one record per iteration, with cost / token counts / exit code / result snippet)
- `driver.stdout.log` (when started via `start_driver` helper) — raw stdout/stderr of the driver process
- `../pids/<role>-<id>.pid` — JSON lease for detached Worker / Scout /
  Smith child iterations. Despite the `.pid` suffix, new files are JSON;
  status helpers still tolerate legacy plain-number pid files.

Each line is a JSON record: `{ts, level, source, event, ...}`. `cat | jq` to parse, or `Get-Content -Wait` to live-tail.

Pair with `skills/garelier-core/scripts/status.{sh,ps1}` for human-readable snapshots of project state.

## Multi-project / multi-PM

The driver is single-PM per process — point it at one `--project` root and
one `--pm-id`. To run several PMs (in the same project or across projects)
in parallel, launch one driver per `(project, pm_id)` pair. Each gets its
own `driver.pid` / logs / poll loop under
`__garelier/<pm_id>/runtime/driver/`. No global registry; processes are
independent. See DEC-006 (per-PM namespace).

## Without the driver: `/loop` mode

If you don't want the Bun toolchain — pure Pro account, just trying Garelier out, or debugging one role at a time — you can run all roles as interactive `claude` sessions and use `/loop <interval> "<prompt>"` to auto-poll the non-PM ones. See `garelier-pm/references/autonomous-mode.md` §15.10 for the prompts to paste.

The driver is the right answer for unattended overnight runs; `/loop` mode is the right answer for live observation and easy intervention.

## File layout

```
driver/
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── main.ts       # CLI, PID, signals, main poll loop
    ├── agent_child.ts # detached Worker/Scout/Smith one-iteration runner
    ├── config.ts     # parse setup_config.toml
    ├── state.ts     # STATE.md + mtime change detection
    ├── prompts.ts   # per-iteration user prompts + headless directive
    ├── role.ts      # spawns provider CLI with the right flags
    └── log.ts       # structured (human + JSONL) logger
```

No `tools.ts` — provider CLIs bring their own tools. The driver only handles coordination: when to spawn, where to spawn (which cwd / which role), and what to feed it.
