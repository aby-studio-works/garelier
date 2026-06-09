#Requires -Version 5.1
<#
.SYNOPSIS
    Stop the Garelier driver gracefully by writing the stop file.

.DESCRIPTION
    v2.1: pm-id aware. Each PM has its own driver. Auto-detects pm_id
    when exactly one PM is initialized under __garelier/.

.PARAMETER PmId
    PM whose driver to stop. Required when more than one PM exists
    under __garelier/.

.PARAMETER ProjectRoot
    Project root directory. Defaults to current working directory.

.PARAMETER Wait
    Block until the driver actually exits (driver.pid removed).

.PARAMETER TimeoutSeconds
    Max seconds to wait with -Wait. Default 180.
#>

[CmdletBinding()]
param(
    [string]$PmId = '',
    [string]$ProjectRoot = (Get-Location).Path,
    [switch]$Wait,
    [int]$TimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'

$GarelierRoot = Join-Path $ProjectRoot '__garelier'

if (-not (Test-Path $GarelierRoot -PathType Container)) {
    Write-Error "Not a Garelier project root: $ProjectRoot"
    exit 1
}

if ([string]::IsNullOrWhiteSpace($PmId)) {
    $candidates = @()
    foreach ($d in (Get-ChildItem -LiteralPath $GarelierRoot -Directory -ErrorAction SilentlyContinue)) {
        if (Test-Path -LiteralPath (Join-Path $d.FullName '_pm/setup_config.toml') -PathType Leaf) {
            $candidates += $d.Name
        }
    }
    switch ($candidates.Count) {
        0 {
            Write-Error "No Garelier PM initialized under $GarelierRoot; run setup_wizard."
            exit 1
        }
        1 {
            $PmId = $candidates[0]
        }
        default {
            $list = ($candidates | ForEach-Object { "         - $_" }) -join "`n"
            Write-Error "Multiple PMs found under ${GarelierRoot} — pass -PmId <id>.`n       Available PMs:`n$list"
            exit 1
        }
    }
}

$PidFile    = Join-Path $GarelierRoot "$PmId\runtime\driver\driver.pid"
$StopFile   = Join-Path $GarelierRoot "$PmId\runtime\driver\stop"
$ConfigFile = Join-Path $GarelierRoot "$PmId\_pm\setup_config.toml"

if (-not (Test-Path $ConfigFile -PathType Leaf)) {
    Write-Error "PM '$PmId' not found: $ConfigFile missing."
    exit 1
}

if (-not (Test-Path $PidFile -PathType Leaf)) {
    Write-Host "No driver.pid for PM '$PmId' — driver is not running. Nothing to stop."
    if (Test-Path $StopFile) { Remove-Item -LiteralPath $StopFile -Force }
    exit 0
}

New-Item -ItemType Directory -Path (Split-Path $StopFile) -Force | Out-Null
New-Item -ItemType File -Path $StopFile -Force | Out-Null
Write-Host "Stop signal written for PM '$PmId': $StopFile"
Write-Host '  Driver will exit on its next stop-file check (~500ms during poll wait, up to poll interval during a running iteration).'

if ($Wait) {
    Write-Host "  Waiting up to ${TimeoutSeconds}s for driver to exit..."
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-Path $PidFile)) {
            Write-Host '  Driver exited.'
            exit 0
        }
        Start-Sleep -Seconds 2
    }
    Write-Warning "Driver did not exit within ${TimeoutSeconds}s. Check logs or kill manually."
    exit 1
}
