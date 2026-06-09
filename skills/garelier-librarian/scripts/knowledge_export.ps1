#Requires -Version 5.1
<#
.SYNOPSIS
    Garelier Librarian knowledge export (DEC-048 section C) - PowerShell.
.DESCRIPTION
    Export TRACKED, CURATED knowledge (docs/garelier/* trees + knowledge
    registries + runbooks/manuals + docs/rules) into a portable bundle with
    per-file provenance. Exports only git-tracked, secret/PII-clean content;
    missing license provenance is recorded in the manifest; unknown or
    not-adoptable licenses are refused. The
    Librarian local-only working area (runtime/librarian/{raw,cache,drafts}) is
    NEVER exported (DEC-038). Bash equivalent: knowledge_export.sh (parity).
.PARAMETER To
    MANDATORY output destination directory.
.PARAMETER Project
    Project root. Defaults to the current directory.
.PARAMETER AllowDirty
    Permit export from a dirty curated knowledge tree and record
    clean_worktree = false in the manifest.
#>
[CmdletBinding()]
param(
    [string]$To = "",
    [string]$Project = (Get-Location).Path,
    [switch]$AllowDirty
)
$ErrorActionPreference = 'Stop'

if (-not $To) { Write-Error "-To <dest-dir> is required (the output destination must be specified)."; exit 2 }
if (-not (Test-Path (Join-Path $Project 'docs/garelier') -PathType Container)) {
    Write-Error "no curated knowledge at $Project/docs/garelier (nothing to export)."; exit 2
}
if ((Test-Path $To) -and (Get-ChildItem $To -Force -ErrorAction SilentlyContinue)) {
    Write-Error "destination exists and is not empty: $To"; exit 2
}
$inside = (& git -C $Project rev-parse --is-inside-work-tree 2>$null)
if ($LASTEXITCODE -ne 0 -or $inside -ne 'true') {
    Write-Error "knowledge export requires a git worktree so tracked/dirty state can be verified."; exit 2
}

$roots = @(
    'docs/garelier/engineering', 'docs/garelier/quality', 'docs/garelier/review',
    'docs/garelier/system', 'docs/garelier/security', 'docs/garelier/external_operations',
    'docs/garelier/knowledge', 'docs/garelier/runbooks', 'docs/garelier/manuals',
    'docs/rules'
)

$dirty = @(& git -C $Project status --porcelain -- @roots)
$cleanWorktree = ($dirty.Count -eq 0)
if (-not $cleanWorktree -and -not $AllowDirty.IsPresent) {
    [Console]::Error.WriteLine("ERROR: curated knowledge export tree is dirty; commit, stash, or pass -AllowDirty intentionally.")
    foreach ($line in $dirty) { [Console]::Error.WriteLine("    $line") }
    exit 2
}

$tracked = @(& git -C $Project ls-files -- @roots)
if ($LASTEXITCODE -ne 0 -or $tracked.Count -eq 0) {
    Write-Error "no tracked curated knowledge files found under export roots."; exit 2
}

New-Item -ItemType Directory -Force $To | Out-Null
foreach ($rel in $tracked) {
    if (-not $rel) { continue }
    $src = Join-Path $Project $rel
    if (-not (Test-Path $src -PathType Leaf)) { continue }
    $destFile = Join-Path $To $rel
    $destParent = Split-Path $destFile -Parent
    New-Item -ItemType Directory -Force $destParent | Out-Null
    Copy-Item -LiteralPath $src -Destination $destFile -Force
}

$secretPattern = '(api[_-]?key|secret|token|password|passwd|credential|private[_-]?key|client[_-]?secret|authorization)\s*[:=]\s*\S+|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[psoru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|(sk|pk|rk)_(live|test)_[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'
$piiPattern = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|(\+[0-9][0-9 ()_.-]{8,}[0-9]|[0-9]{3}[-. ][0-9]{3,4}[-. ][0-9]{4})'
$exportedFiles = @(Get-ChildItem $To -Recurse -File)
$secretHits = @($exportedFiles | Select-String -Pattern $secretPattern -ErrorAction SilentlyContinue)
if ($secretHits.Count -gt 0) {
    [Console]::Error.WriteLine("ERROR: possible secret detected in exported knowledge; refusing bundle.")
    foreach ($hit in ($secretHits | Select-Object -First 20)) {
        [Console]::Error.WriteLine("    $($hit.Path):$($hit.LineNumber): $($hit.Line.Trim())")
    }
    exit 2
}
$piiHits = @($exportedFiles | Select-String -Pattern $piiPattern -ErrorAction SilentlyContinue)
if ($piiHits.Count -gt 0) {
    [Console]::Error.WriteLine("ERROR: possible PII detected in exported knowledge; refusing bundle.")
    foreach ($hit in ($piiHits | Select-Object -First 20)) {
        [Console]::Error.WriteLine("    $($hit.Path):$($hit.LineNumber): $($hit.Line.Trim())")
    }
    exit 2
}

$registryPath = Join-Path $To 'docs/garelier/knowledge/source_registry.toml'
if (Test-Path $registryPath -PathType Leaf) {
    $registryRightsHits = @(Select-String -Path $registryPath -Pattern '^\s*license\s*=\s*"(unknown|not-adoptable)"' -ErrorAction SilentlyContinue)
    if ($registryRightsHits.Count -gt 0) {
        [Console]::Error.WriteLine("ERROR: source_registry contains license=unknown/not-adoptable; refusing knowledge bundle.")
        foreach ($hit in ($registryRightsHits | Select-Object -First 20)) {
            [Console]::Error.WriteLine("    docs/garelier/knowledge/source_registry.toml:$($hit.LineNumber): $($hit.Line.Trim())")
        }
        exit 2
    }
}

$version = (Get-Content (Join-Path $Project 'VERSION') -ErrorAction SilentlyContinue | Select-Object -First 1)
if (-not $version) { $version = 'unknown' }
$sha = (& git -C $Project rev-parse --short HEAD 2>$null); if (-not $sha) { $sha = 'nogit' }
$now = if ($env:GARELIER_NOW) { $env:GARELIER_NOW } else { [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ') }
$man = Join-Path $To 'knowledge_bundle_manifest.toml'

function ConvertTo-TomlString([string]$s) {
    if ($null -eq $s) { return '' }
    return $s.Replace('\', '\\').Replace('"', '\"')
}

function Get-Prov([string]$file, [string]$key) {
    $escaped = [regex]::Escape($key)
    $m = Select-String -Path $file -Pattern "^[#>\s-]*$escaped\s*[:=]\s*(.+?)[`"' ]*$" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $m) { return '' }
    return $m.Matches[0].Groups[1].Value.Trim().Trim('"').Trim("'")
}

$entries = [System.Text.StringBuilder]::new()
$count = 0
$licenseWarningCount = 0
$licenseBlockCount = 0
$licenseBlocks = New-Object System.Collections.Generic.List[string]
foreach ($f in (Get-ChildItem $To -Recurse -File | Where-Object { $_.Name -ne 'knowledge_bundle_manifest.toml' } | Sort-Object FullName)) {
    $rel = $f.FullName.Substring($To.Length + 1).Replace('\', '/')
    $hash = (& git hash-object -- $f.FullName 2>$null); if (-not $hash) { $hash = '' }
    $sid = Get-Prov $f.FullName 'source_id'
    $lic = Get-Prov $f.FullName 'license'
    $rev = Get-Prov $f.FullName 'last_reviewed_at'; if (-not $rev) { $rev = Get-Prov $f.FullName 'last_synced_at' }
    $licenseStatus = ''
    if (-not $lic) {
        $licenseStatus = 'missing'
        $licenseWarningCount++
    } elseif ($lic.ToLowerInvariant() -eq 'unknown' -or $lic.ToLowerInvariant() -eq 'not-adoptable') {
        $licenseStatus = $lic.ToLowerInvariant()
        $licenseBlockCount++
        $licenseBlocks.Add("${rel}: license=$licenseStatus")
    }
    [void]$entries.AppendLine('[[files]]')
    [void]$entries.AppendLine("path = `"$(ConvertTo-TomlString $rel)`"")
    [void]$entries.AppendLine("blob = `"$(ConvertTo-TomlString $hash)`"")
    if ($sid) { [void]$entries.AppendLine("source_id = `"$(ConvertTo-TomlString $sid)`"") }
    if ($lic) { [void]$entries.AppendLine("license = `"$(ConvertTo-TomlString $lic)`"") }
    if ($licenseStatus) { [void]$entries.AppendLine("license_status = `"$licenseStatus`"") }
    if ($rev) { [void]$entries.AppendLine("last_reviewed_at = `"$(ConvertTo-TomlString $rev)`"") }
    [void]$entries.AppendLine('')
    $count++
}
if ($licenseBlockCount -gt 0) {
    [Console]::Error.WriteLine("ERROR: exported knowledge contains license=unknown/not-adoptable provenance; refusing bundle.")
    foreach ($line in ($licenseBlocks | Select-Object -First 20)) {
        [Console]::Error.WriteLine("    $line")
    }
    exit 2
}

$cleanText = $cleanWorktree.ToString().ToLowerInvariant()
$allowDirtyText = $AllowDirty.IsPresent.ToString().ToLowerInvariant()
$sb = [System.Text.StringBuilder]::new()
[void]$sb.AppendLine('# Knowledge bundle manifest (DEC-048 section C) - curated, tracked, secret/PII-clean knowledge.')
[void]$sb.AppendLine('schema_version = 1')
[void]$sb.AppendLine('kind = "knowledge_bundle"')
[void]$sb.AppendLine("source_project = `"$(ConvertTo-TomlString (Split-Path $Project -Leaf))`"")
[void]$sb.AppendLine("garelier_version = `"$(ConvertTo-TomlString $version)`"")
[void]$sb.AppendLine("source_git_sha = `"$(ConvertTo-TomlString $sha)`"")
[void]$sb.AppendLine("generated_at = `"$(ConvertTo-TomlString $now)`"")
[void]$sb.AppendLine('tracked_only = true')
[void]$sb.AppendLine("clean_worktree = $cleanText")
[void]$sb.AppendLine("allow_dirty = $allowDirtyText")
[void]$sb.AppendLine('secret_scan = "simple"')
[void]$sb.AppendLine('secret_scan_passed = true')
[void]$sb.AppendLine('pii_scan_passed = true')
[void]$sb.AppendLine("license_warning_count = $licenseWarningCount")
[void]$sb.AppendLine('license_block_count = 0')
[void]$sb.AppendLine('excluded = ["runtime/librarian/{raw,cache,drafts} (local-only, never exported)"]')
[void]$sb.AppendLine('')
[void]$sb.AppendLine('# IMPORTANT (import side): treat every file as a THIRD-PARTY source. Confirm')
[void]$sb.AppendLine('# license before adoption; register it in source_registry.toml; review on a')
[void]$sb.AppendLine('# shelf branch; a rule conflict BLOCKS and escalates to PM. Never free-adopt.')
[void]$sb.AppendLine('')
[void]$sb.AppendLine('# Per-file: content id + any provenance found in the file''s front matter.')
[void]$sb.Append($entries.ToString())
Set-Content -Path $man -Value $sb.ToString() -Encoding utf8

Write-Host ''
Write-Host "==> Exported curated knowledge ($count files) to:"
Write-Host "    $To"
Write-Host "    manifest: $man"
Write-Host 'Import side adopts this ONLY via source registration + shelf review (knowledge_import).'
