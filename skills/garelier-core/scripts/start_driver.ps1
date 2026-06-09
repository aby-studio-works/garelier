#Requires -Version 5.1
<#
.SYNOPSIS
    Launch the Garelier driver detached. Calls `bun run` on the TS driver
    in garelier-core/driver/ and returns immediately.

.DESCRIPTION
    v2.1: pm-id aware. Driver instances are per-PM. Pass -PmId explicitly
    when more than one PM lives under __garelier/. If exactly one exists
    it is auto-detected.

    Thin wrapper around `Start-Process -WindowStyle Hidden -PassThru` that:
    - Validates the project is a Garelier root
    - Resolves or auto-detects the active pm_id
    - Refuses if a live driver.pid already exists for that PM
    - Spawns the Bun driver detached (survives the caller exiting)
    - Redirects stdout/stderr to driver.stdout.log

    Authentication: the driver shells out to the provider configured in
    _pm/setup_config.toml (`claude -p` or `codex exec`). Run `claude login`
    or `codex login` once for whichever provider is enabled. No provider
    API key is managed by this script.

.PARAMETER PmId
    PM identifier whose driver to launch. Required when more than one
    PM exists under __garelier/.

.PARAMETER ProjectRoot
    Project root directory. Defaults to current working directory.

.PARAMETER NoWatchdog
    Do NOT tie the driver's lifetime to this PM session. By default the driver
    self-stops (and tears down its detached role children/leases) when the PM's
    interactive `claude` terminal closes — no zombies. Pass -NoWatchdog to keep the driver
    running detached after the terminal closes (long-running unattended use).
#>

[CmdletBinding()]
param(
    [string]$PmId = '',
    [string]$ProjectRoot = (Get-Location).Path,
    [switch]$Force,
    [switch]$NoWatchdog
)

$ErrorActionPreference = 'Stop'

# Dispatch-only (DEC-061): the headless driver (Mode B) is disabled. Garelier runs
# roles via DISPATCH (the interactive PM/Dock session dispatches each role as an
# in-session subagent, or a `codex exec` subprocess), NOT the per-iteration
# `claude -p` driver. This entrypoint refuses to launch. The driver code is
# retained but gated off; $env:GARELIER_ALLOW_DRIVER = '1' is an UNSUPPORTED
# internal recovery escape hatch only.
if ($env:GARELIER_ALLOW_DRIVER -ne '1') {
    Write-Error "Garelier is DISPATCH-ONLY: the headless driver (Mode B) is disabled (DEC-061). Run roles via dispatch — the interactive PM/Dock session dispatches each role as an in-session subagent (or a 'codex exec' subprocess). See README / docs/execution_backends.md."
    exit 2
}

$GarelierRoot = Join-Path $ProjectRoot '__garelier'

if (-not (Test-Path $GarelierRoot -PathType Container)) {
    Write-Error "Not a Garelier project root: $ProjectRoot (no __garelier/ directory)."
    exit 1
}

# Auto-detect pm_id when not provided
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

# Resolve garelier-core dir (DEC-053: cache-safe + dual-mode). Order:
#   1. GARELIER_CORE_DIR (explicit override)
#   2. ${CLAUDE_PLUGIN_ROOT}/skills/garelier-core (plugin runtime)
#   3. script-relative self-location (this script lives in
#      garelier-core\scripts\, so parent/.. = garelier-core); verified by
#      SKILL.md presence — works in the read-only plugin cache too
#   4. legacy $env:USERPROFILE\.claude\skills\garelier-core (dev symlink last resort)
$SelfCoreDir = Split-Path -Parent $PSScriptRoot
if ($env:GARELIER_CORE_DIR) {
    $SkillDir = $env:GARELIER_CORE_DIR
} elseif ($env:CLAUDE_PLUGIN_ROOT) {
    $SkillDir = Join-Path $env:CLAUDE_PLUGIN_ROOT 'skills\garelier-core'
} elseif (Test-Path (Join-Path $SelfCoreDir 'SKILL.md')) {
    $SkillDir = $SelfCoreDir
} else {
    $SkillDir = Join-Path $env:USERPROFILE '.claude\skills\garelier-core'
}
# Export so the driver (main.ts) and its subprocesses inherit the resolved dir.
$env:GARELIER_CORE_DIR = $SkillDir
$DriverDir   = Join-Path $SkillDir 'driver'
$EntryPoint  = Join-Path $DriverDir 'src\main.ts'
$ConfigFile  = Join-Path $GarelierRoot "$PmId\_pm\setup_config.toml"
$PidFile     = Join-Path $GarelierRoot "$PmId\runtime\driver\driver.pid"
$StopFile    = Join-Path $GarelierRoot "$PmId\runtime\driver\stop"
$LogsDir     = Join-Path $GarelierRoot "$PmId\runtime\driver\logs"
$StdoutLog   = Join-Path $LogsDir 'driver.stdout.log'

if (-not (Test-Path $ConfigFile -PathType Leaf)) {
    Write-Error "PM '$PmId' not found: $ConfigFile missing."
    exit 1
}
if (-not (Test-Path $EntryPoint -PathType Leaf)) {
    Write-Error "Driver entry not found at $EntryPoint. Reinstall the garelier-core skill."
    exit 1
}

# Live driver check
if (Test-Path $PidFile -PathType Leaf) {
    $existing = (Get-Content -LiteralPath $PidFile -Raw).Trim()
    if ($existing -match '^\d+$') {
        try {
            $null = Get-Process -Id ([int]$existing) -ErrorAction Stop
            Write-Error "Driver already running for PM '$PmId' (pid $existing). Stop it with: stop_driver.ps1 -PmId $PmId  (or touch $StopFile)."
            exit 1
        } catch {
            # stale pid — driver's own startup will clean it up
        }
    }
}

if (Test-Path $StopFile -PathType Leaf) {
    Remove-Item -LiteralPath $StopFile -Force
    Write-Host "Removed stale stop file from previous run."
}

# === Shell-level pre-flight cleanup (PM history-and-operations §13.4 subset) ===
#
# When PM mediates the restart, PM runs the full audit in §13.4 (asks
# the user about PM-owned dirty files etc). When the user invokes
# start_driver directly (common in Mode B Hybrid), no LLM runs that
# audit. This block performs the shell-safe subset that doesn't need
# judgment:
#   1. Stale merge_gate active.lock with dead pid → remove
#   2. Orphan .git/MERGE_HEAD → git merge --abort
#   3. Working-tree dirty → warn (do not auto-fix; needs PM/user)

$MergeGateLock = Join-Path $GarelierRoot "$PmId\runtime\merge_gate\locks\active.lock"
if (Test-Path $MergeGateLock -PathType Leaf) {
    $lockContent = Get-Content -LiteralPath $MergeGateLock -Raw -ErrorAction SilentlyContinue
    if ($lockContent -and $lockContent -match '"pid"\s*:\s*(\d+)') {
        $lockPid = [int]$matches[1]
        try {
            $null = Get-Process -Id $lockPid -ErrorAction Stop
            # alive — leave it; the active driver owns it
        } catch {
            Remove-Item -LiteralPath $MergeGateLock -Force
            Write-Host "Removed stale merge_gate active.lock (pid $lockPid was dead)."
        }
    }
}

$MergeHead = Join-Path $ProjectRoot '.git\MERGE_HEAD'
if (Test-Path $MergeHead -PathType Leaf) {
    Write-Host "Aborting orphan merge state (.git/MERGE_HEAD present) ..."
    Push-Location $ProjectRoot
    try { & git merge --abort 2>&1 | ForEach-Object { "  $_" } | Write-Host }
    finally { Pop-Location }
}

# Working-tree dirt: warn only.
Push-Location $ProjectRoot
try {
    $dirty = & git status --porcelain 2>$null
    if ($dirty) {
        $dirtyCount = ($dirty | Measure-Object).Count
        Write-Host ""
        Write-Host "WARNING: $dirtyCount dirty path(s) in primary checkout. Examples:"
        $dirty | Select-Object -First 10 | ForEach-Object { "  $_" } | Write-Host
        Write-Host ""
        Write-Host "  Driver will start anyway. PM-owned dirt (AGENTS.md, CLAUDE.md,"
        Write-Host "  __garelier/<pm_id>/{_pm,control}/*) should be reviewed and committed"
        Write-Host "  in your next PM session — see garelier-pm/references/history-and-operations.md §13.4 for the full audit"
        Write-Host "  + classification procedure."
        Write-Host ""
    }
} finally { Pop-Location }

# === Doctor pre-flight ===
#
# Run the health check before launching. A P0 (blocking) finding — broken
# setup, placeholder leakage, dangerous config without commands — refuses
# the start unless -Force was passed. P1/P2 only warn; the start proceeds.
$Doctor = Join-Path $PSScriptRoot 'doctor.ps1'
if (Test-Path $Doctor -PathType Leaf) {
    $doctorOut = & $Doctor -PmId $PmId -ProjectRoot $ProjectRoot 2>&1
    $doctorRc = $LASTEXITCODE
    if ($doctorRc -ne 0) {
        $doctorOut | ForEach-Object { "  $_" } | Write-Host
        if (-not $Force) {
            Write-Host ""
            Write-Host "Refusing to start: doctor reported P0 (blocking) findings for PM '$PmId'." -ForegroundColor Red
            Write-Host "  Fix them (re-run doctor.ps1 -PmId $PmId), or pass -Force to override."
            exit 1
        }
        Write-Host "  -Force given: starting despite P0 findings."
    } else {
        $warns = @($doctorOut | Where-Object { $_ -match '^\[(P1|P2)\]' })
        if ($warns.Count -gt 0) {
            Write-Host "Doctor warnings (non-blocking):"
            $warns | ForEach-Object { "  $_" } | Write-Host
        }
    }
}

# === Bun runtime (needed only to LAUNCH) ===
# Checked after the doctor pre-flight so a broken config is still diagnosed
# (doctor is pure PowerShell) even when Bun isn't installed yet.
$bunCmd = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bunCmd) {
    Write-Error "'bun' not found on PATH. Install with: winget install Oven-sh.Bun"
    exit 1
}
$nodeModules = Join-Path $DriverDir 'node_modules'
if (-not (Test-Path $nodeModules -PathType Container)) {
    Write-Host "First-time setup: running 'bun install' in $DriverDir ..."
    Push-Location $DriverDir
    try { & bun install | Out-Host } finally { Pop-Location }
}

New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null

# Pass pm_id to the driver via both env var and CLI flag.
$env:GARELIER_PM_ID = $PmId

# === No-zombie watchdog: discover the PM's interactive claude session PID ===
#
# The driver is launched DETACHED (so it survives this PowerShell tool-call
# shell), which means closing the PM terminal (WezTerm / VS Code) would orphan
# the driver and its detached role children. To prevent zombies we pass the PM session
# PID as --watchdog-pid; the driver self-stops (and tears down its role children) the
# moment that process exits. Discovery: walk the parent chain from this script up
# to the nearest `claude` process. Best-effort — if not found we simply omit the
# flag (driver runs as before; -NoWatchdog forces that explicitly).
function Get-ClaudeAncestorPid {
    param([int]$StartPid)
    $cur = $StartPid
    for ($i = 0; $i -lt 24 -and $cur -gt 0; $i++) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
        if (-not $proc) { return 0 }
        if ($proc.Name -match 'claude') { return [int]$proc.ProcessId }
        $cur = [int]$proc.ParentProcessId
    }
    return 0
}

$WatchdogPid = 0
if (-not $NoWatchdog) {
    try { $WatchdogPid = Get-ClaudeAncestorPid -StartPid $PID } catch { $WatchdogPid = 0 }
    if ($WatchdogPid -le 0 -and $env:CLAUDECODE -eq '1') {
        Write-Host "Note: running under a Claude Code session but could not resolve its PID; driver will run without a watchdog (closing the terminal will NOT auto-stop it)."
    }
}

$driverArgs = @('run', $EntryPoint, '--project', $ProjectRoot, '--pm-id', $PmId)
if ($WatchdogPid -gt 0) { $driverArgs += @('--watchdog-pid', "$WatchdogPid") }

# Detached spawn. -WindowStyle Hidden + no -Wait means the driver outlives
# this script and is owned by the OS (not chained to PM's Bash subprocess).
$proc = Start-Process bun `
    -ArgumentList $driverArgs `
    -WorkingDirectory $ProjectRoot `
    -WindowStyle Hidden `
    -PassThru `
    -RedirectStandardOutput $StdoutLog `
    -RedirectStandardError "$StdoutLog.err"

Write-Host "Driver launched (PID $($proc.Id), detached) for PM '$PmId'."
Write-Host "  Project: $ProjectRoot"
Write-Host "  Stdout:  $StdoutLog"
Write-Host "  JSONL:   $LogsDir\driver.jsonl"
if ($WatchdogPid -gt 0) {
    Write-Host "  Watchdog: tied to PM claude session PID $WatchdogPid (closing this terminal stops the driver + its role children)."
} else {
    Write-Host "  Watchdog: none (driver keeps running after this terminal closes; stop it explicitly)."
}
Write-Host "  Stop:    stop_driver.ps1 -PmId $PmId  (or touch $StopFile)"
