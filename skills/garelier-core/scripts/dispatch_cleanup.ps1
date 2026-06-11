# dispatch_cleanup.ps1 — remove a dispatch_prepare container after the merge
# gate integrated (or rejected) the branch (DEC-063 Part A).
# PowerShell twin of dispatch_cleanup.sh — keep behavior at parity.
#
# Usage:
#   .\dispatch_cleanup.ps1 -Project <root> -PmId <id> -Id <n> [-DeleteBranch] [-Force]
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Project,
    [Parameter(Mandatory = $true)][string]$PmId,
    [Parameter(Mandatory = $true)][int]$Id,
    [switch]$DeleteBranch,
    [switch]$Force
)
$ErrorActionPreference = 'Stop'

$container = Join-Path $Project "__garelier/$PmId/_dispatch$Id"
# Both layouts: helper-made containers hold the worktree at checkout/; older
# hand-made dispatches used the container dir itself as the worktree.
$checkout = Join-Path $container 'checkout'
if (-not (Test-Path -LiteralPath $checkout)) { $checkout = $container }
if (-not (Test-Path -LiteralPath $checkout)) { Write-Error "dispatch_cleanup: no worktree at $container[/checkout]"; exit 1 }

$branch = ''
try { $branch = (git -C $checkout branch --show-current).Trim() } catch { }

if ($Force) { git -C $Project worktree remove --force $checkout | Out-Host }
else { git -C $Project worktree remove $checkout | Out-Host }
if ($LASTEXITCODE -ne 0) {
    # Windows MAX_PATH: git cannot delete deep build trees (e.g. Rust target/).
    # Fall back to a long-path-safe recursive delete + prune.
    Write-Host 'dispatch_cleanup: git worktree remove failed; falling back to Remove-Item + prune (long-path safe)'
    $longPath = '\\?\' + ($checkout -replace '/', '\')
    Remove-Item -LiteralPath $longPath -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $checkout) { Write-Error 'dispatch_cleanup: fallback delete failed'; exit 1 }
    git -C $Project worktree prune | Out-Host
}

$branchDeleted = $false
if ($DeleteBranch -and $branch) {
    git -C $Project branch -D $branch | Out-Host
    if ($LASTEXITCODE -ne 0) { Write-Error 'dispatch_cleanup: git branch -D failed'; exit 1 }
    $branchDeleted = $true
}

try { Remove-Item -LiteralPath (Join-Path $container 'STATE.md') -Force -ErrorAction Stop } catch { }
try { Remove-Item -LiteralPath $container -ErrorAction Stop } catch { }

# W-011: record the lifecycle end + regenerate the in_flight.md derived view
# (the removed container drops out of it). Best-effort - cleanup must succeed
# even if the event helper is missing.
try {
    & (Join-Path $PSScriptRoot 'dispatch_event.ps1') -Project $Project -PmId $PmId `
        -Kind 'cleanup' -Role "dispatch(#$Id)" -Task "#$Id container removed" | Out-Host
} catch { }

$fwd = ($checkout -replace '\\', '/')
Write-Output ('{"id":' + $Id + ',"removed":"' + $fwd + '","branch":"' + $branch + '","branch_deleted":' + ($branchDeleted.ToString().ToLower()) + '}')
