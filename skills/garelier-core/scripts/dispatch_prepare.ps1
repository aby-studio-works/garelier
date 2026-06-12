# dispatch_prepare.ps1 — zero-LLM producer-dispatch scaffolding (DEC-063 Part A).
# PowerShell twin of dispatch_prepare.sh — keep behavior at parity.
#
# Usage:
#   .\dispatch_prepare.ps1 -Project <root> -PmId <id> -Role <worker|smith|librarian|artisan>
#                          -Slug <kebab-slug> [-Base <integration-branch>]
#
# Atomically claims the next task id, cuts an ISOLATED worktree off the
# integration branch on the role's branch family, prints
# {id, container, checkout, branch, base_sha} as one JSON line. Read-only roles
# (scout/observer/guardian) are rejected — no worktree under dispatch.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Project,
    [Parameter(Mandatory = $true)][string]$PmId,
    [Parameter(Mandatory = $true)][string]$Role,
    [Parameter(Mandatory = $true)][string]$Slug,
    [string]$Base = ""
)
$ErrorActionPreference = 'Stop'

if ($Slug -notmatch '^[a-z0-9-]+$') { Write-Error 'dispatch_prepare: -Slug must be kebab-case [a-z0-9-]'; exit 2 }

switch ($Role) {
    'worker'    { $family = 'workbench' }
    'smith'     { $family = 'anvil' }
    'librarian' { $family = 'shelf' }
    'artisan'   { $family = 'satchel' }
    { $_ -in @('scout', 'observer', 'guardian') } {
        Write-Error "dispatch_prepare: $Role is read-only under dispatch - no worktree needed (role_subagent_dispatch.md §2)"; exit 2 }
    default { Write-Error "dispatch_prepare: unknown role: $Role (worker|smith|librarian|artisan)"; exit 2 }
}

if (-not $Base) {
    $config = Join-Path $Project "__garelier/$PmId/_pm/setup_config.toml"
    if (-not (Test-Path -LiteralPath $config)) { Write-Error "dispatch_prepare: no -Base and no $config"; exit 2 }
    $m = Select-String -LiteralPath $config -Pattern '^\s*integration\s*=\s*"(.*)"' | Select-Object -First 1
    if (-not $m) { Write-Error "dispatch_prepare: [branches] integration not found in $config"; exit 2 }
    $Base = $m.Matches[0].Groups[1].Value
}
if ($Base -notmatch '/studio$') { Write-Error "dispatch_prepare: integration branch must end in /studio: $Base"; exit 2 }

# Atomic id claim: directory creation is atomic; the lock guards read-increment-write.
$idFile = Join-Path $Project "__garelier/$PmId/runtime/backlog/next_id"
$null = New-Item -ItemType Directory -Force (Split-Path -Parent $idFile)
$lock = "$idFile.lock"
$tries = 0
while ($true) {
    try { $null = New-Item -ItemType Directory -Path $lock -ErrorAction Stop; break }
    catch {
        $tries++
        if ($tries -ge 50) { Write-Error "dispatch_prepare: could not lock $lock"; exit 1 }
        Start-Sleep -Milliseconds 100
    }
}
try {
    if (-not (Test-Path -LiteralPath $idFile)) { Set-Content -LiteralPath $idFile -Value '1' -NoNewline:$false }
    $idText = (Get-Content -LiteralPath $idFile -Raw) -replace '[^0-9]', ''
    if (-not $idText) { Write-Error "dispatch_prepare: $idFile is not a number"; exit 1 }
    $id = [int]$idText
    Set-Content -LiteralPath $idFile -Value ([string]($id + 1))
} finally {
    Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue
}

$container = Join-Path $Project "__garelier/$PmId/_dispatch$id"
if (Test-Path -LiteralPath $container) { Write-Error "dispatch_prepare: container already exists: $container"; exit 1 }
$branch = ($Base -replace 'studio$', '') + "$family/#$id/$Slug"

$null = New-Item -ItemType Directory -Force $container
$checkout = Join-Path $container 'checkout'
git -C $Project worktree add $checkout -b $branch $Base | Out-Host
if ($LASTEXITCODE -ne 0) { Write-Error 'dispatch_prepare: git worktree add failed'; exit 1 }
$baseSha = (git -C $Project rev-parse --short $Base).Trim()
if ($LASTEXITCODE -ne 0) { Write-Error 'dispatch_prepare: git rev-parse failed'; exit 1 }

# Visibility: STATE.md for the Status Web dispatch panel + a start event +
# the regenerated in_flight.md view (W-011: dispatch_event appends the event
# AND derives the view from the live _dispatch<N> containers).
$utf8 = New-Object System.Text.UTF8Encoding($false)
$stateBody = "# Dispatch #$id - $Role $Slug`n`n## Status`n`nWORKING`n`n## Current task`n`n#$id $Slug ($branch)`n"
[System.IO.File]::WriteAllText((Join-Path $container 'STATE.md'), $stateBody, $utf8)

# Report scaffold: producers converged on different report locations in live
# runs; pre-creating the file makes the location structural. dispatch_cleanup
# archives it to runtime/backlog/done/ when the container is removed.
$reportBody = "# Report - #$id $Slug ($Role)`n`n" +
    "- Branch: $branch`n- Base SHA: $baseSha`n`n" +
    "## Status`n`n(REPORTING | BLOCKED)`n`n" +
    "## Summary`n`n(what changed and why - compact; reference paths/SHAs, never paste diffs)`n`n" +
    "## Gates`n`n(commands run + results)`n`n" +
    "## Evidence`n`n(red->green proof, measurements, writer-audit conclusions)`n"
[System.IO.File]::WriteAllText((Join-Path $container 'report.md'), $reportBody, $utf8)

& (Join-Path $PSScriptRoot 'dispatch_event.ps1') -Project $Project -PmId $PmId `
    -Kind 'start' -Role "$Role(#$id)" -Task "#$id $Slug dispatched" | Out-Host

$fwd = { param($p) ($p -replace '\\', '/') }
Write-Output ('{"id":' + $id + ',"container":"' + (& $fwd $container) + '","checkout":"' + (& $fwd $checkout) + '","branch":"' + $branch + '","base_sha":"' + $baseSha + '"}')
