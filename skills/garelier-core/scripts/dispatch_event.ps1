#Requires -Version 5.1
<#
.SYNOPSIS
    Garelier dispatch event (PowerShell) — W-011 (DEC-064 §3): single-source
    runtime execution state. Twin of dispatch_event.sh — keep parity.
.DESCRIPTION
    1. Appends ONE event line to runtime/dispatch/events.jsonl — the
       append-only record of dispatch execution ({ts, role, kind, task, ref};
       proper JSON escaping, so callers never hand-write JSON).
    2. Regenerates the derived view runtime/backlog/in_flight.md from the
       live _dispatch<N>/STATE.md containers (the structural truth). The view
       is GENERATED — never hand-edited.
.EXAMPLE
    .\dispatch_event.ps1 -Project C:\proj -PmId tpm -Kind complete `
        -Role 'worker(#40)' -Task '#40 slug -> ENQUEUED'
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Project,
    [Parameter(Mandatory)][string]$PmId,
    [string]$Kind = '',
    [string]$Role = '',
    [string]$Task = '',
    [string]$Ref = '',
    [switch]$RegenOnly
)
$ErrorActionPreference = 'Stop'

$base = Join-Path $Project "__garelier/$PmId"
if (-not (Test-Path -LiteralPath $base -PathType Container)) {
    Write-Error "dispatch_event: no PM at $base"; exit 1
}

function ConvertTo-JsonEscaped([string]$s) {
    ($s -replace '\\', '\\' -replace '"', '\"') -replace "`r|`n", ''
}

if (-not $RegenOnly) {
    if (-not $Kind -or -not $Role -or -not $Task) {
        Write-Error 'dispatch_event: -Kind/-Role/-Task required (or pass -RegenOnly)'; exit 1
    }
    $evDir = Join-Path $base 'runtime/dispatch'
    New-Item -ItemType Directory -Force $evDir | Out-Null
    $ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
    $refJson = if ($Ref) { '"' + (ConvertTo-JsonEscaped $Ref) + '"' } else { 'null' }
    $line = '{"ts":"' + $ts + '","role":"' + (ConvertTo-JsonEscaped $Role) + '","kind":"' + (ConvertTo-JsonEscaped $Kind) + '","task":"' + (ConvertTo-JsonEscaped $Task) + '","ref":' + $refJson + '}'
    Add-Content -LiteralPath (Join-Path $evDir 'events.jsonl') -Value $line
}

# Derived view: the live producers. Structural truth = _dispatch<N>/STATE.md.
$view = Join-Path $base 'runtime/backlog/in_flight.md'
New-Item -ItemType Directory -Force (Split-Path -Parent $view) | Out-Null
$sb = [System.Text.StringBuilder]::new()
[void]$sb.AppendLine('# In flight — GENERATED VIEW (DEC-064 W-011)')
[void]$sb.AppendLine('')
[void]$sb.AppendLine('Derived from the live `_dispatch<N>/STATE.md` containers by')
[void]$sb.AppendLine('`scripts/dispatch_event.{sh,ps1}`. Do not edit — rewritten on every')
[void]$sb.AppendLine('dispatch event. The append-only record is `runtime/dispatch/events.jsonl`.')
[void]$sb.AppendLine('')
[void]$sb.AppendLine('| Task | Agent | Branch |')
[void]$sb.AppendLine('| ---- | ----- | ------ |')
foreach ($d in Get-ChildItem -LiteralPath $base -Directory -Filter '_dispatch*' -ErrorAction SilentlyContinue) {
    $sf = Join-Path $d.FullName 'STATE.md'
    if (-not (Test-Path -LiteralPath $sf -PathType Leaf)) { continue }
    $n = $d.Name -replace '^_dispatch', ''
    $body = Get-Content -LiteralPath $sf -Raw
    $roleM = [regex]::Match($body, '(?m)^#\s*Dispatch\s*#\d+\s*-\s*([A-Za-z]+)')
    $taskM = [regex]::Match($body, '(?ms)##\s*Current task\s*\r?\n\s*(\S[^\r\n]*)')
    $taskLine = if ($taskM.Success) { $taskM.Groups[1].Value.Trim() } else { '' }
    $branchM = [regex]::Match($taskLine, '\(([^()]+)\)\s*$')
    $branch = if ($branchM.Success) { $branchM.Groups[1].Value } else { '' }
    $taskName = ($taskLine -replace '\s*\([^()]*\)\s*$', '')
    if (-not $taskName) { $taskName = "#$n" }
    $roleName = if ($roleM.Success) { $roleM.Groups[1].Value } else { '?' }
    [void]$sb.AppendLine("| $taskName | dispatch$n ($roleName) | $branch |")
}
# Legacy/parked: any non-IDLE persistent role container also carries live
# work (same truth status.{sh,ps1} shows as PARKED).
$legacyContainers = @()
foreach ($g in @('_workers', '_scouts', '_smiths', '_librarians', '_observers', '_guardians', '_concierges')) {
    $gd = Join-Path $base $g
    if (Test-Path -LiteralPath $gd) { $legacyContainers += Get-ChildItem -LiteralPath $gd -Directory -ErrorAction SilentlyContinue }
}
$art = Join-Path $base '_artisan'
if (Test-Path -LiteralPath $art) { $legacyContainers += Get-Item -LiteralPath $art }
foreach ($c in $legacyContainers) {
    $sf = Join-Path $c.FullName 'STATE.md'
    if (-not (Test-Path -LiteralPath $sf -PathType Leaf)) { continue }
    $body = Get-Content -LiteralPath $sf -Raw
    $stM = [regex]::Match($body, '(?ms)##\s*Status\s*\r?\n\s*(\S+)')
    $st = if ($stM.Success) { $stM.Groups[1].Value.Trim() } else { '' }
    if (-not $st -or $st -ieq 'IDLE') { continue }
    $roleDir = (Split-Path -Leaf (Split-Path -Parent $c.FullName)) -replace '^_', '' -replace 's$', ''
    $cid = $c.Name
    if ($c.Name -eq '_artisan') { $cid = 'artisan'; $roleDir = 'artisan' }
    $taskM = [regex]::Match($body, '(?ms)##\s*Current task\s*\r?\n\s*(\S[^\r\n]*)')
    $taskLine = if ($taskM.Success) { $taskM.Groups[1].Value.Trim() } else { "($st)" }
    if ($taskLine.Length -gt 100) { $taskLine = $taskLine.Substring(0, 100) }
    [void]$sb.AppendLine("| $taskLine | $cid ($roleDir) | |")
}
[System.IO.File]::WriteAllText($view, $sb.ToString(), [System.Text.UTF8Encoding]::new($false))
