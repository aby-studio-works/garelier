# Driver Failure Scenario Checklist / driver 異常終了検証

> Purpose: manually verify that the autonomous driver can stop, restart,
> skip duplicate role invocations, and recover from stale PID files.
> Run this checklist when `skills/garelier-core/scripts/start_driver.{sh,ps1}`
> changes.

この手順は target project 側の検証用です。framework repo 自体には runtime が
ないため、setup wizard で作った一時 repo か、実プロジェクトの検証用 clone で
実行します。

## 1. Test Harness

実 Claude を呼ばずに driver だけを検証するため、`GARELIER_SPAWN_CMD` を
短命の stub に差し替えます。stub は引数を log に書いてすぐ終了するだけで
十分です。

### Bash stub

```bash
mkdir -p /tmp/garelier-driver-stub
cat > /tmp/garelier-driver-stub/spawn.sh <<'EOF'
#!/usr/bin/env bash
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) cwd=$PWD args=$*" >> "$GARELIER_STUB_LOG"
sleep "${GARELIER_STUB_SLEEP:-0}"
exit "${GARELIER_STUB_EXIT:-0}"
EOF
chmod +x /tmp/garelier-driver-stub/spawn.sh
export GARELIER_SPAWN_CMD=/tmp/garelier-driver-stub/spawn.sh
export GARELIER_STUB_LOG="$PWD/__garelier/<pm_id>/runtime/driver/stub.log"
```

### PowerShell stub

```powershell
New-Item -ItemType Directory -Force C:\tmp\garelier-driver-stub | Out-Null
@'
param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Args)
$ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
Add-Content -LiteralPath $env:GARELIER_STUB_LOG -Value "$ts cwd=$PWD args=$($Args -join ' ')"
if ($env:GARELIER_STUB_SLEEP) { Start-Sleep -Seconds ([int]$env:GARELIER_STUB_SLEEP) }
if ($env:GARELIER_STUB_EXIT) { exit ([int]$env:GARELIER_STUB_EXIT) }
exit 0
'@ | Set-Content -Encoding UTF8 C:\tmp\garelier-driver-stub\spawn.ps1
$env:GARELIER_SPAWN_CMD = "pwsh -NoLogo -NonInteractive -File C:\tmp\garelier-driver-stub\spawn.ps1"
$env:GARELIER_STUB_LOG = "$PWD\__garelier\<pm_id>\runtime\driver\stub.log"
```

Use a short poll interval in `__garelier/<pm_id>/_pm/setup_config.toml`:

```toml
[autonomy]
enabled = true
driver_poll_interval_seconds = 2
```

## 2. Baseline Start / Stop

Expected:

- Driver creates `__garelier/<pm_id>/runtime/driver/driver.pid`.
- Driver creates `__garelier/<pm_id>/runtime/driver/logs/driver.jsonl`.
- PM and Dock are invoked once per poll.
- `touch __garelier/<pm_id>/runtime/driver/stop` (PowerShell:
  `New-Item __garelier/<pm_id>/runtime/driver/stop -ItemType File`) causes the
  driver to exit on the next poll and remove the stop file.

Pass criteria:

- driver exits without stack trace.
- no stop file remains.
- `driver.jsonl` contains `stop_requested` and `shutting_down`.

## 3. Autonomy Disabled

Set:

```toml
[autonomy]
enabled = false
```

Expected:

- Driver prints `[autonomy] enabled != true; exiting.`
- No role invocation happens.
- Existing project files are not modified except driver directories that
  may be created before the config check.

## 4. Stale Driver PID Cleanup

With autonomy enabled, create a stale PID file:

```bash
mkdir -p __garelier/<pm_id>/runtime/driver
echo 999999 > __garelier/<pm_id>/runtime/driver/driver.pid
```

Expected on next start:

- Driver removes the stale `driver.pid`.
- Driver starts and writes its real PID.
- `driver.jsonl` does not show repeated errors for the stale PID.

## 5. Live Driver PID Refusal

Start a long sleep process and write its PID into `driver.pid`.

Bash:

```bash
sleep 30 &
echo $! > __garelier/<pm_id>/runtime/driver/driver.pid
```

PowerShell:

```powershell
$p = Start-Process pwsh -ArgumentList '-NoLogo','-NonInteractive','-Command','Start-Sleep 30' -PassThru
Set-Content __garelier/<pm_id>/runtime/driver/driver.pid $p.Id
```

Expected:

- A new driver refuses to start while the PID is alive.
- After the sleep exits, a new driver start removes the stale PID and
  proceeds.

## 6. Runnable Worker / Scout / Smith Selection

Edit one Worker `STATE.md` to each state and observe invocation behavior.

Worker invoked:

- `ASSIGNED`
- `WORKING`
- `REWORK`
- `REPORTING` only when `under_review.md`, `review.md`, `merged.md`, or `abort.md` exists
- `REVIEWING` only when `review.md`, `merged.md`, or `abort.md` exists
- `BLOCKED` only when `answers.md` or `abort.md` exists
- `MERGED` only when `merged.md` or `abort.md` exists

Worker skipped:

- `IDLE`
- `REPORTING` awaiting Dock review marker
- `REVIEWING` awaiting review/merge result
- `BLOCKED` awaiting answer
- `ABORTED`
- missing `STATE.md`

Scout invoked:

- `ASSIGNED`
- `WORKING`
- `REPORTING` only when `committed.md` or `abort.md` exists
- `BLOCKED` only when `answers.md` or `abort.md` exists

Scout skipped:

- `IDLE`
- `REPORTING` awaiting `committed.md`
- `BLOCKED` awaiting answer
- `ABORTED`
- missing `STATE.md`

Smith invoked:

- `ASSIGNED`
- `WORKING`
- `REWORK`
- `REPORTING` only when `under_review.md`, `review.md`, `merged.md`, or `abort.md` exists
- `REVIEWING` only when `review.md`, `merged.md`, or `abort.md` exists
- `BLOCKED` only when `answers.md` or `abort.md` exists
- `MERGED` only when `merged.md` or `abort.md` exists

Smith skipped:

- `IDLE`
- `REPORTING` awaiting Dock review marker
- `REVIEWING` awaiting review/merge result
- `BLOCKED` awaiting answer
- `ABORTED`
- missing `STATE.md`

Unknown states should be skipped and logged as `NO_STATE` unless an
assignment/bootstrap file exists.

Restart smoke test:

1. Run `--once` twice against an unchanged PM tree.
2. If a Worker / Scout / Smith child lease is still alive, confirm the
   second run logs `agent_lease_running` and does not launch a duplicate.
   If no child lease is active, confirm the second run logs only
   `*_skipped` for unchanged roles.
3. Confirm `__garelier/<pm_id>/runtime/driver/change_tracker.json`
   exists and is updated.
4. For a completed detached child, run one more `--once` and confirm the
   driver consumes and removes
   `__garelier/<pm_id>/runtime/driver/pids/<role>-<id>.pid`.

## 7. Driver Killed Mid-Run

Set the stub sleep to keep role processes alive:

```bash
export GARELIER_STUB_SLEEP=30
```

Start the driver, wait for role PID files, then kill only the driver
process. Do not kill the role stub processes.

Expected after restarting the driver:

- Worker / Scout / Smith leases exist as JSON files under
  `__garelier/<pm_id>/runtime/driver/pids/<role>-<id>.pid`.
- Each live lease records at least `pid`, `assignment_hash`, `branch`,
  and `started_at`.
- If leased role processes are still alive, driver keeps their PID files
  and skips duplicate invocations.
- After role processes exit, driver consumes finished leases. If a role
  process died without writing a finished outcome, driver clears the
  stale lease, invalidates that role's mtime snapshot, and resumes normal
  invocation.
- No manual edit to `manifest.md` is needed for this scenario.

## 8. Spawn Failure

Set the stub to exit non-zero:

```bash
export GARELIER_STUB_EXIT=42
```

Expected:

- A failed role invocation is visible in that role's log file.
- Driver keeps running unless the spawn command itself cannot be started.

If the spawn binary is missing or cannot be started, record the actual
behavior for both bash and PowerShell. The desired safety behavior is:
log the failure, leave project state untouched, and allow the operator to
fix `GARELIER_SPAWN_CMD` before restart.

## 9. Recovery Cross-Check

After each failure scenario:

- `git status --short` in the target project has no unexpected source
  changes.
- `__garelier/<pm_id>/runtime/driver/logs/driver.jsonl` records the event.
- `__garelier/<pm_id>/runtime/driver/driver.pid` is absent after stop or
  points at the live driver.
- `__garelier/<pm_id>/runtime/driver/stop` is absent unless intentionally set.
- `__garelier/<pm_id>/runtime/manifest.md` remains parseable.

If any condition fails, follow
`__garelier/<pm_id>/control/operations/recovery.md` before restarting autonomy.

## 10. Merge Gate Result Visibility

Run this after changing `merge-gate.{sh,ps1}`, `driver/src/merge_gate.ts`,
or Dock's merge-result handling.

Expected:

- The subprocess archives only
  `runtime/merge_gate/requests/<request_id>.json`.
- `runtime/merge_gate/results/<request_id>.json` remains in place until
  Dock consumes it.
- `runtime/merge_gate/results/<request_id>.summary.json` remains in place
  until Dock consumes it.
- `runtime/merge_gate/logs/<request_id>.log` remains in place until
  Dock consumes it.
- After Dock writes `merged.md` or `review.md`, Dock moves the
  result JSON, summary JSON, and log into `runtime/merge_gate/archive/`.
- In a multi-PM project, pre-merge target tracking reads
  `__garelier/<pm_id>/_pm/setup_config.toml` from the request's own PM
  tree, never from a sibling PM.

Pass criteria:

- Success, failed, conflict, and aborted result files are visible under
  `results/` before Dock consumption.
- A quality-gate command that exits non-zero produces
  `status:"failed"` with gate-step evidence, not `status:"aborted"`.
- A dead subprocess with no result produces one synthetic
  `status:"aborted"` result on the next driver poll.
- A dead subprocess with an existing result only clears stale
  `locks/active.lock`; it does not overwrite the result.

See also
[`operational_scenario_validation.md`](operational_scenario_validation.md)
for the wider 10+ scenario operational assessment.
