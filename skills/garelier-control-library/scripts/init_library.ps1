#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Project = (Get-Location).Path,
    [string]$PmId = '_workshop'
)
$ErrorActionPreference = 'Stop'
if ($PmId -eq '_workspace') { throw "'_workspace' is forbidden; use '_workshop'." }
if ($PmId -ne '_workshop' -and $PmId -notmatch '^[a-z0-9]([a-z0-9_-]{0,18}[a-z0-9])?$') { throw "invalid pm_id '$PmId'" }

$Project = [IO.Path]::GetFullPath($Project)
$local = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../garelier-librarian/templates'))
$installed = Join-Path $env:USERPROFILE '.claude\skills\garelier-librarian\templates'
$templates = if ($env:GARELIER_LIBRARIAN_TEMPLATES_DIR) { $env:GARELIER_LIBRARIAN_TEMPLATES_DIR } elseif (Test-Path $local) { $local } else { $installed }
if (-not (Test-Path $templates -PathType Container)) { throw "Librarian templates not found: $templates" }
$starterTemplates = Join-Path $PSScriptRoot '../templates'

$knowledge = Join-Path $Project 'docs/garelier/knowledge'
$projectCategory = Join-Path $Project 'docs/garelier/project'
$runtime = Join-Path $Project "__garelier/$PmId/runtime/librarian"
New-Item -ItemType Directory -Force $knowledge, $projectCategory, "$runtime/raw", "$runtime/cache", "$runtime/drafts", "$runtime/reports" | Out-Null

foreach ($name in @('knowledge.toml', 'role_index.toml', 'source_registry.toml', 'routine_registry.toml')) {
    $dest = Join-Path $knowledge $name
    $src = if ($name -eq 'knowledge.toml') { Join-Path $templates $name } else { Join-Path $starterTemplates $name }
    if (-not (Test-Path $dest)) { Copy-Item -LiteralPath $src -Destination $dest }
}
$idx = Join-Path $projectCategory 'index.md'
if (-not (Test-Path $idx)) {
    (Get-Content -Raw (Join-Path $templates 'knowledge_index.md')).Replace('{{Category}}', 'Project').Replace('{{category}}', 'project').Replace('{{knowledge/policy owner}}', 'user / project owner').Replace('{{condition}}', 'project-specific knowledge is needed').Replace('{{on change / scheduled review}}', 'on change') | Set-Content $idx -Encoding utf8
}
# DEC-051: ignore rules live in a nested __garelier/.gitignore (git honors nested
# ignore files), so the project's ROOT .gitignore is never touched. Never clobber
# an existing (possibly fuller, full-PM) nested file.
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
Write-Host "Initialized Garelier library at $Project/docs/garelier"
Write-Host "Local staging: $runtime"
