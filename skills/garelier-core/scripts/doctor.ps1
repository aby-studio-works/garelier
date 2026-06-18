#Requires -Version 5.1
<#
.SYNOPSIS
    Garelier Doctor (PowerShell) — health check for one PM's install.

.DESCRIPTION
    Read-only inspection. Detects setup breakage, placeholder leakage,
    dangerous configuration, and Guardian-report secret leakage (G-14) BEFORE
    dispatch runs work. Never mutates state (never deletes lane.lock,
    pid files, or anything else).

    Findings are grouped by severity:
      P0  blocking   — must be fixed before dispatching work
      P1  warning    — likely wrong / stale; start proceeds
      P2  advisory   — informational

    Exit code: 1 if any P0 finding exists; 0 otherwise (P1/P2 only warn).

    pm_id resolution mirrors status.ps1:
      1. -PmId param
      2. $env:GARELIER_PM_ID
      3. cwd inference (inside __garelier/<pm_id>/...)
      4. single-PM autodetect under __garelier/

.PARAMETER PmId
    PM identifier to inspect. Required when more than one PM exists under
    __garelier/ (unless $env:GARELIER_PM_ID is set or cwd is inside a PM dir).

.PARAMETER ProjectRoot
    Project root directory. Defaults to current working directory.
#>

[CmdletBinding()]
param(
    [string]$PmId = '',
    [string]$ProjectRoot = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'

# Expected repo version. Bump this per release (canonical copy: VERSION).
$ExpectedVersion = '2.7.2'

# Walk up if cwd is not a project root (mirror status.ps1).
function Find-ProjectRoot {
    param([string]$Start)
    $cur = (Resolve-Path -LiteralPath $Start -ErrorAction SilentlyContinue).Path
    if (-not $cur) { return $null }
    while ($true) {
        if (Test-Path -LiteralPath (Join-Path $cur '__garelier') -PathType Container) { return $cur }
        $parent = Split-Path -Parent $cur
        if ([string]::IsNullOrEmpty($parent) -or $parent -eq $cur) { return $null }
        $cur = $parent
    }
}

if (-not (Test-Path (Join-Path $ProjectRoot '__garelier') -PathType Container)) {
    $found = Find-ProjectRoot $ProjectRoot
    if ($found) {
        $ProjectRoot = $found
    } else {
        Write-Error "Not a Garelier project root: $ProjectRoot (no __garelier/ here or in any parent). Pass -ProjectRoot <path>."
        exit 1
    }
}

$GarelierRoot = Join-Path $ProjectRoot '__garelier'

# pm_id resolution: param, env var, cwd inference, single-PM autodetect.
if ([string]::IsNullOrWhiteSpace($PmId)) { $PmId = $env:GARELIER_PM_ID }
if ([string]::IsNullOrWhiteSpace($PmId)) {
    $cwd = (Get-Location).Path
    $rootPrefix = $GarelierRoot + [System.IO.Path]::DirectorySeparatorChar
    if ($cwd.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        $rel = $cwd.Substring($rootPrefix.Length)
        $PmId = ($rel -split '[\\/]')[0]
    }
}
if ([string]::IsNullOrWhiteSpace($PmId)) {
    $candidates = @()
    foreach ($d in (Get-ChildItem -LiteralPath $GarelierRoot -Directory -ErrorAction SilentlyContinue)) {
        if (Test-Path -LiteralPath (Join-Path $d.FullName '_pm/setup_config.toml') -PathType Leaf) {
            $candidates += $d.Name
        }
    }
    switch ($candidates.Count) {
        0 { Write-Error "No Garelier PM initialized under $GarelierRoot; run setup_wizard."; exit 1 }
        1 { $PmId = $candidates[0] }
        default {
            $list = ($candidates | ForEach-Object { "         - $_" }) -join "`n"
            Write-Error "Multiple PMs found under ${GarelierRoot} — pass -PmId <id>.`n       Available PMs:`n$list"
            exit 1
        }
    }
}

$PmRoot     = Join-Path $GarelierRoot $PmId
$Config     = Join-Path $PmRoot '_pm/setup_config.toml'
$AgentsFile = Join-Path $ProjectRoot 'AGENTS.md'

if (-not (Test-Path $Config -PathType Leaf)) {
    Write-Error "PM '$PmId' not found: $Config missing."
    exit 1
}

# === Findings accumulator ===
$Findings = [System.Collections.Generic.List[object]]::new()
function Add-Finding {
    param([string]$Severity, [string]$Check, [string]$Detail, [string]$Fix)
    $Findings.Add([pscustomobject]@{
        Severity = $Severity
        Check    = $Check
        Detail   = $Detail
        Fix      = $Fix
    })
}

# === TOML helpers (mirror status.ps1) ===
$ConfigLines = Get-Content -LiteralPath $Config

function Read-Toml {
    param([string]$Section, [string]$Key)
    $inSection = $false
    foreach ($line in $ConfigLines) {
        if ($line -match "^\[$([regex]::Escape($Section))\]") { $inSection = $true; continue }
        if ($line -match '^\[') { $inSection = $false; continue }
        if ($inSection -and $line -match "^$([regex]::Escape($Key))\s*=\s*(.*?)(\s*#.*)?$") {
            return ($matches[1].Trim() -replace '^"|"$', '')
        }
    }
    return ''
}

function Test-TomlSection {
    param([string]$Section)
    foreach ($line in $ConfigLines) {
        if ($line -match "^\[$([regex]::Escape($Section))\]\s*$") { return $true }
    }
    return $false
}

# Return raw lines of an array assignment (key = [ ... ]) within a section,
# from the key line through the closing bracket.
function Get-TomlArrayBody {
    param([string]$Section, [string]$Key)
    $inSection = $false
    $capture = $false
    $body = @()
    foreach ($line in $ConfigLines) {
        if ($line -match "^\[$([regex]::Escape($Section))\]") { $inSection = $true; continue }
        if ($line -match '^\[') { if ($capture) { break }; $inSection = $false; continue }
        if ($inSection -and -not $capture -and $line -match "^$([regex]::Escape($Key))\s*=") {
            $capture = $true
            $body += $line
            if ($line -match '\]') { break }
            continue
        }
        if ($capture) {
            $body += $line
            if ($line -match '\]') { break }
        }
    }
    return $body
}

# Count quoted-string elements in an array body, ignoring comments.
function Get-TomlArrayCount {
    param([string]$Section, [string]$Key)
    $n = 0
    foreach ($line in (Get-TomlArrayBody $Section $Key)) {
        $s = $line -replace '#.*$', ''
        $n += ([regex]::Matches($s, '"[^"]*"')).Count
    }
    return $n
}

# List [[section]] ids.
function Get-AgentIds {
    param([string]$Section)
    $result = @()
    $inSection = $false
    foreach ($line in $ConfigLines) {
        if ($line -match "^\[\[$([regex]::Escape($Section))\]\]") { $inSection = $true; continue }
        if ($line -match '^\[') { $inSection = $false; continue }
        if ($inSection -and $line -match '^id\s*=\s*"([^"]+)"') { $result += $matches[1] }
    }
    return $result
}

# worktree value for a given id inside [[section]] blocks.
function Get-AgentWorktree {
    param([string]$Section, [string]$WantId)
    $inSection = $false
    $curId = ''
    $curWt = ''
    foreach ($line in $ConfigLines) {
        if ($line -match "^\[\[$([regex]::Escape($Section))\]\]") {
            if ($curId -eq $WantId -and $curWt) { return $curWt }
            $inSection = $true; $curId = ''; $curWt = ''; continue
        }
        if ($line -match '^\[') {
            if ($inSection -and $curId -eq $WantId -and $curWt) { return $curWt }
            $inSection = $false; continue
        }
        if ($inSection -and $line -match '^id\s*=\s*"([^"]+)"') { $curId = $matches[1] }
        if ($inSection -and $line -match '^worktree\s*=\s*"([^"]+)"') { $curWt = $matches[1] }
    }
    if ($inSection -and $curId -eq $WantId -and $curWt) { return $curWt }
    return ''
}

# Bare-bool `checkout` value for a given id within [[section]] blocks (DEC-021;
# empty if unset → caller treats as the default true).
function Get-AgentCheckout {
    param([string]$Section, [string]$WantId)
    $inSection = $false; $curId = ''; $curCo = ''
    foreach ($line in $ConfigLines) {
        if ($line -match "^\[\[$([regex]::Escape($Section))\]\]") {
            if ($curId -eq $WantId -and $curCo) { return $curCo }
            $inSection = $true; $curId = ''; $curCo = ''; continue
        }
        if ($line -match '^\[') {
            if ($inSection -and $curId -eq $WantId -and $curCo) { return $curCo }
            $inSection = $false; continue
        }
        if ($inSection -and $line -match '^id\s*=\s*"([^"]+)"') { $curId = $matches[1] }
        if ($inSection -and $line -match '^checkout\s*=\s*(\S+)') { $curCo = $matches[1].Trim() }
    }
    if ($inSection -and $curId -eq $WantId -and $curCo) { return $curCo }
    return ''
}

# DEC-035: a role's container may live in a machine-local home OUTSIDE the
# project; the gitignored pointer records its absolute path. Resolve to that when
# present, else fall back to the in-proj relative worktree (project-root joined).
function Get-DoctorPointerKey {
    param([string]$Table, [string]$Id)
    if ($Table -eq 'artisan') { return 'artisan' }
    $r = switch ($Table) {
        'workers' {'worker'} 'scouts' {'scout'} 'smiths' {'smith'} 'librarians' {'librarian'}
        'observers' {'observer'} 'guardians' {'guardian'} 'concierges' {'concierge'} default { $Table.TrimEnd('s') }
    }
    return "$r.$Id"
}

function Resolve-DoctorContainer {
    param([string]$Table, [string]$Id, [string]$Wt)
    $pf = Join-Path $ProjectRoot "__garelier/$PmId/runtime/workspace_paths"
    $key = Get-DoctorPointerKey $Table $Id
    if (Test-Path -LiteralPath $pf) {
        foreach ($line in (Get-Content -LiteralPath $pf)) {
            if ($line.StartsWith("$key=")) { return $line.Substring($key.Length + 1) }
        }
    }
    return (Join-Path $ProjectRoot $Wt)
}

# DEC-035: the RESOLVED absolute container for every configured id of a role.
# Security scans (concierge push-guard, report-leak) must walk these, not the
# in-project `_<role>/*` glob, which is empty once the role is exiled.
function Get-ResolvedRoleContainers {
    param([string]$Table)
    $out = @()
    foreach ($id in (Get-AgentIds $Table)) {
        $wt = Get-AgentWorktree $Table $id
        if (-not $wt) { $wt = "__garelier/$PmId/_$Table/$id" }
        $out += (Resolve-DoctorContainer $Table $id $wt)
    }
    return $out
}

function Test-PidAlive {
    param([int]$ProcessId)
    try { $null = Get-Process -Id $ProcessId -ErrorAction Stop; return $true }
    catch { return $false }
}

function Get-PidFromFile {
    param([string]$Path)
    $raw = (Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue)
    if (-not $raw) { return $null }
    $raw = $raw.Trim()
    if ($raw -match '^\d+$') { return [int]$raw }
    $m = [regex]::Match($raw, '"(?:pid|child_pid)"\s*:\s*(\d+)')
    if ($m.Success) { return [int]$m.Groups[1].Value }
    return $null
}

function Get-JsonStringField {
    param([string]$Path, [string]$Field)
    $raw = (Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue)
    if (-not $raw) { return '' }
    $m = [regex]::Match($raw, "`"$([regex]::Escape($Field))`"\s*:\s*`"([^`"]*)`"")
    if ($m.Success) { return $m.Groups[1].Value }
    return ''
}

# === Checks ===

# --- 1. Placeholder leakage (P0) ---
$cfgPlaceholders = @([regex]::Matches((Get-Content -LiteralPath $Config -Raw), '\{\{[^}]*\}\}') | ForEach-Object { $_.Value } | Select-Object -Unique)
if ($cfgPlaceholders.Count -gt 0) {
    $sample = ($cfgPlaceholders | Select-Object -First 3) -join ' '
    Add-Finding P0 'placeholder-leak' "unresolved {{...}} marker in setup_config.toml ($sample)" 're-run setup_wizard to substitute placeholders'
}
if (-not (Test-Path $AgentsFile -PathType Leaf)) {
    Add-Finding P0 'agents-missing' "AGENTS.md not found at project root ($AgentsFile)" 'every role reads AGENTS.md for project-specific rules; create it (re-run setup_wizard from __garelier/ with GARELIER_CORE_TEMPLATES_DIR set, or copy skills/garelier-core/templates/agents.md and fill it in)'
} else {
    $agentPlaceholders = @([regex]::Matches((Get-Content -LiteralPath $AgentsFile -Raw), '\{\{[^}]*\}\}') | ForEach-Object { $_.Value } | Select-Object -Unique)
    if ($agentPlaceholders.Count -gt 0) {
        $sample = ($agentPlaceholders | Select-Object -First 3) -join ' '
        Add-Finding P0 'placeholder-leak' "unresolved {{...}} marker in AGENTS.md ($sample)" 'edit AGENTS.md and fill the remaining project-specific fields (restricted files, conventions); re-running setup_wizard will NOT fill these (it skips an existing AGENTS.md)'
    }
}

# --- 2/3. Quality gate (P0) + stack/rust-default mismatch (P1) ---
$qgStack = Read-Toml 'quality_gate' 'stack'
$qgCmdCount = Get-TomlArrayCount 'quality_gate' 'commands'
$qgBody = (Get-TomlArrayBody 'quality_gate' 'commands') -join "`n"
$qgFullCmdCount = Get-TomlArrayCount 'quality_gate.full' 'commands'
$qgFullBody = (Get-TomlArrayBody 'quality_gate.full' 'commands') -join "`n"
$qgEffectiveCmdCount = $qgCmdCount
$qgEffectiveBody = $qgBody
if ($qgFullCmdCount -gt 0) {
    $qgEffectiveCmdCount = $qgFullCmdCount
    $qgEffectiveBody = $qgFullBody
}
$recognizedStack = @('rust', 'typescript', 'python', 'go') -contains $qgStack

if (-not (Test-TomlSection 'quality_gate')) {
    Add-Finding P0 'quality-gate' '[quality_gate] section missing' 'add [quality_gate] with stack or commands (see setup_config.toml template)'
} elseif ($qgStack -eq 'custom' -and $qgEffectiveCmdCount -eq 0) {
    Add-Finding P0 'quality-gate' 'stack = "custom" but full commands list is empty' 'fill in [quality_gate] commands or [quality_gate.full] commands (custom stack requires explicit full commands)'
} elseif ($qgEffectiveCmdCount -eq 0 -and -not $recognizedStack) {
    $shown = if ($qgStack) { $qgStack } else { '<unset>' }
    Add-Finding P0 'quality-gate' "no commands and unrecognized stack '$shown'" 'set stack to rust/typescript/python/go, or list explicit full commands'
}

# Rust-default-but-non-rust-stack heuristic (P1).
if ($qgEffectiveCmdCount -gt 0 -and $qgStack -and $qgStack -ne 'rust') {
    if ($qgEffectiveBody -match '"\s*cargo[ "]') {
        Add-Finding P1 'quality-gate-stale' "commands still use 'cargo ...' but stack = `"$qgStack`"" 'replace the Rust default commands with ones for your stack'
    }
}

# --- 4. Dangerous permission profile (P1) ---
$permProfile = Read-Toml 'permissions' 'profile'
if ($permProfile -eq 'dangerous') {
    Add-Finding P1 'permissions-dangerous' '[permissions] profile = "dangerous" (full provider access)' 'confirm this is a deliberate isolated autonomous run; else use reviewed/safe'
}

# --- 5. Protected paths unset (P2) ---
if (Test-TomlSection 'permissions') {
    $approvalCount = Get-TomlArrayCount 'permissions' 'require_pm_approval_paths'
    if ($approvalCount -eq 0) {
        Add-Finding P2 'protected-paths' '[permissions] require_pm_approval_paths is empty/absent' 'list sensitive globs (.env*, infra/**, migrations/**, deploy/**) to gate PM approval'
    }
}

# --- 5b. Jig mode configured (DEC-062 Phase 1) (P2) ---
$jigEnabled = Read-Toml 'jig' 'enabled'
if ($jigEnabled -eq 'false') {
    Add-Finding P2 'jig-mode' '[jig] enabled = false - jig is DEFAULT-ON (DEC-062 amended 2026-06-11); this is an explicit opt-out' 'the Mode D prose tick operates; remove the key (or set true) to run templates/jig_tick.workflow.js per tick'
}

# --- 5c. Jig Smith-window knowledge dependency (DEC-069/071) ---
# The jig SMITH phase hands the producer the ordered views in
# docs/garelier/quality/integration_hardening_views.md. Producers silently
# skip a missing read, so a project seeded BEFORE that template existed runs
# window batches without the views and nothing notices.
$jigSmithEvery = Read-Toml 'jig' 'smith_batch_every'
if ($jigEnabled -ne 'false' -and $jigSmithEvery -ne '0' -and
    (Test-Path (Join-Path $ProjectRoot 'docs/garelier') -PathType Container) -and
    -not (Test-Path (Join-Path $ProjectRoot 'docs/garelier/quality/integration_hardening_views.md'))) {
    Add-Finding P1 'jig-smith-views-missing' 'jig Smith window is active but docs/garelier/quality/integration_hardening_views.md is not seeded - window batches run without the V1-V7 views' 'seed it from garelier-librarian/templates/quality/integration_hardening_views.md (knowledge-sync Librarian dispatch), or set [jig] smith_batch_every = 0 to disable the window'
}

# --- 6. Role container layout (P1 only when half-created) ---
# DEC-065 dispatch-native: a configured seat with NO container is the healthy
# default — roster entries are seat defaults (model routing); producers run in
# ephemeral _dispatch<N>/ homes. A container that EXISTS but has no checkout/
# is half-created and still flagged.
$ConfiguredDirs = @{}

function Test-RoleTable {
    param([string]$Table, [string]$RoleDir)
    foreach ($id in (Get-AgentIds $Table)) {
        $wt = Get-AgentWorktree $Table $id
        if (-not $wt) { $wt = "__garelier/$PmId/$RoleDir/$id" }
        $base = Split-Path -Leaf $wt
        $ConfiguredDirs["$base@$RoleDir"] = $true
        # DEC-035: resolve the (possibly exiled) container via the pointer.
        $abs = Resolve-DoctorContainer $Table $id $wt
        if (-not (Test-Path $abs -PathType Container)) {
            # dispatch-native default (DEC-065): seat declared, no container.
        } elseif (-not (Test-Path (Join-Path $abs 'checkout') -PathType Container)) {
            # DEC-021: a read-only role with checkout=false has no worktree by design.
            if ((Get-AgentCheckout $Table $id) -ne 'false') {
                Add-Finding P1 'worktree-layout' "[[$Table]] id '$id' container exists but has no checkout/ worktree: $abs" 'remove the leftover container, or recreate the seat home via diff mode (remove the seat, then re-add it)'
            }
        }
    }
}

Test-RoleTable 'workers'    '_workers'
Test-RoleTable 'scouts'     '_scouts'
Test-RoleTable 'smiths'     '_smiths'
Test-RoleTable 'librarians' '_librarians'
Test-RoleTable 'observers'  '_observers'
Test-RoleTable 'guardians'  '_guardians'
Test-RoleTable 'concierges' '_concierges'

# Artisan (single [artisan] block, gated by enabled = true).
$artisanEnabled = Read-Toml 'artisan' 'enabled'
if ($artisanEnabled -eq 'true') {
    $artisanWt = Read-Toml 'artisan' 'worktree'
    if (-not $artisanWt) { $artisanWt = "__garelier/$PmId/_artisan" }
    $ConfiguredDirs["$(Split-Path -Leaf $artisanWt)@_artisan"] = $true
    $artisanAbs = Resolve-DoctorContainer 'artisan' '' $artisanWt   # DEC-035
    # DEC-065: an enabled artisan lane with no container is the dispatch-native
    # default; only a half-created container (no checkout/) is flagged.
    if ((Test-Path $artisanAbs -PathType Container) -and -not (Test-Path (Join-Path $artisanAbs 'checkout') -PathType Container)) {
        Add-Finding P1 'worktree-layout' "[artisan] container exists but has no checkout/ worktree: $artisanAbs" 'remove the leftover container, or recreate the seat home via diff mode (remove the seat, then re-add it)'
    }
}

# Guardian policy enabled but no [[guardians]] defined (DEC-024).
if ((Read-Toml 'guardian_policy' 'enabled') -eq 'true') {
    if (@(Get-AgentIds 'guardians').Count -eq 0) {
        Add-Finding P0 'guardian-policy' '[guardian_policy] enabled = true but no [[guardians]] are defined — the security gate is mandatory with no Guardian to satisfy it' 'add a [[guardians]] block, or set [guardian_policy].enabled = false'
    }
}

# Concierge policy enabled but no [[concierges]] (DEC-025), and the external-
# write safety guards must not be disabled while enabled.
if ((Read-Toml 'concierge_policy' 'enabled') -eq 'true') {
    if (@(Get-AgentIds 'concierges').Count -eq 0) {
        Add-Finding P0 'concierge-policy' '[concierge_policy] enabled = true but no [[concierges]] are defined — external operations are enabled with no Concierge to run them' 'add a [[concierges]] block, or set [concierge_policy].enabled = false'
    }
    foreach ($cflag in @('require_pm_approval', 'require_user_instruction_for_write', 'require_guardian_before_external_write', 'forbid_push_garelier_branches', 'forbid_force_push', 'forbid_blind_git_pull')) {
        if ((Read-Toml 'concierge_policy' $cflag) -eq 'false') {
            Add-Finding P0 'concierge-safety' "[concierge_policy].$cflag = false weakens an external-write safety guard" "set [concierge_policy].$cflag = true (it guards against unapproved / destructive external writes)"
        }
    }
    # Mechanical push guard (DEC-030): every existing Concierge worktree must have
    # the pre-push hook installed (per-worktree core.hooksPath -> a dir with pre-push).
    # DEC-035: resolve each Concierge container (it may be exiled outside the
    # project) so an exiled Concierge missing its push guard is still caught.
    foreach ($ccontainer in (Get-ResolvedRoleContainers 'concierges')) {
        $checkout = Join-Path $ccontainer 'checkout'
        if (-not (Test-Path (Join-Path $checkout '.git'))) { continue }
        $hp = (& git -C $checkout config --get core.hooksPath 2>$null)
        if (-not $hp -or -not (Test-Path (Join-Path $hp 'pre-push'))) {
            Add-Finding P0 'concierge-push-guard' "Concierge worktree $checkout has no mechanical push guard (core.hooksPath -> a dir with pre-push)" "run garelier install-concierge-guards `"$checkout`" (DEC-030); the Concierge does this at pickup"
        }
    }
}

# Provider permission verification on write roles (DEC-033). Gemini/Cursor are
# first-class (permission profiles wired to CLI flags), but those flags are
# version-sensitive; nudge the user to verify via the provider smoke (advisory).
function Get-RiskyProvidersInTable([string]$Section) {
    $found = New-Object System.Collections.Generic.HashSet[string]
    $inblk = $false
    foreach ($line in (Get-Content -LiteralPath $Config -ErrorAction SilentlyContinue)) {
        if ($line -eq "[[$Section]]") { $inblk = $true; continue }
        if ($line -match '^\[') { $inblk = $false }
        if ($inblk -and $line -match '^\s*provider\s*=\s*"?([^"\s]+)') {
            $v = $Matches[1]
            if ($v -match 'gemini|cursor') { [void]$found.Add($v) }
        }
    }
    return ($found -join ' ')
}
foreach ($sec in @('workers', 'smiths', 'concierges')) {
    $rp = Get-RiskyProvidersInTable $sec
    if ($rp) {
        Add-Finding P2 'provider-verify' "[[$sec]] uses $rp on a write/external role; its permission flags (DEC-033) are wired but version-sensitive" "verify the CLI works by running it once manually; if a flag is rejected, set GARELIER_PROVIDER_<KIND>_PERMISSION=off"
    }
}
$solProvider = Read-Toml 'artisan' 'provider'
if ($solProvider -match 'gemini|cursor') {
    Add-Finding P2 'provider-verify' "[artisan] uses $solProvider and integrates its own satchel into studio; its permission flags (DEC-033 / DEC-045) are version-sensitive" "verify with the provider smoke before relying on it; GARELIER_PROVIDER_<KIND>_PERMISSION=off falls back if a flag is rejected"
}

# Guardian report output safety (G-14, P0, DEC-024): a Guardian report is
# pointer-only / redacted by rule — a report that carries a raw secret value
# becomes the leak. Scan the Guardian report areas for unambiguous secret-value
# formats (private keys, cloud/provider tokens, JWTs). Redaction placeholders
# ({{...}} / [REDACTED] / pointers) do not match. High-confidence formats only,
# to avoid false P0s. All scanned paths are gitignored, but a local leak is
# still a leak the moment it is read or accidentally committed.
$secretRe = '-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[posru]_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+|sk-[A-Za-z0-9]{32,}'
$gReportGlobs = @(
    (Join-Path $PmRoot '_guardians/*/guardian_report.md'),
    (Join-Path $PmRoot '_guardians/*/checkout/guardian_report.md'),
    (Join-Path $PmRoot 'runtime/guardian/results/*'),
    (Join-Path $PmRoot 'runtime/guardian/inbox/*')
)
# DEC-035: also scan reports in exiled Guardian containers (outside the project).
foreach ($gc in (Get-ResolvedRoleContainers 'guardians')) {
    $gReportGlobs += (Join-Path $gc 'guardian_report.md')
    $gReportGlobs += (Join-Path $gc 'checkout/guardian_report.md')
}
foreach ($glob in $gReportGlobs) {
    foreach ($f in (Get-ChildItem -Path $glob -File -ErrorAction SilentlyContinue)) {
        $content = Get-Content -LiteralPath $f.FullName -Raw -ErrorAction SilentlyContinue
        if ($content -and ($content -cmatch $secretRe)) {
            $rel = if ($f.FullName.StartsWith($ProjectRoot)) { $f.FullName.Substring($ProjectRoot.Length).TrimStart('\', '/') } else { $f.FullName }
            Add-Finding P0 'guardian-report-leak' "Guardian report appears to contain an unredacted secret-like value: $rel" "redact to pointer-only per the report's REDACTION RULE; if the value is real, rotate it immediately"
        }
    }
}

# Concierge report output safety (P0, DEC-025): concierge_report.md is
# pointer-only / redacted like a Guardian report — same high-confidence scan.
$cReportGlobs = @(
    (Join-Path $PmRoot '_concierges/*/concierge_report.md'),
    (Join-Path $PmRoot '_concierges/*/checkout/concierge_report.md'),
    (Join-Path $PmRoot 'runtime/concierge/results/*'),
    (Join-Path $PmRoot 'runtime/concierge/inbox/*')
)
# DEC-035: also scan reports in exiled Concierge containers (outside the project).
foreach ($cc in (Get-ResolvedRoleContainers 'concierges')) {
    $cReportGlobs += (Join-Path $cc 'concierge_report.md')
    $cReportGlobs += (Join-Path $cc 'checkout/concierge_report.md')
}
foreach ($glob in $cReportGlobs) {
    foreach ($f in (Get-ChildItem -Path $glob -File -ErrorAction SilentlyContinue)) {
        $content = Get-Content -LiteralPath $f.FullName -Raw -ErrorAction SilentlyContinue
        if ($content -and ($content -cmatch $secretRe)) {
            $rel = if ($f.FullName.StartsWith($ProjectRoot)) { $f.FullName.Substring($ProjectRoot.Length).TrimStart('\', '/') } else { $f.FullName }
            Add-Finding P0 'concierge-report-leak' "Concierge report appears to contain an unredacted secret-like value: $rel" "redact to pointer-only per the report's redaction rule; if the value is real, rotate it immediately"
        }
    }
}

# Stray on-disk role dirs without a config entry.
foreach ($roleDir in @('_workers', '_scouts', '_smiths', '_librarians', '_observers', '_guardians', '_concierges')) {
    $base = Join-Path $PmRoot $roleDir
    if (-not (Test-Path $base -PathType Container)) { continue }
    foreach ($d in (Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue)) {
        if (-not $ConfiguredDirs.ContainsKey("$($d.Name)@$roleDir")) {
            Add-Finding P1 'stray-worktree' "$roleDir/$($d.Name) exists on disk but has no config entry" "add a config block for '$($d.Name)', or remove the stale worktree (git worktree remove)"
        }
    }
}

# --- 7. Stale lane.lock (P1) ---
$LaneLock = Join-Path $PmRoot 'runtime/lane.lock'
if (Test-Path $LaneLock -PathType Leaf) {
    $lanePid = Get-PidFromFile $LaneLock
    $laneOwner = Get-JsonStringField $LaneLock 'owner'
    if ($lanePid -and -not (Test-PidAlive $lanePid)) {
        $ownerShown = if ($laneOwner) { $laneOwner } else { '?' }
        Add-Finding P1 'stale-lane-lock' "lane.lock owner '$ownerShown' pid $lanePid is not alive" 'verify no role is mid-lane, then clear lane.lock via PM (doctor never deletes it)'
    }
}

# --- 7b. Stale Concierge external lock (P1, DEC-025) ---
$ExternalLockDir = Join-Path $PmRoot 'runtime/concierge/locks'
if (Test-Path $ExternalLockDir -PathType Container) {
    foreach ($lk in (Get-ChildItem -LiteralPath $ExternalLockDir -Filter '*.lock' -File -ErrorAction SilentlyContinue)) {
        $extPid = Get-PidFromFile $lk.FullName
        $extOp = Get-JsonStringField $lk.FullName 'operation_kind'
        $extReq = Get-JsonStringField $lk.FullName 'request_id'
        if ($extPid -and -not (Test-PidAlive $extPid)) {
            $reqShown = if ($extReq) { $extReq } else { '?' }
            $opShown = if ($extOp) { $extOp } else { '?' }
            Add-Finding P1 'stale-external-lock' "concierge lock $($lk.Name) ($reqShown, $opShown) pid $extPid is not alive" 'a Concierge crashed holding the lock; on pickup it reconciles (SKILL section 10.5) — verify the external operations actual state before clearing'
        }
    }
}

# --- 7c. Provider CLI availability (P1, DEC-026) ---
if (Test-Path $Config -PathType Leaf) {
    $usedProviders = @(Get-Content -LiteralPath $Config |
        Where-Object { $_ -notmatch '^\s*#' } |
        ForEach-Object { if ($_ -match 'provider\s*=\s*"([a-z-]+)"') { $matches[1] } } |
        Sort-Object -Unique)
    foreach ($p in $usedProviders) {
        $pbin = switch ($p) {
            'claude-code' { 'claude' }
            'codex-cli'   { 'codex' }
            'gemini-cli'  { 'gemini' }
            'copilot-cli' { 'copilot' }
            'cursor-cli'  { 'cursor-agent' }
            default { $null }
        }
        if (-not $pbin) { continue }
        $envKey = "GARELIER_PROVIDER_$($p.ToUpper().Replace('-','_'))_CMD"
        if ([Environment]::GetEnvironmentVariable($envKey)) { continue }
        $avail = $false
        if ($p -eq 'cursor-cli') {
            if ((Get-Command cursor-agent -ErrorAction SilentlyContinue) -or (Get-Command cursor -ErrorAction SilentlyContinue)) { $avail = $true }
        } elseif (Get-Command $pbin -ErrorAction SilentlyContinue) {
            $avail = $true
        }
        if (-not $avail) {
            Add-Finding P1 'provider-unavailable' "provider '$p' is configured but its CLI ('$pbin') is not on PATH" "install the $p CLI, set $envKey / a per-agent provider_command, or remove agents using it"
        }
    }
}

# --- 9. Version mismatch (P2) ---
$cfgVersion = Read-Toml 'project' 'garelier_version'
if ($cfgVersion -and $cfgVersion -ne $ExpectedVersion) {
    Add-Finding P2 'version-mismatch' "setup_config.toml garelier_version = $cfgVersion, expected $ExpectedVersion" 're-run setup_wizard (migrate mode) to align with the installed framework version'
}

# --- 9b. Concurrency cap (DEC-027) ---
# The cap bounds detached provider CLIs so enabling every role does not exhaust
# memory. 0 disables it. Absent section is fine (tooling applies cap=4 default).
if (Test-TomlSection 'concurrency') {
    $ccMax = Read-Toml 'concurrency' 'max_concurrent_agents'
    if ($ccMax -eq '0') {
        Add-Finding P2 'concurrency-unbounded' '[concurrency] max_concurrent_agents = 0 (cap disabled): all detached agents may run at once' 'set a bound (e.g. 4) if running many roles on a memory-constrained machine'
    } elseif ($ccMax -match '^-') {
        Add-Finding P1 'concurrency-invalid' "[concurrency] max_concurrent_agents = $ccMax is negative; tooling clamps it to 0 (unbounded)" 'set max_concurrent_agents to a non-negative integer (0 disables the cap)'
    }
}

# --- 9c. Output control (DEC-028) ---
if (Test-TomlSection 'output_control') {
    $ocDefault = Read-Toml 'output_control' 'default_profile'
    if ($ocDefault -and $ocDefault -notmatch '^(normal|compact|micro)$') {
        Add-Finding P0 'output-control-profile' "[output_control] default_profile = `"$ocDefault`" is not normal/compact/micro" 'set default_profile to normal, compact, or micro'
    }
    $ocViol = Read-Toml 'output_control' 'violation_mode'
    if ($ocViol -and $ocViol -notmatch '^(warn|fail)$') {
        Add-Finding P0 'output-control-violation-mode' "[output_control] violation_mode = `"$ocViol`" must be warn or fail" 'set violation_mode = "warn" (default) or "fail" (experimental)'
    } elseif ($ocViol -eq 'fail') {
        Add-Finding P1 'output-control-violation-fail' '[output_control] violation_mode = "fail" is experimental: a role writing a long but legitimate warning could be failed' 'prefer violation_mode = "warn" until fail-mode has been validated for your roster'
    }
    $ocLogMax = Read-Toml 'output_control' 'driver_log_max_bytes'
    if ($ocLogMax -match '^[0-9]+$' -and [int64]$ocLogMax -lt 1048576) {
        Add-Finding P0 'output-control-log-rotation' "[output_control] driver_log_max_bytes = $ocLogMax is below 1MB; logs would rotate constantly" 'set driver_log_max_bytes to at least 1048576 (1MB)'
    }
    foreach ($prof in @('normal', 'compact', 'micro')) {
        $soft = Read-Toml "output_control.profiles.$prof" 'soft_result_chars'
        if ($soft -match '^[0-9]+$' -and [int]$soft -lt 200) {
            Add-Finding P0 'output-control-soft-chars' "[output_control.profiles.$prof] soft_result_chars = $soft is below 200 (too terse to be safe)" 'raise soft_result_chars to at least 200'
        }
    }
    foreach ($role in @('guardian', 'concierge')) {
        if ((Read-Toml 'output_control.roles' $role) -eq 'micro') {
            Add-Finding P1 'output-control-safety-micro' "[output_control.roles] $role = `"micro`" can pressure warnings / approvals / responsibility boundaries short" "keep $role at `"normal`" (or `"compact`"); safety-critical roles should not be micro"
        }
    }
    if ((Read-Toml 'output_control' 'enabled') -eq 'false') {
        Add-Finding P2 'output-control-disabled' '[output_control] enabled = false: provider final responses and tool logs are not bounded' 'leave enabled = true unless you are deliberately debugging full output'
    }
    if ((Read-Toml 'output_control' 'usage_summary') -eq 'false') {
        Add-Finding P2 'output-control-no-usage' '[output_control] usage_summary = false: token / output / over-budget trends are not recorded' 'set usage_summary = true to track which roles bloat output over time'
    }
}

# --- 9d. Librarian role knowledge trees (DEC-029) ---
# Entirely-absent knowledge tree (DEC-050 follow-up): if docs/garelier/ has no
# knowledge at all, the role knowledge index + status-web Knowledge / RoleKnowledge
# / Source / Routine panels are empty. A brand/path rename that moved __garelier
# but forgot docs/<old>/ → docs/garelier/ lands here.
if (-not (Test-Path (Join-Path $ProjectRoot 'docs/garelier') -PathType Container)) {
    Add-Finding P1 'knowledge-tree-absent' 'docs/garelier/ is entirely absent — role knowledge + status-web Knowledge/Source/Routine panels are empty' 'run setup_wizard to seed it; or if a brand/path rename moved __garelier, ensure docs/<old>/ was also moved to docs/garelier/ (tracked_path_rename_migration runbook)'
}
foreach ($ktree in @('security', 'engineering', 'quality', 'review', 'system')) {
    $kdir = Join-Path $ProjectRoot "docs/garelier/$ktree"
    if (Test-Path $kdir -PathType Container) {
        if (-not (Test-Path (Join-Path $kdir 'index.md'))) {
            Add-Finding P1 'knowledge-tree-index' "docs/garelier/$ktree/ exists but index.md is missing" "restore docs/garelier/$ktree/index.md (re-run setup_wizard, or copy from garelier-librarian/templates/$ktree/index.md)"
        }
    } elseif (Test-Path (Join-Path $ProjectRoot 'docs/garelier') -PathType Container) {
        Add-Finding P2 'knowledge-tree-missing' "docs/garelier/$ktree/ is not seeded" "run setup_wizard (it seeds Librarian role knowledge trees), or seed from garelier-librarian/templates/$ktree/"
    }
}

# --- 9e. role_index closure (DEC-071 follow-up) ---
# Every knowledge doc the role_index names must exist: producers and the jig
# silently SKIP a missing read, so a stale tree (templates added to the
# framework after this project was seeded) hides itself.
$ridx = Join-Path $ProjectRoot 'docs/garelier/knowledge/role_index.toml'
if (Test-Path $ridx) {
    $riMissing = @()
    $riRefs = [regex]::Matches((Get-Content -LiteralPath $ridx -Raw), 'docs/garelier/[A-Za-z0-9_/.-]+\.md') |
        ForEach-Object { $_.Value } | Sort-Object -Unique
    foreach ($ref in $riRefs) {
        if (-not (Test-Path (Join-Path $ProjectRoot $ref))) { $riMissing += $ref }
    }
    if ($riMissing.Count -gt 0) {
        Add-Finding P1 'role-index-dangling' "role_index.toml names knowledge docs that do not exist: $($riMissing -join ' ')" 'seed them from garelier-librarian/templates/ (knowledge-sync Librarian dispatch), or remove the stale entries'
    }
}

# --- 10. Compact-handoff bloat (P2) ---
# compact_handoff.md mandates pointers over pasted bodies; a handoff / inbox
# file far past the terse size usually means a diff / full report was pasted in.
$handoffMaxBytes = 16384
$handoffNames = @('assignment.md','report.md','questions.md','review.md','answers.md','checkpoint.md')
$handoffBig = @(Get-ChildItem -LiteralPath $PmRoot -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object {
        $_.Length -gt $handoffMaxBytes -and
        ($handoffNames -contains $_.Name -or $_.FullName -replace '\\','/' -match '/inbox/[^/]+\.md$')
    } | Select-Object -First 20)
if ($handoffBig.Count -gt 0) {
    $sample = ($handoffBig | Select-Object -First 3 | ForEach-Object {
        "$(($_.FullName).Substring($ProjectRoot.Length).TrimStart('\','/')) ($($_.Length)B)"
    }) -join ' '
    Add-Finding P2 'handoff-bloat' "$($handoffBig.Count) compact-handoff/inbox file(s) exceed ${handoffMaxBytes}B: $sample" 'reference artifacts by path (compact_handoff.md: never paste a diff/report/blueprint body into a handoff)'
}

# --- 11. Role worktree containers must be gitignored (P1) ---
# DEC-051: ignore rules live in the nested __garelier/.gitignore. git check-ignore
# honors nested ignore files, so this check is location-agnostic (works for nested
# or legacy-root rules alike).
$null = git -C $ProjectRoot rev-parse --is-inside-work-tree 2>$null
if ($LASTEXITCODE -eq 0) {
    foreach ($wd in @('_workers','_scouts','_smiths','_librarians','_observers','_artisan','_guardians','_concierges')) {
        if (-not (Test-Path (Join-Path $PmRoot $wd) -PathType Container)) { continue }
        $rel = "__garelier/$PmId/$wd"
        git -C $ProjectRoot check-ignore -q $rel 2>$null
        if ($LASTEXITCODE -ne 0) {
            Add-Finding P1 'worktree-not-ignored' "$rel exists but is not gitignored — its worktree content shows as untracked in the target repo" 'copy skills/garelier-core/templates/runtime_gitignore to __garelier/.gitignore (nested; project root untouched — it must include _librarians/ _observers/ _artisan/); re-run setup_wizard --mode migrate to do this automatically'
        }
    }
}

# --- 12. Studio integration-branch topology (DEC-050 operator-surgery class) ---
# The main checkout is where PM/Dock operate and is expected to sit on the studio
# integration branch. A DETACHED HEAD means the integration point has drifted — a
# merge may have landed on a detached fork instead of advancing the studio ref
# (the failure mode that parked the pipeline after the Garelier rebrand). A
# non-studio branch is usually transient (e.g. mid-promote) so it is advisory.
$null = git -C $ProjectRoot rev-parse --is-inside-work-tree 2>$null
if ($LASTEXITCODE -eq 0) {
    $studioBranch = (git -C $ProjectRoot for-each-ref --format='%(refname:short)' refs/heads/ 2>$null |
        Where-Object { $_ -match "^garelier/.*/$PmId/studio$" } | Select-Object -First 1)
    $headBranch = (git -C $ProjectRoot symbolic-ref -q --short HEAD 2>$null)
    if (-not $studioBranch) {
        Add-Finding P2 'studio-branch-missing' "no 'garelier/<slug>/$PmId/studio' branch found — integration-branch topology cannot be verified" 'confirm the studio branch exists (setup_wizard creates it); if the target slug changed, re-run setup_wizard --mode migrate'
    } elseif (-not $headBranch) {
        $headSha = (git -C $ProjectRoot rev-parse --short HEAD 2>$null); if (-not $headSha) { $headSha = '?' }
        $extra = ''
        $subj = (git -C $ProjectRoot log -1 --format='%s' HEAD 2>$null)
        if ($subj -match 'merge .*into studio') {
            git -C $ProjectRoot merge-base --is-ancestor HEAD $studioBranch 2>$null
            if ($LASTEXITCODE -ne 0) { $extra = " — this commit is a 'Merge into studio' fork NOT contained in the studio branch (a merge landed on a detached HEAD instead of advancing studio)" }
        }
        Add-Finding P1 'studio-detached-head' "main checkout is on a DETACHED HEAD ($headSha), expected studio branch '$studioBranch'$extra" "switch the main checkout back to studio (git -C `"$ProjectRoot`" switch `"$studioBranch`"); if a merge landed on a detached fork, replay it onto studio via cherry-pick (DEC-050 operator-surgery)"
    } elseif ($headBranch -ne $studioBranch) {
        Add-Finding P2 'studio-not-checked-out' "main checkout is on '$headBranch', not studio '$studioBranch' (PM/Dock operate from studio; fine if mid-promote)" "if not mid-promote, switch back: git -C `"$ProjectRoot`" switch `"$studioBranch`""
    }
}

# === Report ===
"=== Garelier Doctor — PM '$PmId' ==="
"Project: $ProjectRoot"
''

$p0 = @($Findings | Where-Object { $_.Severity -eq 'P0' })
$p1 = @($Findings | Where-Object { $_.Severity -eq 'P1' })
$p2 = @($Findings | Where-Object { $_.Severity -eq 'P2' })

foreach ($f in ($p0 + $p1 + $p2)) {
    "[$($f.Severity)] $($f.Check): $($f.Detail) — fix: $($f.Fix)"
}

if ($Findings.Count -eq 0) {
    'No issues found. (0 findings)'
}

''
"Summary: $($p0.Count) P0 (blocking), $($p1.Count) P1 (warning), $($p2.Count) P2 (advisory)."

if ($p0.Count -gt 0) { exit 1 }
exit 0
