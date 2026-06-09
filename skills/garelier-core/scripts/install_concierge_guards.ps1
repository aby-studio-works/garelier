#!/usr/bin/env pwsh
# Install the Garelier mechanical push guard (DEC-030) into a Concierge
# worktree — PowerShell parity with install_concierge_guards.sh. Scopes the
# pre-push hook to THIS worktree only (per-worktree config). Idempotent.
#
# Usage: install_concierge_guards.ps1 <concierge-checkout-dir>

param([Parameter(Mandatory = $true, Position = 0)][string]$Checkout)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$hooksDir = Join-Path $scriptDir 'hooks'

if (-not (Test-Path (Join-Path $Checkout '.git'))) {
    [Console]::Error.WriteLine("install_concierge_guards: not a git worktree: $Checkout")
    exit 1
}
if (-not (Test-Path (Join-Path $hooksDir 'pre-push'))) {
    [Console]::Error.WriteLine("install_concierge_guards: pre-push hook missing at $hooksDir")
    exit 1
}

# Per-worktree config so only the Concierge worktree gets this hooks path.
& git -C $Checkout config extensions.worktreeConfig true
& git -C $Checkout config --worktree core.hooksPath $hooksDir

Write-Host "  + Concierge push guard installed (DEC-030): $Checkout core.hooksPath -> $hooksDir"
