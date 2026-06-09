#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Project = (Get-Location).Path,
    [string]$FromPmId = '_workshop',
    [Parameter(Mandatory = $true)]
    [string]$ToPmId,
    [Parameter(Mandatory = $true)]
    [string[]]$SelectPath,
    [string]$BatchId = (Get-Date -Format 'yyyyMMdd-HHmmss'),
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'

function Test-PmId([string]$Id) {
    return $Id -eq '_workshop' -or $Id -match '^[a-z0-9]([a-z0-9_-]{0,18}[a-z0-9])?$'
}
function Test-ControlRelative([string]$Path) {
    return $Path -and -not [IO.Path]::IsPathRooted($Path) -and
        $Path -notmatch '(^|[\\/])\.\.([\\/]|$)'
}

$Project = [IO.Path]::GetFullPath($Project)
if (-not (Test-PmId $FromPmId)) { throw "invalid source pm_id '$FromPmId'" }
if (-not (Test-PmId $ToPmId)) { throw "invalid destination pm_id '$ToPmId'" }
if ($FromPmId -eq $ToPmId) { throw 'source and destination pm_id must differ' }
$sourceRoot = Join-Path $Project "__garelier/$FromPmId/control"
if (-not (Test-Path $sourceRoot -PathType Container)) { throw "source control tree not found: $sourceRoot" }

$selections = @($SelectPath | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim().Replace('\', '/') } | Where-Object { $_ } | Select-Object -Unique)
$files = @{}
foreach ($selection in $selections) {
    if (-not (Test-ControlRelative $selection)) { throw "selection must be control-relative and cannot contain '..': $selection" }
    $matches = @(Get-ChildItem -Path (Join-Path $sourceRoot $selection) -File -Recurse -ErrorAction SilentlyContinue)
    if ($matches.Count -eq 0) { throw "selection matched no files: $selection" }
    foreach ($f in $matches) {
        $rel = $f.FullName.Substring($sourceRoot.Length + 1).Replace('\', '/')
        $files[$rel] = $f.FullName
    }
}

Write-Host "Control split plan: $FromPmId -> $ToPmId"
Write-Host "Selected files: $($files.Count)"
foreach ($rel in @($files.Keys | Sort-Object)) { Write-Host "  $rel" }
Write-Host 'Source control will remain unchanged. Destination control will not be written directly.'
if (-not $Apply) {
    Write-Host 'Dry run only. Re-run with -Apply to create a gitignored staging batch.'
    exit 0
}

$destRoot = Join-Path $Project "__garelier/$ToPmId/control"
if (-not (Test-Path $destRoot -PathType Container)) {
    & (Join-Path $PSScriptRoot 'init_control.ps1') -Project $Project -PmId $ToPmId
}
$batchRoot = Join-Path $Project "__garelier/$ToPmId/runtime/import/split/$BatchId"
if (Test-Path $batchRoot) { throw "batch already exists: $batchRoot" }
New-Item -ItemType Directory -Force "$batchRoot/source/control", "$batchRoot/drafts", "$batchRoot/reports" | Out-Null
foreach ($rel in $files.Keys) {
    $target = Join-Path "$batchRoot/source/control" $rel
    New-Item -ItemType Directory -Force (Split-Path $target -Parent) | Out-Null
    Copy-Item -LiteralPath $files[$rel] -Destination $target
}

$report = @(
    '# Control Split Staging Report'
    ''
    "- Source: ``$FromPmId``"
    "- Destination: ``$ToPmId``"
    "- Batch: ``$BatchId``"
    "- Selected files: $($files.Count)"
    ''
    '## Selected'
    ''
)
foreach ($rel in @($files.Keys | Sort-Object)) { $report += "- ``$rel``" }
$report += @(
    ''
    '## Required review'
    ''
    '- Find references into and out of the selected set.'
    '- Rebuild destination dashboard summaries; do not copy source hot files wholesale.'
    '- Resolve decision IDs, ownership, policies, and quality gates.'
    '- Preserve source until destination validation and approved cutover.'
)
Set-Content -Path (Join-Path $batchRoot 'reports/plan.md') -Value $report -Encoding utf8
Write-Host "Staged split batch: $batchRoot"
Write-Host 'Next: analyze dependencies, normalize drafts, validate, and promote reviewed destination control changes.'
