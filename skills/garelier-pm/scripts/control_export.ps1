#Requires -Version 5.1
<#
.SYNOPSIS
    Garelier PM control export (DEC-048 section B) — PowerShell.
.DESCRIPTION
    Snapshot a PM's TRACKED control/ authority tree into a portable,
    self-describing bundle (backup / new-PM template / planning hand-off).

    This is the LOCAL bundle primitive. It does NOT leave the sandbox by itself:
      - publishing/pushing the bundle outside the sandbox -> Concierge + Guardian
      - handing it to ANOTHER PM                           -> request_intake/ (DEC-006)
    Run commit-hygiene before sharing: control/ can hold planning notes / names.

    Bash equivalent: control_export.sh (feature parity).
.PARAMETER To
    MANDATORY output destination directory. Must be specified explicitly.
.PARAMETER PmId
    PM to export. Auto-detected when exactly one PM exists.
.PARAMETER Project
    Project root. Defaults to the current directory.
#>
[CmdletBinding()]
param(
    [string]$To = "",
    [string]$PmId = "",
    [string]$Project = (Get-Location).Path
)
$ErrorActionPreference = 'Stop'

if (-not $To) { Write-Error "-To <dest-dir> is required (the output destination must be specified)."; exit 2 }

$garelier = Join-Path $Project '__garelier'
if (-not (Test-Path $garelier -PathType Container)) { Write-Error "not a Garelier project (no __garelier/): $Project"; exit 2 }

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

$control = Join-Path $garelier "$PmId/control"
if (-not (Test-Path $control -PathType Container)) { Write-Error "no control/ tree at $control"; exit 2 }

if ((Test-Path $To) -and (Get-ChildItem $To -Force -ErrorAction SilentlyContinue)) {
    Write-Error "destination exists and is not empty: $To"; exit 2
}

$controlOut = Join-Path $To 'control'
New-Item -ItemType Directory -Force $controlOut | Out-Null
# control/ is the tracked authority. runtime/ is a SIBLING (gitignored,
# machine-local) and is excluded by construction — only control/ is copied.
Copy-Item -Path (Join-Path $control '*') -Destination $controlOut -Recurse -Force

$version = (Get-Content (Join-Path $Project 'VERSION') -ErrorAction SilentlyContinue | Select-Object -First 1)
if (-not $version) { $version = 'unknown' }
$sha = (& git -C $Project rev-parse --short HEAD 2>$null); if (-not $sha) { $sha = 'nogit' }
$now = if ($env:GARELIER_NOW) { $env:GARELIER_NOW } else { [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ') }
$srcName = Split-Path $Project -Leaf
$man = Join-Path $To 'control_bundle_manifest.toml'

$sb = [System.Text.StringBuilder]::new()
[void]$sb.AppendLine('# Control bundle manifest (DEC-048 section B) — a snapshot of a PM''s tracked control/ authority.')
[void]$sb.AppendLine('schema_version = 1')
[void]$sb.AppendLine('kind = "control_bundle"')
[void]$sb.AppendLine("pm_id = `"$PmId`"")
[void]$sb.AppendLine("source_project = `"$srcName`"")
[void]$sb.AppendLine("garelier_version = `"$version`"")
[void]$sb.AppendLine("source_git_sha = `"$sha`"")
[void]$sb.AppendLine("generated_at = `"$now`"")
[void]$sb.AppendLine('excluded = ["runtime/ (gitignored, machine-local)"]')
[void]$sb.AppendLine('')
[void]$sb.AppendLine('# Per-file content ids (git blob sha; verify on import). Paths are bundle-relative.')

$count = 0
foreach ($f in (Get-ChildItem $controlOut -Recurse -File | Sort-Object FullName)) {
    $rel = 'control/' + $f.FullName.Substring($controlOut.Length + 1).Replace('\', '/')
    $hash = (& git hash-object $f.FullName 2>$null); if (-not $hash) { $hash = '' }
    [void]$sb.AppendLine('[[files]]')
    [void]$sb.AppendLine("path = `"$rel`"")
    [void]$sb.AppendLine("blob = `"$hash`"")
    [void]$sb.AppendLine('')
    $count++
}
Set-Content -Path $man -Value $sb.ToString() -Encoding utf8

Write-Host ''
Write-Host "==> Exported PM '$PmId' control/ ($count files) to:"
Write-Host "    $To"
Write-Host "    manifest: $man"
Write-Host 'Next: review it. To publish outside the sandbox use Concierge (Guardian-gated);'
Write-Host 'to hand it to another PM use the request_intake/ mechanism (DEC-006).'
