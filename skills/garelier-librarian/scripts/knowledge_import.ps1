#Requires -Version 5.1
<#
.SYNOPSIS
    Garelier Librarian knowledge import (DEC-048 section C) — PowerShell.
.DESCRIPTION
    Import another project's knowledge bundle — NOT as a free adoption. The
    bundle is STAGED into the Librarian local-only working area
    (__garelier/<pm_id>/runtime/librarian/raw/, gitignored) and a
    source_registry stub is emitted. The Librarian then reviews it on a shelf
    branch, CONFIRMS the license, resolves any rule conflict (BLOCK -> escalate
    to PM), and promotes only license-clean content into docs/garelier/*.

    This script never writes the tracked trees directly. Bash equivalent:
    knowledge_import.sh (feature parity).
.PARAMETER From
    MANDATORY input source: the knowledge bundle directory.
.PARAMETER PmId
    PM to stage into. Auto-detected when exactly one PM exists.
.PARAMETER Project
    Project root. Defaults to the current directory.
#>
[CmdletBinding()]
param(
    [string]$From = "",
    [string]$PmId = "",
    [string]$Project = (Get-Location).Path
)
$ErrorActionPreference = 'Stop'

if (-not $From) { Write-Error "-From <bundle-dir> is required (the input source must be specified)."; exit 2 }
$manPath = Join-Path $From 'knowledge_bundle_manifest.toml'
if (-not (Test-Path $manPath -PathType Leaf)) { Write-Error "not a knowledge bundle (no knowledge_bundle_manifest.toml in $From)."; exit 2 }
$kindLine = (Select-String -Path $manPath -Pattern '^kind\s*=\s*"(.*)"' | Select-Object -First 1)
$kind = if ($kindLine) { $kindLine.Matches[0].Groups[1].Value } else { '' }
if ($kind -ne 'knowledge_bundle') { Write-Error "manifest kind is '$kind', expected 'knowledge_bundle'."; exit 2 }

$garelier = Join-Path $Project '__garelier'
if (-not (Test-Path $garelier -PathType Container)) {
    if ($PmId) { New-Item -ItemType Directory -Force $garelier | Out-Null }
    else { Write-Error "no __garelier/ staging namespace; pass -PmId (usually _workshop)."; exit 2 }
}
if (-not $PmId) {
    $cands = @()
    foreach ($d in Get-ChildItem $garelier -Directory -ErrorAction SilentlyContinue) {
        if ((Test-Path (Join-Path $d.FullName '_pm/setup_config.toml')) -or
            (Test-Path (Join-Path $d.FullName 'control/control.toml')) -or
            (Test-Path (Join-Path $d.FullName 'runtime/librarian'))) { $cands += $d.Name }
    }
    if ($cands.Count -eq 1) { $PmId = $cands[0]; Write-Host "  auto-detected pm-id: $PmId" }
    elseif ($cands.Count -eq 0) { Write-Error "no knowledge staging namespace under $garelier; pass -PmId."; exit 2 }
    else { Write-Error "multiple PMs under $garelier; pass -PmId <id>."; exit 2 }
}
if ($PmId -ne '_workshop' -and $PmId -notmatch '^[a-z0-9]([a-z0-9_-]{0,18}[a-z0-9])?$') { Write-Error "invalid pm_id '$PmId'."; exit 2 }

$name = (Split-Path $From -Leaf) -replace '[^A-Za-z0-9._-]', '-'
$srcProjLine = (Select-String -Path $manPath -Pattern '^source_project\s*=\s*"(.*)"' | Select-Object -First 1)
$srcProj = if ($srcProjLine) { $srcProjLine.Matches[0].Groups[1].Value } else { 'unknown' }
$stage = Join-Path $garelier "$PmId/runtime/librarian/raw/imported-$name"
if (Test-Path $stage) { Write-Error "already staged at $stage (remove it first)."; exit 2 }
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item -Path (Join-Path $From '*') -Destination $stage -Recurse -Force

$stub = Join-Path $stage '_source_registry.stub.toml'
$s = [System.Text.StringBuilder]::new()
[void]$s.AppendLine('# source_registry STUB for an imported knowledge bundle (DEC-048 section C).')
[void]$s.AppendLine('# Confirm license + authority, then add to docs/garelier/knowledge/source_registry.toml')
[void]$s.AppendLine('# on a shelf branch. Defaults are deliberately conservative.')
[void]$s.AppendLine('[[sources]]')
[void]$s.AppendLine("id = `"imported-$name`"")
[void]$s.AppendLine("title = `"Imported knowledge bundle from $srcProj`"")
[void]$s.AppendLine('kind = "imported_knowledge_bundle"')
[void]$s.AppendLine('source_type = "local_file"')
[void]$s.AppendLine("path = `"runtime/librarian/raw/imported-$name`"")
[void]$s.AppendLine('owner = "pm"')
[void]$s.AppendLine('update_mode = "manual"')
[void]$s.AppendLine('authority = "third-party"      # confirm: official | recognized | internal | third-party')
[void]$s.AppendLine('license = "unknown"            # MUST confirm before adoption: confirmed | unknown | not-adoptable')
[void]$s.AppendLine('use = "inspiration-only"       # inspiration-only | allowed-summary | internal-policy-source')
[void]$s.AppendLine('trust = "unreviewed"')
Set-Content -Path $stub -Value $s.ToString() -Encoding utf8

Write-Host ''
Write-Host '==> Staged knowledge bundle into the Librarian local-only working area:'
Write-Host "    $stage"
Write-Host "    source_registry stub: $stub"
Write-Host ''
Write-Host 'Next (Librarian, on a shelf branch — never a free adoption):'
Write-Host '  1. CONFIRM the license of each file (manifest license fields are hints only).'
Write-Host '  2. Add the (license-confirmed) source to docs/garelier/knowledge/source_registry.toml.'
Write-Host '  3. Generalize into ORIGINAL project wording with provenance; do NOT copy verbatim.'
Write-Host '  4. A rule CONFLICT with existing knowledge -> BLOCK + escalate to PM (never silently override).'
Write-Host '  5. Promote only license-clean, reviewed content into docs/garelier/* via Dock shelf review.'
Write-Host 'Raw staged content is gitignored (runtime/) and must never be committed as-is.'
