#Requires -Version 5.1
<#
.SYNOPSIS
    Garelier Status (PowerShell) — v2.1 (pm-id aware).

.DESCRIPTION
    Show current project state in a human-readable form. Reads, per PM:
      - __garelier/<pm_id>/_pm/setup_config.toml
      - __garelier/<pm_id>/runtime/driver/driver.pid
      - __garelier/<pm_id>/runtime/driver/pids/*.pid (detached agent leases)
      - __garelier/<pm_id>/runtime/driver/logs/...
      - __garelier/<pm_id>/_workers/<id>/STATE.md
      - __garelier/<pm_id>/_scouts/<id>/STATE.md
      - __garelier/<pm_id>/_smiths/<id>/STATE.md
      - __garelier/<pm_id>/runtime/manifest.md

    Without -PmId, lists ALL PMs found under __garelier/. With -PmId,
    shows only that PM. -Watch refreshes in place.

.PARAMETER PmId
    Restrict output to a single PM. Without this flag, every PM under
    __garelier/ is shown.

.PARAMETER ProjectRoot
    Project root to inspect. Defaults to current working directory.

.PARAMETER Watch
    Re-print every N seconds. Stops on Ctrl-C.
#>

[CmdletBinding()]
param(
    [string]$PmId = '',
    [string]$ProjectRoot = (Get-Location).Path,
    [int]$Watch = 0
)

$ErrorActionPreference = 'Stop'

# If $ProjectRoot doesn't contain __garelier/, try walking up — the user
# may have cd'd into __garelier/<pm_id>/_pm/ (the natural place to be).
function Find-ProjectRoot {
    param([string]$Start)
    $cur = (Resolve-Path -LiteralPath $Start -ErrorAction SilentlyContinue).Path
    if (-not $cur) { return $null }
    while ($true) {
        if (Test-Path -LiteralPath (Join-Path $cur '__garelier') -PathType Container) {
            return $cur
        }
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
        Write-Error "Not a Garelier project root: $ProjectRoot (no __garelier/ directory found here or in any parent). Pass -ProjectRoot <path>."
        exit 1
    }
}

$GarelierRoot = Join-Path $ProjectRoot '__garelier'

# Per-PM state, set by Set-PmPaths for each PM iteration.
$script:Config        = ''
$script:PmRoot        = ''
$script:DriverDir     = ''
$script:DriverPidFile = ''
$script:PidsDir       = ''
$script:LogsDir       = ''
$script:Manifest      = ''

function Set-PmPaths {
    param([string]$Pm)
    $script:PmRoot        = Join-Path $GarelierRoot $Pm
    $script:Config        = Join-Path $script:PmRoot '_pm/setup_config.toml'
    $script:DriverDir     = Join-Path $script:PmRoot 'runtime/driver'
    $script:DriverPidFile = Join-Path $script:DriverDir 'driver.pid'
    $script:PidsDir       = Join-Path $script:DriverDir 'pids'
    $script:LogsDir       = Join-Path $script:DriverDir 'logs'
    $script:Manifest      = Join-Path $script:PmRoot 'runtime/manifest.md'
}

function Get-DiscoveredPms {
    $result = @()
    foreach ($d in (Get-ChildItem -LiteralPath $GarelierRoot -Directory -ErrorAction SilentlyContinue)) {
        if (Test-Path -LiteralPath (Join-Path $d.FullName '_pm/setup_config.toml') -PathType Leaf) {
            $result += $d.Name
        }
    }
    return $result
}

# === Helpers ===

function Read-Toml {
    param([string]$Section, [string]$Key)
    $inSection = $false
    foreach ($line in (Get-Content -LiteralPath $script:Config)) {
        if ($line -match "^\[$([regex]::Escape($Section))\]") { $inSection = $true; continue }
        if ($line -match '^\[') { $inSection = $false; continue }
        if ($inSection -and $line -match "^$([regex]::Escape($Key))\s*=\s*(.*?)(\s*#.*)?$") {
            $val = $matches[1].Trim()
            $val = $val -replace '^"|"$', ''
            return $val
        }
    }
    return ''
}

function Truncate-Field {
    # Compress whitespace and cap at $Max chars (with "..." suffix when
    # truncated). STATE.md fields and Dock result lines tend to
    # contain multi-paragraph narratives that blow the status display;
    # this is the display-side safeguard. Agents should still write
    # compact entries (see per-role SKILL.md).
    param([string]$Value, [int]$Max = 100)
    if (-not $Value) { return $Value }
    $v = $Value.Trim() -replace '\s+', ' '
    if ($v.Length -gt $Max) { return $v.Substring(0, $Max - 3) + '...' }
    return $v
}

function Get-StateField {
    param([string]$File, [string]$Section)
    if (-not (Test-Path $File -PathType Leaf)) { return '(no STATE.md)' }
    # Canonical template format: "## Status\n\nWORKING" header sections.
    $capture = $false
    foreach ($line in (Get-Content -LiteralPath $File)) {
        if ($line -eq "## $Section") { $capture = $true; continue }
        if ($capture -and $line -match '^## ') { break }
        if ($capture -and $line.Trim()) { return $line.Trim() }
    }
    # Fallback: tolerate the "- Field: value" list-item style that Workers
    # sometimes emit instead of the canonical header form. Map the common
    # field aliases so the status helper still gets sensible output.
    $aliases = @{
        'Status'        = @('Current state', 'Status', 'State')
        'Current task'  = @('Task ID', 'Current task', 'Task')
        'Current branch'= @('Branch', 'Current branch')
        'Last activity' = @('Reported at', 'Picked up at', 'Last activity')
    }
    $keys = if ($aliases.ContainsKey($Section)) { $aliases[$Section] } else { @($Section) }
    foreach ($line in (Get-Content -LiteralPath $File)) {
        foreach ($k in $keys) {
            if ($line -match "^[-*]\s+$([regex]::Escape($k))\s*:\s*(.+)$") {
                $val = $matches[1].Trim()
                if ($val -and $val -ne 'n/a') { return $val }
            }
        }
    }
    return ''
}

function Get-ManifestSection {
    param([string]$Section)
    if (-not (Test-Path $script:Manifest -PathType Leaf)) { return @() }
    $result = @()
    $capture = $false
    $headerPattern = '^##\s+' + [regex]::Escape($Section) + '(\s|\(|$)'
    foreach ($line in (Get-Content -LiteralPath $script:Manifest)) {
        if ($line -match $headerPattern) { $capture = $true; continue }
        if ($capture -and $line -match '^## ') { break }
        if ($capture) { $result += $line }
    }
    return $result
}

function Get-ManifestAgentStatus {
    param([string]$Role, [string]$Id)
    $section = switch ($Role) {
        'workers' { 'Active Workers' }
        'scouts'  { 'Active Scouts' }
        'smiths'  { 'Active Smiths' }
        default   { '' }
    }
    if (-not $section) { return '' }
    foreach ($line in (Get-ManifestSection $section)) {
        if ($line -notmatch '^\|') { continue }
        $cells = @($line.Trim('|') -split '\|' | ForEach-Object { $_.Trim() })
        if ($cells.Count -lt 2) { continue }
        if ($cells[0] -eq $Id -and $cells[1] -notmatch '^-+$') {
            return $cells[1]
        }
    }
    return ''
}

function Get-AgentIds {
    param([string]$Section)
    $result = @()
    $inSection = $false
    foreach ($line in (Get-Content -LiteralPath $script:Config)) {
        if ($line -match "^\[\[$([regex]::Escape($Section))\]\]") { $inSection = $true; continue }
        if ($line -match '^\[') { $inSection = $false; continue }
        if ($inSection -and $line -match '^id\s*=\s*"([^"]+)"') {
            $result += $matches[1]
        }
    }
    return $result
}

function Test-PidAlive {
    param([int]$ProcessId)
    try {
        $null = Get-Process -Id $ProcessId -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Read-RolePidFile {
    param([string]$Path)
    $raw = (Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue).Trim()
    if ($raw -match '^\d+$') {
        return [pscustomobject]@{
            Pid = [int]$raw
            Status = ''
            Branch = ''
            AssignmentHash = ''
        }
    }
    try {
        $obj = $raw | ConvertFrom-Json
        return [pscustomobject]@{
            Pid = if ($obj.pid) { [int]$obj.pid } elseif ($obj.child_pid) { [int]$obj.child_pid } else { $null }
            Status = [string]$obj.status
            Branch = [string]$obj.branch
            AssignmentHash = [string]$obj.assignment_hash
        }
    } catch {
        return [pscustomobject]@{
            Pid = $null
            Status = 'corrupt'
            Branch = ''
            AssignmentHash = ''
        }
    }
}

function Format-Lines {
    param([string[]]$Lines, [string]$Prefix = '    ')
    $out = @()
    foreach ($l in $Lines) {
        if ($l.Trim()) { $out += ($Prefix + $l) }
    }
    if ($out.Count -eq 0) { $out += ($Prefix + '(empty)') }
    return ($out -join "`n")
}

# DEC-035: a role's container may live in a machine-local home OUTSIDE the
# project; the gitignored pointer records its absolute path. Resolve to that when
# present, else fall back to the in-proj container path passed in.
function Get-StatusPointerKey {
    param([string]$Role, [string]$Id)
    if ($Role -eq 'artisan') { return 'artisan' }
    $r = switch ($Role) {
        'workers' {'worker'} 'scouts' {'scout'} 'smiths' {'smith'} 'librarians' {'librarian'}
        'observers' {'observer'} 'guardians' {'guardian'} 'concierges' {'concierge'} default { $Role.TrimEnd('s') }
    }
    return "$r.$Id"
}
function Resolve-StatusContainer {
    param([string]$Role, [string]$Id, [string]$Fallback)
    $pf = Join-Path $script:PmRoot 'runtime/workspace_paths'
    $key = Get-StatusPointerKey $Role $Id
    if (Test-Path -LiteralPath $pf) {
        foreach ($line in (Get-Content -LiteralPath $pf)) {
            if ($line.StartsWith("$key=")) { return $line.Substring($key.Length + 1) }
        }
    }
    return $Fallback
}

function Get-GitDirtySummary {
    param([string]$Path)
    if (-not (Test-Path $Path -PathType Container)) { return '' }
    # DEC-020 / DEC-035: a worktree role's git tree is <container>/checkout; the bare
    # container has no .git, so `git -C <container>` would walk UP to the primary
    # (studio) checkout and misreport ITS dirtiness as the role's. Prefer the
    # nested checkout worktree when present (PM/Dock have no checkout and
    # legitimately share the primary checkout).
    if (Test-Path (Join-Path $Path 'checkout/.git')) { $Path = Join-Path $Path 'checkout' }
    $null = & git -C $Path rev-parse --show-toplevel 2>$null
    if ($LASTEXITCODE -ne 0) { return '' }
    $lines = @(& git -C $Path status --short --untracked-files=normal 2>$null)
    if ($LASTEXITCODE -ne 0 -or $lines.Count -eq 0) { return '' }
    $sample = @($lines | Select-Object -First 5 | ForEach-Object { $_.Trim() })
    $suffix = if ($lines.Count -gt $sample.Count) { '; ...' } else { '' }
    return ('{0} entries ({1}{2})' -f $lines.Count, ($sample -join '; '), $suffix)
}

function Get-SmithTargetCountFromFile {
    param([string]$Path)
    if (-not (Test-Path $Path -PathType Leaf)) { return 0 }
    $seen = @{}
    foreach ($line in (Get-Content -LiteralPath $Path)) {
        if ($line -notmatch '(?i)(smith_targets|smith target|covered worker merges|covered merges|smith hardening targets)') {
            continue
        }
        if ($line -match '(?i)(none|n/a)') {
            continue
        }
        foreach ($m in [regex]::Matches($line, '#\d+(?:@[0-9A-Fa-f]+)?')) {
            $seen[$m.Value] = $true
        }
    }
    return $seen.Count
}

function Test-ActiveAgentStatus {
    param([string]$Status)
    return @('ASSIGNED', 'WORKING', 'REPORTING', 'REVIEWING', 'REWORK', 'BLOCKED') -contains $Status
}

function Get-ActiveSmithTargetSummary {
    $dir = Join-Path $script:PmRoot '_smiths'
    $activeTargets = 0
    $activeBatches = 0
    $unknownBatches = 0
    foreach ($id in (Get-AgentIds 'smiths')) {
        $agentDir = Resolve-StatusContainer 'smiths' $id (Join-Path $dir $id)   # DEC-035
        $sf = Join-Path $agentDir 'STATE.md'
        $assignment = Join-Path $agentDir 'assignment.md'
        $status = Get-StateField -File $sf -Section 'Status'
        if ((Test-ActiveAgentStatus $status) -or ((Test-Path $assignment -PathType Leaf) -and $status -ne 'MERGED' -and $status -ne 'ABORTED')) {
            $activeBatches++
            $count = Get-SmithTargetCountFromFile $assignment
            if ($count -gt 0) {
                $activeTargets += $count
            } else {
                $unknownBatches++
            }
        }
    }
    return @{
        ActiveTargets = $activeTargets
        ActiveBatches = $activeBatches
        UnknownBatches = $unknownBatches
    }
}

function Write-SmithHardeningCounters {
    $pendingFile = Join-Path $script:PmRoot 'runtime/backlog/pending.md'
    $pendingCount = Get-SmithTargetCountFromFile $pendingFile
    $active = Get-ActiveSmithTargetSummary
    $total = $pendingCount + $active.ActiveTargets
    $note = "    Smith hardening targets remaining:   $total (pending $pendingCount, active $($active.ActiveTargets))"
    if ($active.UnknownBatches -gt 0) {
        $note += "; active batches missing parseable targets: $($active.UnknownBatches)"
    }
    $note
}

function Write-RoleBlock {
    param([string]$Role)
    $dir = switch ($Role) {
        'workers'    { Join-Path $script:PmRoot '_workers' }
        'scouts'     { Join-Path $script:PmRoot '_scouts' }
        'smiths'     { Join-Path $script:PmRoot '_smiths' }
        'librarians' { Join-Path $script:PmRoot '_librarians' }
        'observers'  { Join-Path $script:PmRoot '_observers' }
        'guardians'  { Join-Path $script:PmRoot '_guardians' }
        'concierges' { Join-Path $script:PmRoot '_concierges' }
        default      { '' }
    }
    if (-not $dir) { return }
    foreach ($id in (Get-AgentIds $Role)) {
        $agentDir = Resolve-StatusContainer $Role $id (Join-Path $dir $id)   # DEC-035
        $sf = Join-Path $agentDir 'STATE.md'
        $status = Get-StateField -File $sf -Section 'Status'
        $task   = Truncate-Field (Get-StateField -File $sf -Section 'Current task')   100
        $last   = Truncate-Field (Get-StateField -File $sf -Section 'Last activity')  120
        '  {0,-12} {1,-10}  task: {2}' -f $id, $status, $task
        '  {0,-12} {1,-10}  last: {2}' -f '', '', $last
        $manifestStatus = Get-ManifestAgentStatus -Role $Role -Id $id
        if ($manifestStatus -and $manifestStatus -ne $status) {
            '  {0,-12} {1,-10}  manifest: {2}; STATE: {3}' -f '', 'STALE', $manifestStatus, $status
        }
        $dirty = Get-GitDirtySummary -Path $agentDir
        if ($dirty) {
            '  {0,-12} {1,-10}  git dirty: {2}' -f '', 'DIRTY', $dirty
        }
    }
}

function Write-ArtisanBlock {
    # Artisan is a singleton [artisan] table (not an array); worktree _artisan/.
    $wt = Resolve-StatusContainer 'artisan' '' (Join-Path $script:PmRoot '_artisan')   # DEC-035
    $enabled = Read-Toml 'artisan' 'enabled'
    if ($enabled -ne 'true' -and -not (Test-Path $wt -PathType Container)) {
        '  {0,-12} {1,-10}' -f 'artisan', 'disabled'
        return
    }
    $sf = Join-Path $wt 'STATE.md'
    $status = Get-StateField -File $sf -Section 'Status'
    $task   = Truncate-Field (Get-StateField -File $sf -Section 'Current task')  100
    $last   = Truncate-Field (Get-StateField -File $sf -Section 'Last activity') 120
    '  {0,-12} {1,-10}  task: {2}' -f 'artisan', $status, $task
    '  {0,-12} {1,-10}  last: {2}' -f '', '', $last
    $dirty = Get-GitDirtySummary -Path $wt
    if ($dirty) { '  {0,-12} {1,-10}  git dirty: {2}' -f '', 'DIRTY', $dirty }
}

function Get-Lane {
    # Active lane from runtime/lane.lock (artisan | dock). Default: idle.
    $lf = Join-Path $script:PmRoot 'runtime/lane.lock'
    if (Test-Path $lf -PathType Leaf) {
        $m = [regex]::Match((Get-Content -LiteralPath $lf -Raw), '"lane"\s*:\s*"([^"]*)"')
        if ($m.Success) { return ('{0} (lane.lock held)' -f $m.Groups[1].Value) }
        return 'held (unparseable lane.lock)'
    }
    return 'idle/dock (no lane.lock)'
}

function Write-ObserverIo {
    # Observer request/result inbox counts + recent verdicts (schema-agnostic).
    $reqDir = Join-Path $script:PmRoot 'runtime/observer/requests'
    $resDir = Join-Path $script:PmRoot 'runtime/observer/results'
    $req = if (Test-Path $reqDir) { @(Get-ChildItem -LiteralPath $reqDir -File -ErrorAction SilentlyContinue).Count } else { 0 }
    $res = if (Test-Path $resDir) { @(Get-ChildItem -LiteralPath $resDir -File -ErrorAction SilentlyContinue).Count } else { 0 }
    '    pending requests: {0}    results: {1}' -f $req, $res
    if (Test-Path $resDir) {
        foreach ($f in (Get-ChildItem -LiteralPath $resDir -File -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -First 3)) {
            $m = [regex]::Match((Get-Content -LiteralPath $f.FullName -Raw -ErrorAction SilentlyContinue), 'PASS_WITH_NOTES|REWORK_RECOMMENDED|NO_OPINION|PASS|BLOCK')
            $verdict = if ($m.Success) { $m.Value } else { '?' }
            '    - {0}: {1}' -f $f.Name, $verdict
        }
    }
}

function Get-LastIteration {
    param([string]$JsonlPath)
    if (-not (Test-Path $JsonlPath -PathType Leaf)) { return $null }
    $lines = Get-Content -LiteralPath $JsonlPath -Tail 200
    $lastEnd = $null
    $lastResult = $null
    foreach ($line in $lines) {
        if (-not $line.Trim()) { continue }
        try { $obj = $line | ConvertFrom-Json -ErrorAction Stop } catch { continue }
        if ($obj.event -eq 'iteration_end' -or $obj.event -eq 'iteration_failed') { $lastEnd = $obj }
        if ($obj.event -eq 'model_result') { $lastResult = $obj }
    }
    if (-not $lastEnd) { return $null }
    return @{
        when = $lastEnd.ts
        durationMs = $lastEnd.duration_ms
        costUsd = $lastEnd.cost_usd
        numTurns = $lastEnd.num_turns
        outcome = if ($lastEnd.event -eq 'iteration_failed') { 'failed' } else { 'ok' }
        action = if ($lastResult) { $lastResult.text } else { '' }
    }
}

function Format-AgoSeconds {
    # See history: must accept arbitrary type to keep Utc DateTime objects from
    # being stringified through local culture (observed JST 9h drift bug).
    param($Iso)
    try {
        $then = $null
        if ($Iso -is [DateTime]) {
            switch ($Iso.Kind) {
                'Utc'   { $then = $Iso }
                'Local' { $then = $Iso.ToUniversalTime() }
                default { $then = [DateTime]::SpecifyKind($Iso, 'Utc') }
            }
        } else {
            $then = [DateTimeOffset]::Parse([string]$Iso).UtcDateTime
        }
        $now  = [DateTime]::UtcNow
        $secs = [int]($now - $then).TotalSeconds
        if ($secs -lt 0)     { return $Iso.ToString() }
        if ($secs -lt 60)    { return "${secs}s ago" }
        if ($secs -lt 3600)  { return "$([int]($secs / 60))m ago" }
        if ($secs -lt 86400) { return "$([int]($secs / 3600))h ago" }
        return "$([int]($secs / 86400))d ago"
    } catch { return $Iso.ToString() }
}

function Format-Duration {
    param([int]$Ms)
    if (-not $Ms) { return '?' }
    $s = [int]($Ms / 1000)
    if ($s -lt 60) { return "${s}s" }
    $m = [int]($s / 60); $rs = $s % 60
    return "${m}m${rs}s"
}

function Write-DriverRoleBlock {
    param(
        [string]$Role,
        [bool]$IsSupervised
    )
    if ($Role -eq 'pm' -and -not $IsSupervised) {
        '  {0,-12} {1,-10}  user-managed interactive session (driver supervise_pm = false)' -f $Role, 'HYBRID'
        return
    }
    $logPath = Join-Path $script:LogsDir "$Role.jsonl"
    $last = Get-LastIteration -JsonlPath $logPath
    if (-not $last) {
        '  {0,-12} {1,-10}  no iterations yet' -f $Role, '—'
        return
    }
    $when = Format-AgoSeconds $last.when
    $cost = if ($last.costUsd) { '$' + ('{0:F3}' -f $last.costUsd) } else { '?' }
    $dur  = Format-Duration $last.durationMs
    $turns = if ($last.numTurns) { "$($last.numTurns) turns" } else { '? turns' }
    '  {0,-12} {1,-10}  last iter: {2}  cost {3}  {4}  duration {5}' -f $Role, $last.outcome.ToUpper(), $when, $cost, $turns, $dur
    if ($last.action) {
        $text = Truncate-Field $last.action 140
        '  {0,-12} {1,-10}  result: {2}' -f '', '', $text
    }
}

function Write-PmSection {
    param([string]$Pm)
    Set-PmPaths $Pm

    if (-not (Test-Path $script:Config -PathType Leaf)) {
        "=== PM: $Pm === (missing setup_config.toml — skipping)"
        return
    }

    # Top-line liveness summary: RUNNING / STOPPED / STALE.
    $driverAlive = $false
    $stalePid    = $false
    if (Test-Path $script:DriverPidFile -PathType Leaf) {
        $raw = (Get-Content -LiteralPath $script:DriverPidFile -Raw).Trim()
        if ($raw -match '^\d+$') {
            if (Test-PidAlive ([int]$raw)) { $driverAlive = $true } else { $stalePid = $true }
        }
    }
    $stopFilePresent = Test-Path (Join-Path $script:DriverDir 'stop') -PathType Leaf
    $mergeLockPresent = Test-Path (Join-Path $script:PmRoot 'runtime/merge_gate/locks/active.lock') -PathType Leaf

    # Detect rate-limit state by scanning recent driver.jsonl entries
    # for level:error event:"rate_limited" or event:"rate_limit_backoff".
    $rateLimitNote = ''
    $jsonlPath = Join-Path $script:LogsDir 'driver.jsonl'
    if (Test-Path $jsonlPath -PathType Leaf) {
        $lastLines = Get-Content -LiteralPath $jsonlPath -Tail 50 -ErrorAction SilentlyContinue
        $rlEvents = @()
        foreach ($ln in $lastLines) {
            if ($ln -match '"event"\s*:\s*"(rate_limited|rate_limit_backoff|rate_limited_recorded)"') {
                $rlEvents += $ln
            }
        }
        if ($rlEvents.Count -gt 0) {
            $latestRl = $rlEvents[-1]
            $tsMatch = [regex]::Match($latestRl, '"ts"\s*:\s*"([^"]+)"')
            if ($tsMatch.Success) {
                $rlAgo = Format-AgoSeconds $tsMatch.Groups[1].Value
                $rateLimitNote = " — RATE_LIMITED ($($rlEvents.Count) hits in last 50 events, latest $rlAgo)"
            }
        }
    }

    $summary =
        if     ($driverAlive -and $stopFilePresent) { 'SHUTTING_DOWN' }
        elseif ($driverAlive -and $rateLimitNote)   { "RUNNING$rateLimitNote" }
        elseif ($driverAlive)                       { 'RUNNING' }
        elseif ($stalePid)                          { 'STOPPED_DIRTY (stale pid file — see Driver below)' }
        else                                        { 'STOPPED' }

    "=== PM: $Pm — $summary ==="

    $proj        = Read-Toml -Section 'project'  -Key 'name'
    $target      = Read-Toml -Section 'branches' -Key 'target'
    $integration = Read-Toml -Section 'branches' -Key 'integration'
    $enabled     = Read-Toml -Section 'autonomy' -Key 'enabled'
    $supervise   = Read-Toml -Section 'autonomy' -Key 'supervise_pm'
    $poll        = Read-Toml -Section 'autonomy' -Key 'driver_poll_interval_seconds'
    if (-not $poll) { $poll = '30' }

    "  Project: $proj"
    "  Target:  $target"
    "  Studio:  $integration"
    if ($enabled -eq 'true') {
        if ($supervise -eq 'false') {
            "  Mode:    autonomous (hybrid: PM interactive, others driver-supervised), poll=${poll}s"
        } else {
            "  Mode:    autonomous (full: driver supervises all roles), poll=${poll}s"
        }
    } else {
        "  Mode:    classic (autonomy disabled, no driver)"
    }

    ''
    '  --- Driver ---'
    $dpid = $null
    if (Test-Path $script:DriverPidFile -PathType Leaf) {
        $dpidRaw = (Get-Content -LiteralPath $script:DriverPidFile -Raw).Trim()
        if ($dpidRaw -match '^\d+$') { $dpid = [int]$dpidRaw }
        if ($dpid -and (Test-PidAlive $dpid)) {
            "  Driver: alive (PID $dpid)"
        } else {
            "  Driver: STALE pid file (PID $dpidRaw not alive — zombie marker, kill -9 / crash / power loss)"
        }
    } else {
        '  Driver: not running'
    }

    if (Test-Path $script:PidsDir -PathType Container) {
        $running = @()
        $finished = @()
        $stale = @()
        foreach ($f in (Get-ChildItem -Path $script:PidsDir -Filter '*.pid' -ErrorAction SilentlyContinue)) {
            $lease = Read-RolePidFile -Path $f.FullName
            $shortHash = if ($lease.AssignmentHash) { ", assignment $($lease.AssignmentHash.Substring(0, [Math]::Min(12, $lease.AssignmentHash.Length)))" } else { '' }
            if ($lease.Pid -and (Test-PidAlive $lease.Pid)) {
                $branch = if ($lease.Branch) { ", $($lease.Branch)" } else { '' }
                $running += "$($f.BaseName)(PID $($lease.Pid)$branch$shortHash)"
            } elseif ($lease.Status -eq 'finished') {
                $finished += "$($f.BaseName)(finished)"
            } elseif ($lease.Pid) {
                $stale += "$($f.BaseName)(STALE PID $($lease.Pid))"
            }
        }
        if ($running.Count -gt 0) {
            "  Agent leases running: $($running -join ' ')"
        } else {
            '  Agent leases running: (none right now)'
        }
        if ($finished.Count -gt 0) { "  Agent leases finished, pending driver cleanup: $($finished -join ' ')" }
        if ($stale.Count -gt 0) { "  Agent leases stale: $($stale -join ' ')" }
        # Concurrency cap (DEC-027): how the budget looks right now.
        $ccMax = Read-Toml 'concurrency' 'max_concurrent_agents'
        if (-not $ccMax) { $ccMax = '4' }
        if ($ccMax -eq '0') {
            "  Concurrency cap: disabled (0) — $($running.Count) detached agent(s) alive, no bound"
        } else {
            "  Concurrency cap: $($running.Count) / $ccMax detached agents alive (PM/Dock/merge-gate uncapped)"
        }
        # Output control (DEC-028): enabled + latest-month over-budget ratio.
        $ocEnabled = Read-Toml 'output_control' 'enabled'
        if ($ocEnabled -eq 'false') {
            '  Output control: disabled'
        } else {
            $ocDefault = Read-Toml 'output_control' 'default_profile'
            if (-not $ocDefault) { $ocDefault = 'compact' }
            $usageDir = Join-Path $script:DriverDir 'usage'
            $latestUsage = if (Test-Path $usageDir) {
                Get-ChildItem -Path $usageDir -Filter '*.jsonl' -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -Last 1
            } else { $null }
            if ($latestUsage) {
                $ocLines = @(Get-Content -Path $latestUsage.FullName -ErrorAction SilentlyContinue | Where-Object { $_.Trim() })
                $ocOver = @($ocLines | Where-Object { $_ -match '"over_budget":\s*true' }).Count
                "  Output control: enabled (default $ocDefault); $($latestUsage.BaseName) over soft budget: $ocOver / $($ocLines.Count) iterations"
            } else {
                "  Output control: enabled (default $ocDefault; no usage recorded yet)"
            }
        }
    }

    if ($dpid -and (Test-PidAlive $dpid)) {
        try {
            $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $dpid" -ErrorAction Stop |
                Where-Object { $_.Name -match 'claude|codex' } |
                Select-Object ProcessId, Name, CommandLine
            if ($children.Count -gt 0) {
                $running = @()
                foreach ($c in $children) {
                    $running += "PID $($c.ProcessId)"
                }
                "  Spawning provider CLI: $($running -join ', ')"
            } else {
                '  Spawning provider CLI: (none right now)'
            }
        } catch {
            '  Spawning provider CLI: (n/a — CIM not available)'
        }
    }

    ''
    '  --- PM ---'
    Write-DriverRoleBlock -Role 'pm' -IsSupervised ($supervise -ne 'false')

    ''
    '  --- Dock ---'
    Write-DriverRoleBlock -Role 'dock' -IsSupervised $true

    ''
    '  --- Workers ---'
    Write-RoleBlock 'workers'

    ''
    '  --- Scouts ---'
    Write-RoleBlock 'scouts'

    ''
    '  --- Smiths ---'
    Write-RoleBlock 'smiths'

    ''
    "  --- Artisan (lane: $(Get-Lane)) ---"
    Write-ArtisanBlock

    ''
    '  --- Librarians ---'
    Write-RoleBlock 'librarians'

    ''
    '  --- Observers ---'
    Write-RoleBlock 'observers'

    ''
    '  --- Guardians ---'
    Write-RoleBlock 'guardians'

    ''
    '  --- Concierges ---'
    Write-RoleBlock 'concierges'

    ''
    '  --- Observer requests/results ---'
    Write-ObserverIo

    ''
    '  --- Backlog ---'
    Format-Lines (Get-ManifestSection 'Backlog summary')

    # Scout / Worker / Inspection counters: real counts from the filesystem
    # (not manifest) so the numbers don't lie when the driver is stopped
    # or manifest is stale. Per DEC-008, Scout inspections live under
    # control/inspections/<category>/...; per DEC-009 they may be
    # date-partitioned (.../<category>/YYYY/MM/...).
    $donedir = Join-Path $script:PmRoot 'runtime/backlog/done'
    $doneCount = if (Test-Path $donedir) {
        @(Get-ChildItem -Path $donedir -Filter '*.md' -File -ErrorAction SilentlyContinue).Count
    } else { 0 }
    $inspDir = Join-Path $script:PmRoot 'control/inspections'
    $inspCount = if (Test-Path $inspDir) {
        @(Get-ChildItem -Path $inspDir -Recurse -Filter '*.md' -File -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -ne 'README.md' -and $_.Name -ne '.gitkeep' }).Count
    } else { 0 }
    $intakePending = 0
    $pmInbox = Join-Path $script:PmRoot 'runtime/pm/inbox'
    if (Test-Path $pmInbox) {
        $intakePending = @(Get-ChildItem -Path $pmInbox -Filter '*scout-intake*.md' -File -ErrorAction SilentlyContinue).Count
    }
    "    Tasks done (runtime/backlog/done/):       $doneCount"
    "    Inspections committed (control/inspections/): $inspCount"
    "    Scout intake pending in PM inbox:        $intakePending"
    Write-SmithHardeningCounters

    ''
    '  --- Active milestones ---'
    Format-Lines (Get-ManifestSection 'Active milestones')

    ''
    '  --- Open escalations ---'
    Format-Lines (Get-ManifestSection 'Open escalations')

    ''
    '  --- Recent activity (manifest, latest 5, truncated) ---'
    # Dock LLM tends to write very long bullets (verbose narrative).
    # Take only the most recent 5 entries (top of section = most recent
    # per project convention) and truncate each to 160 chars with an
    # ellipsis. Full content lives in runtime/manifest.md.
    $recent = Get-ManifestSection 'Recent activity'
    $bullets = $recent | Where-Object { $_.Trim() -match '^[-*]\s' } | Select-Object -First 5
    if ($bullets.Count -eq 0) {
        '    (none)'
    } else {
        foreach ($b in $bullets) {
            $trimmed = $b.Trim()
            if ($trimmed.Length -gt 160) {
                '    ' + $trimmed.Substring(0, 157) + '...'
            } else {
                '    ' + $trimmed
            }
        }
        if ($recent.Count -gt 5) {
            "    (... see __garelier/<pm_id>/runtime/manifest.md for full history)"
        }
    }

    ''
    '  --- driver log (last 8 lines of meaningful events) ---'
    $stdoutLog = Join-Path $script:LogsDir 'driver.stdout.log'
    $jsonlLog  = Join-Path $script:LogsDir 'driver.jsonl'
    $legacyLog = Join-Path $script:LogsDir 'driver.log'
    $candidates = @($stdoutLog, $jsonlLog, $legacyLog)
    $shown = $false
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate -PathType Leaf) {
            "    (source: $($candidate.Substring($ProjectRoot.Length + 1)))"
            Format-Lines (Get-Content -LiteralPath $candidate -Tail 8)
            $shown = $true
            break
        }
    }
    if (-not $shown) {
        '    (driver never started for this PM)'
        return
    }

    # Heartbeat: stdout.log only updates on info-level events
    # (iteration_start/end, merge_gate_spawned etc). Driver may be alive
    # and polling every poll_seconds while stdout.log stays silent for
    # tens of minutes. Show driver.jsonl's last debug line so the
    # operator can see the actual poll heartbeat.
    if (Test-Path $jsonlLog -PathType Leaf) {
        $lastJsonl = Get-Content -LiteralPath $jsonlLog -Tail 1 -ErrorAction SilentlyContinue
        if ($lastJsonl) {
            try {
                $obj = $lastJsonl | ConvertFrom-Json -ErrorAction Stop
                $ago = Format-AgoSeconds $obj.ts
                "    heartbeat: $ago — $($obj.event) ($($obj.source))"
            } catch {
                # ignore parse errors
            }
        }
    }
}

function Write-Status {
    $now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

    "=== Garelier Status — $now ==="
    "Root: $ProjectRoot"
    ''

    $pms = @()
    if (-not [string]::IsNullOrWhiteSpace($PmId)) {
        $pms = @($PmId)
    } else {
        $pms = Get-DiscoveredPms
    }

    if ($pms.Count -eq 0) {
        "No Garelier PMs found under $GarelierRoot."
        'Run setup_wizard to initialize a PM.'
        return
    }

    $first = $true
    foreach ($pm in $pms) {
        if (-not $first) { '' }
        $first = $false
        Write-PmSection $pm
    }
}

if ($Watch -gt 0) {
    while ($true) {
        Clear-Host
        Write-Status
        Start-Sleep -Seconds $Watch
    }
} else {
    Write-Status
}
