#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Project = (Get-Location).Path,
    [Parameter(Mandatory = $true)]
    [string[]]$FromPmId,
    [string]$ToPmId = '_workshop',
    [string]$BatchId = (Get-Date -Format 'yyyyMMdd-HHmmss'),
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'

function Test-PmId([string]$Id) {
    return $Id -eq '_workshop' -or $Id -match '^[a-z0-9]([a-z0-9_-]{0,18}[a-z0-9])?$'
}
function Get-RelativeFiles([string]$Root) {
    if (-not (Test-Path $Root -PathType Container)) { return @() }
    return @(Get-ChildItem $Root -Recurse -File | ForEach-Object {
        $_.FullName.Substring($Root.Length + 1).Replace('\', '/')
    } | Sort-Object)
}

$Project = [IO.Path]::GetFullPath($Project)
$sources = @($FromPmId | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique)
if ($sources.Count -lt 1) { throw 'At least one -FromPmId is required.' }
foreach ($id in @($sources) + @($ToPmId)) {
    if (-not (Test-PmId $id)) { throw "invalid pm_id '$id'" }
}

$sourceRoots = @{}
foreach ($id in $sources) {
    $root = Join-Path $Project "__garelier/$id/control"
    if (-not (Test-Path $root -PathType Container)) { throw "source control tree not found: $root" }
    $sourceRoots[$id] = $root
}

$destRoot = Join-Path $Project "__garelier/$ToPmId/control"
$destFiles = @(Get-RelativeFiles $destRoot)
$entries = @{}
foreach ($rel in $destFiles) {
    $entries[$rel] = @(@{ Owner = "destination:$ToPmId"; Path = (Join-Path $destRoot $rel) })
}
foreach ($id in $sources) {
    foreach ($rel in @(Get-RelativeFiles $sourceRoots[$id])) {
        if (-not $entries.ContainsKey($rel)) { $entries[$rel] = @() }
        $entries[$rel] += @{ Owner = "source:$id"; Path = (Join-Path $sourceRoots[$id] $rel) }
    }
}
$overlaps = @($entries.GetEnumerator() | Where-Object { $_.Value.Count -gt 1 } | Sort-Object Name)
$conflicts = @()
$identical = @()
foreach ($entry in $overlaps) {
    $hashes = @($entry.Value | ForEach-Object { (Get-FileHash -Algorithm SHA256 -LiteralPath $_.Path).Hash } | Select-Object -Unique)
    if ($hashes.Count -gt 1) { $conflicts += $entry } else { $identical += $entry }
}

Write-Host "Control consolidation plan: $($sources -join ', ') -> $ToPmId"
Write-Host "Destination exists: $(Test-Path $destRoot -PathType Container)"
Write-Host "Distinct paths: $($entries.Count); identical overlaps: $($identical.Count); conflicts requiring reconciliation: $($conflicts.Count)"
foreach ($c in $conflicts) { Write-Host "  CONFLICT $($c.Key): $(($c.Value | ForEach-Object Owner) -join ', ')" }
if (-not $Apply) {
    Write-Host 'Dry run only. Re-run with -Apply to create a gitignored staging batch; source controls remain unchanged.'
    exit 0
}

if (-not (Test-Path $destRoot -PathType Container)) {
    & (Join-Path $PSScriptRoot 'init_control.ps1') -Project $Project -PmId $ToPmId
}
$batchRoot = Join-Path $Project "__garelier/$ToPmId/runtime/import/consolidation/$BatchId"
if (Test-Path $batchRoot) { throw "batch already exists: $batchRoot" }
New-Item -ItemType Directory -Force "$batchRoot/sources", "$batchRoot/drafts", "$batchRoot/reports" | Out-Null
foreach ($id in $sources) {
    $out = Join-Path $batchRoot "sources/$id/control"
    New-Item -ItemType Directory -Force $out | Out-Null
    Copy-Item -Path (Join-Path $sourceRoots[$id] '*') -Destination $out -Recurse -Force
}

$report = @(
    '# Control Consolidation Staging Report'
    ''
    "- Destination: ``$ToPmId``"
    "- Sources: $($sources -join ', ')"
    "- Batch: ``$BatchId``"
    "- Distinct paths: $($entries.Count)"
    "- Identical overlaps ignored: $($identical.Count)"
    "- Conflicts requiring semantic reconciliation: $($conflicts.Count)"
    ''
    '## Conflicts'
    ''
)
if ($conflicts.Count -eq 0) { $report += '- None' }
foreach ($c in $conflicts) { $report += "- ``$($c.Key)``: $(($c.Value | ForEach-Object Owner) -join ', ')" }
$report += @(
    ''
    '## Rules'
    ''
    '- Source namespaces are snapshots only and remain unchanged.'
    '- Destination control is the base authority.'
    '- Normalize into drafts; do not overwrite destination files.'
    '- Resolve policy/decision conflicts with the owner.'
)
Set-Content -Path (Join-Path $batchRoot 'reports/plan.md') -Value $report -Encoding utf8
Write-Host "Staged consolidation batch: $batchRoot"
Write-Host 'Next: normalize into drafts, reconcile conflicts, validate, then promote reviewed control changes.'
