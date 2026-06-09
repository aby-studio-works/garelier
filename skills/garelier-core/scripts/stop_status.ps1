<#
.SYNOPSIS
  Stop the Garelier Status Web Console for a PM.

.DESCRIPTION
  Reads the pidfile (runtime/status_web/status_web.json) the console wrote on
  launch, stops the process, and removes the pidfile. Read-only console → a
  plain stop is safe (no state to flush).

.EXAMPLE
  .\stop_status.ps1 -PmId acme
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
    Write-Output "No status console pidfile for PM '$PmId' — not running. Nothing to stop."
    exit 0
}

$thePid = $null
try { $thePid = (Get-Content $pidFile -Raw | ConvertFrom-Json).pid } catch {}
if (-not $thePid) {
    Write-Output "Pidfile present but no pid parsed; removing stale $pidFile."
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue; exit 0
}

$proc = Get-Process -Id $thePid -ErrorAction SilentlyContinue
if (-not $proc) {
    Write-Output "Status console (pid $thePid) is not alive; removing stale pidfile."
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue; exit 0
}

try { Stop-Process -Id $thePid -ErrorAction Stop } catch {}
for ($i = 0; $i -lt 10; $i++) {
    if (-not (Get-Process -Id $thePid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 300
}
if (Get-Process -Id $thePid -ErrorAction SilentlyContinue) {
    Stop-Process -Id $thePid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 300
}
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
Write-Output "Status console stopped for PM '$PmId' (pid $thePid)."
