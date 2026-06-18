# dispatch_cleanup.ps1 — remove a dispatch_prepare container after the merge
# gate integrated (or rejected) the branch (DEC-063 Part A).
# PowerShell twin of dispatch_cleanup.sh — keep behavior at parity.
#
# Robust on Windows (DEC-073 Part C): when a lingering rustc/sccache/cargo
# handle (or OS handle lag) holds a file under the worktree's deep `target/`,
# the physical dir cannot be deleted even though git deregistered the worktree.
# Instead of crashing the caller (exit 1) and leaking a stale `_dispatch<N>/`,
# this script:
#   1. retries the delete with backoff (0.5 / 1 / 2 s),
#   2. on persistent failure RECORDS the stale dir in
#      `runtime/backlog/failed_cleanups.jsonl` and exits 0 (git is already
#      pruned; only the physical dir lingers — never a correctness issue),
#   3. is re-runnable in -Sweep mode (retries every recorded stale dir) — the
#      self-heal hook that `dispatch_prepare` calls on every new dispatch.
#
# Usage:
#   .\dispatch_cleanup.ps1 -Project <root> -PmId <id> -Id <n> [-DeleteBranch] [-Force]
#   .\dispatch_cleanup.ps1 -Project <root> -PmId <id> -Sweep   # retry deferred stale dirs
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Project,
    [Parameter(Mandatory = $true)][string]$PmId,
    [int]$Id = 0,
    [switch]$DeleteBranch,
    [switch]$Force,
    [switch]$Sweep
)
$ErrorActionPreference = 'Stop'

$failedFile = Join-Path $Project "__garelier/$PmId/runtime/backlog/failed_cleanups.jsonl"

# Retry-with-backoff removal of a worktree checkout dir. Returns $true if the
# dir is gone (or never existed). Always prunes stale git registrations.
function Remove-CheckoutDir([string]$proj, [string]$checkout, [bool]$force) {
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        if (-not (Test-Path -LiteralPath $checkout)) { return $true }
        if ($force) { git -C $proj worktree remove --force $checkout 2>&1 | Out-Host }
        else { git -C $proj worktree remove $checkout 2>&1 | Out-Host }
        if (-not (Test-Path -LiteralPath $checkout)) { git -C $proj worktree prune 2>&1 | Out-Host; return $true }
        # Long-path-safe fallback delete (bypasses MAX_PATH, not handle locks).
        $longPath = '\\?\' + ($checkout -replace '/', '\')
        Remove-Item -LiteralPath $longPath -Recurse -Force -ErrorAction SilentlyContinue
        git -C $proj worktree prune 2>&1 | Out-Host
        if (-not (Test-Path -LiteralPath $checkout)) { return $true }
        if ($attempt -lt 4) { Start-Sleep -Milliseconds ([int]([Math]::Pow(2, $attempt - 1) * 500)) }
    }
    return (-not (Test-Path -LiteralPath $checkout))
}

function Append-FailedCleanup([int]$id, [string]$container, [string]$reason) {
    try {
        New-Item -ItemType Directory -Force (Split-Path -Parent $failedFile) | Out-Null
        $ts = (Get-Date).ToUniversalTime().ToString('o')
        $fwd = ($container -replace '\\', '/')
        $line = '{"ts":"' + $ts + '","dispatch_id":' + $id + ',"container":"' + $fwd + '","reason":"' + ($reason -replace '"', "'") + '"}'
        Add-Content -LiteralPath $failedFile -Value $line -Encoding UTF8
    } catch { }
}

# -Sweep: retry every recorded stale dir; drop the ones now gone. Self-heal hook.
if ($Sweep) {
    if (-not (Test-Path -LiteralPath $failedFile)) { Write-Output 'swept=0 remaining=0'; exit 0 }
    $entries = @(Get-Content -LiteralPath $failedFile -ErrorAction SilentlyContinue | Where-Object { $_.Trim() })
    $remaining = @()
    $swept = 0
    foreach ($line in $entries) {
        $obj = $null; try { $obj = $line | ConvertFrom-Json } catch { continue }
        $container = $obj.container
        $checkout = Join-Path $container 'checkout'
        if (-not (Test-Path -LiteralPath $checkout)) { $checkout = $container }
        if (-not (Test-Path -LiteralPath $checkout)) { $swept++; continue }   # already gone
        if (Remove-CheckoutDir $Project $checkout $true) {
            try { Remove-Item -LiteralPath $container -Recurse -Force -ErrorAction Stop } catch { }
            if (-not (Test-Path -LiteralPath $container)) { $swept++; continue }
        }
        $remaining += $line
    }
    if ($remaining.Count -gt 0) { Set-Content -LiteralPath $failedFile -Value $remaining -Encoding UTF8 }
    else { Remove-Item -LiteralPath $failedFile -Force -ErrorAction SilentlyContinue }
    Write-Output ("swept=$swept remaining=" + $remaining.Count)
    exit 0
}

if ($Id -le 0) { Write-Error 'dispatch_cleanup: -Id <n> is required (or use -Sweep)'; exit 2 }

$container = Join-Path $Project "__garelier/$PmId/_dispatch$Id"
# Both layouts: helper-made containers hold the worktree at checkout/; older
# hand-made dispatches used the container dir itself as the worktree.
$checkout = Join-Path $container 'checkout'
if (-not (Test-Path -LiteralPath $checkout)) { $checkout = $container }
if (-not (Test-Path -LiteralPath $checkout)) { Write-Error "dispatch_cleanup: no worktree at $container[/checkout]"; exit 1 }

$branch = ''
try { $branch = (git -C $checkout branch --show-current).Trim() } catch { }

# Remove the worktree (retry + backoff). On persistent handle-lock, DEFER (record
# + continue) instead of crashing — git is pruned; the physical dir is swept later.
$cleanupStatus = 'success'
if (-not (Remove-CheckoutDir $Project $checkout $Force.IsPresent)) {
    Write-Host 'dispatch_cleanup: worktree dir still locked after retries; deferring to failed_cleanups.jsonl (git pruned)'
    Append-FailedCleanup $Id $container 'worktree dir locked after retries'
    $cleanupStatus = 'deferred'
}

$branchDeleted = $false
if ($DeleteBranch -and $branch) {
    git -C $Project branch -D $branch | Out-Host
    if ($LASTEXITCODE -ne 0) { Write-Error 'dispatch_cleanup: git branch -D failed'; exit 1 }
    $branchDeleted = $true
}

# Archive the coordination files to runtime/backlog/done/ before removing the
# container (the protocol's completed assignment+report archive — mechanical,
# nothing to remember). Slug derived from the branch family path.
$slug = if ($branch) { ($branch -split '/')[-1] } else { 'dispatch' }
if (-not $slug) { $slug = 'dispatch' }
$doneDir = Join-Path $Project "__garelier/$PmId/runtime/backlog/done"
$coord = @('report.md', 'questions.md', 'answers.md') | Where-Object { Test-Path (Join-Path $container $_) -PathType Leaf }
if ($coord.Count -gt 0) {
    New-Item -ItemType Directory -Force $doneDir | Out-Null
    $sb = [System.Text.StringBuilder]::new()
    $branchLabel = if ($branch) { $branch } else { 'no-branch' }
    [void]$sb.AppendLine("# #$Id $slug - archived by dispatch_cleanup ($branchLabel)")
    [void]$sb.AppendLine('')
    $first = $true
    foreach ($f in $coord) {
        if (-not $first) { [void]$sb.AppendLine(''); [void]$sb.AppendLine('---'); [void]$sb.AppendLine('') }
        [void]$sb.Append((Get-Content -LiteralPath (Join-Path $container $f) -Raw))
        $first = $false
    }
    [System.IO.File]::WriteAllText((Join-Path $doneDir "$Id-$slug.md"), $sb.ToString(), [System.Text.UTF8Encoding]::new($false))
    foreach ($f in $coord) { try { Remove-Item -LiteralPath (Join-Path $container $f) -Force -ErrorAction Stop } catch { } }
}

try { Remove-Item -LiteralPath (Join-Path $container 'STATE.md') -Force -ErrorAction Stop } catch { }
try { Remove-Item -LiteralPath $container -ErrorAction Stop } catch { }
# If the container could not be removed (checkout still locked) and we have not
# already deferred it, record it so a later -Sweep converges it.
if ((Test-Path -LiteralPath $container) -and $cleanupStatus -eq 'success') {
    Append-FailedCleanup $Id $container 'container dir not empty / locked'
    $cleanupStatus = 'deferred'
}

# W-011: record the lifecycle end + regenerate the in_flight.md derived view
# (the removed container drops out of it). Best-effort - cleanup must succeed
# even if the event helper is missing.
try {
    & (Join-Path $PSScriptRoot 'dispatch_event.ps1') -Project $Project -PmId $PmId `
        -Kind 'cleanup' -Role "dispatch(#$Id)" -Task "#$Id container removed" | Out-Host
} catch { }

$fwd = ($checkout -replace '\\', '/')
Write-Output ('{"id":' + $Id + ',"removed":"' + $fwd + '","branch":"' + $branch + '","branch_deleted":' + ($branchDeleted.ToString().ToLower()) + ',"cleanup_status":"' + $cleanupStatus + '"}')
