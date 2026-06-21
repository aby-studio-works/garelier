#!/usr/bin/env pwsh
# Windows twin of install_pm_commit_guard.sh. Installs the Garelier PM commit
# guard into a project's MAIN worktree hooks dir (the hook itself is POSIX sh —
# Git for Windows runs hooks via its bundled sh). A pre-existing non-Garelier
# pre-commit (e.g. check_assets) is preserved as pre-commit.local and chained.
# Per-clone, commits nothing, reversible (rm the hook). Idempotent.
#
# Usage: install_pm_commit_guard.ps1 [-Root <project-root>]   (default: git toplevel)
param([string]$Root)
$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = (git rev-parse --show-toplevel).Trim() }
$src = Join-Path $PSScriptRoot 'hooks/pre-commit'
if (-not (Test-Path -LiteralPath $src)) { Write-Error "install_pm_commit_guard: source hook missing at $src"; exit 1 }

$hp = (git -C $Root config --get core.hooksPath 2>$null)
if ($hp) {
    $hooks = if ([IO.Path]::IsPathRooted($hp)) { $hp } else { Join-Path $Root $hp }
    Write-Warning "core.hooksPath is set ($hp); installing the guard there."
} else {
    $common = (git -C $Root rev-parse --git-common-dir).Trim()
    if (-not [IO.Path]::IsPathRooted($common)) { $common = Join-Path $Root $common }
    $hooks = Join-Path $common 'hooks'
}
if (-not (Test-Path -LiteralPath $hooks)) { New-Item -ItemType Directory -Force -Path $hooks | Out-Null }
$dest = Join-Path $hooks 'pre-commit'
$mark = 'Garelier PM commit guard'

if ((Test-Path -LiteralPath $dest) -and -not (Select-String -LiteralPath $dest -Pattern $mark -Quiet)) {
    $localDest = Join-Path $hooks 'pre-commit.local'
    if (Test-Path -LiteralPath $localDest) {
        Write-Error "install_pm_commit_guard: $localDest already exists; refusing to clobber it. Resolve manually."
        exit 1
    }
    Move-Item -LiteralPath $dest -Destination $localDest -Force
    Write-Output '  + preserved the existing pre-commit hook as pre-commit.local (the guard chains it first)'
}

Copy-Item -LiteralPath $src -Destination $dest -Force
Write-Output "Installed Garelier PM commit guard -> $dest"
Write-Output '  per-clone, local only; blocks non-studio / mid-merge commits on the MAIN worktree.'
Write-Output "  override once: `$env:GARELIER_ALLOW_NONSTUDIO_COMMIT=1; git commit ...   disable: rm `"$dest`""
