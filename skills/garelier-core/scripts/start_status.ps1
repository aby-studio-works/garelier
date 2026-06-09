<#
.SYNOPSIS
  Launch the Garelier Status Web Console detached (read-only).

.DESCRIPTION
  Read-only: never mutates state, never spawns a provider. status_web.ts writes
  its own pidfile (runtime/status_web/status_web.json) so stop_status.ps1 can
  stop it without the launching terminal. LAN-reachable by default; pass
  -Loopback to bind 127.0.0.1 only.

.EXAMPLE
  .\start_status.ps1 -PmId acme
  .\start_status.ps1 -PmId acme -Loopback -Port 3801
#>
[CmdletBinding()]
param(
    [string]$PmId = "",
    [string]$Project = "",
    [int]$Port = 0,
    [switch]$Loopback,
    [string]$BindHost = "",
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)

$ErrorActionPreference = "Stop"

if (-not $PmId -and $Rest -and $Rest.Count -ge 1) { $PmId = $Rest[0] }
if (-not $Project) { $Project = (Get-Location).Path }
$garelierRoot = Join-Path $Project "__garelier"

if (-not (Test-Path $garelierRoot -PathType Container)) {
    Write-Error "Not a Garelier project root: $Project (no __garelier/)"; exit 1
}

if (-not $PmId) {
    $cands = @()
    foreach ($d in Get-ChildItem -Path $garelierRoot -Directory -ErrorAction SilentlyContinue) {
        if ((Test-Path (Join-Path $d.FullName "_pm/setup_config.toml")) -or
            (Test-Path (Join-Path $d.FullName "control/control.toml"))) { $cands += $d.Name }
    }
    if ($cands.Count -eq 0) { Write-Error "No Garelier control namespace under $garelierRoot; initialize Garelier Control or run setup_wizard."; exit 1 }
    elseif ($cands.Count -eq 1) { $PmId = $cands[0] }
    else { Write-Error ("Multiple PMs found — pass -PmId. Available: " + ($cands -join ", ")); exit 1 }
}

# Resolve garelier-core dir (DEC-053: cache-safe + dual-mode). Order:
#   1. GARELIER_CORE_DIR  2. ${CLAUDE_PLUGIN_ROOT}/skills/garelier-core
#   3. script-relative self-location (this script lives in garelier-core/scripts/,
#      so parent/.. = garelier-core), verified by SKILL.md presence
#   4. legacy $HOME/.claude/skills/garelier-core (dev symlink last resort)
$selfCoreDir = Split-Path -Parent $PSScriptRoot
$skillDir = if ($env:GARELIER_CORE_DIR) {
    $env:GARELIER_CORE_DIR
} elseif ($env:CLAUDE_PLUGIN_ROOT) {
    Join-Path $env:CLAUDE_PLUGIN_ROOT "skills/garelier-core"
} elseif (Test-Path (Join-Path $selfCoreDir "SKILL.md")) {
    $selfCoreDir
} else {
    Join-Path $HOME ".claude/skills/garelier-core"
}
$env:GARELIER_CORE_DIR = $skillDir
$entry = Join-Path $skillDir "driver/src/status_web.ts"
$pidFile = Join-Path $garelierRoot "$PmId/runtime/status_web/status_web.json"
$logDir = Join-Path $garelierRoot "$PmId/runtime/status_web"
$stdoutLog = Join-Path $logDir "status_web.stdout.log"

$fullMarker = Join-Path $garelierRoot "$PmId/_pm/setup_config.toml"
$controlMarker = Join-Path $garelierRoot "$PmId/control/control.toml"
if (-not (Test-Path $fullMarker) -and -not (Test-Path $controlMarker)) {
    Write-Error "Garelier namespace '$PmId' not found."; exit 1
}
if (-not (Test-Path $entry)) {
    Write-Error "status_web entry not found at $entry. Reinstall garelier-core (or set GARELIER_CORE_DIR)."; exit 1
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Error "'bun' not found on PATH (https://bun.sh/install)."; exit 1
}

# Refuse if an instance is already alive for this PM.
if (Test-Path $pidFile) {
    try {
        $existing = (Get-Content $pidFile -Raw | ConvertFrom-Json).pid
        if ($existing -and (Get-Process -Id $existing -ErrorAction SilentlyContinue)) {
            Write-Error "Status console already running for PM '$PmId' (pid $existing). Stop it: stop_status.ps1 -PmId $PmId"; exit 1
        }
    } catch {}
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$env:GARELIER_PM_ID = $PmId

$argList = @("run", $entry, "--project", $Project, "--pm-id", $PmId)
if ($Port -gt 0)    { $argList += @("--port", "$Port") }
if ($Loopback)      { $argList += "--loopback" }
if ($BindHost)      { $argList += @("--host", $BindHost) }

$proc = Start-Process -FilePath "bun" -ArgumentList $argList -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog -RedirectStandardError "$stdoutLog.err" -PassThru

# Give it a moment to bind + write its pidfile, then surface the URL.
$url = $null
for ($i = 0; $i -lt 12; $i++) {
    if (Test-Path $pidFile) {
        try { $url = (Get-Content $pidFile -Raw | ConvertFrom-Json).url } catch {}
        if ($url) { break }
    }
    Start-Sleep -Milliseconds 300
}
Write-Output "Status console launched (PID $($proc.Id), detached) for PM '$PmId'."
if ($url) { Write-Output "  URL:   $url" }
Write-Output "  Log:   $stdoutLog"
Write-Output "  Stop:  stop_status.ps1 -PmId $PmId"
