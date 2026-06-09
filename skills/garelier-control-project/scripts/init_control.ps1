#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Project = (Get-Location).Path,
    [string]$PmId = '_workshop'
)
$ErrorActionPreference = 'Stop'

if ($PmId -eq '_workspace') { throw "'_workspace' is forbidden; use single-user default '_workshop'." }
if ($PmId -ne '_workshop' -and $PmId -notmatch '^[a-z0-9]([a-z0-9_-]{0,18}[a-z0-9])?$') {
    throw "invalid pm_id '$PmId'"
}

$Project = [IO.Path]::GetFullPath($Project)
$localTemplates = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../garelier-core/templates/control_scaffold'))
$installedTemplates = Join-Path $env:USERPROFILE '.claude\skills\garelier-core\templates\control_scaffold'
$templates = if ($env:GARELIER_CORE_TEMPLATES_DIR) {
    Join-Path $env:GARELIER_CORE_TEMPLATES_DIR 'control_scaffold'
} elseif (Test-Path $localTemplates -PathType Container) {
    $localTemplates
} else {
    $installedTemplates
}
if (-not (Test-Path $templates -PathType Container)) { throw "canonical control scaffold not found: $templates" }

$pmRoot = Join-Path $Project "__garelier/$PmId"
$control = Join-Path $pmRoot 'control'
$runtimeImport = Join-Path $pmRoot 'runtime/import'
New-Item -ItemType Directory -Force $control, "$runtimeImport/raw", "$runtimeImport/drafts", "$runtimeImport/reports" | Out-Null
$controlDirs = @(
    'blueprints/archive', 'decisions', 'inspections/tech', 'inspections/market',
    'inspections/status', 'observations', 'reports/promote', 'reports/benchmark',
    'reports/data_audit', 'reports/requests', 'reports/delegated_requests',
    'reports/notifications', 'reports/scheduled_jobs', 'reports/handoffs',
    'reports/diagnostics', 'delegation',
    'request_intake/templates', 'scheduled_jobs/templates', 'scheduled_jobs/examples'
)
foreach ($rel in $controlDirs) {
    $dir = Join-Path $control $rel
    New-Item -ItemType Directory -Force $dir | Out-Null
    $keep = Join-Path $dir '.gitkeep'
    if (-not (Test-Path $keep)) { New-Item -ItemType File $keep | Out-Null }
}

foreach ($f in Get-ChildItem $templates -Recurse -File) {
    $rel = $f.FullName.Substring($templates.Length + 1)
    $dest = Join-Path $control $rel
    if (-not (Test-Path $dest)) {
        New-Item -ItemType Directory -Force (Split-Path $dest -Parent) | Out-Null
        Copy-Item -LiteralPath $f.FullName -Destination $dest
    }
}

$marker = Join-Path $control 'control.toml'
if (-not (Test-Path $marker)) {
    @(
        'schema_version = 1'
        'kind = "garelier_control"'
        "pm_id = `"$PmId`""
        'mode = "control_only"'
        ''
    ) | Set-Content -Path $marker -Encoding utf8
}

# DEC-051: ignore rules live in a nested __garelier/.gitignore (git honors nested
# ignore files), so the project's ROOT .gitignore is never touched. Control-only
# namespaces just need runtime/ ignored; a later full-PM upgrade overwrites this
# with the complete worktree set. Never clobber an existing (possibly fuller) one.
$nestedGitignore = Join-Path $Project '__garelier/.gitignore'
if (-not (Test-Path -LiteralPath $nestedGitignore -PathType Leaf)) {
    $coreTmplDir = if ($env:GARELIER_CORE_TEMPLATES_DIR) {
        $env:GARELIER_CORE_TEMPLATES_DIR
    } elseif (Test-Path ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../garelier-core/templates'))) -PathType Container) {
        [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../garelier-core/templates'))
    } else {
        Join-Path $env:USERPROFILE '.claude\skills\garelier-core\templates'
    }
    $rtTmpl = Join-Path $coreTmplDir 'runtime_gitignore'
    if (Test-Path -LiteralPath $rtTmpl -PathType Leaf) {
        Copy-Item -LiteralPath $rtTmpl -Destination $nestedGitignore -Force
    } else {
        "# Garelier nested .gitignore (control-only)`n*/runtime/`n" |
            Set-Content -LiteralPath $nestedGitignore -Encoding utf8 -NoNewline
    }
}
# Best-effort: migrate away the legacy 2-line block a pre-DEC-051 init left in root.
$legacyGitignore = Join-Path $Project '.gitignore'
if (Test-Path -LiteralPath $legacyGitignore -PathType Leaf) {
    $giLines = @(Get-Content -LiteralPath $legacyGitignore)
    if ($giLines | Where-Object { $_ -match 'Garelier transient state' }) {
        $kept = @($giLines | Where-Object {
            $_ -notmatch '^# Garelier transient state$' -and $_ -notmatch '^__garelier/\*/runtime/\s*$'
        })
        if (($kept -join '') -match '\S') {
            $u8 = New-Object System.Text.UTF8Encoding($false)
            [System.IO.File]::WriteAllText($legacyGitignore, (($kept -join "`n") + "`n"), $u8)
        } else {
            Remove-Item -LiteralPath $legacyGitignore -Force
        }
    }
}

Write-Host "Initialized control namespace '$PmId' at $control"
Write-Host 'Existing files were preserved; runtime/import is gitignored staging.'
