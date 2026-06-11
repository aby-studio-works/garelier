# merge_request.ps1 — one-command merge-gate request (DEC-064 §1).
# PowerShell twin of merge_request.sh — keep behavior at parity.
#
# Usage:
#   .\merge_request.ps1 -Project <root> -PmId <id> -Branch <workbench-branch>
#                       -Guardian <PASS|PASS_WITH_NOTES> [-Observer <verdict>]
#                       [-Task <label>] [-Message <msg>] [-Studio <branch>]
#                       [-Core <garelier-core-dir>] [-NoPoll]
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Project,
    [Parameter(Mandatory = $true)][string]$PmId,
    [Parameter(Mandatory = $true)][string]$Branch,
    [Parameter(Mandatory = $true)][string]$Guardian,
    [string]$Observer = "",
    [string]$Task = "",
    [string]$Message = "",
    [string]$Studio = "",
    [string]$Core = "",
    [switch]$NoPoll
)
$ErrorActionPreference = 'Stop'

if (-not $Studio) {
    $config = Join-Path $Project "__garelier/$PmId/_pm/setup_config.toml"
    if (-not (Test-Path -LiteralPath $config)) { Write-Error "merge_request: no -Studio and no $config"; exit 2 }
    $m = Select-String -LiteralPath $config -Pattern '^\s*integration\s*=\s*"(.*)"' | Select-Object -First 1
    if (-not $m) { Write-Error "merge_request: [branches] integration not found in $config"; exit 2 }
    $Studio = $m.Matches[0].Groups[1].Value
}

if (-not $Task) {
    $parts = $Branch -split '/'
    if ($parts.Length -ge 2) { $Task = $parts[-2] + '-' + $parts[-1] } else { $Task = $Branch }
}
$safeTask = (($Task -replace '[^a-zA-Z0-9_-]', '')).Substring(0, [Math]::Min(40, ($Task -replace '[^a-zA-Z0-9_-]', '').Length))
if (-not $safeTask) { $safeTask = 'req' }
$reqId = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss') + '-' + $safeTask

if (-not $Message) {
    $obsPart = if ($Observer) { "; Observer $Observer" } else { "" }
    $Message = "merge $Task into studio`n`nGuardian $Guardian$obsPart."
}

$reqDir = Join-Path $Project "__garelier/$PmId/runtime/merge_gate/requests"
$null = New-Item -ItemType Directory -Force $reqDir
$reqFile = Join-Path $reqDir "$reqId.json"

$obj = [ordered]@{
    request_id       = $reqId
    workbench_branch = $Branch
    studio_branch    = $Studio
    task_id          = $Task
    agent            = 'merge_request.ps1'
    guardian_verdict = $Guardian
}
if ($Observer) { $obj['observer_verdict'] = $Observer }
$obj['merge_message'] = $Message
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($reqFile, (ConvertTo-Json $obj -Depth 4), $utf8)
Write-Host "merge_request: wrote $reqFile"

if ($NoPoll) {
    Write-Output ('{"request_id":"' + $reqId + '","request_file":"' + ($reqFile -replace '\\', '/') + '","polled":false}')
    exit 0
}

if (-not $Core) { $Core = Split-Path -Parent $PSScriptRoot }
bun (Join-Path $Core 'driver/src/dispatch/dock_merge.ts') poll --pm-id $PmId --project $Project
exit $LASTEXITCODE
