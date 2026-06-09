#Requires -Version 5.1
<#
.SYNOPSIS
    Garelier PM control import (DEC-048 section B) — PowerShell.
.DESCRIPTION
    Import a control bundle (produced by control_export) INTO a PM's control/
    tree — for restoring a backup or seeding a new PM from a template project.

    Safety: NO-OVERWRITE. Existing files are never clobbered; every collision is
    reported for the PM to reconcile by hand. Importing from ANOTHER PM across
    machines is request_intake/'s job (DEC-006), not this script.

    Without -Apply this is a DRY RUN (reports new files / collisions, writes
    nothing). Bash equivalent: control_import.sh (feature parity).
.PARAMETER From
    MANDATORY input source: the control bundle directory.
.PARAMETER PmId
    PM to import into. Auto-detected when exactly one PM exists.
.PARAMETER Project
    Project root. Defaults to the current directory.
.PARAMETER Apply
    Actually write the new files (default is a dry run).
#>
[CmdletBinding()]
param(
    [string]$From = "",
    [string]$PmId = "",
    [string]$Project = (Get-Location).Path,
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'

if (-not $From) { Write-Error "-From <bundle-dir> is required (the input source must be specified)."; exit 2 }
if (-not (Test-Path (Join-Path $From 'control') -PathType Container)) { Write-Error "not a control bundle (no control/ under $From)."; exit 2 }
$manPath = Join-Path $From 'control_bundle_manifest.toml'
if (-not (Test-Path $manPath -PathType Leaf)) { Write-Error "missing control_bundle_manifest.toml in $From."; exit 2 }

$kindLine = (Select-String -Path $manPath -Pattern '^kind\s*=\s*"(.*)"' | Select-Object -First 1)
$kind = if ($kindLine) { $kindLine.Matches[0].Groups[1].Value } else { '' }
if ($kind -ne 'control_bundle') { Write-Error "manifest kind is '$kind', expected 'control_bundle'."; exit 2 }

$garelier = Join-Path $Project '__garelier'
if (-not (Test-Path $garelier -PathType Container)) {
    if ($PmId) { New-Item -ItemType Directory -Force $garelier | Out-Null }
    else { Write-Error "not a Garelier project (no __garelier/): $Project; pass -PmId to create a control namespace."; exit 2 }
}

if (-not $PmId) {
    $cands = @()
    foreach ($d in Get-ChildItem $garelier -Directory -ErrorAction SilentlyContinue) {
        if ((Test-Path (Join-Path $d.FullName '_pm/setup_config.toml')) -or
            (Test-Path (Join-Path $d.FullName 'control/control.toml'))) { $cands += $d.Name }
    }
    if ($cands.Count -eq 1) { $PmId = $cands[0]; Write-Host "  auto-detected pm-id: $PmId" }
    elseif ($cands.Count -eq 0) { Write-Error "no control namespace under $garelier; pass -PmId."; exit 2 }
    else { Write-Error "multiple PMs under $garelier; pass -PmId <id>."; exit 2 }
}
if ($PmId -ne '_workshop' -and $PmId -notmatch '^[a-z0-9]([a-z0-9_-]{0,18}[a-z0-9])?$') { Write-Error "invalid pm_id '$PmId'."; exit 2 }

$dest = Join-Path $garelier "$PmId/control"
New-Item -ItemType Directory -Force $dest | Out-Null
$srcControl = Join-Path $From 'control'

$newFiles = @(); $collisions = @()
foreach ($f in (Get-ChildItem $srcControl -Recurse -File | Sort-Object FullName)) {
    $rel = $f.FullName.Substring($srcControl.Length + 1)
    if ($rel -eq 'control.toml') { continue }
    $target = Join-Path $dest $rel
    if (Test-Path $target) { $collisions += $rel } else { $newFiles += $rel }
}

$mode = if ($Apply) { 'APPLY' } else { 'DRY-RUN' }
Write-Host ''
Write-Host "==> Control import into PM '$PmId'  (mode: $mode)"
Write-Host "    new files: $($newFiles.Count)   collisions (NOT overwritten): $($collisions.Count)"
if ($collisions.Count -gt 0) {
    Write-Host '  -- collisions (kept existing; reconcile by hand):'
    foreach ($c in $collisions) { Write-Host "       $($c.Replace('\','/'))" }
}

if (-not $Apply) {
    Write-Host ''
    Write-Host "Dry run only — nothing written. Re-run with -Apply to write the $($newFiles.Count) new file(s)."
    Write-Host 'Collisions are never auto-overwritten; resolve them manually first.'
    exit 0
}

foreach ($rel in $newFiles) {
    $target = Join-Path $dest $rel
    New-Item -ItemType Directory -Force (Split-Path $target -Parent) | Out-Null
    Copy-Item -Path (Join-Path $srcControl $rel) -Destination $target -Force
}
$marker = Join-Path $dest 'control.toml'
if (-not (Test-Path $marker)) {
    @(
        'schema_version = 1'
        'kind = "garelier_control"'
        "pm_id = `"$PmId`""
        'mode = "control_only"'
        ''
    ) | Set-Content -Path $marker -Encoding utf8
}

Write-Host ''
Write-Host "==> Wrote $($newFiles.Count) new file(s) into $dest"
if ($collisions.Count -gt 0) { Write-Host "    $($collisions.Count) collision(s) left untouched — reconcile and re-run if needed." }
Write-Host 'Review, then commit the control/ changes (run commit-hygiene first).'
