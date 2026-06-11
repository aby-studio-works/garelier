#Requires -Version 5.1
<#
.SYNOPSIS
    Garelier Status (PowerShell) — dispatch-native (DEC-066).
.DESCRIPTION
    PowerShell twin of status.sh — keep behavior at parity.
    Shows what is REAL under dispatch-only: lane.lock, merge gate, backlog,
    LIVE ephemeral producers (_dispatch<N>/STATE.md), parked inventory
    (non-IDLE STATE.md in legacy role containers), recent dispatch events,
    and the Status Web URL. No driver pids/leases/usage logs (deleted,
    DEC-066). For the full picture use the Status Web.
.EXAMPLE
    .\status.ps1 -PmId acme -Project C:\proj [-Watch 5]
#>
[CmdletBinding()]
param(
    [string]$Project = (Get-Location).Path,
    [string]$PmId = "",
    [int]$Watch = 0
)
$ErrorActionPreference = 'SilentlyContinue'
$GarelierRoot = Join-Path $Project '__garelier'

function Get-Pms {
    if (-not (Test-Path -LiteralPath $GarelierRoot)) { return @() }
    Get-ChildItem -LiteralPath $GarelierRoot -Directory | Where-Object {
        Test-Path -LiteralPath (Join-Path $_.FullName '_pm/setup_config.toml')
    } | ForEach-Object { $_.Name }
}

function Get-TomlVal([string]$File, [string]$Key) {
    $m = Select-String -LiteralPath $File -Pattern ('^\s*' + $Key + '\s*=\s*"(.*)"') | Select-Object -First 1
    if ($m) { $m.Matches[0].Groups[1].Value } else { '' }
}

function Get-StateWord([string]$File) {
    $lines = Get-Content -LiteralPath $File
    $f = $false
    foreach ($l in $lines) {
        if ($l -match '^##\s*Status') { $f = $true; continue }
        if ($f -and $l.Trim()) { return $l.Trim() }
    }
    ''
}

function Get-TaskLine([string]$File) {
    $lines = Get-Content -LiteralPath $File
    $f = $false
    foreach ($l in $lines) {
        if ($l -match '^##\s*Current task') { $f = $true; continue }
        if ($f -and $l.Trim()) { $t = $l.Trim(); if ($t.Length -gt 100) { return $t.Substring(0, 100) } return $t }
    }
    ''
}

function Show-Pm([string]$pm) {
    $base = Join-Path $GarelierRoot $pm
    $cfg = Join-Path $base '_pm/setup_config.toml'
    Write-Output "--- PM: $pm ---"
    if (Test-Path -LiteralPath $cfg) {
        Write-Output "  target:  $(Get-TomlVal $cfg 'target')"
        Write-Output "  studio:  $(Get-TomlVal $cfg 'integration')"
    }

    $lane = Join-Path $base 'runtime/lane.lock'
    if (Test-Path -LiteralPath $lane) {
        $raw = (Get-Content -LiteralPath $lane -Raw) -replace "`r?`n", ' '
        if ($raw.Length -gt 120) { $raw = $raw.Substring(0, 120) }
        Write-Output "  lane:    $raw"
    } else {
        Write-Output "  lane:    dock (default; no lane.lock)"
    }

    $mg = Join-Path $base 'runtime/merge_gate'
    $act = Join-Path $mg 'locks/active.lock'
    $pend = @(Get-ChildItem -LiteralPath (Join-Path $mg 'requests') -Filter '*.json' |
        Where-Object { $_.Name -notlike '*.summary.json' }).Count
    if (Test-Path -LiteralPath $act) {
        $raw = (Get-Content -LiteralPath $act -Raw) -replace "`r?`n", ' '
        if ($raw.Length -gt 100) { $raw = $raw.Substring(0, 100) }
        Write-Output "  gate:    RUNNING ($raw) | pending=$pend"
    } else {
        $last = Get-ChildItem -LiteralPath (Join-Path $mg 'results') -Filter '*.json' |
            Where-Object { $_.Name -notlike '*summary*' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($last) {
            $st = ''
            $m = Select-String -LiteralPath $last.FullName -Pattern '"status"\s*:\s*"([a-z]+)"' | Select-Object -First 1
            if ($m) { $st = $m.Matches[0].Groups[1].Value }
            Write-Output "  gate:    idle | last=$st ($($last.Name)) | pending=$pend"
        } else {
            Write-Output "  gate:    idle | pending=$pend"
        }
    }

    $bl = Join-Path $base 'runtime/backlog'
    if (Test-Path -LiteralPath $bl) {
        $pn = 0; $dn = 0; $nid = '-'
        $pf = Join-Path $bl 'pending.md'
        if (Test-Path -LiteralPath $pf) { $pn = @(Select-String -LiteralPath $pf -Pattern '^\|\s*[0-9#]').Count }
        $dd = Join-Path $bl 'done'
        if (Test-Path -LiteralPath $dd) { $dn = @(Get-ChildItem -LiteralPath $dd -Filter '*.md').Count }
        $nf = Join-Path $bl 'next_id'
        if (Test-Path -LiteralPath $nf) { $nid = ((Get-Content -LiteralPath $nf -Raw) -replace '[^0-9]', '') }
        Write-Output "  backlog: pending=$pn done=$dn next_id=#$nid"
    }

    $found = $false
    foreach ($d in Get-ChildItem -LiteralPath $base -Directory -Filter '_dispatch*') {
        $sf = Join-Path $d.FullName 'STATE.md'
        if (-not (Test-Path -LiteralPath $sf)) { continue }
        $found = $true
        Write-Output "  LIVE:    $($d.Name) $(Get-StateWord $sf) - $(Get-TaskLine $sf)"
    }
    if (-not $found) { Write-Output "  LIVE:    none (producers exist only while a task executes)" }

    $parked = $false
    $legacy = @('_workers', '_scouts', '_smiths', '_librarians', '_observers', '_guardians', '_concierges')
    $containers = @()
    foreach ($g in $legacy) {
        $gd = Join-Path $base $g
        if (Test-Path -LiteralPath $gd) { $containers += Get-ChildItem -LiteralPath $gd -Directory }
    }
    $art = Join-Path $base '_artisan'
    if (Test-Path -LiteralPath $art) { $containers += Get-Item -LiteralPath $art }
    foreach ($c in $containers) {
        $sf = Join-Path $c.FullName 'STATE.md'
        if (-not (Test-Path -LiteralPath $sf)) { continue }
        $st = Get-StateWord $sf
        if (-not $st -or $st -ieq 'IDLE') { continue }
        $parked = $true
        $rel = $c.FullName.Substring($base.Length + 1) -replace '\\', '/'
        Write-Output "  PARKED:  $rel $st - $(Get-TaskLine $sf)"
    }
    if (-not $parked) { Write-Output "  PARKED:  none" }

    $ev = Join-Path $base 'runtime/dispatch/events.jsonl'
    if (Test-Path -LiteralPath $ev) {
        Write-Output "  recent events:"
        Get-Content -LiteralPath $ev -Tail 5 | ForEach-Object {
            $m = [regex]::Match($_, '"kind":"([a-z]+)".*?"task":"([^"]{1,90})')
            if ($m.Success) { Write-Output "    [$($m.Groups[1].Value)] $($m.Groups[2].Value)" }
        }
    }

    $swf = Join-Path $base 'runtime/status_web/status_web.json'
    if (Test-Path -LiteralPath $swf) {
        $m = Select-String -LiteralPath $swf -Pattern '"url"\s*:\s*"([^"]+)"' | Select-Object -First 1
        if ($m) { Write-Output "  status web: $($m.Matches[0].Groups[1].Value)" }
    }
}

function Show-Status {
    $now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
    Write-Output "=== Garelier Status - $now (dispatch-only) ==="
    Write-Output "Root: $Project"
    $pms = if ($PmId) { @($PmId) } else { @(Get-Pms) }
    if ($pms.Count -eq 0) {
        Write-Output "No Garelier PMs found under $GarelierRoot. Run setup_wizard to initialize a PM."
        return
    }
    foreach ($pm in $pms) { Write-Output ""; Show-Pm $pm }
}

if ($Watch -gt 0) {
    while ($true) { Clear-Host; Show-Status; Start-Sleep -Seconds $Watch }
} else {
    Show-Status
}
