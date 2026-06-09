<#
.SYNOPSIS
  Garelier session digest (PowerShell). Compact, deterministic status summary
  for a Claude Code SessionStart hook when a human opens an interactive PM
  session (hybrid / manual mode).

.DESCRIPTION
  Replaces "AI, summarize the current state" (a token-spending model turn that
  reads runtime files) with a few printed lines from plain PowerShell. No
  provider call, no tokens. Read-only; always exits 0 so it never blocks the
  session. pm_id / project root are inferred from the cwd
  (__garelier/<pm_id>/_pm/); -PmId / -Project override.
#>
[CmdletBinding()]
param(
    [string]$PmId,
    [string]$Project
)

try {
    $cwd = (Get-Location).Path
    if (-not $PmId -and (Split-Path -Leaf $cwd) -eq '_pm') {
        $PmId = Split-Path -Leaf (Split-Path -Parent $cwd)
    }
    if (-not $Project) {
        $cur = $cwd
        while ($cur -and (Split-Path -Parent $cur) -ne $cur) {
            if (Test-Path (Join-Path $cur '__garelier') -PathType Container) { $Project = $cur; break }
            $cur = Split-Path -Parent $cur
        }
    }
    if (-not $Project -or -not $PmId) { exit 0 }
    $pmRoot = Join-Path $Project "__garelier/$PmId"
    if (-not (Test-Path $pmRoot -PathType Container)) { exit 0 }
    $runtime = Join-Path $pmRoot 'runtime'

    function Count-Files($dir) {
        if (Test-Path $dir -PathType Container) {
            return @(Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne '.gitkeep' }).Count
        }
        return 0
    }
    function Count-MergeResults($dir) {
        if (Test-Path $dir -PathType Container) {
            return @(Get-ChildItem -LiteralPath $dir -Filter '*.json' -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike '*.summary.json' }).Count
        }
        return 0
    }
    function Pid-Alive($p) { try { $null = Get-Process -Id $p -ErrorAction Stop; return $true } catch { return $false } }

    # lane
    $lane = 'idle/dock'
    $laneLock = Join-Path $runtime 'lane.lock'
    if (Test-Path $laneLock -PathType Leaf) {
        $m = [regex]::Match((Get-Content -Raw -LiteralPath $laneLock -ErrorAction SilentlyContinue), '"lane"\s*:\s*"([^"]*)"')
        $lane = if ($m.Success) { $m.Groups[1].Value } else { 'held' }
    }

    # driver
    $driver = 'stopped'
    $dpid = Join-Path $runtime 'driver/driver.pid'
    if (Test-Path $dpid -PathType Leaf) {
        $raw = (Get-Content -Raw -LiteralPath $dpid -ErrorAction SilentlyContinue)
        $pidNum = ($raw -replace '\D', '')
        if ($pidNum -and (Pid-Alive ([int]$pidNum))) { $driver = "running (pid $pidNum)" } else { $driver = 'stopped (stale pid)' }
    }

    $pmInbox = Count-Files (Join-Path $runtime 'pm/inbox')
    $orchInbox = Count-Files (Join-Path $runtime 'dock/inbox')
    $mgResults = Count-MergeResults (Join-Path $runtime 'merge_gate/results')
    $obsResults = Count-Files (Join-Path $runtime 'observer/results')

    # stale leases
    $stale = 0
    $pidsDir = Join-Path $runtime 'driver/pids'
    if (Test-Path $pidsDir -PathType Container) {
        foreach ($f in Get-ChildItem -LiteralPath $pidsDir -Filter '*.pid' -File -ErrorAction SilentlyContinue) {
            $c = Get-Content -Raw -LiteralPath $f.FullName -ErrorAction SilentlyContinue
            $pm = [regex]::Match($c, '"pid"\s*:\s*(\d+)')
            $sm = [regex]::Match($c, '"status"\s*:\s*"([^"]*)"')
            if ($pm.Success -and -not (Pid-Alive ([int]$pm.Groups[1].Value)) -and $sm.Groups[1].Value -ne 'finished') { $stale++ }
        }
    }

    # doctor summary (best-effort)
    $doctorSummary = ''
    $doctor = Join-Path $PSScriptRoot 'doctor.ps1'
    if (Test-Path $doctor -PathType Leaf) {
        $out = & $doctor -PmId $PmId -ProjectRoot $Project 2>$null | Out-String
        $line = ($out -split "`n" | Where-Object { $_ -match '^Summary:' } | Select-Object -First 1)
        if ($line) { $doctorSummary = ($line -replace '^Summary:\s*', '').Trim() }
    }

    "── Garelier · PM $PmId ──────────────────────────────"
    "  lane: $lane    driver: $driver"
    "  inbox: pm $pmInbox / dock $orchInbox    results: merge-gate $mgResults / observer $obsResults    stale leases: $stale"
    if ($doctorSummary) { "  doctor: $doctorSummary" }
    "  detail: status.ps1 -PmId $PmId -Project `"$Project`"  |  doctor.ps1 -PmId $PmId"
} catch {
    # never disturb the session
}
exit 0
