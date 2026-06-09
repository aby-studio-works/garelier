<#
.SYNOPSIS
  Report whether the Garelier Status Web Console is running for a PM, and its URL.

.DESCRIPTION
  Reads the pidfile (runtime/status_web/status_web.json) the console wrote on
  launch. Read-only. Exit 0 if up, 1 if down.

.EXAMPLE
  .\status_web_status.ps1 -PmId acme
#>
[CmdletBinding()]
param(
    [string]$PmId = "",
    [string]$Project = "",
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)

$ErrorActionPreference = "Stop"

if (-not $PmId -and $Rest -and $Rest.Count -ge 1) { $PmId = $Rest[0] }
if (-not $Project) { $Project = (Get-Location).Path }
$garelierRoot = Join-Path $Project "__garelier"

if (-not (Test-Path $garelierRoot -PathType Container)) {
    Write-Error "Not a Garelier project root: $Project"; exit 1
}

if (-not $PmId) {
    $cands = @()
    foreach ($d in Get-ChildItem -Path $garelierRoot -Directory -ErrorAction SilentlyContinue) {
        if ((Test-Path (Join-Path $d.FullName "_pm/setup_config.toml")) -or
            (Test-Path (Join-Path $d.FullName "control/control.toml"))) { $cands += $d.Name }
    }
    if ($cands.Count -eq 0) { Write-Error "No Garelier control namespace under $garelierRoot."; exit 1 }
    elseif ($cands.Count -eq 1) { $PmId = $cands[0] }
    else { Write-Error ("Multiple PMs found — pass -PmId. Available: " + ($cands -join ", ")); exit 1 }
}

$pidFile = Join-Path $garelierRoot "$PmId/runtime/status_web/status_web.json"

if (-not (Test-Path $pidFile)) {
    Write-Output "Status console for PM '$PmId': DOWN (no pidfile)."
    exit 1
}

$thePid = $null; $url = $null
try { $j = Get-Content $pidFile -Raw | ConvertFrom-Json; $thePid = $j.pid; $url = $j.url } catch {}

if ($thePid -and (Get-Process -Id $thePid -ErrorAction SilentlyContinue)) {
    Write-Output "Status console for PM '$PmId': UP (pid $thePid)."
    if ($url) { Write-Output "  URL: $url" }
    exit 0
} else {
    Write-Output "Status console for PM '$PmId': DOWN (stale pidfile, pid $thePid not alive)."
    exit 1
}
