#Requires -Version 5.1
<#
.SYNOPSIS
    Garelier Setup Wizard (PowerShell version) — v2.7.1.

.DESCRIPTION
    Three modes:
        -Mode Fresh (default): initialize a new PM under __garelier/<pm_id>/.
                              Run from inside the project's __garelier/
                              directory. Prompts for pm_id (or accepts
                              -PmId), then creates __garelier/<pm_id>/
                              {_pm,control,runtime}, AGENTS.md,
                              setup_config.toml, history.md, manifest.md.
                              Dispatch-native (DEC-065): NO role containers
                              are pre-created — producers run in ephemeral
                              _dispatch<N>/ homes; roster entries are seat
                              defaults. Containers are created on demand
                              via -Mode Diff.
                              Branches:
                                  garelier/<target-slug>/<pm_id>/studio
                                  garelier/<target-slug>/<pm_id>/workbench/...
                                  garelier/<target-slug>/<pm_id>/anvil/...

        -Mode Diff:           modify an existing per-PM installation.
                              Run from inside __garelier/<pm_id>/_pm/
                              (the PM directory). Auto-detects pm_id from
                              cwd. Removals require IDLE unless PM already
                              completed retire-and-requeue and passes
                              -AllowRequeuedRemoval. Before adding,
                              integrates <target> into studio via merge.

        -Mode Migrate:        convert a v2.0 flat layout to v2.1 per-PM.
                              Run from inside __garelier/. Moves _pm/,
                              _dock/, control/ via git mv; worktrees
                              via git worktree move; runtime/ via plain mv;
                              renames studio + workbench branches to embed
                              <pm_id>; writes nested __garelier/.gitignore +
                              .ignore (root untouched, DEC-051); updates
                              setup_config.toml. Local-only.

    Vocabulary (canonical, v2.0+):
        target (formerly "base"), studio (formerly "develop"),
        workbench (formerly "feature"), control (persistent),
        runtime (formerly "workspace"), blueprint (formerly "spec"),
        inspection (formerly "research_report"), promote (formerly "release").

.PARAMETER Mode
    "Fresh" (default), "Diff", or "Migrate".

.PARAMETER ProjectName
    Project name (required for Fresh).

.PARAMETER PmId
    PM identifier (Fresh & Migrate). Format:
    _workshop or [a-z0-9]([a-z0-9_-]{0,18}[a-z0-9])?. Default:
    _workshop for a single-user project. Shared or multi-user projects
    should pass a unique -PmId explicitly. In Diff mode auto-detected from cwd.

.PARAMETER Target
    Target branch (Fresh only; default: current branch).
    In Diff mode read from setup_config.toml.

.PARAMETER Base
    Deprecated alias for -Target. Accepted for backward compatibility.

.PARAMETER Workers
    Worker definitions in "id:model,..." or "id:provider:model,..." format.

.PARAMETER Scouts
    Scout definitions in "id:model,..." or "id:provider:model,..." format.

.PARAMETER Smiths
    Smith definitions in "id:model,..." or "id:provider:model,..." format.
    In Diff mode, omit this parameter to keep existing Smiths unchanged.

.PARAMETER ScoutIdleTask
    Whether scouts produce autonomous status reports. Fresh only.

.PARAMETER SkipConfirm
    Skip interactive confirmation.

.PARAMETER InstallTools
    Best-effort install/setup of missing local tooling: Bun, gitleaks when
    Guardian gates are configured, driver dependencies, and the offline Mermaid
    bundle. Without this flag, interactive runs ask only when something is
    missing; -SkipConfirm never installs external tools implicitly.

.PARAMETER AllowRequeuedRemoval
    Diff only: allow removing non-IDLE agents after PM has moved their
    task rows back to runtime/backlog/pending.md with Outcome: requeued.
    This flag does not perform the requeue itself.

.PARAMETER Stack
    Fresh only. Tech stack driving the quality-gate default command set and
    the AGENTS.md language field: rust | typescript | python | go | mixed |
    custom. Default: rust. custom/mixed require -QualityGate.

.PARAMETER QualityGate
    Fresh only. Explicit quality-gate command(s); overrides the stack default
    set (pass multiple). Required when -Stack is custom or mixed.

.PARAMETER PermissionProfile
    Fresh only. Provider autonomy profile: safe | reviewed | dangerous.
    Default: reviewed. dangerous = full provider access (opt-in only).

.PARAMETER AgentsPolicy
    Fresh only. How AGENTS.md placeholders are handled: strict | minimal.
    Default: strict. strict leaves project-specific fields (restricted
    files, conventions) as {{...}} — doctor reports P0 and the driver
    won't start until you fill them. minimal fills safe initial values so
    doctor passes immediately (handy for quick trials; tighten later).

.PARAMETER Librarians
    Librarian set "<id:provider[:model],...>" (DEC-018). Fresh seeds the set;
    diff reconciles it (omit = keep existing, "" = remove all).

.PARAMETER Observers
    Observer set "<id:provider[:model],...>" (DEC-019). Fresh seeds the set;
    diff reconciles it (omit = keep existing, "" = remove all).

.PARAMETER Guardians
    Guardian set "<id:provider[:model],...>" (DEC-024). Fresh seeds the set;
    diff reconciles it (omit = keep existing, "" = remove all).

.PARAMETER Concierges
    Concierge set "<id:provider[:model],...>" (DEC-025). Fresh seeds the set;
    diff reconciles it (omit = keep existing, "" = remove all).

.PARAMETER Artisan
    Enable the artisan lane (DEC-017). Optional inline "<id:provider[:model]>".

.PARAMETER NoArtisan
    Diff only: disable the artisan lane. Omit both -Artisan and -NoArtisan to
    keep the current artisan state unchanged. (Artisan is a singleton — one only.)

.PARAMETER DefaultLane
    Fresh: lane the driver runs when runtime/lane.lock is absent — "dock"
    (default, parallel pipeline) or "artisan" (single-agent lane runs by
    default; small projects). An explicit lane.lock overrides per task (DEC-056).
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [ValidateSet('Fresh', 'Diff', 'Migrate')]
    [string]$Mode = 'Fresh',

    [Parameter(Mandatory = $false)]
    [string]$ProjectName,

    [Parameter(Mandatory = $false)]
    [string]$PmId,

    [Parameter(Mandatory = $false)]
    [string]$Target,

    [Parameter(Mandatory = $false)]
    [string]$Base,

    [Parameter(Mandatory = $false)]
    [string]$Workers,

    [Parameter(Mandatory = $false)]
    [string]$Scouts,

    [Parameter(Mandatory = $false)]
    [string]$Smiths,

    [Parameter(Mandatory = $false)]
    [bool]$ScoutIdleTask = $false,

    [Parameter(Mandatory = $false)]
    [switch]$SkipConfirm,

    [Parameter(Mandatory = $false)]
    [switch]$InstallTools,

    [Parameter(Mandatory = $false)]
    [switch]$AllowRequeuedRemoval,

    [Parameter(Mandatory = $false)]
    [ValidateSet('rust', 'typescript', 'python', 'go', 'mixed', 'custom')]
    [string]$Stack = 'rust',

    [Parameter(Mandatory = $false)]
    [string[]]$QualityGate = @(),

    [Parameter(Mandatory = $false)]
    [ValidateSet('safe', 'reviewed', 'dangerous')]
    [string]$PermissionProfile = 'reviewed',

    [Parameter(Mandatory = $false)]
    [ValidateSet('strict', 'minimal')]
    [string]$AgentsPolicy = 'strict',

    [Parameter(Mandatory = $false)]
    [string]$Librarians,

    [Parameter(Mandatory = $false)]
    [string]$Observers,

    [Parameter(Mandatory = $false)]
    [string]$Guardians,

    [Parameter(Mandatory = $false)]
    [string]$Concierges,

    [Parameter(Mandatory = $false)]
    [string]$Artisan,

    [Parameter(Mandatory = $false)]
    [switch]$NoArtisan,

    [Parameter(Mandatory = $false)]
    [ValidateSet('dock', 'artisan')]
    [string]$DefaultLane = 'dock',   # [lanes] default (DEC-056)

    [Parameter(Mandatory = $false)]
    [switch]$Exile   # DEC-036: opt into out-of-project role homes (default in-project)
)

$ErrorActionPreference = 'Stop'
$WizardScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# Resolve the skills dir holding garelier-* (DEC-053: cache-safe + dual-mode).
# Order:
#   1. ${CLAUDE_PLUGIN_ROOT}/skills (plugin runtime)
#   2. script-relative self-location (this wizard lives in garelier-pm\scripts\,
#      so parent\..\.. = the skills dir); verified by garelier-core\SKILL.md
#      presence — works in the read-only plugin cache too
#   3. legacy $env:USERPROFILE\.claude\skills (dev symlink last resort)
$GarelierSelfSkillsDir = Split-Path -Parent (Split-Path -Parent $WizardScriptDir)
$GarelierSkillsDir = if ($env:CLAUDE_PLUGIN_ROOT -and (Test-Path (Join-Path $env:CLAUDE_PLUGIN_ROOT 'skills\garelier-core\SKILL.md'))) {
    Join-Path $env:CLAUDE_PLUGIN_ROOT 'skills'
} elseif (Test-Path (Join-Path $GarelierSelfSkillsDir 'garelier-core\SKILL.md')) {
    $GarelierSelfSkillsDir
} else {
    Join-Path $env:USERPROFILE '.claude\skills'
}
$GarelierDriverDir = Join-Path $GarelierSkillsDir 'garelier-core\driver'
$smithsProvided = $PSBoundParameters.ContainsKey('Smiths')
$librariansProvided = $PSBoundParameters.ContainsKey('Librarians')
$observersProvided = $PSBoundParameters.ContainsKey('Observers')
$guardiansProvided = $PSBoundParameters.ContainsKey('Guardians')
$conciergesProvided = $PSBoundParameters.ContainsKey('Concierges')
$artisanProvided = $PSBoundParameters.ContainsKey('Artisan')
# --artisan / --no-artisan toggle the artisan lane in diff mode; omitting both keeps it.
$artisanSet = $artisanProvided -or $NoArtisan
$artisanDesiredEnable = (-not $NoArtisan)

# Accept deprecated -Base alias.
if ([string]::IsNullOrWhiteSpace($Target) -and -not [string]::IsNullOrWhiteSpace($Base)) {
    $Target = $Base
}

if ($Mode -eq 'Fresh') {
    if ([string]::IsNullOrWhiteSpace($ProjectName)) {
        Write-Error '-ProjectName is required for Fresh mode.'
        exit 1
    }
    # Workers/Scouts (and every other role) are no longer required: fresh
    # defaults to exactly one of each (DEC-055). Scale up later via the PM.
}
if ($Mode -eq 'Diff') {
    if ([string]::IsNullOrWhiteSpace($Workers) -or [string]::IsNullOrWhiteSpace($Scouts)) {
        Write-Error '-Workers and -Scouts are required for Diff mode (the desired final set).'
        exit 1
    }
}
if ($Mode -ne 'Fresh' -and $PSBoundParameters.ContainsKey('DefaultLane')) {
    Write-Error "-DefaultLane only applies to -Mode Fresh. In diff/migrate, edit '[lanes] default' in setup_config.toml directly (DEC-056)."
    exit 1
}

# === Fresh-mode defaults: EXACTLY ONE of every role (DEC-055) ===
#
# A FRESH setup creates exactly one of every role using the default provider/
# model (claude-code:claude-code), with NO composition prompts and NO zero
# option — every role is minimum one. An empty OR omitted value is coerced to a
# single default instance (0 is impossible in fresh). Scale up later (more
# instances, other providers such as codex-cli) via the PM, which runs
# -Mode Diff. The Artisan lane is always enabled in fresh too (see below).
#
# This block is Fresh-only. Diff mode keeps its "omit = keep existing" /
# explicit-desired-set semantics untouched: it never consults these defaults
# and still honors explicit empties (the *Provided flags are for diff).
$artisanDefaultEnabled = $false
if ($Mode -eq 'Fresh') {
    if ([string]::IsNullOrWhiteSpace($Workers))    { $Workers = 'worker-01:claude-code:claude-code' }
    if ([string]::IsNullOrWhiteSpace($Scouts))     { $Scouts = 'scout-01:claude-code:claude-code' }
    if ([string]::IsNullOrWhiteSpace($Smiths))     { $Smiths = 'smith-01:claude-code:claude-code' }
    if ([string]::IsNullOrWhiteSpace($Librarians)) { $Librarians = 'librarian-01:claude-code:claude-code' }
    if ([string]::IsNullOrWhiteSpace($Observers))  { $Observers = 'observer-01:claude-code:claude-code' }
    if ([string]::IsNullOrWhiteSpace($Guardians))  { $Guardians = 'guardian-01:claude-code:claude-code' }
    if ([string]::IsNullOrWhiteSpace($Concierges)) { $Concierges = 'concierge-01:claude-code:claude-code' }
    # Artisan lane: ALWAYS enabled in a fresh full setup — like every other role
    # it is minimum one (DEC-055; full Garelier uses the Artisan lane). -NoArtisan
    # is ignored in fresh; disable the lane later via -Mode Diff if ever needed.
    $artisanDefaultEnabled = $true
}

# === Determine project root and pm_id from cwd ===

$cwd = (Get-Location).Path
$cwdBasename = Split-Path -Leaf $cwd
$cwdParent = Split-Path -Parent $cwd
$cwdParentBasename = Split-Path -Leaf $cwdParent

switch ($Mode) {
    'Fresh' {
        if ($cwdBasename -ne '__garelier') {
            Write-Error "-Mode Fresh must run from the project's __garelier/ directory. Current: $cwd"
            exit 1
        }
        $projectRoot = $cwdParent
    }
    'Migrate' {
        if ($cwdBasename -ne '__garelier') {
            Write-Error "-Mode Migrate must run from the project's __garelier/ directory. Current: $cwd"
            exit 1
        }
        $projectRoot = $cwdParent
    }
    'Diff' {
        if ($cwdBasename -ne '_pm') {
            Write-Error "-Mode Diff must run from __garelier/<pm_id>/_pm/. Current: $cwd"
            exit 1
        }
        $grandparent = Split-Path -Parent $cwdParent
        $grandparentBasename = Split-Path -Leaf $grandparent
        if ($grandparentBasename -ne '__garelier') {
            Write-Error "-Mode Diff must run from __garelier/<pm_id>/_pm/ (got: $cwd)."
            exit 1
        }
        $pmIdFromCwd = $cwdParentBasename
        if ([string]::IsNullOrWhiteSpace($PmId)) {
            $PmId = $pmIdFromCwd
        } elseif ($PmId -ne $pmIdFromCwd) {
            Write-Error "-PmId ($PmId) does not match cwd PM ($pmIdFromCwd)."
            exit 1
        }
        $projectRoot = Split-Path -Parent $grandparent
    }
}

Set-Location -Path $projectRoot

$now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

# === Helpers ===

function Test-CommandAvailable {
    param([string]$Name)
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Update-GarelierToolPath {
    $candidates = @()
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        $candidates += (Join-Path $env:USERPROFILE '.bun\bin')
        $candidates += (Join-Path $env:USERPROFILE 'go\bin')
    }
    if (-not [string]::IsNullOrWhiteSpace($HOME)) {
        $candidates += (Join-Path $HOME '.bun/bin')
        $candidates += (Join-Path $HOME 'go/bin')
    }
    $pathParts = @($env:PATH -split [System.IO.Path]::PathSeparator)
    foreach ($candidate in $candidates) {
        if ((Test-Path $candidate) -and ($pathParts -notcontains $candidate)) {
            $env:PATH = "$candidate$([System.IO.Path]::PathSeparator)$env:PATH"
            $pathParts = @($env:PATH -split [System.IO.Path]::PathSeparator)
        }
    }
}

function Get-TomlScalarValueEarly {
    param(
        [string]$Path,
        [string]$Section,
        [string]$Key
    )
    if (-not (Test-Path $Path -PathType Leaf)) { return $null }
    $inSection = $false
    foreach ($line in (Get-Content -LiteralPath $Path)) {
        if ($line -match '^\s*\[(.+)\]\s*$') {
            $inSection = ($Matches[1] -eq $Section)
            continue
        }
        if ($inSection -and $line -match "^\s*$([regex]::Escape($Key))\s*=\s*(.*?)\s*(#.*)?$") {
            return ($Matches[1].Trim().Trim('"', "'"))
        }
    }
    return $null
}

function Get-GuardianSetupConfigPathEarly {
    switch ($Mode) {
        'Diff' {
            $toml = "__garelier/$script:PmId/_pm/setup_config.toml"
            if ((-not [string]::IsNullOrWhiteSpace($script:PmId)) -and (Test-Path $toml -PathType Leaf)) {
                return $toml
            }
        }
        'Migrate' {
            $pmToml = "__garelier/$script:PmId/_pm/setup_config.toml"
            if ((-not [string]::IsNullOrWhiteSpace($script:PmId)) -and (Test-Path $pmToml -PathType Leaf)) {
                return $pmToml
            }
            if (Test-Path '__garelier/_pm/setup_config.toml' -PathType Leaf) {
                return '__garelier/_pm/setup_config.toml'
            }
        }
    }
    return $null
}

function Test-GuardianSecretScanRequiresGitleaks {
    $configPath = Get-GuardianSetupConfigPathEarly
    if ([string]::IsNullOrWhiteSpace($configPath)) {
        # Fresh setups have not written setup_config.toml yet; the default
        # Guardian secret scanner is gitleaks.
        return $true
    }
    $scan = Get-TomlScalarValueEarly -Path $configPath -Section 'guardian_tools' -Key 'secret_scan'
    $scan = if ($null -eq $scan) { '' } else { $scan.Trim().ToLowerInvariant() }
    if ($scan -eq '' -or $scan -eq 'off' -or $scan -eq 'none' -or $scan -eq 'disabled') {
        return $false
    }
    return $scan.Contains('gitleaks')
}

function Test-GuardianToolsNeeded {
    switch ($Mode) {
        'Fresh' {
            return ((-not [string]::IsNullOrWhiteSpace($Guardians)) -and (Test-GuardianSecretScanRequiresGitleaks))
        }
        'Diff' {
            if ($guardiansProvided) {
                return ((-not [string]::IsNullOrWhiteSpace($Guardians)) -and (Test-GuardianSecretScanRequiresGitleaks))
            }
            $toml = "__garelier/$script:PmId/_pm/setup_config.toml"
            return ((Test-Path $toml) -and (Select-String -Path $toml -Pattern '^\[\[guardians\]\]' -Quiet) -and (Test-GuardianSecretScanRequiresGitleaks))
        }
        'Migrate' {
            $pmToml = "__garelier/$script:PmId/_pm/setup_config.toml"
            $flatToml = '__garelier/_pm/setup_config.toml'
            if ((-not [string]::IsNullOrWhiteSpace($script:PmId)) -and (Test-Path $pmToml)) {
                return ((Select-String -Path $pmToml -Pattern '^\[\[guardians\]\]' -Quiet) -and (Test-GuardianSecretScanRequiresGitleaks))
            }
            if (Test-Path $flatToml) {
                return ((Select-String -Path $flatToml -Pattern '^\[\[guardians\]\]' -Quiet) -and (Test-GuardianSecretScanRequiresGitleaks))
            }
            return $false
        }
        default {
            return $false
        }
    }
}

function Get-GarelierMissingTools {
    Update-GarelierToolPath
    $missing = New-Object System.Collections.Generic.List[string]
    if (-not (Test-CommandAvailable 'bun')) {
        $missing.Add('Bun')
    }
    else {
        if ((Test-Path $GarelierDriverDir) -and -not (Test-Path (Join-Path $GarelierDriverDir 'node_modules'))) {
            $missing.Add('driver dependencies')
        }
        if ((Test-Path $GarelierDriverDir) -and -not (Test-Path (Join-Path $GarelierDriverDir 'static\vendor\mermaid.min.js'))) {
            $missing.Add('offline Mermaid bundle')
        }
    }
    if ((Test-GuardianToolsNeeded) -and -not (Test-CommandAvailable 'gitleaks')) {
        $missing.Add('gitleaks')
    }
    return $missing.ToArray()
}

function Write-GarelierMissingTools {
    param([string[]]$Missing)
    foreach ($item in $Missing) {
        if (-not [string]::IsNullOrWhiteSpace($item)) {
            Write-Host "  - $item"
        }
    }
}

function Install-BunBestEffort {
    Update-GarelierToolPath
    if (Test-CommandAvailable 'bun') { return $true }

    Write-Host '==> Installing Bun (best effort)...'
    if ($env:OS -eq 'Windows_NT') {
        $ps = Get-Command 'powershell.exe' -ErrorAction SilentlyContinue
        if (-not $ps) { $ps = Get-Command 'powershell' -ErrorAction SilentlyContinue }
        if ($ps) {
            & $ps.Source -NoProfile -ExecutionPolicy Bypass -Command 'irm bun.sh/install.ps1 | iex'
            Update-GarelierToolPath
        }
    }
    if (-not (Test-CommandAvailable 'bun') -and (Test-CommandAvailable 'brew')) {
        & brew install bun
        Update-GarelierToolPath
    }
    if (-not (Test-CommandAvailable 'bun') -and (Test-CommandAvailable 'curl') -and (Test-CommandAvailable 'bash')) {
        & bash -lc 'curl -fsSL https://bun.com/install | bash'
        Update-GarelierToolPath
    }

    return (Test-CommandAvailable 'bun')
}

function Install-GitleaksBestEffort {
    if (Test-CommandAvailable 'gitleaks') { return $true }

    Write-Host '==> Installing gitleaks (best effort)...'
    if (Test-CommandAvailable 'winget') {
        & winget install --exact --id Gitleaks.Gitleaks --accept-source-agreements --accept-package-agreements
        Update-GarelierToolPath
    }
    if (-not (Test-CommandAvailable 'gitleaks') -and (Test-CommandAvailable 'choco')) {
        & choco install gitleaks -y
        Update-GarelierToolPath
    }
    if (-not (Test-CommandAvailable 'gitleaks') -and (Test-CommandAvailable 'brew')) {
        & brew install gitleaks
        Update-GarelierToolPath
    }
    if (-not (Test-CommandAvailable 'gitleaks') -and (Test-CommandAvailable 'go')) {
        & go install github.com/gitleaks/gitleaks/v8@latest
        Update-GarelierToolPath
    }

    return (Test-CommandAvailable 'gitleaks')
}

function Install-GarelierDriverAssets {
    if (-not (Test-Path $GarelierDriverDir)) {
        Write-Warning "driver directory not found: $GarelierDriverDir"
        return
    }
    if (-not (Test-CommandAvailable 'bun')) {
        Write-Warning "Bun is not available; skipping driver dependencies and Mermaid bundle."
        return
    }

    Write-Host '==> Setting up Garelier driver dependencies...'
    Push-Location $GarelierDriverDir
    try {
        & bun install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "bun install failed; run it manually in $GarelierDriverDir"
        }

        Write-Host '==> Vendoring offline Mermaid bundle for Status Web...'
        & bun run vendor:mermaid
        if ($LASTEXITCODE -ne 0) {
            Write-Warning 'Mermaid vendoring failed; Status Web will show diagram source until this succeeds.'
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-GarelierToolSetup {
    if (-not (Test-CommandAvailable 'bun')) {
        if (-not (Install-BunBestEffort)) {
            Write-Warning "Bun installation did not make 'bun' available on PATH. Install Bun manually, then rerun setup_wizard or run 'bun install --frozen-lockfile' in $GarelierDriverDir."
        }
    }

    Update-GarelierToolPath
    Install-GarelierDriverAssets

    if ((Test-GuardianToolsNeeded) -and -not (Test-CommandAvailable 'gitleaks')) {
        if (-not (Install-GitleaksBestEffort)) {
            Write-Warning 'gitleaks is still unavailable; Guardian secret_scan gates will fail until it is installed or [guardian_tools].secret_scan is set to "off" with block_when_required_scanner_unavailable = false.'
        }
    }
}

function Invoke-GarelierToolSetupIfNeeded {
    $missing = @(Get-GarelierMissingTools)
    if ($missing.Count -eq 0) { return }

    if ($InstallTools) {
        Write-Host 'Garelier tool setup requested. Missing:'
        Write-GarelierMissingTools -Missing $missing
        Invoke-GarelierToolSetup
        return
    }

    $inputRedirected = $true
    try { $inputRedirected = [Console]::IsInputRedirected } catch { $inputRedirected = $true }
    if ($SkipConfirm) {
        Write-Host 'Garelier tool setup skipped. Missing:'
        Write-GarelierMissingTools -Missing $missing
        Write-Host 'Rerun setup_wizard with -InstallTools, or install them manually.'
        return
    }

    if (-not [Environment]::UserInteractive -or $inputRedirected) {
        Write-Host 'Garelier tool setup needs user approval before project changes. Missing:'
        Write-GarelierMissingTools -Missing $missing
        Write-Host 'Ask the user whether to install/setup these tools, then rerun with -InstallTools.'
        Write-Host 'Use -SkipConfirm only when you intentionally want to continue without tool setup.'
        exit 3
    }

    Write-Host 'Garelier can set up missing local tooling:'
    Write-GarelierMissingTools -Missing $missing
    $answer = Read-Host 'Install/setup these now? [y/N]'
    if ($answer -match '^[yY]') {
        Invoke-GarelierToolSetup
    }
    else {
        Write-Host 'Tool setup skipped. Rerun with -InstallTools if you want the wizard to do this later.'
    }
}

Invoke-GarelierToolSetupIfNeeded

function Write-Utf8File {
    param([string]$RelativePath, [string]$Content)
    # DEC-035: exile homes resolve to an ABSOLUTE container path; pass it through
    # unchanged (Join-Path would otherwise prepend cwd, e.g. C:\proj\C:\home\...).
    $absPath = if ([System.IO.Path]::IsPathRooted($RelativePath)) { $RelativePath } else { Join-Path (Get-Location).Path $RelativePath }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($absPath, $Content, $utf8NoBom)
}

function Add-Utf8File {
    param([string]$RelativePath, [string]$Content)
    $absPath = if ([System.IO.Path]::IsPathRooted($RelativePath)) { $RelativePath } else { Join-Path (Get-Location).Path $RelativePath }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::AppendAllText($absPath, $Content, $utf8NoBom)
}

# DEC-051: Garelier keeps its ignore rules INSIDE __garelier/ (nested .gitignore
# / .ignore) and NEVER appends to the project's root files. git and ripgrep/fd
# honor nested ignore files, so the rules still apply to every <pm_id> under
# __garelier/ while the project root stays pristine, churn-free, and removable.
function Remove-GarelierLegacyRootBlock {
    param([string]$File, [string]$Marker)
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return }
    $lines = @(Get-Content -LiteralPath $File)
    if (-not ($lines | Where-Object { $_ -like "*$Marker*" })) { return }

    # Remove only the contiguous Garelier block (it may sit mid-file, with the
    # user's own rules after it), NOT marker-to-EOF. Mirrors the bash awk: drop
    # Garelier pattern lines and the comments/blanks buffered right before them;
    # when a non-blank non-comment NON-Garelier line appears, the block ended —
    # flush the buffer back (it is the next section's header) and resume copying.
    # Trailing buffered lines at EOF are block trailers and are dropped.
    $isPat = {
        param($l)
        ($l -match '^!?__garelier/') -or
        ($l -match '^!?\*/(runtime|_workers|_scouts|_smiths|_librarians|_observers|_artisan|_guardians|_concierges|_dock)/?$') -or
        ($l -match '^\*/_pm/CLAUDE\.md$') -or
        ($l -match '^!\*/control/') -or
        ($l -match '^/(STATE|assignment|review|questions|answers|report|under_review|merged|abort|track-target)\.md$') -or
        ($l -match '^/archive/$') -or
        ($l -match '^\*\.bak(\..*)?$') -or
        ($l -match '^/?target/$')
    }
    $isCb = { param($l) ($l -match '^#') -or ($l -match '^\s*$') }

    $kept = New-Object System.Collections.Generic.List[string]
    $buf  = New-Object System.Collections.Generic.List[string]
    $removing = $false
    foreach ($line in $lines) {
        if (-not $removing) {
            if ($line -like "*$Marker*") { $removing = $true }
            else { $kept.Add($line) }
        } elseif (& $isPat $line) {
            $buf.Clear()
        } elseif (& $isCb $line) {
            $buf.Add($line)
        } else {
            $removing = $false
            foreach ($b in $buf) { $kept.Add($b) }
            $buf.Clear()
            $kept.Add($line)
        }
    }
    while ($kept.Count -gt 0 -and [string]::IsNullOrWhiteSpace($kept[$kept.Count - 1])) {
        $kept.RemoveAt($kept.Count - 1)
    }
    if ($kept.Count -eq 0) {
        Remove-Item -LiteralPath $File -Force
        Write-Host "  - removed now-empty root $File (Garelier no longer touches it)"
    } else {
        Write-Utf8File -RelativePath $File -Content (($kept -join "`n") + "`n")
        Write-Host "  - migrated: removed legacy Garelier block from root $File"
    }
}

# Write nested __garelier/.gitignore + .ignore from templates, then migrate away
# any legacy root block. Idempotent; both files are wholly Garelier-owned, so a
# rewrite never clobbers shared content. (Copy-Item is byte-safe — no UTF-8
# round-trip corruption, unlike Get-Content -Raw + Set-Content.)
function Write-GarelierNestedIgnores {
    $tdir = if ($env:GARELIER_CORE_TEMPLATES_DIR) {
        $env:GARELIER_CORE_TEMPLATES_DIR
    } else {
        Join-Path $GarelierSkillsDir 'garelier-core\templates'
    }
    $giTmpl = Join-Path $tdir 'runtime_gitignore'
    $igTmpl = Join-Path $tdir 'search_ignore'
    if (-not (Test-Path -LiteralPath '__garelier' -PathType Container)) {
        New-Item -ItemType Directory -Path '__garelier' -Force | Out-Null
    }
    if (Test-Path -LiteralPath $giTmpl -PathType Leaf) {
        Copy-Item -LiteralPath $giTmpl -Destination (Join-Path '__garelier' '.gitignore') -Force
        Write-Host '  + __garelier/.gitignore written (nested; project root untouched)'
    } else {
        Write-Warning "runtime_gitignore template not found at $giTmpl"
    }
    if (Test-Path -LiteralPath $igTmpl -PathType Leaf) {
        Copy-Item -LiteralPath $igTmpl -Destination (Join-Path '__garelier' '.ignore') -Force
        Write-Host '  + __garelier/.ignore written (nested; project root untouched)'
    } else {
        Write-Warning "search_ignore template not found at $igTmpl"
    }
    Remove-GarelierLegacyRootBlock -File '.gitignore' -Marker 'Garelier runtime'
    Remove-GarelierLegacyRootBlock -File '.ignore' -Marker 'Garelier search-ignore'
}

function ConvertTo-TargetSlug {
    param([string]$Branch)
    return ($Branch -replace '/', '-')
}

function Test-PmIdValid {
    param([string]$Id)
    if ([string]::IsNullOrWhiteSpace($Id)) { return $false }
    if ($Id -eq '_workshop') { return $true }
    if ($Id.Length -lt 1 -or $Id.Length -gt 20) { return $false }
    return ($Id -match '^[a-z0-9]([a-z0-9_-]{0,18}[a-z0-9])?$')
}

function Get-DefaultPmId {
    return '_workshop'
}

function Resolve-PmIdInteractive {
    if (-not [string]::IsNullOrWhiteSpace($script:PmId)) {
        if (-not (Test-PmIdValid -Id $script:PmId)) {
            Write-Error "pm_id '$($script:PmId)' must be '_workshop' or match [a-z0-9]([a-z0-9_-]{0,18}[a-z0-9])?."
            exit 1
        }
        return
    }
    $default = Get-DefaultPmId
    # Non-TTY guard: when invoked from an AI agent / driver / CI etc.,
    # refuse to silently apply the single-user default. pm_id becomes part of
    # tracked paths and branch names; the operator must choose it
    # explicitly via -PmId. See setup_wizard.sh for the rationale.
    if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) {
        Write-Error @"
-PmId was not provided and the script is not running in an interactive terminal.
setup_wizard requires an explicit pm_id in non-interactive contexts
(AI agent, driver, CI). Re-run with -PmId _workshop for a single-user
project, or a unique -PmId <slug> for a shared/multi-user project.
"@
        exit 2
    }
    if ($script:SkipConfirm) {
        if ([string]::IsNullOrWhiteSpace($default)) {
            Write-Error 'No default pm_id is available; pass -PmId explicitly.'
            exit 1
        }
        if (-not (Test-PmIdValid -Id $default)) {
            Write-Error "Default pm_id '$default' is not valid; pass -PmId explicitly."
            exit 1
        }
        $script:PmId = $default
        return
    }
    while ($true) {
        if (-not [string]::IsNullOrWhiteSpace($default)) {
            $entered = Read-Host "PM identifier (default: $default)"
        } else {
            $entered = Read-Host 'PM identifier'
        }
        if ([string]::IsNullOrWhiteSpace($entered)) { $entered = $default }
        if (Test-PmIdValid -Id $entered) {
            $script:PmId = $entered
            return
        }
        Write-Host "pm_id '$entered' must be '_workshop' or match [a-z0-9]([a-z0-9_-]{0,18}[a-z0-9])? (1-20 chars)."
    }
}

function Parse-Entries {
    param([string]$RawInput)
    $arr = @()
    foreach ($e in ($RawInput -split ',')) {
        $e = $e.Trim()
        if ($e) { $arr += (Normalize-AgentEntry -Entry $e) }
    }
    return $arr
}

function Normalize-AgentEntry {
    param([string]$Entry)
    $parts = $Entry.Split(':')
    if ($parts.Count -eq 2) {
        $id = $parts[0]
        # Two-field form is id:model with provider defaulting to claude-code.
        # worker-01:claude-code is the normal Claude form (provider defaults to
        # claude-code, model placeholder is harmless). But worker-01:codex /
        # worker-01:codex-cli contradicts the default provider — the user meant
        # a Codex agent and would silently get a claude-code one. Reject it.
        if ($parts[1].ToLowerInvariant() -in @('codex','codex-cli','gemini','gemini-cli','google-gemini','copilot','github-copilot','copilot-cli','cursor','cursor-cli','cursor-agent')) {
            Write-Error "Ambiguous agent entry '$Entry'. '$($parts[1])' is a provider, not a model; id:$($parts[1]) would silently run under provider=claude-code. Use id:provider:model, e.g. $($parts[0]):gemini-cli:gemini-default."
            exit 1
        }
        $provider = 'claude-code'
        $model = $parts[1]
    } elseif ($parts.Count -eq 3) {
        $id = $parts[0]
        $provider = $parts[1].ToLowerInvariant()
        $model = $parts[2]
    } else {
        Write-Error "Agent entry must be id:model or id:provider:model (got: $Entry)."
        exit 1
    }
    if ([string]::IsNullOrWhiteSpace($id) -or [string]::IsNullOrWhiteSpace($model)) {
        Write-Error "Agent entry must include id and model (got: $Entry)."
        exit 1
    }
    switch ($provider) {
        'claude' { $provider = 'claude-code' }
        'claude-code' { $provider = 'claude-code' }
        'codex' { $provider = 'codex-cli' }
        'codex-cli' { $provider = 'codex-cli' }
        'gemini' { $provider = 'gemini-cli' }
        'gemini-cli' { $provider = 'gemini-cli' }
        'google-gemini' { $provider = 'gemini-cli' }
        'copilot' { $provider = 'copilot-cli' }
        'github-copilot' { $provider = 'copilot-cli' }
        'copilot-cli' { $provider = 'copilot-cli' }
        'cursor' { $provider = 'cursor-cli' }
        'cursor-cli' { $provider = 'cursor-cli' }
        'cursor-agent' { $provider = 'cursor-cli' }
        default {
            Write-Error "Unsupported provider '$provider' in agent entry '$Entry'. Expected claude-code, codex-cli, gemini-cli, copilot-cli, or cursor-cli."
            exit 1
        }
    }
    return "${id}:${provider}:${model}"
}

function Get-EntryId {
    param([string]$Entry)
    return $Entry.Split(':')[0]
}

function Get-EntryProvider {
    param([string]$Entry)
    return $Entry.Split(':')[1]
}

function Get-EntryModel {
    param([string]$Entry)
    return $Entry.Split(':')[2]
}

function Read-ExistingBlockIds {
    param([string]$Section)  # "workers", "scouts", or "smiths"
    $toml = "__garelier/$script:PmId/_pm/setup_config.toml"
    if (-not (Test-Path $toml)) { return @() }

    $result = @()
    $inSection = $false
    $curId = ''
    $curProvider = ''
    $curModel = ''
    $headerPattern = "^\[\[$Section\]\]$"

    foreach ($line in (Get-Content -LiteralPath $toml)) {
        if ($line -match $headerPattern) {
            if ($inSection -and $curId) {
                if ([string]::IsNullOrWhiteSpace($curProvider)) { $curProvider = 'claude-code' }
                $result += "${curId}:${curProvider}:${curModel}"
            }
            $inSection = $true
            $curId = ''; $curProvider = ''; $curModel = ''
            continue
        }
        if ($line -match '^\[') {
            if ($inSection -and $curId) {
                if ([string]::IsNullOrWhiteSpace($curProvider)) { $curProvider = 'claude-code' }
                $result += "${curId}:${curProvider}:${curModel}"
            }
            $inSection = $false
            $curId = ''; $curProvider = ''; $curModel = ''
            continue
        }
        if ($inSection) {
            if ($line -match '^id\s*=\s*"([^"]+)"') {
                $curId = $matches[1]
            } elseif ($line -match '^provider\s*=\s*"([^"]+)"') {
                $curProvider = $matches[1]
            } elseif ($line -match '^model\s*=\s*"([^"]+)"') {
                $curModel = $matches[1]
            }
        }
    }
    if ($inSection -and $curId) {
        if ([string]::IsNullOrWhiteSpace($curProvider)) { $curProvider = 'claude-code' }
        $result += "${curId}:${curProvider}:${curModel}"
    }
    return $result
}

function Get-ExistingAgentEffort {
    param([string]$Section, [string]$Id)
    $toml = "__garelier/$script:PmId/_pm/setup_config.toml"
    if (-not (Test-Path $toml)) { return $null }

    $inSection = $false
    $curId = ''
    $curEffort = ''
    $headerPattern = "^\[\[$Section\]\]$"

    function Flush-AgentEffort {
        param([bool]$InSection, [string]$CurrentId, [string]$CurrentEffort, [string]$WantedId)
        if ($InSection -and $CurrentId -eq $WantedId -and -not [string]::IsNullOrWhiteSpace($CurrentEffort)) {
            return $CurrentEffort
        }
        return $null
    }

    foreach ($line in (Get-Content -LiteralPath $toml)) {
        if ($line -match $headerPattern) {
            $found = Flush-AgentEffort -InSection $inSection -CurrentId $curId -CurrentEffort $curEffort -WantedId $Id
            if ($found) { return $found }
            $inSection = $true
            $curId = ''; $curEffort = ''
            continue
        }
        if ($line -match '^\[') {
            $found = Flush-AgentEffort -InSection $inSection -CurrentId $curId -CurrentEffort $curEffort -WantedId $Id
            if ($found) { return $found }
            $inSection = $false
            $curId = ''; $curEffort = ''
            continue
        }
        if ($inSection) {
            if ($line -match '^id\s*=\s*"([^"]+)"') {
                $curId = $matches[1]
            } elseif ($line -match '^effort\s*=\s*"([^"]+)"') {
                $curEffort = $matches[1]
            }
        }
    }
    return (Flush-AgentEffort -InSection $inSection -CurrentId $curId -CurrentEffort $curEffort -WantedId $Id)
}

function Add-EffortLine {
    param([System.Text.StringBuilder]$Builder, [string]$Section, [string]$Id)
    $effort = Get-ExistingAgentEffort -Section $Section -Id $Id
    if ([string]::IsNullOrWhiteSpace($effort)) {
        [void]$Builder.AppendLine('# effort = "xhigh"')
    } else {
        [void]$Builder.AppendLine("effort = `"$effort`"")
    }
}

function Read-TomlValueFrom {
    param([string]$TomlPath, [string]$Section, [string]$Key)
    if (-not (Test-Path $TomlPath)) { return $null }
    $inSection = $false
    foreach ($line in (Get-Content -LiteralPath $TomlPath)) {
        if ($line -match "^\[$([regex]::Escape($Section))\]") { $inSection = $true; continue }
        if ($line -match '^\[') { $inSection = $false; continue }
        if ($inSection -and $line -match "^$([regex]::Escape($Key))\s*=\s*`"([^`"]+)`"") {
            return $matches[1]
        }
    }
    return $null
}

function Read-TomlValue {
    param([string]$Section, [string]$Key)
    return (Read-TomlValueFrom -TomlPath "__garelier/$script:PmId/_pm/setup_config.toml" -Section $Section -Key $Key)
}

# Read a bare (unquoted) scalar — e.g., a boolean — from [section]. The quoted
# reader above only matches "double-quoted" values, so booleans need this.
function Read-TomlBare {
    param([string]$Section, [string]$Key)
    $toml = "__garelier/$script:PmId/_pm/setup_config.toml"
    if (-not (Test-Path $toml)) { return $null }
    $inSection = $false
    foreach ($line in (Get-Content -LiteralPath $toml)) {
        if ($line -match "^\[$([regex]::Escape($Section))\]") { $inSection = $true; continue }
        if ($line -match '^\[') { $inSection = $false; continue }
        if ($inSection -and $line -match "^$([regex]::Escape($Key))\s*=\s*(.+?)\s*(#.*)?$") {
            return $matches[1].Trim()
        }
    }
    return $null
}

function Get-SetupState {
    # State for the current $script:PmId.
    $pmRoot = "__garelier/$script:PmId"
    $toml = "$pmRoot/_pm/setup_config.toml"
    if (Test-Path -Path $toml -PathType Leaf) {
        $content = Get-Content -LiteralPath $toml -Raw
        $hasMarker = $false
        $inSetup = $false
        foreach ($line in ($content -split "`r?`n")) {
            if ($line -match '^\[setup\]$') { $inSetup = $true; continue }
            if ($line -match '^\[') { $inSetup = $false; continue }
            if ($inSetup -and $line -match '^complete\s*=\s*true') {
                $hasMarker = $true
                break
            }
        }
        if ($hasMarker) { return 'complete' }

        if (($content -match '(?m)^\[branches\]') `
            -and (Test-Path "$pmRoot/runtime/manifest.md" -PathType Leaf) `
            -and (Test-Path "$pmRoot/_pm/history.md" -PathType Leaf)) {
            return 'complete'
        }
        return 'partial'
    }
    $controlMarker = "$pmRoot/control/control.toml"
    if (Test-Path -Path $controlMarker -PathType Leaf) {
        $controlBody = Get-Content -LiteralPath $controlMarker -Raw
        if (($controlBody -match '(?m)^kind\s*=\s*"garelier_control"\s*$') `
            -and ($controlBody -match '(?m)^mode\s*=\s*"control_only"\s*$')) {
            return 'starter'
        }
    }
    $scaffolds = @(
        "$pmRoot/runtime", "$pmRoot/control", "$pmRoot/_pm",
        "$pmRoot/_dock", "$pmRoot/_workers", "$pmRoot/_scouts",
        "$pmRoot/_smiths"
    )
    foreach ($d in $scaffolds) {
        if (Test-Path -Path $d -PathType Container) { return 'partial' }
    }
    return 'absent'
}

function Resolve-CleanupTarget {
    $candidate = ''
    if ($script:Target -and $script:Target -notlike 'garelier/*') {
        $candidate = $script:Target
    }
    if (-not $candidate -and (Test-Path "__garelier/$script:PmId/_pm/setup_config.toml" -PathType Leaf)) {
        $candidate = Read-TomlValue -Section 'branches' -Key 'target'
        if ($candidate -like 'garelier/*') { $candidate = '' }
    }
    if (-not $candidate) {
        $cur = git symbolic-ref --short HEAD 2>$null
        if ($LASTEXITCODE -eq 0 -and $cur -and $cur -notlike 'garelier/*') {
            $candidate = $cur.Trim()
        }
    }
    if (-not $candidate) {
        foreach ($cand in @('main', 'develop')) {
            $null = git rev-parse --verify $cand 2>$null
            if ($LASTEXITCODE -eq 0) { $candidate = $cand; break }
        }
    }
    if (-not $candidate) {
        $allBr = git for-each-ref --format='%(refname:short)' refs/heads/ 2>$null
        if ($LASTEXITCODE -eq 0 -and $allBr) {
            foreach ($b in ($allBr -split "`r?`n")) {
                $b = $b.Trim()
                if ($b -and $b -notlike 'garelier/*') { $candidate = $b; break }
            }
        }
    }
    return $candidate
}

function Invoke-CleanupPartialInstall {
    param(
        [string]$TargetForSwitch,
        [string]$StudioToDelete
    )
    $pmRoot = "__garelier/$script:PmId"

    if (-not $TargetForSwitch -or $TargetForSwitch -like 'garelier/*') {
        Write-Error "cleanup target '$TargetForSwitch' is not a valid user target. Pass -Target <branch> explicitly to recover."
        return $false
    }

    $wtList = git worktree list --porcelain 2>$null
    if ($LASTEXITCODE -eq 0 -and $wtList) {
        foreach ($line in ($wtList -split "`r?`n")) {
            if ($line -match '^worktree\s+(.+)$') {
                $wtPath = $matches[1]
                if ($wtPath -match "__garelier[\\/]$([regex]::Escape($script:PmId))[\\/]_(workers|scouts|smiths)[\\/]") {
                    git worktree remove --force $wtPath *>$null
                    Write-Host "  - removed worktree $wtPath"
                    # DEC-020: drop the container (coordination files) too.
                    if ($wtPath -match '[\\/]checkout$') { Remove-Item -Recurse -Force ($wtPath -replace '[\\/]checkout$','') -ErrorAction SilentlyContinue }
                }
            }
        }
    }

    $curBranch = git symbolic-ref --short HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and $curBranch -like 'garelier/*') {
        $null = git rev-parse --verify $TargetForSwitch 2>$null
        if ($LASTEXITCODE -eq 0) {
            git checkout $TargetForSwitch *>$null
            Write-Host "  - primary worktree switched back to $TargetForSwitch"
        } else {
            Write-Error "Target '$TargetForSwitch' does not exist; cannot switch off $curBranch."
            return $false
        }
    }

    if ($StudioToDelete) {
        $null = git rev-parse --verify $StudioToDelete 2>$null
        if ($LASTEXITCODE -eq 0) {
            git branch -D $StudioToDelete *>$null
            Write-Host "  - deleted branch $StudioToDelete"
        }
    }

    if (Test-Path -Path $pmRoot -PathType Container) {
        Remove-Item -Recurse -Force $pmRoot
        Write-Host "  - removed $pmRoot/"
    }

    # DEC-051: ignore rules live in nested __garelier/.gitignore / .ignore, shared
    # across PMs — leave it while other PMs remain. Still clean up any legacy block
    # a pre-DEC-051 install left in the root files (best-effort).
    Remove-GarelierLegacyRootBlock -File '.gitignore' -Marker 'Garelier runtime'
    Remove-GarelierLegacyRootBlock -File '.ignore' -Marker 'Garelier search-ignore'
    # When this was the last PM, remove the orphaned nested ignore files too.
    if ((Test-Path '__garelier' -PathType Container) -and
        -not (Get-ChildItem -LiteralPath '__garelier' -Directory -ErrorAction SilentlyContinue)) {
        Remove-Item -LiteralPath (Join-Path '__garelier' '.gitignore') -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath (Join-Path '__garelier' '.ignore') -Force -ErrorAction SilentlyContinue
        Write-Host '  - removed orphaned __garelier/.gitignore + .ignore (no PMs left)'
    }

    return $true
}

# === DEC-035: role homes outside the project tree ===
# Worktree roles keep their container (mailbox + checkout/) in a machine-local
# studio home OUTSIDE the target project; a gitignored runtime/workspace_paths
# pointer maps <role>.<id> -> abs container. Tools resolve via it and fall back
# to the legacy in-proj path when absent.
function Get-WsHomeRoot {
    $r = $env:GARELIER_HOME
    if (-not $r -and (Test-Path "__garelier/$script:PmId/_pm/setup_config.toml")) {
        $r = Read-TomlValue -Section 'workspace' -Key 'home_root'
    }
    if (-not $r) { $r = Join-Path $HOME '.garelier' }
    if ($r -like '~/*') { $r = Join-Path $HOME $r.Substring(2) } elseif ($r -eq '~') { $r = $HOME }
    return ((Join-Path $r 'studios') -replace '\\','/')
}
function Get-WsSha8 {
    param([string]$S)
    $bytes = [System.Security.Cryptography.SHA1]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($S))
    return (-join ($bytes | ForEach-Object { $_.ToString('x2') })).Substring(0, 8)
}
function Get-WsHomeId {
    $root = (Get-Location).Path
    $base = (Split-Path -Leaf $root) -replace '[^A-Za-z0-9._-]','-' -replace '^-+','' -replace '-+$',''
    $gitdir = (& git -C $root rev-parse --absolute-git-dir 2>$null)
    if (-not $gitdir) { $gitdir = Join-Path $root '.git' }
    return "$base-$(Get-WsSha8 $gitdir)-$script:PmId"
}
function Get-WsLegacyContainer {
    param([string]$Role, [string]$Id)
    if ($Role -eq 'artisan') { return "__garelier/$script:PmId/_artisan" }
    return "__garelier/$script:PmId/_$Role/$Id"
}
function Get-WsExileContainer {
    param([string]$Role, [string]$Id)
    if ($Role -eq 'artisan') { return "$(Get-WsHomeRoot)/$(Get-WsHomeId)/_artisan" }
    return "$(Get-WsHomeRoot)/$(Get-WsHomeId)/_$Role/$Id"
}
function Get-WsPointerFile { return "__garelier/$script:PmId/runtime/workspace_paths" }
function Get-WsPointerKey {
    param([string]$Role, [string]$Id)
    if ($Role -eq 'artisan') { return 'artisan' }
    $singular = switch ($Role) {
        'workers' {'worker'} 'scouts' {'scout'} 'smiths' {'smith'} 'librarians' {'librarian'}
        'observers' {'observer'} 'guardians' {'guardian'} 'concierges' {'concierge'} default { $Role.TrimEnd('s') }
    }
    return "$singular.$Id"
}
function Resolve-WsContainer {
    param([string]$Role, [string]$Id)
    $pf = Get-WsPointerFile; $key = Get-WsPointerKey $Role $Id
    if (Test-Path $pf) {
        foreach ($line in Get-Content -LiteralPath $pf) {
            if ($line.StartsWith("$key=")) { return $line.Substring($key.Length + 1) }
        }
    }
    return (Get-WsLegacyContainer $Role $Id)
}
function Write-WsPointer {
    param([string]$Role, [string]$Id, [string]$Container)
    $pf = Get-WsPointerFile; $key = Get-WsPointerKey $Role $Id
    $dir = Split-Path -Parent $pf
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
    # Use a List so a single-element result is never unwrapped to a string
    # (an `if/else` array expression assigned to a var collapses @('x') -> 'x',
    # and `+=` then concatenates instead of appending).
    $lines = [System.Collections.Generic.List[string]]::new()
    if (Test-Path $pf) {
        Get-Content -LiteralPath $pf | Where-Object { -not $_.StartsWith("$key=") } | ForEach-Object { $lines.Add($_) }
    } else {
        $lines.Add('# DEC-036 exile role-home pointer (gitignored, machine-local; only when exile opted in). <role>.<id>=<abs container>')
    }
    $lines.Add("$key=$Container")
    $abs = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $pf))
    [System.IO.File]::WriteAllLines($abs, $lines, (New-Object System.Text.UTF8Encoding($false)))
}
function Remove-WsPointer {
    param([string]$Role, [string]$Id)
    $pf = Get-WsPointerFile; $key = Get-WsPointerKey $Role $Id
    if (Test-Path $pf) {
        $lines = [System.Collections.Generic.List[string]]::new()
        Get-Content -LiteralPath $pf | Where-Object { -not $_.StartsWith("$key=") } | ForEach-Object { $lines.Add($_) }
        $abs = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $pf))
        [System.IO.File]::WriteAllLines($abs, $lines, (New-Object System.Text.UTF8Encoding($false)))
    }
}

# DEC-036: exile (a machine-local studio home OUTSIDE the project) is OPT-IN. The
# DEFAULT is in-project — respects Claude Code's launch-folder access model and
# works in shared/restricted environments. Opt in via -Exile, GARELIER_HOME, or
# [workspace] home_root. A non-writable exile home root falls back to in-project.
function Test-WsUseExile {
    $want = $false
    if ($script:WsExile) { $want = $true }
    if ($env:GARELIER_HOME) { $want = $true }
    if (-not $want -and (Test-Path "__garelier/$script:PmId/_pm/setup_config.toml")) {
        $hr = Read-TomlValue -Section 'workspace' -Key 'home_root'
        if ($hr -and $hr -ne ':in-project:') { $want = $true }
    }
    if (-not $want) { return $false }
    $root = Get-WsHomeRoot
    try { if (-not (Test-Path $root)) { New-Item -ItemType Directory -Force $root | Out-Null } } catch {}
    if (Test-Path $root) { return $true }
    Write-Warning "exile home '$root' not creatable - using in-project layout (DEC-036)"
    return $false
}

# The container to CREATE for a role: in-project (default) or exile (opt-in).
function Get-WsContainer {
    param([string]$Role, [string]$Id)
    if (Test-WsUseExile) { return (Get-WsExileContainer $Role $Id) } else { return (Get-WsLegacyContainer $Role $Id) }
}

# DEC-036: an in-project role worktree sits inside the target project, so the
# CLAUDE.md ancestry walk from the checkout would also load the target's mainline
# CLAUDE.md (a duplicate of the worktree's own copy). Identity is prompt-
# authoritative regardless, so this is only a token cost - neutralize it with the
# official `claudeMdExcludes` setting (honored headless). No-op for exiled checkouts.
function Write-RoleSettings {
    param([string]$Checkout)
    # NB: [IO.Path]::GetFullPath resolves a RELATIVE path against .NET's
    # Environment.CurrentDirectory, which PowerShell's Set-Location does NOT update
    # — so make the checkout path absolute via (Get-Location).Path first.
    $co = if ([System.IO.Path]::IsPathRooted($Checkout)) { $Checkout } else { Join-Path (Get-Location).Path $Checkout }
    $absproj = (Get-Location).Path -replace '\\','/'
    $dir = Join-Path $co '.claude'
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
    $json = "{`n  `"claudeMdExcludes`": [`n" +
            "    `"$absproj/CLAUDE.md`",`n" +
            "    `"$absproj/.claude/CLAUDE.md`",`n" +
            "    `"$absproj/.claude/rules/**`"`n" +
            "  ]`n}`n"
    [System.IO.File]::WriteAllText((Join-Path $dir 'settings.local.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
    # Keep the role worktree clean: ignore the local settings within THIS worktree.
    if (Test-Path (Join-Path $co '.git')) {
        $excl = (& git -C $co rev-parse --git-path info/exclude 2>$null)
        if ($excl) {
            $exclAbs = if ([System.IO.Path]::IsPathRooted($excl)) { $excl } else { Join-Path $co $excl }
            $exclDir = Split-Path -Parent $exclAbs
            if ($exclDir -and -not (Test-Path $exclDir)) { New-Item -ItemType Directory -Force $exclDir | Out-Null }
            $cur = if (Test-Path $exclAbs) { Get-Content -LiteralPath $exclAbs } else { @() }
            if ($cur -notcontains '.claude/settings.local.json') { Add-Content -LiteralPath $exclAbs -Value '.claude/settings.local.json' }
        }
    }
}

function Test-AgentIdle {
    param([string]$Role, [string]$Id)
    $container = Resolve-WsContainer $Role $Id
    # DEC-065 dispatch-native: a seat whose container was never created holds
    # no parked work — trivially removable. A container WITHOUT STATE.md is
    # half-broken and stays conservative (not idle).
    if (-not (Test-Path -LiteralPath $container)) { return $true }
    $stateFile = $container + '/STATE.md'
    if (-not (Test-Path $stateFile)) { return $false }
    $content = Get-Content -LiteralPath $stateFile -Raw
    if ($content -match '##\s+Status\s*\r?\n\s*(\S+)') {
        return ($matches[1].Trim() -eq 'IDLE')
    }
    return $false
}

# Module-scope variable used by Write-RoleFiles / New-AgentWorktree.
$script:StudioBranch = ''
# DEC-036: -Exile switch -> script scope so Test-WsUseExile can read it.
$script:WsExile = [bool]$Exile

# Derive a role's container dir / skill name / scout-only extra CLAUDE line.
function Get-RoleMeta {
    param([string]$Role, [string]$Id)
    $root = (Get-Location).Path
    # DEC-035: absolute control/inspections path (the exile home is outside the project).
    $meta = switch ($Role) {
        'workers'    { @{ Skill = 'garelier-worker';    Extra = '' } }
        'scouts'     { @{ Skill = 'garelier-scout';     Extra = "Inspections to:    $root/__garelier/$script:PmId/control/inspections/`n" } }
        'smiths'     { @{ Skill = 'garelier-smith';     Extra = '' } }
        'librarians' { @{ Skill = 'garelier-librarian'; Extra = '' } }
        'observers'  { @{ Skill = 'garelier-observer';  Extra = '' } }
        'guardians'  { @{ Skill = 'garelier-guardian';  Extra = '' } }
        'concierges' { @{ Skill = 'garelier-concierge'; Extra = '' } }
        'artisan'    { @{ Skill = 'garelier-artisan';   Extra = '' } }
        default      { Write-Error "Unknown agent role '$Role'."; exit 1 }
    }
    # DEC-035: resolve the (possibly exiled) container via the pointer.
    $meta.Dir = Resolve-WsContainer $Role $Id
    return $meta
}

# Write ONLY the role's CLAUDE.md (DEC-020 cwd=checkout relative paths). Shared
# by fresh/diff (via Write-RoleFiles) and migrate (which must NOT reset STATE).
function Write-RoleClaude {
    param([string]$Role, [string]$Id, [string]$Provider, [string]$Model)
    $meta = Get-RoleMeta $Role $Id
    $singular = $Role.TrimEnd('s')
    $root = (Get-Location).Path
    # DEC-035: the container may live in a machine-local home OUTSIDE the project,
    # so runtime/control/primary are ABSOLUTE (a relative ../ would escape the home).
    # The coordination files (assignment/STATE) are still one ../ up from the cwd.
    $claude = "You are $singular $Id (provider: $Provider, model: $Model) in a Garelier project.`n" +
              "PM identifier:       $script:PmId`n" +
              "Your working directory (cwd) is this git worktree — the target project tree.`n" +
              "Garelier coordination files are in the PARENT dir (one ../ up).`n" +
              "Primary checkout (where __garelier/ lives): $root`n" +
              "Runtime directory:   $root/__garelier/$script:PmId/runtime/`n" +
              "Control directory:   $root/__garelier/$script:PmId/control/`n" +
              "Your assignment file: ../assignment.md`n" +
              "Your state file:      ../STATE.md`n" +
              $meta.Extra +
              "`n" +
              "Follow the $($meta.Skill) skill.`n"
    Write-Utf8File -RelativePath "$($meta.Dir)/CLAUDE.md" -Content $claude
}

function Write-RoleFiles {
    param([string]$Role, [string]$Id, [string]$Provider, [string]$Model)

    $roleDir = (Get-RoleMeta $Role $Id).Dir
    $singular = $Role.TrimEnd('s')
    Write-RoleClaude -Role $Role -Id $Id -Provider $Provider -Model $Model

    $stateBranch = $script:StudioBranch
    $state = "# $singular $Id — State`n" +
             "`n" +
             "## Status`n" +
             "IDLE`n" +
             "`n" +
             "## Current branch`n" +
             "(detached HEAD at $stateBranch)`n" +
             "`n" +
             "## Current task`n" +
             "(none)`n" +
             "`n" +
             "## Last activity`n" +
             "$now — Initialized by setup wizard`n" +
             "`n" +
             "## Recent log`n" +
             "- $now Initialized by setup wizard`n" +
             "`n" +
             "## Next planned action`n" +
             "Wait for assignment.`n"
    Write-Utf8File -RelativePath "$roleDir/STATE.md" -Content $state
}

function New-AgentWorktree {
    param([string]$Role, [string]$Id, [string]$Provider, [string]$Model)
    # DEC-036: in-project by default (<proj>/__garelier/<pm>/_<role>/<id>/);
    # exile (a machine-local home outside the project) is opt-in and then records
    # the gitignored workspace_paths pointer.
    $path = Get-WsContainer $Role $Id
    New-Item -ItemType Directory -Force $path | Out-Null
    git worktree add --detach "$path/checkout" $script:StudioBranch *>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to create worktree at $path/checkout"
        exit 1
    }
    if (Test-WsUseExile) { Write-WsPointer $Role $Id $path }
    Write-RoleSettings "$path/checkout"   # DEC-036: claudeMdExcludes
    # DEC-030: a Concierge worktree gets the mechanical push guard at creation.
    if ($Role -eq 'concierges') {
        $ct = if ($env:GARELIER_CORE_TEMPLATES_DIR) { $env:GARELIER_CORE_TEMPLATES_DIR } else { Join-Path $GarelierSkillsDir 'garelier-core\templates' }
        $guard = Join-Path (Split-Path -Parent $ct) 'scripts/install_concierge_guards.ps1'
        if (Test-Path $guard) {
            & pwsh -NoProfile -File $guard "$path/checkout" *>$null
            if ($LASTEXITCODE -ne 0) { Write-Warning "could not install Concierge push guard for $Id (DEC-030); it installs at pickup" }
        }
    }
    Write-RoleFiles -Role $Role -Id $Id -Provider $Provider -Model $Model
}

function Remove-AgentWorktree {
    param([string]$Role, [string]$Id)
    switch ($Role) {
        'workers'    { $path = "__garelier/$script:PmId/_workers/$Id" }
        'scouts'     { $path = "__garelier/$script:PmId/_scouts/$Id" }
        'smiths'     { $path = "__garelier/$script:PmId/_smiths/$Id" }
        'librarians' { $path = "__garelier/$script:PmId/_librarians/$Id" }
        'observers'  { $path = "__garelier/$script:PmId/_observers/$Id" }
        'guardians'  { $path = "__garelier/$script:PmId/_guardians/$Id" }
        'concierges' { $path = "__garelier/$script:PmId/_concierges/$Id" }
        default {
            Write-Error "Unknown agent role '$Role'."
            exit 1
        }
    }
    # DEC-035: resolve the (possibly exiled) container; remove worktree +
    # container, drop the pointer entry, prune stale worktree registrations.
    $path = Resolve-WsContainer $Role $Id
    git worktree remove --force "$path/checkout" *>$null
    git worktree remove --force $path *>$null
    if (Test-Path $path) {
        Remove-Item -Recurse -Force $path
    }
    Remove-WsPointer $Role $Id
    git worktree prune *>$null
}

# === DEC-020 migration (worktree -> container/checkout nesting) ===
$script:MigDone = 0; $script:MigSkip = 0; $script:MigFail = 0

# DEC-035: relocate one role's worktree+mailbox from its legacy in-proj
# container to its machine-local exile home, and record the pointer. Handles
# DEC-020 (nested) and pre-0020 (flat) sources. Gate: tracked-only (uncommitted
# tracked changes are skipped; untracked coordination files ride along).
function Move-RoleToCheckout {
    param([string]$Role, [string]$Id, [string]$Legacy)
    $exile = Get-WsExileContainer $Role $Id

    if (Test-Path (Join-Path $exile 'checkout') -PathType Container) {
        Write-WsPointer $Role $Id $exile
        if ((Test-Path $Legacy) -and ($Legacy -ne $exile)) { Remove-Item -Recurse -Force $Legacy -ErrorAction SilentlyContinue }
        return
    }
    if (-not (Test-Path $Legacy -PathType Container)) { return }

    # Locate the current git worktree: nested (DEC-020) or flat (pre-0020).
    $wt = ''
    if (Test-Path (Join-Path $Legacy 'checkout/.git')) { $wt = (Join-Path $Legacy 'checkout') }
    elseif (Test-Path (Join-Path $Legacy '.git')) { $wt = $Legacy }

    if ($wt) {
        $dirty = (& git -C $wt status --porcelain --untracked-files=no 2>$null)
        if ($dirty) {
            Write-Host "  ! $Legacy has uncommitted tracked changes — commit them, then re-run migrate"
            $script:MigSkip++; return
        }
    }

    # Preserve provider/model from the existing CLAUDE.md identity line.
    $prov = 'claude-code'; $model = 'claude-code'
    $claudePath = Join-Path $Legacy 'CLAUDE.md'
    if (Test-Path $claudePath -PathType Leaf) {
        $line = (Get-Content -LiteralPath $claudePath -TotalCount 1)
        if ($line -match 'provider:\s*([^,]*),') { $prov = $matches[1].Trim() }
        if ($line -match 'model:\s*([^)]*)\)') { $model = $matches[1].Trim() }
    }

    New-Item -ItemType Directory -Force $exile | Out-Null
    if ($wt) {
        git worktree move $wt (Join-Path $exile 'checkout') *>$null
        if ($LASTEXITCODE -ne 0) {
            $sha = (& git -C $wt rev-parse HEAD 2>$null)
            git worktree remove --force $wt *>$null
            $base = if ($sha) { $sha } else { $script:StudioBranch }
            git worktree add --detach (Join-Path $exile 'checkout') $base *>$null
            if ($LASTEXITCODE -ne 0) { Write-Host "  ! could not relocate worktree for $Legacy to $exile"; $script:MigFail++; return }
        }
    }
    # Move coordination files to the exile container (from the legacy container
    # root, and from the relocated worktree for the pre-0020 flat case). The role
    # CLAUDE.md is regenerated below, not pulled out of the clean checkout.
    foreach ($f in @('CLAUDE.md','STATE.md','assignment.md','report.md','review.md','questions.md','answers.md',
                     'under_review.md','merged.md','abort.md','track-target.md','committed.md','acked.md',
                     'guardian_report.md','concierge_report.md','archive','checkpoints')) {
        $src = Join-Path $Legacy $f
        if (Test-Path $src) { Move-Item -Force $src (Join-Path $exile $f) -ErrorAction SilentlyContinue }
    }
    foreach ($f in @('STATE.md','assignment.md','report.md','review.md','questions.md','answers.md',
                     'under_review.md','merged.md','abort.md','track-target.md','committed.md','acked.md',
                     'guardian_report.md','concierge_report.md','archive','checkpoints')) {
        $src = Join-Path $exile "checkout/$f"; $dst = Join-Path $exile $f
        if ((Test-Path $src) -and -not (Test-Path $dst)) { Move-Item -Force $src $dst -ErrorAction SilentlyContinue }
    }
    Write-WsPointer $Role $Id $exile
    Write-RoleClaude -Role $Role -Id $Id -Provider $prov -Model $model
    if (Test-Path $Legacy) { Remove-Item -Recurse -Force $Legacy -ErrorAction SilentlyContinue }
    git worktree prune *>$null
    Write-Host "  + $Legacy -> $exile"
    $script:MigDone++
}

# Nest every worktree role under __garelier/$PmId into checkout/ (idempotent).
function Invoke-Dec020Nesting {
    Write-Host ''
    Write-Host '==> DEC-035: relocating role worktrees to the machine-local studio home ...'
    foreach ($base in @('_workers','_scouts','_smiths','_librarians','_observers','_guardians','_concierges')) {
        $role = $base.TrimStart('_')
        $baseDir = "__garelier/$script:PmId/$base"
        if (-not (Test-Path $baseDir -PathType Container)) { continue }
        foreach ($d in (Get-ChildItem -LiteralPath $baseDir -Directory -ErrorAction SilentlyContinue)) {
            Move-RoleToCheckout -Role $role -Id $d.Name -Legacy "$baseDir/$($d.Name)"
        }
    }
    if (Test-Path "__garelier/$script:PmId/_artisan" -PathType Container) {
        Move-RoleToCheckout -Role 'artisan' -Id '' -Legacy "__garelier/$script:PmId/_artisan"
    }
    Write-Host "  DEC-035 relocate: $script:MigDone relocated, $script:MigSkip skipped (uncommitted), $script:MigFail failed"
    return ($script:MigFail -eq 0)
}

# DEC-036: the INVERSE — relocate one role's worktree+mailbox from its exile home
# BACK into the project, write claudeMdExcludes, drop the pointer. Role is plural.
function Move-RoleToInproject {
    param([string]$Role, [string]$Id, [string]$Exile)
    $inproj = Get-WsLegacyContainer $Role $Id
    if (Test-Path (Join-Path $inproj 'checkout/.git')) {
        Remove-WsPointer $Role $Id
        if ((Test-Path $Exile) -and ($Exile -ne $inproj)) { Remove-Item -Recurse -Force $Exile -ErrorAction SilentlyContinue }
        return
    }
    if (-not (Test-Path (Join-Path $Exile 'checkout/.git'))) { return }
    $dirty = (& git -C "$Exile/checkout" status --porcelain --untracked-files=no 2>$null)
    if ($dirty) { Write-Host "  ! $Exile has uncommitted tracked changes - commit them, then re-run migrate"; $script:MigSkip++; return }
    $prov = 'claude-code'; $model = 'claude-code'
    $cp = Join-Path $Exile 'CLAUDE.md'
    if (Test-Path $cp -PathType Leaf) {
        $line = (Get-Content -LiteralPath $cp -TotalCount 1)
        if ($line -match 'provider:\s*([^,]*),') { $prov = $matches[1].Trim() }
        if ($line -match 'model:\s*([^)]*)\)') { $model = $matches[1].Trim() }
    }
    New-Item -ItemType Directory -Force $inproj | Out-Null
    git worktree move "$Exile/checkout" "$inproj/checkout" *>$null
    if ($LASTEXITCODE -ne 0) {
        $sha = (& git -C "$Exile/checkout" rev-parse HEAD 2>$null)
        git worktree remove --force "$Exile/checkout" *>$null
        $base = if ($sha) { $sha } else { $script:StudioBranch }
        git worktree add --detach "$inproj/checkout" $base *>$null
        if ($LASTEXITCODE -ne 0) { Write-Host "  ! could not relocate worktree $Exile -> $inproj"; $script:MigFail++; return }
    }
    foreach ($f in @('STATE.md','assignment.md','report.md','review.md','questions.md','answers.md',
                     'under_review.md','merged.md','abort.md','track-target.md','committed.md','acked.md',
                     'guardian_report.md','concierge_report.md','archive','checkpoints')) {
        $src = Join-Path $Exile $f
        if (Test-Path $src) { Move-Item -Force $src (Join-Path $inproj $f) -ErrorAction SilentlyContinue }
    }
    # Drop the pointer FIRST so Write-RoleClaude (via Resolve-WsContainer) targets
    # the in-proj container, then regenerate CLAUDE.md + claudeMdExcludes there.
    Remove-WsPointer $Role $Id
    Write-RoleSettings "$inproj/checkout"
    Write-RoleClaude -Role $Role -Id $Id -Provider $prov -Model $model
    if (Test-Path $Exile) { Remove-Item -Recurse -Force $Exile -ErrorAction SilentlyContinue }
    git worktree prune *>$null
    Write-Host "  + $Exile -> $inproj"
    $script:MigDone++
}

# Relocate every EXILED role (pointer entries) back into the project.
function Invoke-RelocateToInproject {
    Write-Host ''
    Write-Host '==> DEC-036: relocating role worktrees back into the project ...'
    $pf = Get-WsPointerFile
    if (-not (Test-Path $pf)) { Write-Host '  no workspace_paths pointer - already in-project'; return $true }
    $entries = @(Get-Content -LiteralPath $pf | Where-Object { $_ -and -not $_.StartsWith('#') })
    foreach ($line in $entries) {
        $eq = $line.IndexOf('='); if ($eq -lt 1) { continue }
        $key = $line.Substring(0, $eq); $val = $line.Substring($eq + 1)
        if ($key -eq 'artisan') { $role = 'artisan'; $id = '' }
        else {
            $dot = $key.IndexOf('.'); $rsing = $key.Substring(0, $dot); $id = $key.Substring($dot + 1)
            $role = switch ($rsing) {
                'worker' {'workers'} 'scout' {'scouts'} 'smith' {'smiths'} 'librarian' {'librarians'}
                'observer' {'observers'} 'guardian' {'guardians'} 'concierge' {'concierges'} default { "${rsing}s" }
            }
        }
        Move-RoleToInproject -Role $role -Id $id -Exile $val
    }
    if (Test-Path $pf) {
        $left = @(Get-Content -LiteralPath $pf | Where-Object { $_ -and -not $_.StartsWith('#') })
        if ($left.Count -eq 0) { Remove-Item -Force $pf }
    }
    Write-Host "  DEC-036 relocate: $script:MigDone relocated, $script:MigSkip skipped (uncommitted), $script:MigFail failed"
    return ($script:MigFail -eq 0)
}

# Direction dispatcher: exile is opt-in; default relocates BACK in-project.
function Invoke-Relocate {
    if (Test-WsUseExile) { return (Invoke-Dec020Nesting) } else { return (Invoke-RelocateToInproject) }
}

function Invoke-IntegrateTargetIntoStudio {
    param([string]$TargetBranch)
    git checkout $script:StudioBranch *>$null
    $null = git merge-base --is-ancestor $TargetBranch HEAD 2>$null
    if ($LASTEXITCODE -eq 0) {
        return $true
    }
    git merge --no-edit $TargetBranch *>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  + integrated $TargetBranch into $script:StudioBranch"
        return $true
    }
    git merge --abort *>$null
    Write-Warning "merge of $TargetBranch into $script:StudioBranch had conflicts"
    Write-Warning 'PM must resolve manually (see DEC-001 §2.5) then re-run.'
    return $false
}

# === Mode dispatch ===

if ($Mode -eq 'Fresh') {

    # === FRESH MODE ===

    $null = git rev-parse --is-inside-work-tree 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Error "$projectRoot is not inside a git repository."
        exit 1
    }
    $null = git rev-parse HEAD 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Error 'Repository has no commits. Make at least one commit first.'
        exit 1
    }

    $script:PmId = $PmId
    Resolve-PmIdInteractive
    $script:UpgradeControlOnly = $false

    if (Test-Path "__garelier/$script:PmId") {
        $setupState = Get-SetupState
        switch ($setupState) {
            'complete' {
                Write-Error "PM '$script:PmId' already initialized at __garelier/$script:PmId/. Choose another -PmId, or cd __garelier/$script:PmId/_pm and use -Mode Diff."
                exit 1
            }
            'partial' {
                Write-Host "Detected a partial install for PM '$script:PmId' (wizard was interrupted)."
                Write-Host ''
                Write-Host "Found leftovers under __garelier/$script:PmId/:"
                foreach ($d in @(
                    "__garelier/$script:PmId/runtime",
                    "__garelier/$script:PmId/control",
                    "__garelier/$script:PmId/_pm",
                    "__garelier/$script:PmId/_dock",
                    "__garelier/$script:PmId/_workers",
                    "__garelier/$script:PmId/_scouts",
                    "__garelier/$script:PmId/_smiths"
                )) {
                    if (Test-Path -Path $d) { Write-Host "  - $d" }
                }
                $brs = git for-each-ref --format='%(refname:short)' "refs/heads/garelier/*/$script:PmId/studio" 2>$null
                if ($LASTEXITCODE -eq 0 -and $brs) {
                    foreach ($br in ($brs -split "`r?`n")) {
                        $br = $br.Trim()
                        if ($br) { Write-Host "  - branch $br" }
                    }
                }
                $wtl = git worktree list --porcelain 2>$null
                if ($LASTEXITCODE -eq 0 -and $wtl) {
                    foreach ($line in ($wtl -split "`r?`n")) {
                        if ($line -match "^worktree\s+(.+__garelier[\\/]$([regex]::Escape($script:PmId))[\\/]_(workers|scouts|smiths)[\\/].+)$") {
                            Write-Host "  - worktree $($matches[1])"
                        }
                    }
                }
                Write-Host ''

                $script:Target = $Target
                $cleanupTarget = Resolve-CleanupTarget
                if (-not $cleanupTarget) {
                    Write-Error 'Cannot determine a non-Garelier branch to switch to. Pass -Target <branch> explicitly to recover.'
                    exit 1
                }
                $studioToDelete = ''
                if (Test-Path "__garelier/$script:PmId/_pm/setup_config.toml" -PathType Leaf) {
                    $studioToDelete = Read-TomlValue -Section 'branches' -Key 'integration'
                }
                if (-not $studioToDelete) {
                    $studioToDelete = "garelier/$(ConvertTo-TargetSlug $cleanupTarget)/$script:PmId/studio"
                }

                if ($SkipConfirm) {
                    Write-Host 'Auto-cleaning (-SkipConfirm passed).'
                    $ok = Invoke-CleanupPartialInstall -TargetForSwitch $cleanupTarget -StudioToDelete $studioToDelete
                    if (-not $ok) { exit 1 }
                } else {
                    Write-Host "Cleanup target: $cleanupTarget (real branch to switch to)"
                    Write-Host "Studio to delete: $studioToDelete"
                    $resp = Read-Host 'Clean these up and continue with fresh init? [y/N]'
                    if ($resp -notmatch '^[yY]') {
                        Write-Error 'Aborted. Resolve the partial install manually then re-run.'
                        exit 1
                    }
                    $ok = Invoke-CleanupPartialInstall -TargetForSwitch $cleanupTarget -StudioToDelete $studioToDelete
                    if (-not $ok) { exit 1 }
                }
            }
            'starter' {
                $script:UpgradeControlOnly = $true
                Write-Host "Detected a Garelier small starter at __garelier/$script:PmId/."
                Write-Host 'Its existing control and knowledge will be preserved while full Garelier is added.'
            }
            'absent' {
                # PM dir exists but is empty — odd but allowed.
            }
        }
    }

    if ([string]::IsNullOrWhiteSpace($Target)) {
        $Target = git symbolic-ref --short HEAD 2>$null
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($Target)) {
            Write-Error 'Cannot determine current branch (detached HEAD?). Pass -Target <branch>.'
            exit 1
        }
    }
    $null = git rev-parse --verify $Target 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Target branch '$Target' does not exist."
        exit 1
    }

    $targetSlug = ConvertTo-TargetSlug $Target
    $script:StudioBranch = "garelier/$targetSlug/$script:PmId/studio"

    $null = git rev-parse --verify $script:StudioBranch 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Error "Branch $script:StudioBranch already exists. Either choose a different -PmId, or delete the stale branch first."
        exit 1
    }

    $workerEntries = Parse-Entries $Workers
    $scoutEntries  = Parse-Entries $Scouts
    $smithEntries  = Parse-Entries $Smiths
    $librarianEntries = @(Parse-Entries $Librarians)
    $observerEntries  = @(Parse-Entries $Observers)
    $guardianEntries  = @(Parse-Entries $Guardians)
    $conciergeEntries = @(Parse-Entries $Concierges)
    if ($workerEntries.Count -eq 0) {
        Write-Error '-Workers must contain at least one entry.'
        exit 1
    }

    # Resolve the (optional) Artisan. -Artisan (present at all, even empty)
    # enables the artisan lane; an inline "id:provider[:model]" overrides
    # defaults. In Fresh mode the lane is also enabled by default when neither
    # -Artisan nor -NoArtisan was passed ("batteries included").
    $artisanEnable = $PSBoundParameters.ContainsKey('Artisan') -or $artisanDefaultEnabled
    $artisanId = 'artisan-01'; $artisanProvider = 'claude-code'; $artisanModel = 'claude-code'
    if ($artisanEnable -and -not [string]::IsNullOrWhiteSpace($Artisan)) {
        $solEntry = @(Parse-Entries $Artisan)
        if ($solEntry.Count -gt 1) {
            Write-Error "the Artisan is a singleton — only one -Artisan entry is allowed (got $($solEntry.Count)). (DEC-017/DEC-056)"
            exit 1
        }
        if ($solEntry.Count -gt 0) {
            $artisanId = Get-EntryId $solEntry[0]
            $artisanProvider = Get-EntryProvider $solEntry[0]
            $artisanModel = Get-EntryModel $solEntry[0]
        }
    }
    $obsPolicyEnabled = if ($observerEntries.Count -gt 0) { 'true' } else { 'false' }
    # Guardian policy auto-enables when Guardians are configured; else stays
    # disabled by default (DEC-024).
    $grdPolicyEnabled = if ($guardianEntries.Count -gt 0) { 'true' } else { 'false' }
    # Concierge policy auto-enables when Concierges are configured; else stays
    # disabled by default (DEC-025).
    $conPolicyEnabled = if ($conciergeEntries.Count -gt 0) { 'true' } else { 'false' }

    $pmRoot = "__garelier/$script:PmId"

    Write-Host ''
    Write-Host 'Garelier setup plan (fresh mode)'
    Write-Host '================================='
    Write-Host "  Project name:   $ProjectName"
    Write-Host "  Project root:   $projectRoot"
    Write-Host "  PM identifier:  $script:PmId"
    Write-Host "  PM root:        $pmRoot"
    Write-Host "  Target branch:  $Target"
    Write-Host "  Target slug:    $targetSlug"
    Write-Host "  Will create branch: $script:StudioBranch (from $Target)"
    Write-Host "  Workers ($($workerEntries.Count)):"
    foreach ($e in $workerEntries) { Write-Host "      + $e" }
    Write-Host "  Scouts ($($scoutEntries.Count)):"
    foreach ($e in $scoutEntries) { Write-Host "      + $e" }
    Write-Host "  Smiths ($($smithEntries.Count)):"
    foreach ($e in $smithEntries) { Write-Host "      + $e" }
    Write-Host ''

    if (-not $SkipConfirm) {
        $resp = Read-Host 'Proceed? [y/N]'
        if ($resp -notmatch '^[yY]') {
            Write-Host 'Aborted.'; exit 0
        }
    }

    New-Item -ItemType Directory -Path "$pmRoot/_pm" -Force | Out-Null

    Write-Host ''
    Write-Host '==> Creating integration (studio) branch...'
    git branch $script:StudioBranch $Target | Out-Null
    Write-Host "  + $script:StudioBranch created from $Target"
    git checkout $script:StudioBranch *>$null
    Write-Host "  + primary worktree switched to $script:StudioBranch"

    Write-Host ''
    Write-Host "==> Creating $pmRoot/runtime/ structure..."
    $rtDirs = @(
        "$pmRoot/runtime/dock/inbox",
        "$pmRoot/runtime/dock/inbox-archive",
        "$pmRoot/runtime/dock/escalation",
        "$pmRoot/runtime/dock/escalation-archive",
        "$pmRoot/runtime/pm/inbox",
        "$pmRoot/runtime/pm/inbox-archive",
        "$pmRoot/runtime/pm/resolutions",
        "$pmRoot/runtime/backlog/done",
        "$pmRoot/runtime/backlog/archive",
        "$pmRoot/runtime/backlog/requeued",
        "$pmRoot/runtime/driver",
        "$pmRoot/runtime/requests/inbox",
        "$pmRoot/runtime/requests/processing",
        "$pmRoot/runtime/requests/processed",
        "$pmRoot/runtime/requests/rejected",
        "$pmRoot/runtime/requests/failed",
        "$pmRoot/runtime/requests/locks",
        "$pmRoot/runtime/scheduled_jobs/locks",
        "$pmRoot/runtime/scheduled_jobs/runs",
        # DEC-007: merge gate async subprocess artifacts
        "$pmRoot/runtime/merge_gate/requests",
        "$pmRoot/runtime/merge_gate/results",
        "$pmRoot/runtime/merge_gate/logs",
        "$pmRoot/runtime/merge_gate/locks",
        "$pmRoot/runtime/merge_gate/archive",
        # DEC-019: Observer request/result inbox (sidecar; both lanes)
        "$pmRoot/runtime/observer/inbox",
        "$pmRoot/runtime/observer/requests",
        "$pmRoot/runtime/observer/results",
        "$pmRoot/runtime/observer/locks",
        # DEC-024: Guardian gate request/result inbox (security gate; both lanes)
        "$pmRoot/runtime/guardian/inbox",
        "$pmRoot/runtime/guardian/requests",
        "$pmRoot/runtime/guardian/results",
        "$pmRoot/runtime/guardian/locks",
        # DEC-025: Concierge external-operations request/result inbox + archive
        "$pmRoot/runtime/concierge/inbox",
        "$pmRoot/runtime/concierge/requests",
        "$pmRoot/runtime/concierge/results",
        "$pmRoot/runtime/concierge/locks",
        "$pmRoot/runtime/concierge/archive",
        # DEC-038: Librarian local-only working area (raw pulls / cache / drafts)
        "$pmRoot/runtime/librarian/raw",
        "$pmRoot/runtime/librarian/cache",
        "$pmRoot/runtime/librarian/drafts"
    )
    foreach ($d in $rtDirs) {
        New-Item -ItemType Directory -Path $d -Force | Out-Null
    }
    $libReadme = "$pmRoot/runtime/librarian/README.md"
    if (-not (Test-Path $libReadme)) {
        @'
# Librarian local-only working area (NOT committed)

Gitignored (under `runtime/`). Holds the Librarian's machine-local working
material; nothing here is shared or committed.

- `raw/`    — raw external pulls (fetched pages, downloads) before review.
- `cache/`  — sync caches keyed by source (see knowledge/source_registry.toml).
- `drafts/` — pre-publication drafts of knowledge files.

**Curated, shareable knowledge is promoted to the TRACKED trees** under
`docs/garelier/<category>/` (engineering / quality / review / system /
security / external_operations) via a `shelf` branch reviewed by Dock.
Never commit raw external content with unknown license or PII — see
`docs/garelier/security/commit_hygiene_policy.md` + `license_policy.md`.
'@ | Set-Content -Path $libReadme -Encoding utf8
    }
    $gitkeepDirs = @(
        "$pmRoot/runtime/dock/inbox",
        "$pmRoot/runtime/dock/escalation",
        "$pmRoot/runtime/pm/inbox",
        "$pmRoot/runtime/backlog/done",
        "$pmRoot/runtime/backlog/requeued",
        "$pmRoot/runtime/requests/inbox",
        "$pmRoot/runtime/requests/rejected",
        "$pmRoot/runtime/scheduled_jobs/locks"
    )
    foreach ($d in $gitkeepDirs) {
        New-Item -ItemType File -Path "$d/.gitkeep" -Force | Out-Null
    }
    Write-Host "  + $pmRoot/runtime/ tree created"

    New-Item -ItemType Directory -Path "$pmRoot/_pm/history/archive" -Force | Out-Null
    New-Item -ItemType File -Path "$pmRoot/_pm/history/archive/.gitkeep" -Force | Out-Null

    Write-Host ''
    Write-Host "==> Creating $pmRoot/control/ structure..."
    $ctlDirs = @(
        "$pmRoot/control/project_dashboard",
        "$pmRoot/control/operations",
        "$pmRoot/control/blueprints/archive",
        "$pmRoot/control/delegation",
        "$pmRoot/control/inspections/tech",
        "$pmRoot/control/inspections/market",
        "$pmRoot/control/inspections/status",
        "$pmRoot/control/request_intake/templates",
        "$pmRoot/control/scheduled_jobs/templates",
        "$pmRoot/control/scheduled_jobs/examples",
        "$pmRoot/control/decisions",
        "$pmRoot/control/reports/promote",
        "$pmRoot/control/reports/benchmark",
        "$pmRoot/control/reports/data_audit",
        "$pmRoot/control/reports/requests",
        "$pmRoot/control/reports/delegated_requests",
        "$pmRoot/control/reports/notifications",
        "$pmRoot/control/reports/scheduled_jobs",
        "$pmRoot/control/observations"
    )
    foreach ($d in $ctlDirs) {
        New-Item -ItemType Directory -Path $d -Force | Out-Null
    }
    $ctlGitkeepDirs = @(
        "$pmRoot/control/blueprints/archive",
        "$pmRoot/control/inspections/tech",
        "$pmRoot/control/inspections/market",
        "$pmRoot/control/inspections/status",
        "$pmRoot/control/reports/promote",
        "$pmRoot/control/reports/benchmark",
        "$pmRoot/control/reports/data_audit",
        "$pmRoot/control/reports/requests",
        "$pmRoot/control/reports/delegated_requests",
        "$pmRoot/control/reports/notifications",
        "$pmRoot/control/reports/scheduled_jobs",
        "$pmRoot/control/observations"
    )
    foreach ($d in $ctlGitkeepDirs) {
        New-Item -ItemType File -Path "$d/.gitkeep" -Force | Out-Null
    }

    $coreTemplateRoot = if ($env:GARELIER_CORE_TEMPLATES_DIR) {
        $env:GARELIER_CORE_TEMPLATES_DIR
    } else {
        Join-Path $GarelierSkillsDir 'garelier-core\templates'
    }
    if (-not $script:UpgradeControlOnly) {
    $ctlReadme = "# Garelier Control — PM: $script:PmId`n`n" +
        "This tree holds the persistent project authority for PM ``$script:PmId```: project dashboard,`n" +
        "operations rules, blueprints, inspections, request intake, delegation,`n" +
        "scheduled jobs, decisions, and reports.`n`n" +
        "Sibling ``$pmRoot/runtime/`` holds transient execution state.`n`n" +
        "For the read order and authority order, see`n" +
        "``project_dashboard/README.md`` and the individual operations files.`n"
    Write-Utf8File -RelativePath "$pmRoot/control/README.md" -Content $ctlReadme

    $pdReadme = "# Project Dashboard`n`n" +
        "Persistent planning state for this PM. Order of authority`n" +
        "(highest first):`n`n" +
        "1. ../operations/  (safety rules)`n" +
        "2. quality_gates.md`n" +
        "3. decisions.md`n" +
        "4. current.md`n" +
        "5. roadmap.md`n" +
        "6. backlog.md`n" +
        "7. notes.md  (lowest authority)`n`n" +
        "``notes.md`` is unsorted scratch; promote validated entries to a`n" +
        "higher-authority file and trim notes when they outgrow.`n"
    Write-Utf8File -RelativePath "$pmRoot/control/project_dashboard/README.md" -Content $pdReadme

    Write-Utf8File -RelativePath "$pmRoot/control/project_dashboard/current.md" -Content "# Current`n`n(populate when the project starts work)`n"
    Write-Utf8File -RelativePath "$pmRoot/control/project_dashboard/roadmap.md" -Content "# Roadmap`n`n(populate as milestones are defined)`n"
    Write-Utf8File -RelativePath "$pmRoot/control/project_dashboard/backlog.md" -Content "# Backlog`n`n(populate as work items accumulate)`n"
    Write-Utf8File -RelativePath "$pmRoot/control/project_dashboard/decisions.md" -Content "# Decisions`n`n(append settled judgments here; reference DECs when applicable)`n"
    Write-Utf8File -RelativePath "$pmRoot/control/project_dashboard/risks.md" -Content "# Risks`n`n(populate as risks are identified)`n"
    Write-Utf8File -RelativePath "$pmRoot/control/project_dashboard/quality_gates.md" -Content "# Quality Gates`n`nCompletion criteria that bind review and promote. See AGENTS.md §2`nfor the project's quality-gate commands.`n"
    Write-Utf8File -RelativePath "$pmRoot/control/project_dashboard/notes.md" -Content "# Notes`n`nUnsorted scratch. Lowest authority. Promote validated entries to`nthe appropriate higher-authority file.`n"

    $opReadme = "# Operations`n`n" +
        "Highest-authority rules. Editing these is a Garelier-wide change.`n`n" +
        "- runbook.md             — startup/shutdown/monitoring`n" +
        "- promote_checklist.md   — what must hold before studio → target`n" +
        "- recovery.md            — driver crashes, marker collisions, etc.`n" +
        "- data_change_policy.md  — guardrails for any data-mutating task`n"
    Write-Utf8File -RelativePath "$pmRoot/control/operations/README.md" -Content $opReadme

    $runbook = "# Runbook`n`nProject: $ProjectName`nPM:            $script:PmId`nTarget branch: $Target`nStudio branch: $script:StudioBranch`n`n(Add project-specific startup/shutdown notes here.)`n"
    Write-Utf8File -RelativePath "$pmRoot/control/operations/runbook.md" -Content $runbook

    $promoteChecklist = "# Promote Checklist`n`n" +
        "Before promoting studio to target:`n`n" +
        "- [ ] Studio branch is clean.`n" +
        "- [ ] All workbench branches are merged or explicitly abandoned.`n" +
        "- [ ] Required tests passed.`n" +
        "- [ ] Quality gates in project_dashboard/quality_gates.md are satisfied.`n" +
        "- [ ] Active risks are reviewed.`n" +
        "- [ ] Runtime manifest is consistent with reality.`n" +
        "- [ ] Smith hardening targets remaining is 0, or PM recorded an explicit user waiver.`n" +
        "- [ ] No production data write is pending.`n" +
        "- [ ] User explicitly approved this promote.`n"
    Write-Utf8File -RelativePath "$pmRoot/control/operations/promote_checklist.md" -Content $promoteChecklist

    Write-Utf8File -RelativePath "$pmRoot/control/operations/recovery.md" -Content "# Recovery`n`nProcedures for recovering from driver crashes, state inconsistency,`nand marker-file corruption. See the framework recovery template for`nthe full procedure.`n"

    $dataPolicy = "# Data Change Policy`n`n" +
        "Any task that mutates external data must:`n`n" +
        "- Run in a dry-run mode that prints intended changes.`n" +
        "- Provide before/after counts and sample changed records.`n" +
        "- Include a rollback plan in the blueprint and report.`n" +
        "- Show explicit user approval (timestamp + words) in ``_pm/history.md``.`n" +
        "- Not commit secrets.`n" +
        "- Treat customer-facing notifications as data-changing; allowlisted`n" +
        "  scheduled-job operational email must be audited in reports/notifications/.`n`n" +
        "Dock refuses the merge gate if any of the above is missing.`n"
    Write-Utf8File -RelativePath "$pmRoot/control/operations/data_change_policy.md" -Content $dataPolicy

    $controlScaffold = Join-Path $coreTemplateRoot 'control_scaffold'
    if (Test-Path -Path $controlScaffold -PathType Container) {
        Copy-Item -Path (Join-Path $controlScaffold '*') -Destination "$pmRoot/control" -Recurse -Force
        Write-Host '  + control_scaffold templates copied'
    } else {
        throw "canonical control_scaffold template not found at $controlScaffold"
    }
    } else {
        Write-Host '  = existing small-starter control preserved'
    }
    $controlMarker = @(
        'schema_version = 1'
        'kind = "garelier_control"'
        "pm_id = `"$script:PmId`""
        'mode = "full"'
        ''
    ) -join "`n"
    Write-Utf8File -RelativePath "$pmRoot/control/control.toml" -Content $controlMarker
    # Guardian security knowledge (DEC-024): seed docs/garelier/security/ from
    # the Librarian-owned defaults if absent. PM/user curate from there.
    # Honor the same override the bash wizard exposes (sh/ps1 parity).
    $librarianTemplateRoot = if ($env:GARELIER_LIBRARIAN_TEMPLATES_DIR) {
        $env:GARELIER_LIBRARIAN_TEMPLATES_DIR
    } else {
        $coreTemplateRoot -replace 'garelier-core', 'garelier-librarian'
    }
    $securityScaffold = Join-Path $librarianTemplateRoot 'security'
    if ((Test-Path -Path $securityScaffold -PathType Container) -and -not (Test-Path 'docs/garelier/security')) {
        New-Item -ItemType Directory -Force 'docs/garelier/security' | Out-Null
        Copy-Item -Path (Join-Path $securityScaffold '*') -Destination 'docs/garelier/security' -Recurse -Force
        Write-Host '  + Guardian security knowledge seeded at docs/garelier/security/ (edit per project)'
    }
    # Librarian-managed role knowledge trees (DEC-029): seed if absent. PM/user
    # curate from there; gate/producing roles read but do not edit. No-overwrite.
    foreach ($ktree in @('engineering', 'quality', 'review', 'system')) {
        $kscaffold = Join-Path $librarianTemplateRoot $ktree
        if ((Test-Path -Path $kscaffold -PathType Container) -and -not (Test-Path "docs/garelier/$ktree")) {
            New-Item -ItemType Directory -Force "docs/garelier/$ktree" | Out-Null
            Copy-Item -Path (Join-Path $kscaffold '*') -Destination "docs/garelier/$ktree" -Recurse -Force
            Write-Host "  + Librarian $ktree knowledge seeded at docs/garelier/$ktree/ (edit per project)"
        }
    }
    # Concierge external-operation policy (DEC-025) and routine runbooks are
    # referenced by default role knowledge / registries, so fresh setup must
    # install their starter docs too. No-overwrite.
    $externalOpsScaffold = Join-Path $librarianTemplateRoot 'external_operations'
    if ((Test-Path -Path $externalOpsScaffold -PathType Container) -and -not (Test-Path 'docs/garelier/external_operations')) {
        New-Item -ItemType Directory -Force 'docs/garelier/external_operations' | Out-Null
        Copy-Item -Path (Join-Path $externalOpsScaffold '*') -Destination 'docs/garelier/external_operations' -Recurse -Force
        Write-Host '  + Concierge external-operations knowledge seeded at docs/garelier/external_operations/ (edit per project)'
    }
    $runbooksScaffold = Join-Path $librarianTemplateRoot 'runbooks'
    if ((Test-Path -Path $runbooksScaffold -PathType Container) -and -not (Test-Path 'docs/garelier/runbooks')) {
        New-Item -ItemType Directory -Force 'docs/garelier/runbooks' | Out-Null
        Copy-Item -Path (Join-Path $runbooksScaffold '*') -Destination 'docs/garelier/runbooks' -Recurse -Force
        Write-Host '  + Librarian runbooks seeded at docs/garelier/runbooks/ (edit per project)'
    }
    # Role knowledge index (DEC-048): the by-role reading map every role reads
    # first (read_first set), authoritative for the role->docs mapping. Seed to
    # docs/garelier/knowledge/ if absent. No-overwrite.
    $roleIndexTpl = Join-Path $librarianTemplateRoot 'role_index.toml'
    if ((Test-Path -Path $roleIndexTpl -PathType Leaf) -and -not (Test-Path 'docs/garelier/knowledge/role_index.toml')) {
        New-Item -ItemType Directory -Force 'docs/garelier/knowledge' | Out-Null
        Copy-Item -Path $roleIndexTpl -Destination 'docs/garelier/knowledge/role_index.toml' -Force
        Write-Host '  + Role knowledge index seeded at docs/garelier/knowledge/role_index.toml (DEC-048)'
    }
    # Git command policy (DEC-048 capability invariant): SoT for which git commands
    # roles may run. The driver grant is CI-enforced to mirror it. Seed if absent.
    $gitPolicyTpl = Join-Path $librarianTemplateRoot 'git_command_policy.toml'
    if ((Test-Path -Path $gitPolicyTpl -PathType Leaf) -and -not (Test-Path 'docs/garelier/knowledge/git_command_policy.toml')) {
        New-Item -ItemType Directory -Force 'docs/garelier/knowledge' | Out-Null
        Copy-Item -Path $gitPolicyTpl -Destination 'docs/garelier/knowledge/git_command_policy.toml' -Force
        Write-Host '  + Git command policy seeded at docs/garelier/knowledge/git_command_policy.toml (DEC-048)'
    }
    # Librarian registries (DEC-029 / DEC-018): seed starter source_registry +
    # routine_registry so the console + Librarian have them from day one.
    foreach ($reg in @('source_registry', 'routine_registry')) {
        $regTpl = Join-Path $librarianTemplateRoot "$reg.toml"
        if ((Test-Path -Path $regTpl -PathType Leaf) -and -not (Test-Path "docs/garelier/knowledge/$reg.toml")) {
            New-Item -ItemType Directory -Force 'docs/garelier/knowledge' | Out-Null
            Copy-Item -Path $regTpl -Destination "docs/garelier/knowledge/$reg.toml" -Force
            Write-Host "  + Librarian registry seeded at docs/garelier/knowledge/$reg.toml"
        }
    }
    $knowledgeMarkerTpl = Join-Path $librarianTemplateRoot 'knowledge.toml'
    if ((Test-Path -Path $knowledgeMarkerTpl -PathType Leaf) -and -not (Test-Path 'docs/garelier/knowledge/knowledge.toml')) {
        Copy-Item -Path $knowledgeMarkerTpl -Destination 'docs/garelier/knowledge/knowledge.toml' -Force
        Write-Host '  + Knowledge contract marker seeded at docs/garelier/knowledge/knowledge.toml'
    }

    Write-Host "  + $pmRoot/control/ tree created"

    # DEC-065 (dispatch-native layout): fresh setup pre-creates NO role
    # containers — no _dock/, no _workers/<id>/, no _artisan/. Producers run
    # in ephemeral _dispatch<N>/ homes (scripts/dispatch_prepare.{sh,ps1});
    # the roster entries written to setup_config.toml below are SEAT DEFAULTS
    # (provider/model routing, DEC-063), not live homes. A persistent
    # container is created on demand only — re-run this wizard in -Mode Diff
    # to add one deliberately (e.g. to park long-running work in a slot).
    Write-Host ''
    Write-Host '==> Role containers: none pre-created (dispatch-native, DEC-065).'
    Write-Host '    Producers run in ephemeral _dispatch<N>/ homes; roster entries'
    Write-Host '    in setup_config.toml are seat defaults (model routing).'

    Write-Host ''
    Write-Host "==> Generating $pmRoot/_pm/setup_config.toml..."
    $idleTaskValue = if ($ScoutIdleTask) { 'true' } else { 'false' }
    $sb = [System.Text.StringBuilder]::new()
    [void]$sb.AppendLine('# Garelier setup configuration')
    [void]$sb.AppendLine("# Generated by setup_wizard.ps1 on $now")
    [void]$sb.AppendLine('#')
    [void]$sb.AppendLine("# Add or remove agents by re-running setup_wizard.ps1 in -Mode Diff")
    [void]$sb.AppendLine("# from inside $pmRoot/_pm/.")
    [void]$sb.AppendLine('# To enable health check warnings, uncomment the [health_check] section')
    [void]$sb.AppendLine('# at the bottom and adjust thresholds.')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('[project]')
    [void]$sb.AppendLine("name = `"$ProjectName`"")
    [void]$sb.AppendLine("initialized_at = `"$now`"")
    [void]$sb.AppendLine('garelier_version = "2.7.1"')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('[pm]')
    [void]$sb.AppendLine("pm_id = `"$script:PmId`"")
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('[branches]')
    [void]$sb.AppendLine("target = `"$Target`"")
    [void]$sb.AppendLine("target_slug = `"$targetSlug`"")
    [void]$sb.AppendLine("integration = `"$script:StudioBranch`"")
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('[runner]')
    [void]$sb.AppendLine('pm_provider = "claude-code"')
    [void]$sb.AppendLine('pm_model = "claude-code"')
    [void]$sb.AppendLine('dock_provider = "claude-code"')
    [void]$sb.AppendLine('dock_model = "claude-code"')
    [void]$sb.AppendLine('default_agent_provider = "claude-code"')
    [void]$sb.AppendLine('default_agent_model = "claude-code"')
    [void]$sb.AppendLine('# Optional per-role / per-agent effort.')
    [void]$sb.AppendLine('# pm_effort = "xhigh"')
    [void]$sb.AppendLine('# dock_effort = "xhigh"')
    [void]$sb.AppendLine('# default_agent_effort = "xhigh"')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('# === Role roster (SEAT DEFAULTS, DEC-065) ===')
    [void]$sb.AppendLine('#')
    [void]$sb.AppendLine('# Each [[<role>]] entry is a seat: provider/model routing defaults for')
    [void]$sb.AppendLine('# dispatch (DEC-063 model_routing). No container exists until one is')
    [void]$sb.AppendLine("# created on demand (setup_wizard -Mode Diff); 'worktree' is where")
    [void]$sb.AppendLine('# that container WOULD live. Producers normally run in ephemeral')
    [void]$sb.AppendLine('# _dispatch<N>/ homes instead.')
    foreach ($e in $workerEntries) {
        $workerId = Get-EntryId $e
        $workerProvider = Get-EntryProvider $e
        $workerModel = Get-EntryModel $e
        [void]$sb.AppendLine('[[workers]]')
        [void]$sb.AppendLine("id = `"$workerId`"")
        [void]$sb.AppendLine("provider = `"$workerProvider`"")
        [void]$sb.AppendLine("model = `"$workerModel`"")
        [void]$sb.AppendLine('# effort = "xhigh"')
        [void]$sb.AppendLine("worktree = `"$pmRoot/_workers/$workerId`"")
        [void]$sb.AppendLine('')
    }
    foreach ($e in $scoutEntries) {
        $scoutId = Get-EntryId $e
        $scoutProvider = Get-EntryProvider $e
        $scoutModel = Get-EntryModel $e
        [void]$sb.AppendLine('[[scouts]]')
        [void]$sb.AppendLine("id = `"$scoutId`"")
        [void]$sb.AppendLine("provider = `"$scoutProvider`"")
        [void]$sb.AppendLine("model = `"$scoutModel`"")
        [void]$sb.AppendLine('# effort = "xhigh"')
        [void]$sb.AppendLine("worktree = `"$pmRoot/_scouts/$scoutId`"")
        [void]$sb.AppendLine("idle_task = $idleTaskValue")
        [void]$sb.AppendLine('idle_interval_hours = 24')
        [void]$sb.AppendLine('')
    }
    foreach ($e in $smithEntries) {
        $smithId = Get-EntryId $e
        $smithProvider = Get-EntryProvider $e
        $smithModel = Get-EntryModel $e
        [void]$sb.AppendLine('[[smiths]]')
        [void]$sb.AppendLine("id = `"$smithId`"")
        [void]$sb.AppendLine("provider = `"$smithProvider`"")
        [void]$sb.AppendLine("model = `"$smithModel`"")
        [void]$sb.AppendLine('# effort = "xhigh"')
        [void]$sb.AppendLine("worktree = `"$pmRoot/_smiths/$smithId`"")
        [void]$sb.AppendLine('')
    }
    [void]$sb.AppendLine('# === Lane selection (DEC-056) ===')
    [void]$sb.AppendLine('#')
    [void]$sb.AppendLine('# Lane assumed when runtime/lane.lock is absent. "dock"')
    [void]$sb.AppendLine('# (default) = the parallel pipeline; "artisan" = the single-agent')
    [void]$sb.AppendLine('# Artisan lane runs by default (small projects). An explicit')
    [void]$sb.AppendLine('# lane.lock still overrides this per task.')
    [void]$sb.AppendLine('[lanes]')
    [void]$sb.AppendLine("default = `"$DefaultLane`"")
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('# === Artisan (artisan lane) ===')
    [void]$sb.AppendLine('#')
    [void]$sb.AppendLine('# The Artisan performs the combined Dock + Worker + Scout + Smith +')
    [void]$sb.AppendLine('# Librarian scope by ITSELF — build, investigation/web research, and')
    [void]$sb.AppendLine('# knowledge work — on a `satchel` branch, then passes Guardian +')
    [void]$sb.AppendLine('# Observer and integrates into `studio` (DEC-045). SINGLETON: one')
    [void]$sb.AppendLine('# [artisan] table only. Mutually exclusive with the dock lane')
    [void]$sb.AppendLine('# (arbitrated by runtime/lane.lock).')
    $artisanEnabledStr = if ($artisanEnable) { 'true' } else { 'false' }
    [void]$sb.AppendLine('[artisan]')
    [void]$sb.AppendLine("enabled = $artisanEnabledStr")
    [void]$sb.AppendLine("id = `"$artisanId`"")
    [void]$sb.AppendLine("provider = `"$artisanProvider`"")
    [void]$sb.AppendLine("model = `"$artisanModel`"")
    [void]$sb.AppendLine('# effort = "xhigh"')
    [void]$sb.AppendLine("worktree = `"$pmRoot/_artisan`"")
    [void]$sb.AppendLine('branch_namespace = "satchel"')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('# === Librarian definitions (dock lane) ===')
    [void]$sb.AppendLine('#')
    [void]$sb.AppendLine('# One [[librarians]] block per Librarian instance. Knowledge /')
    [void]$sb.AppendLine('# registry / runbook work on a `shelf` branch, merged through')
    [void]$sb.AppendLine('# Dock review. Dock-subordinate; never dispatched by PM.')
    if ($librarianEntries.Count -gt 0) {
        foreach ($e in $librarianEntries) {
            $libId = Get-EntryId $e; $libProvider = Get-EntryProvider $e; $libModel = Get-EntryModel $e
            [void]$sb.AppendLine('[[librarians]]')
            [void]$sb.AppendLine("id = `"$libId`"")
            [void]$sb.AppendLine("provider = `"$libProvider`"")
            [void]$sb.AppendLine("model = `"$libModel`"")
            [void]$sb.AppendLine('enabled = true')
            [void]$sb.AppendLine('# effort = "xhigh"')
            [void]$sb.AppendLine("worktree = `"$pmRoot/_librarians/$libId`"")
            [void]$sb.AppendLine('branch_namespace = "shelf"')
            [void]$sb.AppendLine('')
        }
    } else {
        [void]$sb.AppendLine('# (none configured — add one [[librarians]] block per Librarian)')
        [void]$sb.AppendLine('')
    }
    [void]$sb.AppendLine('# === Observer definitions (read-only review/advice sidecar, DEC-019) ===')
    [void]$sb.AppendLine('#')
    [void]$sb.AppendLine('# One [[observers]] block per Observer. Commit-free; runs in both')
    [void]$sb.AppendLine('# lanes; never takes lane.lock. Gated by [observer_policy] below.')
    if ($observerEntries.Count -gt 0) {
        foreach ($e in $observerEntries) {
            $obsId = Get-EntryId $e; $obsProvider = Get-EntryProvider $e; $obsModel = Get-EntryModel $e
            [void]$sb.AppendLine('[[observers]]')
            [void]$sb.AppendLine("id = `"$obsId`"")
            [void]$sb.AppendLine("provider = `"$obsProvider`"")
            [void]$sb.AppendLine("model = `"$obsModel`"")
            [void]$sb.AppendLine('enabled = true')
            [void]$sb.AppendLine('# effort = "xhigh"')
            [void]$sb.AppendLine("worktree = `"$pmRoot/_observers/$obsId`"")
            [void]$sb.AppendLine('allowed_request_kinds = ["merge_review", "artisan_premerge_review", "direction_advice", "architecture_risk_review", "policy_consistency_review"]')
            [void]$sb.AppendLine('')
        }
    } else {
        [void]$sb.AppendLine('# (none configured — add one [[observers]] block per Observer)')
        [void]$sb.AppendLine('')
    }
    [void]$sb.AppendLine('# === Guardian definitions (security/privacy/dependency/license gate, DEC-024) ===')
    [void]$sb.AppendLine('#')
    [void]$sb.AppendLine('# One [[guardians]] block per Guardian. Commit-free; runs on an')
    [void]$sb.AppendLine('# ephemeral `gavel` branch; gated by [guardian_policy] below.')
    if ($guardianEntries.Count -gt 0) {
        foreach ($e in $guardianEntries) {
            $grdId = Get-EntryId $e; $grdProvider = Get-EntryProvider $e; $grdModel = Get-EntryModel $e
            [void]$sb.AppendLine('[[guardians]]')
            [void]$sb.AppendLine("id = `"$grdId`"")
            [void]$sb.AppendLine("provider = `"$grdProvider`"")
            [void]$sb.AppendLine("model = `"$grdModel`"")
            [void]$sb.AppendLine('enabled = true')
            [void]$sb.AppendLine('# effort = "xhigh"')
            [void]$sb.AppendLine('checkout = true')
            [void]$sb.AppendLine("worktree = `"$pmRoot/_guardians/$grdId`"")
            [void]$sb.AppendLine('allowed_request_kinds = ["preflight", "delta_gate", "final_gate", "promote_gate", "knowledge_update_request"]')
            [void]$sb.AppendLine('')
        }
    } else {
        [void]$sb.AppendLine('# (none configured — add one [[guardians]] block per Guardian)')
        [void]$sb.AppendLine('')
    }
    [void]$sb.AppendLine('# === Concierge definitions (external operations executor, DEC-025) ===')
    [void]$sb.AppendLine('#')
    [void]$sb.AppendLine('# One [[concierges]] block per Concierge. Always checkout=true (external')
    [void]$sb.AppendLine('# operations need live git state); runs on a `clipboard` branch; gated')
    [void]$sb.AppendLine('# by [concierge_policy] below.')
    if ($conciergeEntries.Count -gt 0) {
        foreach ($e in $conciergeEntries) {
            $conId = Get-EntryId $e; $conProvider = Get-EntryProvider $e; $conModel = Get-EntryModel $e
            [void]$sb.AppendLine('[[concierges]]')
            [void]$sb.AppendLine("id = `"$conId`"")
            [void]$sb.AppendLine("provider = `"$conProvider`"")
            [void]$sb.AppendLine("model = `"$conModel`"")
            [void]$sb.AppendLine('enabled = true')
            [void]$sb.AppendLine('# effort = "xhigh"')
            [void]$sb.AppendLine('checkout = true')
            [void]$sb.AppendLine("worktree = `"$pmRoot/_concierges/$conId`"")
            [void]$sb.AppendLine('branch_namespace = "clipboard"')
            [void]$sb.AppendLine('allowed_operation_kinds = ["promote_target", "sync_remote"]')
            [void]$sb.AppendLine('')
        }
    } else {
        [void]$sb.AppendLine('# (none configured — add one [[concierges]] block per Concierge)')
        [void]$sb.AppendLine('')
    }
    [void]$sb.AppendLine('[milestones]')
    [void]$sb.AppendLine('current = []')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('# === Status Web Console (read-only) ===')
    [void]$sb.AppendLine('#')
    [void]$sb.AppendLine('# A local, read-only browser view of Garelier state (lane, roles,')
    [void]$sb.AppendLine('# branches, merge gate, recent reports, warnings, source/routine')
    [void]$sb.AppendLine('# registries). Zero AI tokens — it only reads runtime files. Start it')
    [void]$sb.AppendLine('# with `bun run status -- --pm-id <pm_id>` from the driver directory.')
    [void]$sb.AppendLine('# It binds to loopback only and never mutates state.')
    [void]$sb.AppendLine('[status_web]')
    [void]$sb.AppendLine('enabled = false              # informational; the standalone command runs regardless')
    [void]$sb.AppendLine('host = "127.0.0.1"           # loopback only; non-loopback values are rejected')
    [void]$sb.AppendLine('port = 3787')
    [void]$sb.AppendLine('auto_refresh_seconds = 5')
    [void]$sb.AppendLine('read_only = true             # phase 1 is read-only; no operation UI')
    [void]$sb.AppendLine('show_source_urls = true      # false => show only the host of source registry URLs')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('# === Retention (high-volume operation) ===')
    [void]$sb.AppendLine('#')
    [void]$sb.AppendLine('# Defaults from garelier-core/retention.md. Tune when daily reports,')
    [void]$sb.AppendLine('# Scout inspections, or runtime archives become high-volume.')
    [void]$sb.AppendLine('[retention]')
    [void]$sb.AppendLine('history_hot_entries = 120')
    [void]$sb.AppendLine('history_archive_granularity = "month"')
    [void]$sb.AppendLine('inspection_path_granularity = "month"')
    [void]$sb.AppendLine('inspection_monthly_summary = true')
    [void]$sb.AppendLine('runtime_archive_keep_days = 30')
    [void]$sb.AppendLine('runtime_archive_keep_files = 300')
    [void]$sb.AppendLine('merge_gate_archive_keep_days = 14')
    [void]$sb.AppendLine('role_local_archive_keep_days = 30')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('# === Execution backend (DEC-042) ===')
    [void]$sb.AppendLine('#')
    [void]$sb.AppendLine('# This axis only configures the now-DISABLED headless driver (DEC-061: the driver')
    [void]$sb.AppendLine('# refuses to launch in this dispatch-only build; retained as historical/reference).')
    [void]$sb.AppendLine('# It does NOT affect dispatch. Model + effort stay your per-role choice; this NEVER')
    [void]$sb.AppendLine('# tiers/downgrades. Provider terms and billing are the operator''s responsibility.')
    [void]$sb.AppendLine('#   headless (driver path, DISABLED per DEC-061) — classic "claude -p". An absent')
    [void]$sb.AppendLine('#       [execution] section also defaults to headless (back-compat).')
    [void]$sb.AppendLine('#   codex — run iterations with the Codex CLI ("codex exec") instead. A per-role')
    [void]$sb.AppendLine('#       provider = "codex-cli" is also respected.')
    [void]$sb.AppendLine('[execution]')
    [void]$sb.AppendLine('backend = "headless"')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('# === Concurrency cap (DEC-027) ===')
    [void]$sb.AppendLine('#')
    [void]$sb.AppendLine('# A memory bound on how many detached provider CLIs run at once. Enabling')
    [void]$sb.AppendLine('# every role is encouraged for governance, but launching them all at once')
    [void]$sb.AppendLine('# can exhaust machine memory. The driver counts live detached children each')
    [void]$sb.AppendLine('# poll and launches at most max_concurrent_agents; over-budget roles are')
    [void]$sb.AppendLine('# deferred to a later poll (and aged so a low-priority role can''t starve).')
    [void]$sb.AppendLine('# PM, Dock, and the merge-gate subprocess are NOT counted here.')
    [void]$sb.AppendLine('#')
    [void]$sb.AppendLine('# Rough rule of thumb: ~1.5-2 GB RAM per concurrent provider CLI. 4 suits')
    [void]$sb.AppendLine('# an 8-16 GB machine. Set max_concurrent_agents = 0 to disable the cap.')
    [void]$sb.AppendLine('[concurrency]')
    [void]$sb.AppendLine('max_concurrent_agents = 4')
    [void]$sb.AppendLine('tiers = [["concierge", "guardian", "observer"], ["smith", "librarian"], ["worker", "scout", "artisan"], []]')
    [void]$sb.AppendLine('starvation_cycles = 3')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('# === Output control (DEC-028) ===')
    [void]$sb.AppendLine('#')
    [void]$sb.AppendLine('# Keeps provider FINAL responses short and driver logs from bloating, on top')
    [void]$sb.AppendLine('# of compact-handoff + retention. Over-budget responses are WARNED, not failed.')
    [void]$sb.AppendLine('# Never shortens code/paths/commands/URLs/errors/SHAs, never hides risks.')
    [void]$sb.AppendLine('[output_control]')
    [void]$sb.AppendLine('enabled = true')
    [void]$sb.AppendLine('default_profile = "compact"          # normal | compact | micro')
    [void]$sb.AppendLine('violation_mode = "warn"              # warn (observe) | fail (experimental)')
    [void]$sb.AppendLine('model_result_log_chars = 600         # excerpt cap in driver JSONL (100-5000)')
    [void]$sb.AppendLine('error_tail_chars = 500')
    [void]$sb.AppendLine('driver_log_max_bytes = 10485760      # rotate JSONL past this size')
    [void]$sb.AppendLine('driver_log_keep_files = 10')
    [void]$sb.AppendLine('usage_summary = true                 # runtime/driver/usage/YYYY-MM.jsonl')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('[output_control.profiles.normal]')
    [void]$sb.AppendLine('soft_result_chars = 1600')
    [void]$sb.AppendLine('max_bullets = 8')
    [void]$sb.AppendLine('[output_control.profiles.compact]')
    [void]$sb.AppendLine('soft_result_chars = 900')
    [void]$sb.AppendLine('max_bullets = 5')
    [void]$sb.AppendLine('[output_control.profiles.micro]')
    [void]$sb.AppendLine('soft_result_chars = 500')
    [void]$sb.AppendLine('max_bullets = 3')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('# guardian/concierge stay normal so warnings/approvals are not pressured short.')
    [void]$sb.AppendLine('[output_control.roles]')
    [void]$sb.AppendLine('pm = "normal"')
    [void]$sb.AppendLine('dock = "compact"')
    [void]$sb.AppendLine('worker = "compact"')
    [void]$sb.AppendLine('smith = "compact"')
    [void]$sb.AppendLine('artisan = "compact"')
    [void]$sb.AppendLine('scout = "micro"')
    [void]$sb.AppendLine('observer = "micro"')
    [void]$sb.AppendLine('librarian = "compact"')
    [void]$sb.AppendLine('guardian = "normal"')
    [void]$sb.AppendLine('concierge = "normal"')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('# === Optional: Health check ===')
    [void]$sb.AppendLine('#')
    [void]$sb.AppendLine('# Uncomment to enable. PM will perform a stale-state scan when the')
    [void]$sb.AppendLine('# user explicitly invokes a health check (garelier-pm/references/history-and-operations.md §14).')
    [void]$sb.AppendLine('# Thresholds are in hours. Omit any threshold to disable that check.')
    [void]$sb.AppendLine('#')
    [void]$sb.AppendLine('# [health_check]')
    [void]$sb.AppendLine('# worker_working_warn_hours = 24')
    [void]$sb.AppendLine('# worker_blocked_warn_hours = 12')
    [void]$sb.AppendLine('# scout_working_warn_hours = 12')
    [void]$sb.AppendLine('# scout_reporting_warn_hours = 6')
    [void]$sb.AppendLine('# dock_silent_warn_hours = 24')
    [void]$sb.AppendLine('# pending_backlog_warn_hours = 48')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('# === Optional: Autonomous mode ===')
    [void]$sb.AppendLine('#')
    [void]$sb.AppendLine('# Garelier can run unattended for large, long-running roadmaps.')
    [void]$sb.AppendLine('# Set enabled = true to start the driver and skip PM user-confirmation')
    [void]$sb.AppendLine('# gates (per auto_approve_* flags). Promote flow ALWAYS requires')
    [void]$sb.AppendLine('# explicit user instruction; there is no auto_promote flag.')
    [void]$sb.AppendLine('# See DEC-002 (autonomous mode).')
    [void]$sb.AppendLine('#')
    [void]$sb.AppendLine('# [autonomy]')
    [void]$sb.AppendLine('# enabled = false                          # top-level switch (autonomous /loop is opt-in)')
    [void]$sb.AppendLine('# auto_approve_blueprints = false          # PM auto-proceeds on its own judgment (soft-gate collapse)')
    [void]$sb.AppendLine('# auto_approve_milestones = false          # (Mode A''s "proceed when safe" lives here, WITHIN B/D)')
    [void]$sb.AppendLine('#')
    [void]$sb.AppendLine('# # Canonical modes (DEC-059) - Garelier ALWAYS runs an interactive PM.')
    [void]$sb.AppendLine('# # DEFAULT is "d" (dispatch) even when this block is absent; set "b" for the driver.')
    [void]$sb.AppendLine('# mode = "d"                               # "d" = interactive PM + DISPATCH (DEFAULT; in-session subagents)')
    [void]$sb.AppendLine('#                                          # "b" = interactive PM + headless DRIVER (DISABLED, DEC-061; historical/reference)')
    [void]$sb.AppendLine('#')
    [void]$sb.AppendLine('# # Mode B (driver) supervision:')
    [void]$sb.AppendLine('#')
    [void]$sb.AppendLine('# # Mode D (DEC-059 gated Dock auto-loop; see garelier-dock/references/mode-d-tick.md):')
    [void]$sb.AppendLine('# fan_out_cap = 3                          # max parallel producer subagents per tick')
    [void]$sb.AppendLine('# protected_paths = [                      # HARD gates to the human PM (engine-core/protected)')
    [void]$sb.AppendLine('#   "core/engine/**", "Cargo.toml", "Cargo.lock", ".github/**", "infra/**", "deploy/**", "migrations/**",')
    [void]$sb.AppendLine('# ]')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('# === Quality gate (DEC-007) ===')
    [void]$sb.AppendLine('#')
    [void]$sb.AppendLine('# Commands run by the merge-gate subprocess after')
    [void]$sb.AppendLine("# 'git merge --no-ff --no-commit'. Each is a single shell line.")
    [void]$sb.AppendLine('# Failure of any aborts the merge. The subprocess runs in the')
    [void]$sb.AppendLine('# background relative to driver iterations so Workers, Scouts, and Smiths')
    [void]$sb.AppendLine('# continue in parallel during the merge.')
    [void]$sb.AppendLine('#')
    $qgCmds = if ($QualityGate.Count -gt 0) { $QualityGate } else {
        switch ($Stack) {
            'rust'       { @('cargo check --workspace', 'cargo test --workspace', 'cargo clippy --workspace -- -D warnings') }
            'typescript' { @('npm ci', 'npm run typecheck', 'npm test', 'npm run lint') }
            'python'     { @('python -m pip install -e .', 'ruff check .', 'pytest') }
            'go'         { @('go build ./...', 'go vet ./...', 'go test ./...') }
            default      { @() }
        }
    }
    if ($qgCmds.Count -eq 0) {
        Write-Error "Quality gate has no commands. stack='$Stack' has no default set. Pass -Stack rust|typescript|python|go, or -QualityGate '<cmd>' (custom/mixed require explicit commands)."
        exit 1
    }
    if ($PermissionProfile -eq 'dangerous') {
        Write-Host "WARNING: permission profile 'dangerous' grants full provider access (Claude --dangerously-skip-permissions / Codex danger-full-access). Use only in an isolated environment."
    }
    [void]$sb.AppendLine('# Garelier targets any large app, not just Rust. ''stack'' picks a')
    [void]$sb.AppendLine('# default command set; ''commands'' overrides it (explicit wins).')
    [void]$sb.AppendLine('[quality_gate]')
    [void]$sb.AppendLine("stack = `"$Stack`"")
    [void]$sb.AppendLine('commands = [')
    foreach ($c in $qgCmds) { [void]$sb.AppendLine("    `"$c`",") }
    [void]$sb.AppendLine(']')
    [void]$sb.AppendLine('timeout_minutes_per_cmd = 120')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('# === Permissions (autonomy profile) ===')
    [void]$sb.AppendLine('#')
    [void]$sb.AppendLine('# dangerous = full provider access (opt-in). reviewed = auto-accept')
    [void]$sb.AppendLine('# edits / workspace-write. safe = inspection only.')
    [void]$sb.AppendLine('[permissions]')
    [void]$sb.AppendLine("profile = `"$PermissionProfile`"")
    [void]$sb.AppendLine('allow_network = false')
    [void]$sb.AppendLine('allow_destructive_commands = false')
    [void]$sb.AppendLine('allow_secret_read = false')
    [void]$sb.AppendLine('require_pm_approval_paths = [".env*", "infra/**", "migrations/**", ".github/workflows/**", "deploy/**"]')
    [void]$sb.AppendLine('forbidden_paths = ["**/*.pem", "**/*secret*", "**/id_rsa"]')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('# === Observer policy (DEC-019) ===')
    [void]$sb.AppendLine('#')
    [void]$sb.AppendLine('# When Observer review is mandatory. Disabled by default; enable +')
    [void]$sb.AppendLine('# add [[observers]] blocks to gate merges with independent review.')
    [void]$sb.AppendLine('[observer_policy]')
    [void]$sb.AppendLine("enabled = $obsPolicyEnabled")
    [void]$sb.AppendLine('require_for_all_merges = true         # review EVERY merge (worker->guardian->observer->dock); false = review only on the triggers below')
    [void]$sb.AppendLine('require_for_artisan_premerge = true')
    [void]$sb.AppendLine('require_for_large_diff = true')
    [void]$sb.AppendLine('large_diff_lines = 800')
    [void]$sb.AppendLine('require_for_protected_paths = true')
    [void]$sb.AppendLine('require_for_public_api_change = true')
    [void]$sb.AppendLine('require_for_migration = true')
    [void]$sb.AppendLine('require_for_auth_security = true')
    [void]$sb.AppendLine('allow_worker_direction_request = true')
    [void]$sb.AppendLine('max_parallel_requests = 1')
    [void]$sb.AppendLine('advice_is_binding = false')
    [void]$sb.AppendLine('# [[observers]] — one block per Observer; see the setup_config.toml template.')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('# === Guardian policy (DEC-024) ===')
    [void]$sb.AppendLine('#')
    [void]$sb.AppendLine('# Guardian is the security GATE: commit-free, on an ephemeral `gavel`')
    [void]$sb.AppendLine('# branch, reads Librarian-owned security knowledge')
    [void]$sb.AppendLine('# (docs/garelier/security/) and emits PASS / PASS_WITH_NOTES / BLOCK /')
    [void]$sb.AppendLine('# NO_OPINION. Disabled by default; enable + add [[guardians]] blocks.')
    [void]$sb.AppendLine('[guardian_policy]')
    [void]$sb.AppendLine("enabled = $grdPolicyEnabled")
    [void]$sb.AppendLine('require_for_all_merges = true         # security-gate EVERY merge (guardian step of worker->guardian->observer->dock); false = gate only on the mechanical triggers below')
    [void]$sb.AppendLine('branch_namespace = "gavel"')
    [void]$sb.AppendLine('# Gate timings (delta is the core; preflight/final are staged).')
    [void]$sb.AppendLine('require_delta_before_observer = true')
    [void]$sb.AppendLine('require_final_before_merge = true')
    [void]$sb.AppendLine('require_for_artisan_premerge = true')
    [void]$sb.AppendLine('require_for_promote = true')
    [void]$sb.AppendLine('# Mechanical triggers (when a gate is mandatory).')
    [void]$sb.AppendLine('require_for_dependency_changes = true')
    [void]$sb.AppendLine('require_for_lockfile_changes = true')
    [void]$sb.AppendLine('require_for_auth_security = true')
    [void]$sb.AppendLine('require_for_config_infra_ci_deploy = true')
    [void]$sb.AppendLine('require_for_protected_paths = true')
    [void]$sb.AppendLine('# Blocking rules.')
    [void]$sb.AppendLine('block_on_secret = true')
    [void]$sb.AppendLine('block_on_pii = true')
    [void]$sb.AppendLine('block_on_customer_data = true')
    [void]$sb.AppendLine('block_on_private_key = true')
    [void]$sb.AppendLine('block_on_critical_vulnerability = true')
    [void]$sb.AppendLine('block_on_high_vulnerability = true')
    [void]$sb.AppendLine('block_on_forbidden_license = true')
    [void]$sb.AppendLine('block_on_unknown_license = false')
    [void]$sb.AppendLine('block_when_required_scanner_unavailable = true')
    [void]$sb.AppendLine('# Output safety.')
    [void]$sb.AppendLine('redact_evidence = true')
    [void]$sb.AppendLine('forbid_secret_value_in_report = true')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('[guardian_policy.security_sensitive_paths]')
    [void]$sb.AppendLine('paths = [".env*", "**/*.pem", "**/*.key", "**/*secret*", "**/*credential*", "infra/**", "deploy/**", ".github/workflows/**", "migrations/**"]')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('[guardian_policy.package_files]')
    [void]$sb.AppendLine('paths = ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.toml", "Cargo.lock", "requirements.txt", "pyproject.toml", "poetry.lock", "go.mod", "go.sum"]')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('# Scanner commands. Empty = Guardian uses available project tools and')
    [void]$sb.AppendLine('# reports NO_OPINION/BLOCK per policy if a required command is missing.')
    [void]$sb.AppendLine('# If gitleaks cannot be used, PM may set:')
    [void]$sb.AppendLine('#   block_when_required_scanner_unavailable = false')
    [void]$sb.AppendLine('#   secret_scan = "off"')
    [void]$sb.AppendLine('# Guardian then runs in degraded mode and must report that scanner coverage')
    [void]$sb.AppendLine('# was intentionally disabled; it must not claim full secret-scanner coverage.')
    [void]$sb.AppendLine('[guardian_tools]')
    [void]$sb.AppendLine('secret_scan = "gitleaks detect --no-banner --redact --source ."')
    [void]$sb.AppendLine('pii_scan = ""')
    [void]$sb.AppendLine('dependency_scan = ""')
    [void]$sb.AppendLine('license_scan = ""')
    [void]$sb.AppendLine('sast_scan = ""')
    [void]$sb.AppendLine('# [[guardians]] — one block per Guardian; see the setup_config.toml template.')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('# === Concierge policy (external operations executor, DEC-025) ===')
    [void]$sb.AppendLine('#')
    [void]$sb.AppendLine('# Concierge EXECUTES PM-approved operations that leave Garelier''s local')
    [void]$sb.AppendLine('# sandbox (Phase 1: promote_target + read-only sync_remote). Reads')
    [void]$sb.AppendLine('# Librarian-owned docs/garelier/external_operations/ and consumes the')
    [void]$sb.AppendLine('# Guardian promote_gate verdict. Disabled by default; enable + add')
    [void]$sb.AppendLine('# [[concierges]] blocks. Enabling does NOT auto-push — external writes')
    [void]$sb.AppendLine('# still require an explicit user instruction behind the PM assignment.')
    [void]$sb.AppendLine('[concierge_policy]')
    [void]$sb.AppendLine("enabled = $conPolicyEnabled")
    [void]$sb.AppendLine('branch_namespace = "clipboard"')
    [void]$sb.AppendLine('require_pm_approval = true')
    [void]$sb.AppendLine('require_user_instruction_for_write = true')
    [void]$sb.AppendLine('require_librarian_policy_sources = true')
    [void]$sb.AppendLine('require_guardian_before_external_write = true')
    [void]$sb.AppendLine('require_external_lock = true')
    [void]$sb.AppendLine('forbid_push_garelier_branches = true')
    [void]$sb.AppendLine('forbid_force_push = true')
    [void]$sb.AppendLine('forbid_blind_git_pull = true')
    [void]$sb.AppendLine('redact_sensitive_output = true')
    [void]$sb.AppendLine('# Remote-visible work uses these prefixes — never garelier/* (Phase 2).')
    [void]$sb.AppendLine('allowed_external_branch_prefixes = ["publish/", "pr/", "release/"]')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('[concierge_policy.required_knowledge]')
    [void]$sb.AppendLine('paths = [')
    [void]$sb.AppendLine('    "docs/garelier/external_operations/external_operations_policy.md",')
    [void]$sb.AppendLine('    "docs/garelier/external_operations/git_remote_policy.md",')
    [void]$sb.AppendLine('    "docs/garelier/external_operations/promote_policy.md",')
    [void]$sb.AppendLine('    "docs/garelier/external_operations/rollback_policy.md",')
    [void]$sb.AppendLine(']')
    [void]$sb.AppendLine('# [[concierges]] — one block per Concierge; see the setup_config.toml template.')
    Write-Utf8File -RelativePath "$pmRoot/_pm/setup_config.toml" -Content $sb.ToString()
    Write-Host "  + $pmRoot/_pm/setup_config.toml written"

    Write-Host ''
    Write-Host "==> Generating $pmRoot/_pm/.claude/settings.json (SessionStart digest)..."
    # DEC-066: the SessionEnd hook that touched runtime/driver/stop is gone —
    # the headless driver it signalled was deleted; nothing reads a stop file.
    New-Item -ItemType Directory -Path "$pmRoot/_pm/.claude" -Force | Out-Null
    $hookJson = @'
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash \"$HOME/.claude/skills/garelier-core/scripts/session_digest.sh\" 2>/dev/null || true"
          }
        ]
      }
    ]
  }
}
'@
    Write-Utf8File -RelativePath "$pmRoot/_pm/.claude/settings.json" -Content $hookJson
    Write-Host "  + $pmRoot/_pm/.claude/settings.json written (SessionStart shows a token-free status digest)"

    Write-Host ''
    Write-Host "==> Generating $pmRoot/_pm/history.md..."
    $hb = [System.Text.StringBuilder]::new()
    [void]$hb.AppendLine("# Garelier PM History — $script:PmId")
    [void]$hb.AppendLine('')
    [void]$hb.AppendLine('Hot index of blueprints PM has dispatched. PM appends here while')
    [void]$hb.AppendLine('entries are active/recent, then rotates old completed entries into')
    [void]$hb.AppendLine('_pm/history/archive/YYYY-MM.md per garelier-core/retention.md.')
    [void]$hb.AppendLine('')
    [void]$hb.AppendLine('Entries are numbered sequentially. The number is also the')
    [void]$hb.AppendLine('user-visible reference for re-execution ("re-run #042").')
    [void]$hb.AppendLine('')
    [void]$hb.AppendLine('## Archived history')
    [void]$hb.AppendLine('')
    [void]$hb.AppendLine('(none yet)')
    [void]$hb.AppendLine('')
    [void]$hb.AppendLine("## #001 — $now — Project initialized")
    [void]$hb.AppendLine('- Blueprint: -')
    [void]$hb.AppendLine('- Milestone: -')
    [void]$hb.AppendLine('- Outcome: setup-only (no blueprint dispatched)')
    [void]$hb.AppendLine("- Notes: PM `"$script:PmId`" for project `"$ProjectName`" initialized by setup_wizard. target=$Target, integration=$script:StudioBranch")
    [void]$hb.AppendLine('')
    [void]$hb.AppendLine('<!-- Next entry number: 2 -->')
    Write-Utf8File -RelativePath "$pmRoot/_pm/history.md" -Content $hb.ToString()
    Write-Host "  + $pmRoot/_pm/history.md written"

    Write-Host ''
    Write-Host "==> Generating initial $pmRoot/runtime/manifest.md..."
    $mb = [System.Text.StringBuilder]::new()
    [void]$mb.AppendLine("# Runtime Manifest — $script:PmId")
    [void]$mb.AppendLine('')
    [void]$mb.AppendLine("Last updated: $now")
    [void]$mb.AppendLine('Updated by: setup_wizard')
    [void]$mb.AppendLine('Garelier version: 2.7.1')
    [void]$mb.AppendLine("PM: $script:PmId")
    [void]$mb.AppendLine("Target branch: $Target")
    [void]$mb.AppendLine("Integration (studio) branch: $script:StudioBranch")
    [void]$mb.AppendLine('')
    [void]$mb.AppendLine('## Active milestones')
    [void]$mb.AppendLine('')
    [void]$mb.AppendLine('(none yet — PM will define after setup)')
    [void]$mb.AppendLine('')
    [void]$mb.AppendLine('## Dispatch execution')
    [void]$mb.AppendLine('')
    [void]$mb.AppendLine('Execution state is derived (DEC-064 W-011): see `backlog/in_flight.md`')
    [void]$mb.AppendLine('(generated) and `dispatch/events.jsonl`. This file tracks milestones,')
    [void]$mb.AppendLine('backlog totals, escalations, and recent activity only.')
    [void]$mb.AppendLine('')
    [void]$mb.AppendLine('## Backlog summary')
    [void]$mb.AppendLine('')
    [void]$mb.AppendLine('- Pending: 0 items')
    [void]$mb.AppendLine('- In flight: 0 items')
    [void]$mb.AppendLine('- Smith hardening targets remaining: 0 (pending 0, active 0)')
    [void]$mb.AppendLine('- Done this milestone: 0 items')
    [void]$mb.AppendLine('')
    [void]$mb.AppendLine('## Open escalations')
    [void]$mb.AppendLine('')
    [void]$mb.AppendLine('(none)')
    [void]$mb.AppendLine('')
    [void]$mb.AppendLine('## Recent activity')
    [void]$mb.AppendLine('')
    [void]$mb.AppendLine("- $now — setup_wizard — PM $script:PmId initialized ($ProjectName)")
    Write-Utf8File -RelativePath "$pmRoot/runtime/manifest.md" -Content $mb.ToString()
    Write-Host "  + $pmRoot/runtime/manifest.md written"

    Write-Host ''
    Write-Host '==> Writing nested __garelier/.gitignore + .ignore (DEC-051; root untouched)...'
    Write-GarelierNestedIgnores

    Write-Host ''
    Write-Host '==> Creating AGENTS.md skeleton...'
    if (Test-Path -Path 'AGENTS.md' -PathType Leaf) {
        Write-Host '  ~ AGENTS.md already exists (skipping)'
    } else {
        $agentsTemplate = Join-Path $coreTemplateRoot 'agents.md'
        if (Test-Path -Path $agentsTemplate -PathType Leaf) {
            # Pre-fill §1 language / build / test from -Stack so a fresh
            # AGENTS.md needs no manual edit for the derivable parts. Only
            # project-specific fields (restricted files, conventions) remain.
            switch ($Stack) {
                'rust'       { $agLang = 'Rust';       $agBuild = 'cargo build --workspace'; $agTest = 'cargo test --workspace' }
                'typescript' { $agLang = 'TypeScript'; $agBuild = 'npm run build';            $agTest = 'npm test' }
                'python'     { $agLang = 'Python';     $agBuild = 'python -m build';          $agTest = 'pytest' }
                'go'         { $agLang = 'Go';         $agBuild = 'go build ./...';           $agTest = 'go test ./...' }
                default      { $agLang = '(edit: project language(s))'; $agBuild = '(see Quality gate below)'; $agTest = '(see Quality gate below)' }
            }
            $content = [System.IO.File]::ReadAllText($agentsTemplate) `
                -replace '\{\{project_name\}\}', $ProjectName `
                -replace '\{\{target_branch\}\}', $Target `
                -replace '\{\{target_slug\}\}', $targetSlug `
                -replace '\{\{pm_id\}\}', $script:PmId `
                -replace '\{\{e\.g\., Rust, TypeScript, Python\}\}', $agLang `
                -replace '\{\{e\.g\., cargo build, npm run build\}\}', $agBuild `
                -replace '\{\{e\.g\., cargo test, npm test\}\}', $agTest `
                -replace '\{\{e\.g\., cargo run --bin check_assets\}\}', '(none — configure if this project has an asset check)'
            # -AgentsPolicy minimal: fill the remaining project-specific
            # placeholders with safe initial values so doctor passes with no
            # P0. strict (default) leaves them for the human to complete.
            if ($AgentsPolicy -eq 'minimal') {
                $content = $content `
                    -replace '\{\{file_path_or_glob\}\}', '(none initially)' `
                    -replace '\{\{worker_id\}\}', '-' `
                    -replace '\{\{reason\}\}', 'add conflict-prone files here as they emerge' `
                    -replace '\{\{convention_1\}\}', 'Follow the existing project style and conventions.' `
                    -replace '\{\{convention_2\}\}', '(add project-specific conventions as they emerge)'
                # Collapse the one remaining multi-line {{...}} block (bilingual
                # policy, §8) — the only placeholder that spans lines. The
                # newline requirement leaves the single-line
                # {{quality_gate_command_*}} placeholders for the loop below.
                $content = [regex]::Replace($content, '\{\{[^}]*\n[^}]*\}\}', 'Follow the existing documentation language conventions.')
            }
            # Replace the two {{quality_gate_command_*}} lines with the
            # resolved quality gate command set.
            $agLines = $content -split "`r?`n"
            $agRebuilt = New-Object System.Collections.Generic.List[string]
            foreach ($l in $agLines) {
                if ($l -match '\{\{quality_gate_command_1\}\}') {
                    foreach ($c in $qgCmds) { $agRebuilt.Add($c) }
                } elseif ($l -match '\{\{quality_gate_command_2\}\}') {
                    # drop
                } else {
                    $agRebuilt.Add($l)
                }
            }
            Write-Utf8File -RelativePath 'AGENTS.md' -Content ($agRebuilt -join "`n")
            if ($AgentsPolicy -eq 'minimal') {
                Write-Host "  + AGENTS.md created from template (stack=$Stack; agents-policy=minimal — all placeholders filled with safe defaults)"
            } else {
                Write-Host "  + AGENTS.md created from template (stack=$Stack; language + quality gate pre-filled; restricted files / conventions left as placeholders — edit before launch)"
            }
        } else {
            Write-Warning "agents.md template not found at $agentsTemplate"
        }
    }

    Write-Host ''
    Write-Host '==> Writing setup completion marker...'
    $markerNow = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    $markerBlock = "`n" +
        "# === Setup completion marker ===`n" +
        "#`n" +
        "# Written as the wizard's last step. PM treats this project as`n" +
        "# fully initialized only when [setup] complete = true is present.`n" +
        "# Absence of this section indicates a partial (interrupted) install`n" +
        "# and the wizard will offer to clean up before retrying fresh init.`n" +
        "`n" +
        "[setup]`n" +
        "complete = true`n" +
        "completed_at = `"$markerNow`"`n" +
        "wizard_version = `"2.7.1`"`n"
    Add-Utf8File -RelativePath "$pmRoot/_pm/setup_config.toml" -Content $markerBlock
    Write-Host '  + [setup] complete = true appended to setup_config.toml'

    Write-Host ''
    Write-Host '==================================='
    Write-Host 'Garelier setup complete (fresh).'
    Write-Host '==================================='
    Write-Host ''
    Write-Host 'Next steps:'
    Write-Host '  1. Edit AGENTS.md and replace the remaining project-specific {{...}}'
    Write-Host '     fields (restricted files §3, conventions §10). Doctor flags any'
    Write-Host '     remaining {{placeholder}} as P0 — do not arm the dispatch loop'
    Write-Host '     until it is clean. Language and quality gate are pre-filled.'
    Write-Host '  2. Commit the initial state (local-only — do NOT push):'
    Write-Host "       git add AGENTS.md __garelier/.gitignore __garelier/.ignore $pmRoot/_pm/ $pmRoot/control/"
    Write-Host "       git commit -m 'Garelier: initialize PM $script:PmId (v2.7.1)'"
    Write-Host "     ($($script:StudioBranch) stays local per protocol.md §6.5; only <target> is pushed at promote.)"
    Write-Host '  3. Launch the PM/Dock session with the configured provider:'
    Write-Host "       cd $pmRoot/_pm; claude   # or codex after reading the PM skill docs"
    Write-Host '     Producers run as in-session subagents in ephemeral _dispatch<N>/'
    Write-Host '     homes; no separate Dock session is needed (DEC-061/065).'

} elseif ($Mode -eq 'Migrate') {

    # === MIGRATE MODE ===

    $null = git rev-parse --is-inside-work-tree 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Error "$projectRoot is not inside a git repository."
        exit 1
    }

    # Two migration paths:
    #   (a) flat v2.0 layout (__garelier/_pm/...) -> per-PM (v2.1), then DEC-020 nesting.
    #   (b) already per-PM but worktrees not yet nested -> DEC-020 nesting only.
    if (-not (Test-Path '__garelier/_pm/setup_config.toml' -PathType Leaf)) {
        $script:PmId = $PmId
        Resolve-PmIdInteractive
        $pmRoot = "__garelier/$script:PmId"
        if (-not (Test-Path "$pmRoot/_pm/setup_config.toml" -PathType Leaf)) {
            Write-Error "No Garelier install found to migrate. Expected a flat v2.0 layout (__garelier/_pm/setup_config.toml) or a per-PM layout ($pmRoot/_pm/setup_config.toml)."
            exit 1
        }
        if (Test-WsUseExile) {
            Write-Host 'Garelier migration: relocating role worktrees to the machine-local studio home (exile, opt-in)'
        } else {
            Write-Host 'Garelier migration: relocating role worktrees back into the project (DEC-036, default)'
        }
        Write-Host "  Project root:  $projectRoot"
        Write-Host "  PM identifier: $script:PmId"
        Write-Host ''
        Write-Host "  Each role worktree is moved between its in-project container"
        Write-Host "  (__garelier/$script:PmId/_<role>/<id>/checkout) and its machine-local exile"
        Write-Host '  home; coordination files ride along. Roles with uncommitted tracked changes'
        Write-Host '  are skipped - commit them, then re-run.'
        if (-not $SkipConfirm) {
            $response = Read-Host 'Proceed? [y/N]'
            if ($response -notmatch '^[yY]') { Write-Host 'Aborted.'; exit 0 }
        }
        $ok = Invoke-Relocate
        Write-Host ''
        Write-Host "Relocation done for pm_id=$script:PmId. Review with: git status"
        if ($ok) { exit 0 } else { exit 1 }
    }

    $oldTarget = Read-TomlValueFrom -TomlPath '__garelier/_pm/setup_config.toml' -Section 'branches' -Key 'target'
    $oldTargetSlug = Read-TomlValueFrom -TomlPath '__garelier/_pm/setup_config.toml' -Section 'branches' -Key 'target_slug'
    $oldStudio = Read-TomlValueFrom -TomlPath '__garelier/_pm/setup_config.toml' -Section 'branches' -Key 'integration'
    if ([string]::IsNullOrWhiteSpace($oldTarget) -or [string]::IsNullOrWhiteSpace($oldTargetSlug) -or [string]::IsNullOrWhiteSpace($oldStudio)) {
        Write-Error 'Could not read [branches] from __garelier/_pm/setup_config.toml.'
        exit 1
    }

    $script:PmId = $PmId
    Resolve-PmIdInteractive
    $pmRoot = "__garelier/$script:PmId"

    if (Test-Path $pmRoot) {
        Write-Error "$pmRoot/ already exists; pick a different -PmId."
        exit 1
    }

    $newStudio = "garelier/$oldTargetSlug/$script:PmId/studio"
    $null = git rev-parse --verify $newStudio 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Error "Target branch $newStudio already exists; pick a different -PmId."
        exit 1
    }

    Write-Host ''
    Write-Host 'Garelier migration plan (v2.0 -> v2.1)'
    Write-Host '======================================='
    Write-Host "  Project root:        $projectRoot"
    Write-Host "  PM identifier:       $script:PmId"
    Write-Host "  Old studio branch:   $oldStudio"
    Write-Host "  New studio branch:   $newStudio"
    Write-Host ''
    Write-Host '  Filesystem moves (git-tracked via git mv):'
    Write-Host "    __garelier/_pm        -> $pmRoot/_pm"
    Write-Host "    __garelier/_dock -> $pmRoot/_dock"
    Write-Host "    __garelier/control    -> $pmRoot/control"
    Write-Host ''
    Write-Host '  Worktree moves (git worktree move):'
    if (Test-Path '__garelier/_workers' -PathType Container) {
        Get-ChildItem -Path '__garelier/_workers' -Directory | ForEach-Object {
            Write-Host "    __garelier/_workers/$($_.Name) -> $pmRoot/_workers/$($_.Name)"
        }
    }
    if (Test-Path '__garelier/_scouts' -PathType Container) {
        Get-ChildItem -Path '__garelier/_scouts' -Directory | ForEach-Object {
            Write-Host "    __garelier/_scouts/$($_.Name) -> $pmRoot/_scouts/$($_.Name)"
        }
    }
    if (Test-Path '__garelier/_smiths' -PathType Container) {
        Get-ChildItem -Path '__garelier/_smiths' -Directory | ForEach-Object {
            Write-Host "    __garelier/_smiths/$($_.Name) -> $pmRoot/_smiths/$($_.Name)"
        }
    }
    if (Test-Path '__garelier/runtime' -PathType Container) {
        Write-Host '  Plain mv (gitignored):'
        Write-Host "    __garelier/runtime -> $pmRoot/runtime"
    }
    Write-Host ''
    Write-Host '  Branch renames (git branch -m):'
    Write-Host "    $oldStudio -> $newStudio"
    $oldWb = git for-each-ref --format='%(refname:short)' "refs/heads/garelier/$oldTargetSlug/workbench/*" 2>$null
    if ($LASTEXITCODE -eq 0 -and $oldWb) {
        foreach ($br in ($oldWb -split "`r?`n")) {
            $br = $br.Trim()
            if (-not $br) { continue }
            $suffix = $br.Substring("garelier/$oldTargetSlug/workbench/".Length)
            Write-Host "    $br -> garelier/$oldTargetSlug/$script:PmId/workbench/$suffix"
        }
    }
    Write-Host ''

    if (-not $SkipConfirm) {
        $resp = Read-Host 'Proceed? [y/N]'
        if ($resp -notmatch '^[yY]') {
            Write-Host 'Aborted.'; exit 0
        }
    }

    New-Item -ItemType Directory -Path $pmRoot -Force | Out-Null

    Write-Host ''
    Write-Host '==> Moving tracked directories via git mv...'
    foreach ($d in @('_pm', '_dock', 'control')) {
        if (Test-Path "__garelier/$d") {
            git mv "__garelier/$d" "$pmRoot/$d"
            Write-Host "  + git mv __garelier/$d -> $pmRoot/$d"
        }
    }

    Write-Host ''
    Write-Host '==> Moving worktrees via git worktree move...'
    if (Test-Path '__garelier/_workers' -PathType Container) {
        New-Item -ItemType Directory -Path "$pmRoot/_workers" -Force | Out-Null
        Get-ChildItem -Path '__garelier/_workers' -Directory | ForEach-Object {
            $wid = $_.Name
            git worktree move "__garelier/_workers/$wid" "$pmRoot/_workers/$wid"
            Write-Host "  + worker $wid -> $pmRoot/_workers/$wid"
        }
        if ((Get-ChildItem -Path '__garelier/_workers' -Force | Measure-Object).Count -eq 0) {
            Remove-Item -Path '__garelier/_workers' -Force
        }
    }
    if (Test-Path '__garelier/_scouts' -PathType Container) {
        New-Item -ItemType Directory -Path "$pmRoot/_scouts" -Force | Out-Null
        Get-ChildItem -Path '__garelier/_scouts' -Directory | ForEach-Object {
            $sid = $_.Name
            git worktree move "__garelier/_scouts/$sid" "$pmRoot/_scouts/$sid"
            Write-Host "  + scout $sid -> $pmRoot/_scouts/$sid"
        }
        if ((Get-ChildItem -Path '__garelier/_scouts' -Force | Measure-Object).Count -eq 0) {
            Remove-Item -Path '__garelier/_scouts' -Force
        }
    }
    if (Test-Path '__garelier/_smiths' -PathType Container) {
        New-Item -ItemType Directory -Path "$pmRoot/_smiths" -Force | Out-Null
        Get-ChildItem -Path '__garelier/_smiths' -Directory | ForEach-Object {
            $smid = $_.Name
            git worktree move "__garelier/_smiths/$smid" "$pmRoot/_smiths/$smid"
            Write-Host "  + smith $smid -> $pmRoot/_smiths/$smid"
        }
        if ((Get-ChildItem -Path '__garelier/_smiths' -Force | Measure-Object).Count -eq 0) {
            Remove-Item -Path '__garelier/_smiths' -Force
        }
    }

    Write-Host ''
    Write-Host '==> Moving runtime/ (gitignored)...'
    if (Test-Path '__garelier/runtime' -PathType Container) {
        Move-Item -Path '__garelier/runtime' -Destination "$pmRoot/runtime"
        Write-Host "  + mv __garelier/runtime -> $pmRoot/runtime"
    }

    Write-Host ''
    Write-Host '==> Renaming branches...'
    $null = git rev-parse --verify $oldStudio 2>$null
    if ($LASTEXITCODE -eq 0) {
        git branch -m $oldStudio $newStudio
        Write-Host "  + $oldStudio -> $newStudio"
    }
    $oldWb2 = git for-each-ref --format='%(refname:short)' "refs/heads/garelier/$oldTargetSlug/workbench/*" 2>$null
    if ($LASTEXITCODE -eq 0 -and $oldWb2) {
        foreach ($br in ($oldWb2 -split "`r?`n")) {
            $br = $br.Trim()
            if (-not $br) { continue }
            $suffix = $br.Substring("garelier/$oldTargetSlug/workbench/".Length)
            $newBr = "garelier/$oldTargetSlug/$script:PmId/workbench/$suffix"
            git branch -m $br $newBr
            Write-Host "  + $br -> $newBr"
        }
    }

    Write-Host ''
    Write-Host "==> Patching $pmRoot/_pm/setup_config.toml..."
    $tomlPath = "$pmRoot/_pm/setup_config.toml"
    $tomlLines = Get-Content -LiteralPath $tomlPath
    $hasPmSection = $false
    foreach ($line in $tomlLines) { if ($line -match '^\[pm\]') { $hasPmSection = $true; break } }
    $output = New-Object System.Collections.Generic.List[string]
    $inProject = $false
    $inserted = $false
    foreach ($line in $tomlLines) {
        if ($line -match '^\[project\]') {
            $inProject = $true
            $output.Add($line)
            continue
        }
        if ($line -match '^\[' -and $inProject -and -not $inserted -and -not $hasPmSection) {
            $output.Add('[pm]')
            $output.Add("pm_id = `"$script:PmId`"")
            $output.Add('')
            $inserted = $true
            $inProject = $false
            $output.Add($line)
            continue
        }
        if ($line -match '^\[') {
            $inProject = $false
        }
        # Rewrite integration / worktree / version lines as we go.
        $rewrite = $line
        if ($rewrite -match "^integration\s*=\s*`"$([regex]::Escape($oldStudio))`"$") {
            $rewrite = "integration = `"$newStudio`""
        }
        if ($rewrite -match '^worktree\s*=\s*"__garelier/_workers/') {
            $rewrite = $rewrite -replace '"__garelier/_workers/', "`"$pmRoot/_workers/"
        }
        if ($rewrite -match '^worktree\s*=\s*"__garelier/_scouts/') {
            $rewrite = $rewrite -replace '"__garelier/_scouts/', "`"$pmRoot/_scouts/"
        }
        if ($rewrite -match '^worktree\s*=\s*"__garelier/_smiths/') {
            $rewrite = $rewrite -replace '"__garelier/_smiths/', "`"$pmRoot/_smiths/"
        }
        if ($rewrite -match '^garelier_version\s*=\s*"2\.([015]\.0|6\.[012345])"') {
            $rewrite = 'garelier_version = "2.7.1"'
        }
        if ($rewrite -match '^wizard_version\s*=\s*"2\.([015]\.0|6\.[012345])"') {
            $rewrite = 'wizard_version = "2.7.1"'
        }
        $output.Add($rewrite)
    }
    if (-not $hasPmSection -and -not $inserted) {
        # [project] was the last section; append [pm] at end.
        $output.Add('')
        $output.Add('[pm]')
        $output.Add("pm_id = `"$script:PmId`"")
    }
    Write-Utf8File -RelativePath $tomlPath -Content (($output -join "`n") + "`n")
    Write-Host "  + $tomlPath updated (pm_id, integration, worktree paths, version)"

    # Append blocks introduced after v2.0 (artisan/librarian/status web) if
    # the migrated config predates them. Top-level tables are order-independent.
    $migAppend = [System.Text.StringBuilder]::new()
    if (-not (@($output -match '^\[artisan\]').Count -gt 0)) {
        [void]$migAppend.AppendLine('')
        [void]$migAppend.AppendLine('# === Artisan (artisan lane) ===')
        [void]$migAppend.AppendLine('#')
        [void]$migAppend.AppendLine('# The Artisan performs the combined Dock + Worker + Scout + Smith +')
        [void]$migAppend.AppendLine('# Librarian scope by ITSELF on a `satchel` branch, then passes')
        [void]$migAppend.AppendLine('# Guardian + Observer and integrates into `studio` (DEC-045).')
        [void]$migAppend.AppendLine('# Mutually exclusive with the dock')
        [void]$migAppend.AppendLine('# lane (arbitrated by runtime/lane.lock). Disabled by default.')
        [void]$migAppend.AppendLine('[artisan]')
        [void]$migAppend.AppendLine('enabled = false')
        [void]$migAppend.AppendLine('id = "artisan-01"')
        [void]$migAppend.AppendLine('provider = "claude-code"')
        [void]$migAppend.AppendLine('model = "claude-code"')
        [void]$migAppend.AppendLine('# effort = "xhigh"')
        [void]$migAppend.AppendLine("worktree = `"$pmRoot/_artisan`"")
        [void]$migAppend.AppendLine('branch_namespace = "satchel"')
        Write-Host '  + appended [artisan] block (DEC-017)'
    }
    if (-not (@($output -match '^#?\s*\[\[librarians\]\]').Count -gt 0)) {
        [void]$migAppend.AppendLine('')
        [void]$migAppend.AppendLine('# === Librarian definitions (dock lane) ===')
        [void]$migAppend.AppendLine('#')
        [void]$migAppend.AppendLine('# One [[librarians]] block per Librarian instance. Knowledge /')
        [void]$migAppend.AppendLine('# registry / runbook work on a `shelf` branch, merged through')
        [void]$migAppend.AppendLine('# Dock review. Dock-subordinate; never dispatched by PM.')
        [void]$migAppend.AppendLine('# [[librarians]]')
        [void]$migAppend.AppendLine('# id = "librarian-01"')
        [void]$migAppend.AppendLine('# provider = "claude-code"')
        [void]$migAppend.AppendLine('# model = "claude-code"')
        [void]$migAppend.AppendLine('# enabled = true')
        [void]$migAppend.AppendLine("# worktree = `"$pmRoot/_librarians/librarian-01`"")
        [void]$migAppend.AppendLine('# branch_namespace = "shelf"')
        Write-Host '  + appended [[librarians]] example (DEC-018)'
    }
    if (-not (@($output -match '^\[status_web\]').Count -gt 0)) {
        [void]$migAppend.AppendLine('')
        [void]$migAppend.AppendLine('# === Status Web Console (read-only) ===')
        [void]$migAppend.AppendLine('#')
        [void]$migAppend.AppendLine('# A local, read-only browser view of Garelier state. Zero AI')
        [void]$migAppend.AppendLine('# tokens — it only reads runtime files. Start with')
        [void]$migAppend.AppendLine('# `bun run status -- --pm-id <pm_id>` from the driver directory.')
        [void]$migAppend.AppendLine('# Binds to loopback only and never mutates state.')
        [void]$migAppend.AppendLine('[status_web]')
        [void]$migAppend.AppendLine('enabled = false')
        [void]$migAppend.AppendLine('host = "127.0.0.1"')
        [void]$migAppend.AppendLine('port = 3787')
        [void]$migAppend.AppendLine('auto_refresh_seconds = 5')
        [void]$migAppend.AppendLine('read_only = true')
        [void]$migAppend.AppendLine('show_source_urls = true')
        Write-Host '  + appended [status_web] block'
    }
    if (-not (@($output -match '^\[concurrency\]').Count -gt 0)) {
        [void]$migAppend.AppendLine('')
        [void]$migAppend.AppendLine('# === Concurrency cap (DEC-027) ===')
        [void]$migAppend.AppendLine('#')
        [void]$migAppend.AppendLine('# Memory bound on concurrent detached provider CLIs. The driver launches')
        [void]$migAppend.AppendLine('# at most max_concurrent_agents at once; over-budget roles are deferred')
        [void]$migAppend.AppendLine('# (and aged so a low-priority role can''t starve). PM, Dock, and the')
        [void]$migAppend.AppendLine('# merge-gate subprocess are NOT counted. Set 0 to disable the cap.')
        [void]$migAppend.AppendLine('[concurrency]')
        [void]$migAppend.AppendLine('max_concurrent_agents = 4')
        [void]$migAppend.AppendLine('tiers = [["concierge", "guardian", "observer"], ["smith", "librarian"], ["worker", "scout", "artisan"], []]')
        [void]$migAppend.AppendLine('starvation_cycles = 3')
        Write-Host '  + appended [concurrency] block (DEC-027)'
    }
    if (-not (@($output -match '^\[lanes\]').Count -gt 0)) {
        [void]$migAppend.AppendLine('')
        [void]$migAppend.AppendLine('# === Lane selection (DEC-056) ===')
        [void]$migAppend.AppendLine('#')
        [void]$migAppend.AppendLine('# Lane assumed when runtime/lane.lock is absent. "dock"')
        [void]$migAppend.AppendLine('# (default) = the parallel pipeline; "artisan" = the single-agent')
        [void]$migAppend.AppendLine('# Artisan lane. An explicit lane.lock still overrides this per task.')
        [void]$migAppend.AppendLine('[lanes]')
        [void]$migAppend.AppendLine('default = "dock"')
        Write-Host '  + appended [lanes] block (DEC-056)'
    }
    if (-not (@($output -match '^\[output_control\]').Count -gt 0)) {
        [void]$migAppend.AppendLine('')
        [void]$migAppend.AppendLine('# === Output control (DEC-028) ===')
        [void]$migAppend.AppendLine('#')
        [void]$migAppend.AppendLine('# Keeps provider FINAL responses short and driver logs from bloating, on top')
        [void]$migAppend.AppendLine('# of compact-handoff + retention. Over-budget responses are WARNED, not failed.')
        [void]$migAppend.AppendLine('[output_control]')
        [void]$migAppend.AppendLine('enabled = true')
        [void]$migAppend.AppendLine('default_profile = "compact"')
        [void]$migAppend.AppendLine('violation_mode = "warn"')
        [void]$migAppend.AppendLine('model_result_log_chars = 600')
        [void]$migAppend.AppendLine('error_tail_chars = 500')
        [void]$migAppend.AppendLine('driver_log_max_bytes = 10485760')
        [void]$migAppend.AppendLine('driver_log_keep_files = 10')
        [void]$migAppend.AppendLine('usage_summary = true')
        [void]$migAppend.AppendLine('')
        [void]$migAppend.AppendLine('[output_control.profiles.normal]')
        [void]$migAppend.AppendLine('soft_result_chars = 1600')
        [void]$migAppend.AppendLine('max_bullets = 8')
        [void]$migAppend.AppendLine('[output_control.profiles.compact]')
        [void]$migAppend.AppendLine('soft_result_chars = 900')
        [void]$migAppend.AppendLine('max_bullets = 5')
        [void]$migAppend.AppendLine('[output_control.profiles.micro]')
        [void]$migAppend.AppendLine('soft_result_chars = 500')
        [void]$migAppend.AppendLine('max_bullets = 3')
        [void]$migAppend.AppendLine('')
        [void]$migAppend.AppendLine('[output_control.roles]')
        [void]$migAppend.AppendLine('pm = "normal"')
        [void]$migAppend.AppendLine('dock = "compact"')
        [void]$migAppend.AppendLine('worker = "compact"')
        [void]$migAppend.AppendLine('smith = "compact"')
        [void]$migAppend.AppendLine('artisan = "compact"')
        [void]$migAppend.AppendLine('scout = "micro"')
        [void]$migAppend.AppendLine('observer = "micro"')
        [void]$migAppend.AppendLine('librarian = "compact"')
        [void]$migAppend.AppendLine('guardian = "normal"')
        [void]$migAppend.AppendLine('concierge = "normal"')
        Write-Host '  + appended [output_control] block (DEC-028)'
    }
    if ($migAppend.Length -gt 0) {
        Add-Utf8File -RelativePath $tomlPath -Content $migAppend.ToString()
    }

    Write-Host ''
    Write-Host '==> Migrating ignores to nested __garelier/ form (DEC-051; root untouched)...'
    Write-GarelierNestedIgnores

    # After the per-PM move, bring the worktrees to the chosen layout (in-project
    # by default; exile if opted in). DEC-036.
    $null = Invoke-Relocate

    Write-Host ''
    Write-Host '==================================='
    Write-Host 'Garelier migration complete (v2.0 -> v2.1 + DEC-020).'
    Write-Host '==================================='
    Write-Host ''
    Write-Host 'Worktrees:'
    git worktree list | ForEach-Object { Write-Host "  $_" }
    Write-Host ''
    Write-Host 'Next steps:'
    Write-Host '  1. Review the changes:'
    Write-Host '       git status'
    Write-Host '       git diff --stat'
    Write-Host '  2. Commit the migration (local-only — do NOT push the studio branch):'
    Write-Host '       git add -A'
    Write-Host "       git commit -m 'Garelier: migrate to v2.1 (per-PM namespace, pm_id=$script:PmId)'"
    Write-Host '  3. Launch this PM from its new directory:'
    Write-Host "       cd $pmRoot/_pm; claude"

} else {

    # === DIFF MODE ===

    $script:PmId = $PmId
    $pmRoot = "__garelier/$script:PmId"

    if (-not (Test-Path "$pmRoot/_pm/setup_config.toml" -PathType Leaf)) {
        Write-Error "$pmRoot/_pm/setup_config.toml not found. Use -Mode Fresh to initialize."
        exit 1
    }
    if (-not (Test-Path "$pmRoot/runtime" -PathType Container)) {
        Write-Error "$pmRoot/runtime/ not found. Use -Mode Fresh to initialize."
        exit 1
    }

    if ([string]::IsNullOrWhiteSpace($Target)) {
        $Target = Read-TomlValue -Section 'branches' -Key 'target'
    }
    $targetSlug = Read-TomlValue -Section 'branches' -Key 'target_slug'
    $script:StudioBranch = Read-TomlValue -Section 'branches' -Key 'integration'
    if ([string]::IsNullOrWhiteSpace($Target) -or [string]::IsNullOrWhiteSpace($targetSlug) -or [string]::IsNullOrWhiteSpace($script:StudioBranch)) {
        Write-Error "Could not read [branches] from $pmRoot/_pm/setup_config.toml."
        exit 1
    }

    $existingWorkers = @(Read-ExistingBlockIds -Section 'workers')
    $existingScouts  = @(Read-ExistingBlockIds -Section 'scouts')
    $existingSmiths  = @(Read-ExistingBlockIds -Section 'smiths')
    $existingLibrarians = @(Read-ExistingBlockIds -Section 'librarians')
    $existingObservers  = @(Read-ExistingBlockIds -Section 'observers')
    $existingGuardians  = @(Read-ExistingBlockIds -Section 'guardians')
    $existingConcierges = @(Read-ExistingBlockIds -Section 'concierges')

    $desiredWorkers = @(Parse-Entries $Workers)
    $desiredScouts  = @(Parse-Entries $Scouts)
    $desiredSmiths  = if ($smithsProvided) { @(Parse-Entries $Smiths) } else { $existingSmiths }
    # Librarians (DEC-018) / Observers (DEC-019) / Guardians (DEC-024) /
    # Concierges (DEC-025): omitting the flag keeps the existing set; passing it
    # (even empty) is the desired final set.
    $desiredLibrarians = if ($librariansProvided) { @(Parse-Entries $Librarians) } else { $existingLibrarians }
    $desiredObservers  = if ($observersProvided)  { @(Parse-Entries $Observers)  } else { $existingObservers }
    $desiredGuardians  = if ($guardiansProvided)  { @(Parse-Entries $Guardians)  } else { $existingGuardians }
    $desiredConcierges = if ($conciergesProvided) { @(Parse-Entries $Concierges) } else { $existingConcierges }

    # Artisan (DEC-017) is a single toggle, not a set.
    $artisanExistingEnabled = ((Read-TomlBare -Section 'artisan' -Key 'enabled') -eq 'true')
    $artisanWtExists = Test-Path (Resolve-WsContainer 'artisan' '') -PathType Container  # DEC-035: exile-aware
    $artisanDesiredEnabled = if ($artisanSet) { [bool]$artisanDesiredEnable } else { $artisanExistingEnabled }
    $artisanChange = 'none'
    if ($artisanSet -and ($artisanDesiredEnabled -ne $artisanExistingEnabled)) {
        $artisanChange = if ($artisanDesiredEnabled) { 'enable' } else { 'disable' }
    }

    function Compute-Diff {
        param([array]$Existing, [array]$Desired)
        $kept = @(); $additions = @(); $removals = @()
        foreach ($d in $Desired) {
            $dId = Get-EntryId $d
            $found = $false
            foreach ($e in $Existing) {
                if ((Get-EntryId $e) -eq $dId) { $found = $true; break }
            }
            if ($found) { $kept += $d } else { $additions += $d }
        }
        foreach ($e in $Existing) {
            $eId = Get-EntryId $e
            $found = $false
            foreach ($d in $Desired) {
                if ((Get-EntryId $d) -eq $eId) { $found = $true; break }
            }
            if (-not $found) { $removals += $e }
        }
        return @{ Kept = $kept; Additions = $additions; Removals = $removals }
    }

    $w = Compute-Diff -Existing $existingWorkers -Desired $desiredWorkers
    $s = Compute-Diff -Existing $existingScouts  -Desired $desiredScouts
    $sm = Compute-Diff -Existing $existingSmiths -Desired $desiredSmiths
    $lib = Compute-Diff -Existing $existingLibrarians -Desired $desiredLibrarians
    $obs = Compute-Diff -Existing $existingObservers  -Desired $desiredObservers
    $grd = Compute-Diff -Existing $existingGuardians  -Desired $desiredGuardians
    $con = Compute-Diff -Existing $existingConcierges -Desired $desiredConcierges

    $blocked = @()
    foreach ($e in $w.Removals) {
        if (-not (Test-AgentIdle -Role 'workers' -Id (Get-EntryId $e))) {
            $blocked += "workers:$(Get-EntryId $e)"
        }
    }
    foreach ($e in $s.Removals) {
        if (-not (Test-AgentIdle -Role 'scouts' -Id (Get-EntryId $e))) {
            $blocked += "scouts:$(Get-EntryId $e)"
        }
    }
    foreach ($e in $sm.Removals) {
        if (-not (Test-AgentIdle -Role 'smiths' -Id (Get-EntryId $e))) {
            $blocked += "smiths:$(Get-EntryId $e)"
        }
    }
    foreach ($e in $lib.Removals) {
        if (-not (Test-AgentIdle -Role 'librarians' -Id (Get-EntryId $e))) {
            $blocked += "librarians:$(Get-EntryId $e)"
        }
    }
    foreach ($e in $obs.Removals) {
        if (-not (Test-AgentIdle -Role 'observers' -Id (Get-EntryId $e))) {
            $blocked += "observers:$(Get-EntryId $e)"
        }
    }
    foreach ($e in $grd.Removals) {
        if (-not (Test-AgentIdle -Role 'guardians' -Id (Get-EntryId $e))) {
            $blocked += "guardians:$(Get-EntryId $e)"
        }
    }
    foreach ($e in $con.Removals) {
        if (-not (Test-AgentIdle -Role 'concierges' -Id (Get-EntryId $e))) {
            $blocked += "concierges:$(Get-EntryId $e)"
        }
    }
    if ($artisanChange -eq 'disable' -and $artisanWtExists) {
        if (-not (Test-AgentIdle -Role 'artisan' -Id '')) {
            $blocked += 'artisan:artisan'
        }
    }

    Write-Host ''
    Write-Host 'Garelier setup plan (diff mode)'
    Write-Host '================================'
    Write-Host "  Project root:       $projectRoot"
    Write-Host "  PM identifier:      $script:PmId"
    Write-Host "  PM root:            $pmRoot"
    Write-Host "  Target branch:      $Target"
    Write-Host "  Integration branch: $script:StudioBranch"
    Write-Host ''
    Write-Host '  Workers (existing -> desired):'
    foreach ($e in $w.Kept)      { Write-Host "    = $e (kept)" }
    foreach ($e in $w.Additions) { Write-Host "    + $e (add)" }
    foreach ($e in $w.Removals)  { Write-Host "    - $e (remove)" }
    if ($w.Kept.Count + $w.Additions.Count + $w.Removals.Count -eq 0) {
        Write-Host '    (no workers)'
    }
    Write-Host ''
    Write-Host '  Scouts (existing -> desired):'
    foreach ($e in $s.Kept)      { Write-Host "    = $e (kept)" }
    foreach ($e in $s.Additions) { Write-Host "    + $e (add)" }
    foreach ($e in $s.Removals)  { Write-Host "    - $e (remove)" }
    if ($s.Kept.Count + $s.Additions.Count + $s.Removals.Count -eq 0) {
        Write-Host '    (no scouts)'
    }
    Write-Host ''
    Write-Host '  Smiths (existing -> desired):'
    foreach ($e in $sm.Kept)      { Write-Host "    = $e (kept)" }
    foreach ($e in $sm.Additions) { Write-Host "    + $e (add)" }
    foreach ($e in $sm.Removals)  { Write-Host "    - $e (remove)" }
    if ($sm.Kept.Count + $sm.Additions.Count + $sm.Removals.Count -eq 0) {
        Write-Host '    (no smiths)'
    }
    Write-Host ''
    Write-Host '  Librarians (existing -> desired):'
    foreach ($e in $lib.Kept)      { Write-Host "    = $e (kept)" }
    foreach ($e in $lib.Additions) { Write-Host "    + $e (add)" }
    foreach ($e in $lib.Removals)  { Write-Host "    - $e (remove)" }
    if ($lib.Kept.Count + $lib.Additions.Count + $lib.Removals.Count -eq 0) {
        Write-Host '    (no librarians)'
    }
    Write-Host ''
    Write-Host '  Observers (existing -> desired):'
    foreach ($e in $obs.Kept)      { Write-Host "    = $e (kept)" }
    foreach ($e in $obs.Additions) { Write-Host "    + $e (add)" }
    foreach ($e in $obs.Removals)  { Write-Host "    - $e (remove)" }
    if ($obs.Kept.Count + $obs.Additions.Count + $obs.Removals.Count -eq 0) {
        Write-Host '    (no observers)'
    }
    Write-Host ''
    Write-Host '  Guardians (existing -> desired):'
    foreach ($e in $grd.Kept)      { Write-Host "    = $e (kept)" }
    foreach ($e in $grd.Additions) { Write-Host "    + $e (add)" }
    foreach ($e in $grd.Removals)  { Write-Host "    - $e (remove)" }
    if ($grd.Kept.Count + $grd.Additions.Count + $grd.Removals.Count -eq 0) {
        Write-Host '    (no guardians)'
    }
    Write-Host ''
    Write-Host '  Concierges (existing -> desired):'
    foreach ($e in $con.Kept)      { Write-Host "    = $e (kept)" }
    foreach ($e in $con.Additions) { Write-Host "    + $e (add)" }
    foreach ($e in $con.Removals)  { Write-Host "    - $e (remove)" }
    if ($con.Kept.Count + $con.Additions.Count + $con.Removals.Count -eq 0) {
        Write-Host '    (no concierges)'
    }
    Write-Host ''
    Write-Host '  Artisan lane:'
    if ($artisanChange -eq 'enable') {
        Write-Host "    + enable (was: enabled=$($artisanExistingEnabled.ToString().ToLower()))"
    } elseif ($artisanChange -eq 'disable') {
        Write-Host "    - disable (was: enabled=$($artisanExistingEnabled.ToString().ToLower()))"
    } else {
        Write-Host "    = enabled=$($artisanExistingEnabled.ToString().ToLower()) (unchanged)"
    }
    Write-Host ''

    if ($blocked.Count -gt 0 -and -not $AllowRequeuedRemoval) {
        Write-Host '  ERROR: cannot remove the following agents (state is not IDLE):' -ForegroundColor Red
        foreach ($b in $blocked) { Write-Host "    - $b" -ForegroundColor Red }
        Write-Host ''
        Write-Host '  Wait for these agents to complete their current work, or'
        Write-Host '  clean-stop abort / retire-and-requeue their tasks via PM, then re-run.'
        Write-Host '  Use -AllowRequeuedRemoval only after PM has restored the tasks to pending.'
        exit 2
    }

    if ($blocked.Count -gt 0) {
        Write-Warning 'Removing non-IDLE agents because -AllowRequeuedRemoval was set.'
        Write-Warning 'This assumes PM already moved their task rows from in_flight.md to pending.md and recorded Outcome: requeued.'
        foreach ($b in $blocked) { Write-Warning "  - $b" }
    }

    if ($w.Additions.Count -eq 0 -and $w.Removals.Count -eq 0 `
        -and $s.Additions.Count -eq 0 -and $s.Removals.Count -eq 0 `
        -and $sm.Additions.Count -eq 0 -and $sm.Removals.Count -eq 0 `
        -and $lib.Additions.Count -eq 0 -and $lib.Removals.Count -eq 0 `
        -and $obs.Additions.Count -eq 0 -and $obs.Removals.Count -eq 0 `
        -and $grd.Additions.Count -eq 0 -and $grd.Removals.Count -eq 0 `
        -and $con.Additions.Count -eq 0 -and $con.Removals.Count -eq 0 `
        -and $artisanChange -eq 'none') {
        Write-Host 'No changes required. Setup matches desired state.'
        exit 0
    }

    if (-not $SkipConfirm) {
        $resp = Read-Host 'Apply this diff? [y/N]'
        if ($resp -notmatch '^[yY]') {
            Write-Host 'Aborted.'; exit 0
        }
    }

    git checkout $script:StudioBranch *>$null

    if ($w.Additions.Count -gt 0 -or $s.Additions.Count -gt 0 -or $sm.Additions.Count -gt 0 `
        -or $lib.Additions.Count -gt 0 -or $obs.Additions.Count -gt 0 -or $grd.Additions.Count -gt 0 `
        -or $con.Additions.Count -gt 0 -or $artisanChange -eq 'enable') {
        Write-Host ''
        Write-Host "==> Integrating $Target into $script:StudioBranch (base tracking)..."
        if (-not (Invoke-IntegrateTargetIntoStudio -TargetBranch $Target)) {
            exit 3
        }
    }

    Write-Host ''
    Write-Host '==> Removing agents...'
    foreach ($e in $w.Removals) {
        $id = Get-EntryId $e
        Remove-AgentWorktree -Role 'workers' -Id $id
        Write-Host "  - removed worker $id"
    }
    foreach ($e in $s.Removals) {
        $id = Get-EntryId $e
        Remove-AgentWorktree -Role 'scouts' -Id $id
        Write-Host "  - removed scout $id"
    }
    foreach ($e in $sm.Removals) {
        $id = Get-EntryId $e
        Remove-AgentWorktree -Role 'smiths' -Id $id
        Write-Host "  - removed smith $id"
    }
    foreach ($e in $lib.Removals) {
        $id = Get-EntryId $e
        Remove-AgentWorktree -Role 'librarians' -Id $id
        Write-Host "  - removed librarian $id"
    }
    foreach ($e in $obs.Removals) {
        $id = Get-EntryId $e
        Remove-AgentWorktree -Role 'observers' -Id $id
        Write-Host "  - removed observer $id"
    }
    foreach ($e in $grd.Removals) {
        $id = Get-EntryId $e
        Remove-AgentWorktree -Role 'guardians' -Id $id
        Write-Host "  - removed guardian $id"
    }
    foreach ($e in $con.Removals) {
        $id = Get-EntryId $e
        Remove-AgentWorktree -Role 'concierges' -Id $id
        Write-Host "  - removed concierge $id"
    }
    if ($artisanChange -eq 'disable' -and $artisanWtExists) {
        Remove-AgentWorktree -Role 'artisan' -Id ''   # DEC-035: resolve exile, drop pointer, prune
        Write-Host '  - disabled artisan lane'
    }

    Write-Host ''
    Write-Host '==> Adding agents...'
    foreach ($e in $w.Additions) {
        $id = Get-EntryId $e
        $provider = Get-EntryProvider $e
        $model = Get-EntryModel $e
        New-AgentWorktree -Role 'workers' -Id $id -Provider $provider -Model $model
        Write-Host "  + added worker $id ($provider`:$model)"
    }
    foreach ($e in $s.Additions) {
        $id = Get-EntryId $e
        $provider = Get-EntryProvider $e
        $model = Get-EntryModel $e
        New-AgentWorktree -Role 'scouts' -Id $id -Provider $provider -Model $model
        Write-Host "  + added scout $id ($provider`:$model)"
    }
    foreach ($e in $sm.Additions) {
        $id = Get-EntryId $e
        $provider = Get-EntryProvider $e
        $model = Get-EntryModel $e
        New-AgentWorktree -Role 'smiths' -Id $id -Provider $provider -Model $model
        Write-Host "  + added smith $id ($provider`:$model)"
    }
    foreach ($e in $lib.Additions) {
        $id = Get-EntryId $e
        $provider = Get-EntryProvider $e
        $model = Get-EntryModel $e
        New-AgentWorktree -Role 'librarians' -Id $id -Provider $provider -Model $model
        Write-Host "  + added librarian $id ($provider`:$model)"
    }
    if ($obs.Additions.Count -gt 0) {
        # Scaffold the Observer sidecar runtime/control dirs on first observer.
        foreach ($d in @('runtime/observer/inbox','runtime/observer/requests','runtime/observer/results','runtime/observer/locks','control/observations')) {
            New-Item -ItemType Directory -Force "$pmRoot/$d" | Out-Null
        }
        $gk = "$pmRoot/control/observations/.gitkeep"
        if (-not (Test-Path $gk)) { New-Item -ItemType File $gk | Out-Null }
    }
    foreach ($e in $obs.Additions) {
        $id = Get-EntryId $e
        $provider = Get-EntryProvider $e
        $model = Get-EntryModel $e
        New-AgentWorktree -Role 'observers' -Id $id -Provider $provider -Model $model
        Write-Host "  + added observer $id ($provider`:$model)"
    }
    if ($grd.Additions.Count -gt 0) {
        # Scaffold the Guardian gate runtime dirs on first guardian (DEC-024).
        foreach ($d in @('runtime/guardian/inbox','runtime/guardian/requests','runtime/guardian/results','runtime/guardian/locks')) {
            New-Item -ItemType Directory -Force "$pmRoot/$d" | Out-Null
        }
    }
    foreach ($e in $grd.Additions) {
        $id = Get-EntryId $e
        $provider = Get-EntryProvider $e
        $model = Get-EntryModel $e
        New-AgentWorktree -Role 'guardians' -Id $id -Provider $provider -Model $model
        Write-Host "  + added guardian $id ($provider`:$model)"
    }
    if ($con.Additions.Count -gt 0) {
        # Scaffold the Concierge external-ops runtime dirs on first concierge (DEC-025).
        foreach ($d in @('runtime/concierge/inbox','runtime/concierge/requests','runtime/concierge/results','runtime/concierge/locks','runtime/concierge/archive')) {
            New-Item -ItemType Directory -Force "$pmRoot/$d" | Out-Null
        }
    }
    foreach ($e in $con.Additions) {
        $id = Get-EntryId $e
        $provider = Get-EntryProvider $e
        $model = Get-EntryModel $e
        New-AgentWorktree -Role 'concierges' -Id $id -Provider $provider -Model $model
        Write-Host "  + added concierge $id ($provider`:$model)"
    }
    if ($artisanChange -eq 'enable' -and -not $artisanWtExists) {
        # Resolve identity from -Artisan inline spec, else existing config, else defaults.
        if ($artisanProvided -and -not [string]::IsNullOrWhiteSpace($Artisan)) {
            $solSpec = @(Parse-Entries $Artisan)[0]
            $solId = Get-EntryId $solSpec; $solProv = Get-EntryProvider $solSpec; $solModel = Get-EntryModel $solSpec
        } else {
            $solId = Read-TomlValue -Section 'artisan' -Key 'id'; if ([string]::IsNullOrWhiteSpace($solId)) { $solId = 'artisan-01' }
            $solProv = Read-TomlValue -Section 'artisan' -Key 'provider'; if ([string]::IsNullOrWhiteSpace($solProv)) { $solProv = 'claude-code' }
            $solModel = Read-TomlValue -Section 'artisan' -Key 'model'; if ([string]::IsNullOrWhiteSpace($solModel)) { $solModel = 'claude-code' }
        }
        # Artisan branches `satchel` from and integrates it into studio (DEC-045).
        # DEC-036: in-project by default; exile (+pointer) is opt-in.
        $solC = Get-WsContainer 'artisan' ''
        New-Item -ItemType Directory -Force $solC | Out-Null
        git worktree add --detach "$solC/checkout" $script:StudioBranch *>$null
        if (Test-WsUseExile) { Write-WsPointer 'artisan' '' $solC }
        Write-RoleSettings "$solC/checkout"
        Write-RoleFiles -Role 'artisan' -Id $solId -Provider $solProv -Model $solModel
        Write-Host "  + enabled artisan lane ($solId $solProv`:$solModel at $solC)"
    }

    Write-Host ''
    Write-Host "==> Updating $pmRoot/_pm/setup_config.toml..."
    $allWorkers = ($w.Kept + $w.Additions) | Sort-Object -Unique
    $allScouts  = ($s.Kept + $s.Additions) | Sort-Object -Unique
    $allSmiths  = ($sm.Kept + $sm.Additions) | Sort-Object -Unique
    $allLibrarians = ($lib.Kept + $lib.Additions) | Sort-Object -Unique
    $allObservers  = ($obs.Kept + $obs.Additions) | Sort-Object -Unique
    $allGuardians  = ($grd.Kept + $grd.Additions) | Sort-Object -Unique
    $allConcierges = ($con.Kept + $con.Additions) | Sort-Object -Unique

    $tomlLines = Get-Content -LiteralPath "$pmRoot/_pm/setup_config.toml"
    # Inject blocks introduced after this project was first initialized
    # (DEC-017 artisan, DEC-018 librarian, status web console, DEC-024
    # guardian). Existing blocks are preserved verbatim below; only absent
    # ones are added.
    $artisanPresent    = @($tomlLines -match '^\[artisan\]').Count -gt 0
    $statuswebPresent  = @($tomlLines -match '^\[status_web\]').Count -gt 0
    $concurrencyPresent = @($tomlLines -match '^\[concurrency\]').Count -gt 0
    $outputCtlPresent  = @($tomlLines -match '^\[output_control\]').Count -gt 0
    $librariansPresent = @($tomlLines -match '^#?\s*\[\[librarians\]\]').Count -gt 0
    $guardiansHdrPresent   = @($tomlLines -match '^#?\s*\[\[guardians\]\]').Count -gt 0
    $guardianPolicyPresent = @($tomlLines -match '^\[guardian_policy\]').Count -gt 0
    $conciergesHdrPresent   = @($tomlLines -match '^#?\s*\[\[concierges\]\]').Count -gt 0
    $conciergePolicyPresent = @($tomlLines -match '^\[concierge_policy\]').Count -gt 0
    $desiredLibCount = @($allLibrarians | Where-Object { $_ }).Count
    $desiredObsCount = @($allObservers  | Where-Object { $_ }).Count
    $desiredGrdCount = @($allGuardians  | Where-Object { $_ }).Count
    $desiredConCount = @($allConcierges | Where-Object { $_ }).Count
    $stripped = New-Object System.Collections.Generic.List[string]
    $skip = $false
    foreach ($line in $tomlLines) {
        if ($line -match '^\[\[workers\]\]' -or $line -match '^\[\[scouts\]\]' -or $line -match '^\[\[smiths\]\]' `
            -or $line -match '^\[\[librarians\]\]' -or $line -match '^\[\[observers\]\]' -or $line -match '^\[\[guardians\]\]' `
            -or $line -match '^\[\[concierges\]\]') {
            $skip = $true; continue
        }
        if ($line -match '^\[') { $skip = $false }
        if (-not $skip) { $stripped.Add($line) }
    }

    $finalSb = [System.Text.StringBuilder]::new()
    $inserted = $false
    foreach ($line in $stripped) {
        if (-not $inserted -and $line -match '^\[milestones\]') {
            foreach ($e in $allWorkers) {
                if (-not $e) { continue }
                $id = Get-EntryId $e
                $provider = Get-EntryProvider $e
                $model = Get-EntryModel $e
                [void]$finalSb.AppendLine('[[workers]]')
                [void]$finalSb.AppendLine("id = `"$id`"")
                [void]$finalSb.AppendLine("provider = `"$provider`"")
                [void]$finalSb.AppendLine("model = `"$model`"")
                Add-EffortLine -Builder $finalSb -Section 'workers' -Id $id
                [void]$finalSb.AppendLine("worktree = `"$pmRoot/_workers/$id`"")
                [void]$finalSb.AppendLine('')
            }
            foreach ($e in $allScouts) {
                if (-not $e) { continue }
                $id = Get-EntryId $e
                $provider = Get-EntryProvider $e
                $model = Get-EntryModel $e
                [void]$finalSb.AppendLine('[[scouts]]')
                [void]$finalSb.AppendLine("id = `"$id`"")
                [void]$finalSb.AppendLine("provider = `"$provider`"")
                [void]$finalSb.AppendLine("model = `"$model`"")
                Add-EffortLine -Builder $finalSb -Section 'scouts' -Id $id
                [void]$finalSb.AppendLine("worktree = `"$pmRoot/_scouts/$id`"")
                [void]$finalSb.AppendLine('idle_task = false')
                [void]$finalSb.AppendLine('idle_interval_hours = 24')
                [void]$finalSb.AppendLine('')
            }
            foreach ($e in $allSmiths) {
                if (-not $e) { continue }
                $id = Get-EntryId $e
                $provider = Get-EntryProvider $e
                $model = Get-EntryModel $e
                [void]$finalSb.AppendLine('[[smiths]]')
                [void]$finalSb.AppendLine("id = `"$id`"")
                [void]$finalSb.AppendLine("provider = `"$provider`"")
                [void]$finalSb.AppendLine("model = `"$model`"")
                Add-EffortLine -Builder $finalSb -Section 'smiths' -Id $id
                [void]$finalSb.AppendLine("worktree = `"$pmRoot/_smiths/$id`"")
                [void]$finalSb.AppendLine('')
            }
            # Librarians (DEC-018) — emit the desired set (header is preserved above).
            foreach ($e in $allLibrarians) {
                if (-not $e) { continue }
                $id = Get-EntryId $e
                $provider = Get-EntryProvider $e
                $model = Get-EntryModel $e
                [void]$finalSb.AppendLine('[[librarians]]')
                [void]$finalSb.AppendLine("id = `"$id`"")
                [void]$finalSb.AppendLine("provider = `"$provider`"")
                [void]$finalSb.AppendLine("model = `"$model`"")
                [void]$finalSb.AppendLine('enabled = true')
                Add-EffortLine -Builder $finalSb -Section 'librarians' -Id $id
                [void]$finalSb.AppendLine("worktree = `"$pmRoot/_librarians/$id`"")
                [void]$finalSb.AppendLine('branch_namespace = "shelf"')
                [void]$finalSb.AppendLine('')
            }
            # Observers (DEC-019) — emit the desired set (header is preserved above).
            foreach ($e in $allObservers) {
                if (-not $e) { continue }
                $id = Get-EntryId $e
                $provider = Get-EntryProvider $e
                $model = Get-EntryModel $e
                [void]$finalSb.AppendLine('[[observers]]')
                [void]$finalSb.AppendLine("id = `"$id`"")
                [void]$finalSb.AppendLine("provider = `"$provider`"")
                [void]$finalSb.AppendLine("model = `"$model`"")
                [void]$finalSb.AppendLine('enabled = true')
                Add-EffortLine -Builder $finalSb -Section 'observers' -Id $id
                [void]$finalSb.AppendLine("worktree = `"$pmRoot/_observers/$id`"")
                [void]$finalSb.AppendLine('allowed_request_kinds = ["merge_review", "artisan_premerge_review", "direction_advice", "architecture_risk_review", "policy_consistency_review"]')
                [void]$finalSb.AppendLine('')
            }
            # Guardians (DEC-024) — emit the desired set (header is preserved above).
            foreach ($e in $allGuardians) {
                if (-not $e) { continue }
                $id = Get-EntryId $e
                $provider = Get-EntryProvider $e
                $model = Get-EntryModel $e
                [void]$finalSb.AppendLine('[[guardians]]')
                [void]$finalSb.AppendLine("id = `"$id`"")
                [void]$finalSb.AppendLine("provider = `"$provider`"")
                [void]$finalSb.AppendLine("model = `"$model`"")
                [void]$finalSb.AppendLine('enabled = true')
                Add-EffortLine -Builder $finalSb -Section 'guardians' -Id $id
                [void]$finalSb.AppendLine('checkout = true')
                [void]$finalSb.AppendLine("worktree = `"$pmRoot/_guardians/$id`"")
                [void]$finalSb.AppendLine('allowed_request_kinds = ["preflight", "delta_gate", "final_gate", "promote_gate", "knowledge_update_request"]')
                [void]$finalSb.AppendLine('')
            }
            # Concierges (DEC-025) — emit the desired set (header is preserved above).
            foreach ($e in $allConcierges) {
                if (-not $e) { continue }
                $id = Get-EntryId $e
                $provider = Get-EntryProvider $e
                $model = Get-EntryModel $e
                [void]$finalSb.AppendLine('[[concierges]]')
                [void]$finalSb.AppendLine("id = `"$id`"")
                [void]$finalSb.AppendLine("provider = `"$provider`"")
                [void]$finalSb.AppendLine("model = `"$model`"")
                [void]$finalSb.AppendLine('enabled = true')
                Add-EffortLine -Builder $finalSb -Section 'concierges' -Id $id
                [void]$finalSb.AppendLine('checkout = true')
                [void]$finalSb.AppendLine("worktree = `"$pmRoot/_concierges/$id`"")
                [void]$finalSb.AppendLine('branch_namespace = "clipboard"')
                [void]$finalSb.AppendLine('allowed_operation_kinds = ["promote_target", "sync_remote"]')
                [void]$finalSb.AppendLine('')
            }
            if (-not $artisanPresent) {
                [void]$finalSb.AppendLine('# === Artisan (artisan lane) ===')
                [void]$finalSb.AppendLine('#')
                [void]$finalSb.AppendLine('# The Artisan performs the combined Dock + Worker + Scout + Smith +')
                [void]$finalSb.AppendLine('# Librarian scope by ITSELF on a `satchel` branch, then passes')
                [void]$finalSb.AppendLine('# Guardian + Observer and integrates into `studio` (DEC-045).')
                [void]$finalSb.AppendLine('# Mutually exclusive with the dock')
                [void]$finalSb.AppendLine('# lane (arbitrated by runtime/lane.lock). Disabled by default.')
                [void]$finalSb.AppendLine('[artisan]')
                [void]$finalSb.AppendLine('enabled = false')
                [void]$finalSb.AppendLine('id = "artisan-01"')
                [void]$finalSb.AppendLine('provider = "claude-code"')
                [void]$finalSb.AppendLine('model = "claude-code"')
                [void]$finalSb.AppendLine('# effort = "xhigh"')
                [void]$finalSb.AppendLine("worktree = `"$pmRoot/_artisan`"")
                [void]$finalSb.AppendLine('branch_namespace = "satchel"')
                [void]$finalSb.AppendLine('')
            }
            if ((-not $librariansPresent) -and $desiredLibCount -eq 0) {
                [void]$finalSb.AppendLine('# === Librarian definitions (dock lane) ===')
                [void]$finalSb.AppendLine('#')
                [void]$finalSb.AppendLine('# One [[librarians]] block per Librarian instance. Knowledge /')
                [void]$finalSb.AppendLine('# registry / runbook work on a `shelf` branch, merged through')
                [void]$finalSb.AppendLine('# Dock review. Dock-subordinate; never dispatched by PM.')
                [void]$finalSb.AppendLine('# [[librarians]]')
                [void]$finalSb.AppendLine('# id = "librarian-01"')
                [void]$finalSb.AppendLine('# provider = "claude-code"')
                [void]$finalSb.AppendLine('# model = "claude-code"')
                [void]$finalSb.AppendLine('# enabled = true')
                [void]$finalSb.AppendLine("# worktree = `"$pmRoot/_librarians/librarian-01`"")
                [void]$finalSb.AppendLine('# branch_namespace = "shelf"')
                [void]$finalSb.AppendLine('')
            }
            if ((-not $guardiansHdrPresent) -and $desiredGrdCount -eq 0) {
                [void]$finalSb.AppendLine('# === Guardian definitions (security/privacy/dependency/license gate, DEC-024) ===')
                [void]$finalSb.AppendLine('#')
                [void]$finalSb.AppendLine('# One [[guardians]] block per Guardian. Commit-free; runs on an')
                [void]$finalSb.AppendLine('# ephemeral `gavel` branch; gated by [guardian_policy] below.')
                [void]$finalSb.AppendLine('# [[guardians]]')
                [void]$finalSb.AppendLine('# id = "guardian-01"')
                [void]$finalSb.AppendLine('# provider = "claude-code"')
                [void]$finalSb.AppendLine('# model = "claude-code"')
                [void]$finalSb.AppendLine('# enabled = true')
                [void]$finalSb.AppendLine('# checkout = true')
                [void]$finalSb.AppendLine("# worktree = `"$pmRoot/_guardians/guardian-01`"")
                [void]$finalSb.AppendLine('# allowed_request_kinds = ["preflight", "delta_gate", "final_gate", "promote_gate", "knowledge_update_request"]')
                [void]$finalSb.AppendLine('')
            }
            if ((-not $conciergesHdrPresent) -and $desiredConCount -eq 0) {
                [void]$finalSb.AppendLine('# === Concierge definitions (external operations executor, DEC-025) ===')
                [void]$finalSb.AppendLine('#')
                [void]$finalSb.AppendLine('# One [[concierges]] block per Concierge. Always checkout=true (external')
                [void]$finalSb.AppendLine('# operations need live git state); runs on a `clipboard` branch; gated')
                [void]$finalSb.AppendLine('# by [concierge_policy] below.')
                [void]$finalSb.AppendLine('# [[concierges]]')
                [void]$finalSb.AppendLine('# id = "concierge-01"')
                [void]$finalSb.AppendLine('# provider = "claude-code"')
                [void]$finalSb.AppendLine('# model = "claude-code"')
                [void]$finalSb.AppendLine('# enabled = true')
                [void]$finalSb.AppendLine('# checkout = true')
                [void]$finalSb.AppendLine("# worktree = `"$pmRoot/_concierges/concierge-01`"")
                [void]$finalSb.AppendLine('# branch_namespace = "clipboard"')
                [void]$finalSb.AppendLine('# allowed_operation_kinds = ["promote_target", "sync_remote"]')
                [void]$finalSb.AppendLine('')
            }
            if (-not $statuswebPresent) {
                [void]$finalSb.AppendLine('# === Status Web Console (read-only) ===')
                [void]$finalSb.AppendLine('#')
                [void]$finalSb.AppendLine('# A local, read-only browser view of Garelier state. Zero AI')
                [void]$finalSb.AppendLine('# tokens — it only reads runtime files. Start with')
                [void]$finalSb.AppendLine('# `bun run status -- --pm-id <pm_id>` from the driver directory.')
                [void]$finalSb.AppendLine('# Binds to loopback only and never mutates state.')
                [void]$finalSb.AppendLine('[status_web]')
                [void]$finalSb.AppendLine('enabled = false')
                [void]$finalSb.AppendLine('host = "127.0.0.1"')
                [void]$finalSb.AppendLine('port = 3787')
                [void]$finalSb.AppendLine('auto_refresh_seconds = 5')
                [void]$finalSb.AppendLine('read_only = true')
                [void]$finalSb.AppendLine('show_source_urls = true')
                [void]$finalSb.AppendLine('')
            }
            if (-not $concurrencyPresent) {
                [void]$finalSb.AppendLine('# === Concurrency cap (DEC-027) ===')
                [void]$finalSb.AppendLine('#')
                [void]$finalSb.AppendLine('# Memory bound on concurrent detached provider CLIs. The driver launches')
                [void]$finalSb.AppendLine('# at most max_concurrent_agents at once; over-budget roles are deferred')
                [void]$finalSb.AppendLine('# (and aged so a low-priority role can''t starve). PM, Dock, and the')
                [void]$finalSb.AppendLine('# merge-gate subprocess are NOT counted. Set 0 to disable the cap.')
                [void]$finalSb.AppendLine('[concurrency]')
                [void]$finalSb.AppendLine('max_concurrent_agents = 4')
                [void]$finalSb.AppendLine('tiers = [["concierge", "guardian", "observer"], ["smith", "librarian"], ["worker", "scout", "artisan"], []]')
                [void]$finalSb.AppendLine('starvation_cycles = 3')
                [void]$finalSb.AppendLine('')
            }
            if (-not $outputCtlPresent) {
                [void]$finalSb.AppendLine('# === Output control (DEC-028) ===')
                [void]$finalSb.AppendLine('#')
                [void]$finalSb.AppendLine('# Keeps provider FINAL responses short and driver logs from bloating, on top')
                [void]$finalSb.AppendLine('# of compact-handoff + retention. Over-budget responses are WARNED, not failed.')
                [void]$finalSb.AppendLine('[output_control]')
                [void]$finalSb.AppendLine('enabled = true')
                [void]$finalSb.AppendLine('default_profile = "compact"')
                [void]$finalSb.AppendLine('violation_mode = "warn"')
                [void]$finalSb.AppendLine('model_result_log_chars = 600')
                [void]$finalSb.AppendLine('error_tail_chars = 500')
                [void]$finalSb.AppendLine('driver_log_max_bytes = 10485760')
                [void]$finalSb.AppendLine('driver_log_keep_files = 10')
                [void]$finalSb.AppendLine('usage_summary = true')
                [void]$finalSb.AppendLine('')
                [void]$finalSb.AppendLine('[output_control.profiles.normal]')
                [void]$finalSb.AppendLine('soft_result_chars = 1600')
                [void]$finalSb.AppendLine('max_bullets = 8')
                [void]$finalSb.AppendLine('[output_control.profiles.compact]')
                [void]$finalSb.AppendLine('soft_result_chars = 900')
                [void]$finalSb.AppendLine('max_bullets = 5')
                [void]$finalSb.AppendLine('[output_control.profiles.micro]')
                [void]$finalSb.AppendLine('soft_result_chars = 500')
                [void]$finalSb.AppendLine('max_bullets = 3')
                [void]$finalSb.AppendLine('')
                [void]$finalSb.AppendLine('[output_control.roles]')
                [void]$finalSb.AppendLine('pm = "normal"')
                [void]$finalSb.AppendLine('dock = "compact"')
                [void]$finalSb.AppendLine('worker = "compact"')
                [void]$finalSb.AppendLine('smith = "compact"')
                [void]$finalSb.AppendLine('artisan = "compact"')
                [void]$finalSb.AppendLine('scout = "micro"')
                [void]$finalSb.AppendLine('observer = "micro"')
                [void]$finalSb.AppendLine('librarian = "compact"')
                [void]$finalSb.AppendLine('guardian = "normal"')
                [void]$finalSb.AppendLine('concierge = "normal"')
                [void]$finalSb.AppendLine('')
            }
            $inserted = $true
        }
        [void]$finalSb.AppendLine($line)
    }
    Write-Utf8File -RelativePath "$pmRoot/_pm/setup_config.toml" -Content $finalSb.ToString()

    # Append the Guardian policy + tools sections (DEC-024) if a pre-Guardian
    # config lacks them. Default disabled; the enable toggle below flips it on
    # when guardians are now configured.
    if (-not $guardianPolicyPresent) {
        $gp = [System.Text.StringBuilder]::new()
        [void]$gp.AppendLine('')
        [void]$gp.AppendLine('# === Guardian policy (DEC-024) ===')
        [void]$gp.AppendLine('#')
        [void]$gp.AppendLine('# Guardian is the security GATE: commit-free, on an ephemeral `gavel`')
        [void]$gp.AppendLine('# branch, reads Librarian-owned security knowledge')
        [void]$gp.AppendLine('# (docs/garelier/security/) and emits PASS / PASS_WITH_NOTES / BLOCK /')
        [void]$gp.AppendLine('# NO_OPINION. Disabled by default; enable + add [[guardians]] blocks.')
        [void]$gp.AppendLine('[guardian_policy]')
        [void]$gp.AppendLine('enabled = false')
        [void]$gp.AppendLine('require_for_all_merges = true         # security-gate EVERY merge (guardian step of worker->guardian->observer->dock); false = gate only on the mechanical triggers below')
        [void]$gp.AppendLine('branch_namespace = "gavel"')
        [void]$gp.AppendLine('# Gate timings (delta is the core; preflight/final are staged).')
        [void]$gp.AppendLine('require_delta_before_observer = true')
        [void]$gp.AppendLine('require_final_before_merge = true')
        [void]$gp.AppendLine('require_for_artisan_premerge = true')
        [void]$gp.AppendLine('require_for_promote = true')
        [void]$gp.AppendLine('# Mechanical triggers (when a gate is mandatory).')
        [void]$gp.AppendLine('require_for_dependency_changes = true')
        [void]$gp.AppendLine('require_for_lockfile_changes = true')
        [void]$gp.AppendLine('require_for_auth_security = true')
        [void]$gp.AppendLine('require_for_config_infra_ci_deploy = true')
        [void]$gp.AppendLine('require_for_protected_paths = true')
        [void]$gp.AppendLine('# Blocking rules.')
        [void]$gp.AppendLine('block_on_secret = true')
        [void]$gp.AppendLine('block_on_pii = true')
        [void]$gp.AppendLine('block_on_customer_data = true')
        [void]$gp.AppendLine('block_on_private_key = true')
        [void]$gp.AppendLine('block_on_critical_vulnerability = true')
        [void]$gp.AppendLine('block_on_high_vulnerability = true')
        [void]$gp.AppendLine('block_on_forbidden_license = true')
        [void]$gp.AppendLine('block_on_unknown_license = false')
        [void]$gp.AppendLine('block_when_required_scanner_unavailable = true')
        [void]$gp.AppendLine('# Output safety.')
        [void]$gp.AppendLine('redact_evidence = true')
        [void]$gp.AppendLine('forbid_secret_value_in_report = true')
        [void]$gp.AppendLine('')
        [void]$gp.AppendLine('[guardian_policy.security_sensitive_paths]')
        [void]$gp.AppendLine('paths = [".env*", "**/*.pem", "**/*.key", "**/*secret*", "**/*credential*", "infra/**", "deploy/**", ".github/workflows/**", "migrations/**"]')
        [void]$gp.AppendLine('')
        [void]$gp.AppendLine('[guardian_policy.package_files]')
        [void]$gp.AppendLine('paths = ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.toml", "Cargo.lock", "requirements.txt", "pyproject.toml", "poetry.lock", "go.mod", "go.sum"]')
        [void]$gp.AppendLine('')
        [void]$gp.AppendLine('# Scanner commands. Empty = Guardian uses available project tools and')
        [void]$gp.AppendLine('# reports NO_OPINION/BLOCK per policy if a required command is missing.')
        [void]$gp.AppendLine('# If gitleaks cannot be used, PM may set:')
        [void]$gp.AppendLine('#   block_when_required_scanner_unavailable = false')
        [void]$gp.AppendLine('#   secret_scan = "off"')
        [void]$gp.AppendLine('# Guardian then runs in degraded mode and must report that scanner coverage')
        [void]$gp.AppendLine('# was intentionally disabled; it must not claim full secret-scanner coverage.')
        [void]$gp.AppendLine('[guardian_tools]')
        [void]$gp.AppendLine('secret_scan = "gitleaks detect --no-banner --redact --source ."')
        [void]$gp.AppendLine('pii_scan = ""')
        [void]$gp.AppendLine('dependency_scan = ""')
        [void]$gp.AppendLine('license_scan = ""')
        [void]$gp.AppendLine('sast_scan = ""')
        Add-Utf8File -RelativePath "$pmRoot/_pm/setup_config.toml" -Content $gp.ToString()
    }

    # Append the Concierge policy section (DEC-025) if a pre-Concierge config
    # lacks it. Default disabled; the enable toggle below flips it on when
    # concierges are now configured.
    if (-not $conciergePolicyPresent) {
        $cp = [System.Text.StringBuilder]::new()
        [void]$cp.AppendLine('')
        [void]$cp.AppendLine('# === Concierge policy (external operations executor, DEC-025) ===')
        [void]$cp.AppendLine('#')
        [void]$cp.AppendLine('# Concierge EXECUTES PM-approved operations that leave Garelier''s local')
        [void]$cp.AppendLine('# sandbox (Phase 1: promote_target + read-only sync_remote). Reads')
        [void]$cp.AppendLine('# Librarian-owned docs/garelier/external_operations/ and consumes the')
        [void]$cp.AppendLine('# Guardian promote_gate verdict. Disabled by default; enable + add')
        [void]$cp.AppendLine('# [[concierges]] blocks. Enabling does NOT auto-push — external writes')
        [void]$cp.AppendLine('# still require an explicit user instruction behind the PM assignment.')
        [void]$cp.AppendLine('[concierge_policy]')
        [void]$cp.AppendLine('enabled = false')
        [void]$cp.AppendLine('branch_namespace = "clipboard"')
        [void]$cp.AppendLine('require_pm_approval = true')
        [void]$cp.AppendLine('require_user_instruction_for_write = true')
        [void]$cp.AppendLine('require_librarian_policy_sources = true')
        [void]$cp.AppendLine('require_guardian_before_external_write = true')
        [void]$cp.AppendLine('require_external_lock = true')
        [void]$cp.AppendLine('forbid_push_garelier_branches = true')
        [void]$cp.AppendLine('forbid_force_push = true')
        [void]$cp.AppendLine('forbid_blind_git_pull = true')
        [void]$cp.AppendLine('redact_sensitive_output = true')
        [void]$cp.AppendLine('# Remote-visible work uses these prefixes — never garelier/* (Phase 2).')
        [void]$cp.AppendLine('allowed_external_branch_prefixes = ["publish/", "pr/", "release/"]')
        [void]$cp.AppendLine('')
        [void]$cp.AppendLine('[concierge_policy.required_knowledge]')
        [void]$cp.AppendLine('paths = [')
        [void]$cp.AppendLine('    "docs/garelier/external_operations/external_operations_policy.md",')
        [void]$cp.AppendLine('    "docs/garelier/external_operations/git_remote_policy.md",')
        [void]$cp.AppendLine('    "docs/garelier/external_operations/promote_policy.md",')
        [void]$cp.AppendLine('    "docs/garelier/external_operations/rollback_policy.md",')
        [void]$cp.AppendLine(']')
        Add-Utf8File -RelativePath "$pmRoot/_pm/setup_config.toml" -Content $cp.ToString()
    }

    # When -Guardians was explicitly passed, sync [guardian_policy].enabled to
    # whether any Guardian is now configured (mirrors fresh-mode auto-on). When
    # -Guardians is omitted, leave the policy's enabled flag untouched.
    if ($guardiansProvided) {
        $grdVal = if ($desiredGrdCount -gt 0) { 'true' } else { 'false' }
        $gpLines = Get-Content -LiteralPath "$pmRoot/_pm/setup_config.toml"
        $gpOut = New-Object System.Collections.Generic.List[string]
        $inGp = $false
        foreach ($line in $gpLines) {
            if ($line -match '^\[guardian_policy\]') { $inGp = $true; $gpOut.Add($line); continue }
            if ($line -match '^\[') { $inGp = $false }
            if ($inGp -and $line -match '^enabled\s*=') { $gpOut.Add("enabled = $grdVal"); continue }
            $gpOut.Add($line)
        }
        Write-Utf8File -RelativePath "$pmRoot/_pm/setup_config.toml" -Content (($gpOut -join "`n") + "`n")
    }

    # When -Concierges was explicitly passed, sync [concierge_policy].enabled to
    # whether any Concierge is now configured (mirrors fresh-mode auto-on). When
    # -Concierges is omitted, leave the policy's enabled flag untouched.
    if ($conciergesProvided) {
        $conVal = if ($desiredConCount -gt 0) { 'true' } else { 'false' }
        $cpLines = Get-Content -LiteralPath "$pmRoot/_pm/setup_config.toml"
        $cpOut = New-Object System.Collections.Generic.List[string]
        $inCp = $false
        foreach ($line in $cpLines) {
            if ($line -match '^\[concierge_policy\]') { $inCp = $true; $cpOut.Add($line); continue }
            if ($line -match '^\[') { $inCp = $false }
            if ($inCp -and $line -match '^enabled\s*=') { $cpOut.Add("enabled = $conVal"); continue }
            $cpOut.Add($line)
        }
        Write-Utf8File -RelativePath "$pmRoot/_pm/setup_config.toml" -Content (($cpOut -join "`n") + "`n")
    }

    # Toggle [artisan].enabled in place when -Artisan / -NoArtisan was given.
    if ($artisanSet) {
        $solVal = if ($artisanDesiredEnabled) { 'true' } else { 'false' }
        $togLines = Get-Content -LiteralPath "$pmRoot/_pm/setup_config.toml"
        $togOut = New-Object System.Collections.Generic.List[string]
        $inSol = $false
        foreach ($line in $togLines) {
            if ($line -match '^\[artisan\]') { $inSol = $true; $togOut.Add($line); continue }
            if ($line -match '^\[') { $inSol = $false }
            if ($inSol -and $line -match '^enabled\s*=') { $togOut.Add("enabled = $solVal"); continue }
            $togOut.Add($line)
        }
        Write-Utf8File -RelativePath "$pmRoot/_pm/setup_config.toml" -Content (($togOut -join "`n") + "`n")
    }
    Write-Host '  + setup_config.toml updated'

    $historyContent = Get-Content -LiteralPath "$pmRoot/_pm/history.md" -Raw
    $nextNum = 2
    if ($historyContent -match '<!-- Next entry number:\s*(\d+)') {
        $nextNum = [int]$matches[1]
    }
    $newHistory = ($historyContent -replace '(?m)^<!-- Next entry number:.*$\r?\n?', '').TrimEnd()
    $entryNum = '{0:D3}' -f $nextNum
    $addParts = @()
    foreach ($e in $w.Additions) { $addParts += "worker $e" }
    foreach ($e in $s.Additions) { $addParts += "scout $e" }
    foreach ($e in $sm.Additions) { $addParts += "smith $e" }
    foreach ($e in $lib.Additions) { $addParts += "librarian $e" }
    foreach ($e in $obs.Additions) { $addParts += "observer $e" }
    foreach ($e in $grd.Additions) { $addParts += "guardian $e" }
    foreach ($e in $con.Additions) { $addParts += "concierge $e" }
    if ($artisanChange -eq 'enable') { $addParts += 'artisan lane' }
    $addNotes = if ($addParts.Count -gt 0) { $addParts -join ', ' } else { 'none' }
    $remParts = @()
    foreach ($e in $w.Removals)  { $remParts += "worker $e" }
    foreach ($e in $s.Removals)  { $remParts += "scout $e" }
    foreach ($e in $sm.Removals) { $remParts += "smith $e" }
    foreach ($e in $lib.Removals) { $remParts += "librarian $e" }
    foreach ($e in $obs.Removals) { $remParts += "observer $e" }
    foreach ($e in $grd.Removals) { $remParts += "guardian $e" }
    foreach ($e in $con.Removals) { $remParts += "concierge $e" }
    if ($artisanChange -eq 'disable') { $remParts += 'artisan lane' }
    $remNotes = if ($remParts.Count -gt 0) { $remParts -join ', ' } else { 'none' }
    $newEntry = "`n`n## #$entryNum — $now — Agent set updated`n" +
                "- Blueprint: -`n" +
                "- Milestone: -`n" +
                "- Outcome: setup-change`n" +
                "- Notes: diff-mode wizard. Added: $addNotes. Removed: $remNotes.`n" +
                "`n" +
                "<!-- Next entry number: $($nextNum + 1) -->`n"
    Write-Utf8File -RelativePath "$pmRoot/_pm/history.md" -Content ($newHistory + $newEntry)
    Write-Host "  + $pmRoot/_pm/history.md appended (entry #$entryNum)"

    Write-Host ''
    Write-Host "==> Updating $pmRoot/runtime/manifest.md..."
    $manifestLines = Get-Content -LiteralPath "$pmRoot/runtime/manifest.md"
    # W-011 (DEC-064 §3): new manifests carry no per-agent roster tables —
    # execution state is derived (in_flight.md view + events.jsonl). Only a
    # LEGACY manifest that still has "## Active Workers" gets its tables
    # rebuilt; otherwise just stamp the update and append the activity line.
    if (-not ($manifestLines -match '^## Active Workers')) {
        $stamped = New-Object System.Collections.Generic.List[string]
        foreach ($line in $manifestLines) {
            if ($line -match '^Last updated:') { $stamped.Add("Last updated: $now"); continue }
            if ($line -match '^Updated by:') { $stamped.Add('Updated by: setup_wizard (diff mode)'); continue }
            $stamped.Add($line)
        }
        $stamped.Add("- $now — setup_wizard -Mode Diff — Agent set updated")
        Write-Utf8File -RelativePath "$pmRoot/runtime/manifest.md" -Content (($stamped -join "`n") + "`n")
        Write-Host '  + manifest.md updated (derived execution state — no roster tables, W-011)'
    } else {
    $newManifest = New-Object System.Collections.Generic.List[string]
    $section = ''
    $tableHandled = $false
    $sawSmithSection = $false
    foreach ($line in $manifestLines) {
        if ($line -match '^## Active Workers') {
            $section = 'workers'; $tableHandled = $false
            $newManifest.Add($line)
            continue
        }
        if ($line -match '^## Active Scouts') {
            $section = 'scouts'; $tableHandled = $false
            $newManifest.Add($line)
            continue
        }
        if ($line -match '^## Active Smiths') {
            $section = 'smiths'; $tableHandled = $false; $sawSmithSection = $true
            $newManifest.Add($line)
            continue
        }
        if ($line -match '^## Backlog summary' -and -not $sawSmithSection) {
            $newManifest.Add('## Active Smiths')
            $newManifest.Add('')
            $newManifest.Add('| Smith | State | Focus | Task |')
            $newManifest.Add('| ----- | ----- | ----- | ---- |')
            foreach ($e in $allSmiths) {
                if (-not $e) { continue }
                $id = $e.Split(':')[0]
                $newManifest.Add("| $id | IDLE | - | - |")
            }
            $newManifest.Add('')
            $sawSmithSection = $true
        }
        if ($line -match '^## ') {
            $section = ''
        }
        if (($section -eq 'workers' -or $section -eq 'scouts' -or $section -eq 'smiths') -and $line -match '^\|') {
            continue
        }
        if (($section -eq 'workers' -or $section -eq 'scouts' -or $section -eq 'smiths') -and -not $tableHandled -and $line -match '^$') {
            if ($section -eq 'workers') {
                $newManifest.Add('| Worker | State | Milestone | Phase | Task |')
                $newManifest.Add('| ------ | ----- | --------- | ----- | ---- |')
                foreach ($e in $allWorkers) {
                    if (-not $e) { continue }
                    $id = $e.Split(':')[0]
                    $newManifest.Add("| $id | IDLE | - | - | - |")
                }
            } elseif ($section -eq 'scouts') {
                $newManifest.Add('| Scout | State | Investigation |')
                $newManifest.Add('| ----- | ----- | ------------- |')
                foreach ($e in $allScouts) {
                    if (-not $e) { continue }
                    $id = $e.Split(':')[0]
                    $newManifest.Add("| $id | IDLE | - |")
                }
            } elseif ($section -eq 'smiths') {
                $newManifest.Add('| Smith | State | Focus | Task |')
                $newManifest.Add('| ----- | ----- | ----- | ---- |')
                foreach ($e in $allSmiths) {
                    if (-not $e) { continue }
                    $id = $e.Split(':')[0]
                    $newManifest.Add("| $id | IDLE | - | - |")
                }
            }
            $tableHandled = $true
            $newManifest.Add($line)
            continue
        }
        $newManifest.Add($line)
    }
    for ($i = 0; $i -lt $newManifest.Count; $i++) {
        if ($newManifest[$i] -match '^Last updated:') {
            $newManifest[$i] = "Last updated: $now"
        }
        if ($newManifest[$i] -match '^Updated by:') {
            $newManifest[$i] = 'Updated by: setup_wizard (diff mode)'
        }
    }
    $newManifest.Add('')
    $newManifest.Add("- $now — setup_wizard -Mode Diff — Agent set updated")

    Write-Utf8File -RelativePath "$pmRoot/runtime/manifest.md" -Content (($newManifest -join "`n") + "`n")
    Write-Host '  + manifest.md tables regenerated (legacy roster-table manifest)'
    }

    Write-Host ''
    Write-Host '==================================='
    Write-Host 'Garelier setup complete (diff).'
    Write-Host '==================================='
    Write-Host ''
    Write-Host 'Worktrees:'
    git worktree list | ForEach-Object { Write-Host "  $_" }
}
