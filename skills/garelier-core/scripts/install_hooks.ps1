#Requires -Version 5.1
<#
.SYNOPSIS
  OPT-IN local git hooks for Garelier (DEC-051 commit-message lint).
.DESCRIPTION
  Installs a commit-msg hook into THIS clone's .git/hooks only. It does NOT set
  core.hooksPath and commits nothing, so it never affects other contributors,
  non-Garelier users, or other-skill users. Per-developer and reversible
  (Remove-Item .git/hooks/commit-msg). The hook self-disables when bun is
  unavailable, so it can never block a plain `git commit` in a non-Garelier env.
#>
[CmdletBinding()]
param([string]$Root = (& git rev-parse --show-toplevel))

$ErrorActionPreference = 'Stop'
$hooks = Join-Path $Root '.git/hooks'
$skill = if ($env:GARELIER_CORE_DIR) { $env:GARELIER_CORE_DIR } else { Join-Path $env:USERPROFILE '.claude/skills/garelier-core' }
New-Item -ItemType Directory -Path $hooks -Force | Out-Null
$hook = Join-Path $hooks 'commit-msg'

if ((Test-Path $hook) -and -not (Select-String -Path $hook -Pattern 'Garelier commit-msg lint' -Quiet)) {
  Write-Error "Refusing to overwrite an existing non-Garelier commit-msg hook at $hook."
  exit 1
}

# Git on Windows runs hooks via its bundled bash, so a shell hook is correct here too.
@"
#!/usr/bin/env bash
# Garelier commit-msg lint (opt-in, DEC-051). Remove this file to disable.
command -v bun >/dev/null 2>&1 || exit 0
exec bun "$skill/scripts/lint_commits.ts" "`$1"
"@ | Set-Content -Path $hook -Encoding utf8 -NoNewline:$false

Write-Host "Installed opt-in commit-msg hook -> $hook"
Write-Host "  (per-developer, local only; remove the file to disable; never affects others)"
