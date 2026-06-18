<#
.SYNOPSIS
  Garelier session digest (PowerShell). Compact, deterministic status summary
  for a Claude Code SessionStart hook when a human opens an interactive
  PM/Dock session (dispatch-only, DEC-061/066).

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
    # lane
    $lane = 'idle/dock'
    $laneLock = Join-Path $runtime 'lane.lock'
    if (Test-Path $laneLock -PathType Leaf) {
        $m = [regex]::Match((Get-Content -Raw -LiteralPath $laneLock -ErrorAction SilentlyContinue), '"lane"\s*:\s*"([^"]*)"')
        $lane = if ($m.Success) { $m.Groups[1].Value } else { 'held' }
    }

    # live dispatch producers (DEC-063 ephemeral _dispatch<N> homes)
    $live = 0
    foreach ($d in Get-ChildItem -LiteralPath $pmRoot -Directory -Filter '_dispatch*' -ErrorAction SilentlyContinue) {
        if (Test-Path (Join-Path $d.FullName 'STATE.md') -PathType Leaf) { $live++ }
    }

    # merge gate
    $gate = 'idle'
    if (Test-Path (Join-Path $runtime 'merge_gate/locks/active.lock') -PathType Leaf) { $gate = 'RUNNING' }
    $mgPending = Count-MergeResults (Join-Path $runtime 'merge_gate/requests')

    $pmInbox = Count-Files (Join-Path $runtime 'pm/inbox')
    $orchInbox = Count-Files (Join-Path $runtime 'dock/inbox')
    $mgResults = Count-MergeResults (Join-Path $runtime 'merge_gate/results')
    $obsResults = Count-Files (Join-Path $runtime 'observer/results')

    # doctor summary (best-effort)
    $doctorSummary = ''
    $doctor = Join-Path $PSScriptRoot 'doctor.ps1'
    if (Test-Path $doctor -PathType Leaf) {
        $out = & $doctor -PmId $PmId -ProjectRoot $Project 2>$null | Out-String
        $line = ($out -split "`n" | Where-Object { $_ -match '^Summary:' } | Select-Object -First 1)
        if ($line) { $doctorSummary = ($line -replace '^Summary:\s*', '').Trim() }
    }

    "── Garelier · PM $PmId ──────────────────────────────"
    "  lane: $lane    gate: $gate (pending $mgPending)    live dispatch: $live"
    "  inbox: pm $pmInbox / dock $orchInbox    results: merge-gate $mgResults / observer $obsResults"
    if ($doctorSummary) { "  doctor: $doctorSummary" }
    "  detail: status.ps1 -PmId $PmId -Project `"$Project`"  |  doctor.ps1 -PmId $PmId"
} catch {
    # never disturb the session
}
exit 0
