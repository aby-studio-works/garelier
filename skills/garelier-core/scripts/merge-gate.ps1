#Requires -Version 5.1
<#
.SYNOPSIS
    Garelier Merge Gate (PowerShell) — v2.2 (DEC-007).

.DESCRIPTION
    Mechanical merge + quality gate executor. Runs the workbench/anvil →
    studio merge and the post-merge quality gate as a background
    subprocess spawned by the driver. NO LLM call. NO Anthropic cost.

    Invoked by the driver with one positional arg: the path to a
    request JSON. Reads the request, runs the merge gate, writes a
    result JSON.

    Concurrency: the driver enforces single-active via locks/active.lock;
    this script trusts that.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$RequestJsonPath
)

$ErrorActionPreference = 'Stop'

# Hardening — no interactive hangs.
$env:GIT_TERMINAL_PROMPT = '0'

# Reproducible-build hardening: the quality gate must reflect the committed
# source + the project's own .cargo/config.toml, NOT a host-machine
# RUSTC_WRAPPER / RUSTC_WORKSPACE_WRAPPER env var (cargo lets the env var
# OVERRIDE config). A stray/broken wrapper — e.g. a leftover
# `RUSTC_WRAPPER=sccache` after a project removed sccache from config, or a
# wrapper that can't run the C compiler — would otherwise false-fail EVERY merge
# build regardless of the candidate's source. Clear both so the gate honors the
# repo's wrapper decision. A project that genuinely wants a wrapper sets it in
# .cargo/config.toml (which cargo still reads).
Remove-Item Env:RUSTC_WRAPPER -ErrorAction SilentlyContinue
Remove-Item Env:RUSTC_WORKSPACE_WRAPPER -ErrorAction SilentlyContinue

if (-not (Test-Path $RequestJsonPath -PathType Leaf)) {
    Write-Error "Request JSON not found: $RequestJsonPath"
    exit 2
}
$RequestJsonPath = (Resolve-Path -LiteralPath $RequestJsonPath).Path

# === Parse request ===
$req = Get-Content -Raw -LiteralPath $RequestJsonPath | ConvertFrom-Json
$RequestId             = $req.request_id
$WorkbenchBranch       = $req.workbench_branch
$StudioBranch          = $req.studio_branch
$MergeMessage          = $req.merge_message
$PreMergeBaseTracking  = if ($null -ne $req.pre_merge_base_tracking) { [bool]$req.pre_merge_base_tracking } else { $true }
$CmdTimeoutMinutes     = if ($req.quality_gate_timeout_minutes_per_cmd) { [int]$req.quality_gate_timeout_minutes_per_cmd } else { 120 }
$QualityGateCommands   = @($req.quality_gate_commands)

# Observer merge gate (DEC-019). Resolve the verdict carried by the request:
# from the Observer report when given (so a request cannot claim a PASS the
# report lacks), else the observer_verdict field. When observer_required=true,
# the merge may proceed only with a passing verdict.
$verdict = $null
$reportPath = [string]$req.observer_report_path
if ($reportPath -and (Test-Path -LiteralPath $reportPath)) {
    $rt = Get-Content -Raw -LiteralPath $reportPath -ErrorAction SilentlyContinue
    if ($rt) {
        $sec = [regex]::Match($rt, '##\s*Verdict[^\n]*\n+\s*(PASS_WITH_NOTES|REWORK_RECOMMENDED|NO_OPINION|PASS|BLOCK)')
        if ($sec.Success) {
            $verdict = $sec.Groups[1].Value
        } else {
            $any = [regex]::Match($rt, 'PASS_WITH_NOTES|REWORK_RECOMMENDED|NO_OPINION|PASS|BLOCK')
            if ($any.Success) { $verdict = $any.Value }
        }
    }
}
if (-not $verdict -and $req.observer_verdict) { $verdict = [string]$req.observer_verdict }
$HasPassingVerdict = ($verdict -in @('PASS', 'PASS_WITH_NOTES'))

$ObserverGateFail = ''
if ($req.observer_required -eq $true) {
    if (-not $verdict) {
        $ObserverGateFail = 'observer_required=true but no Observer verdict found (missing report and observer_verdict)'
    } elseif (-not $HasPassingVerdict) {
        $ObserverGateFail = "observer_required=true but Observer verdict is $verdict (need PASS or PASS_WITH_NOTES)"
    }
}

# Guardian merge gate (DEC-024). Same shape: resolve the Guardian verdict from
# the report (verdict: field) when given, else guardian_verdict; refuse when
# guardian_required=true without a passing verdict.
$gverdict = $null
$greportPath = [string]$req.guardian_report_path
if ($greportPath -and (Test-Path -LiteralPath $greportPath)) {
    $grt = Get-Content -Raw -LiteralPath $greportPath -ErrorAction SilentlyContinue
    if ($grt) {
        $gfront = [regex]::Match($grt, '(?m)^\s*verdict:\s*(PASS_WITH_NOTES|NO_OPINION|PASS|BLOCK)')
        if ($gfront.Success) {
            $gverdict = $gfront.Groups[1].Value
        } else {
            $gany = [regex]::Match($grt, 'PASS_WITH_NOTES|NO_OPINION|PASS|BLOCK')
            if ($gany.Success) { $gverdict = $gany.Value }
        }
    }
}
if (-not $gverdict -and $req.guardian_verdict) { $gverdict = [string]$req.guardian_verdict }
$HasPassingGuardianVerdict = ($gverdict -in @('PASS', 'PASS_WITH_NOTES'))

# review_sha for the stale-verdict guard (G-15): the Guardian reviewed a
# specific commit; if the workbench tip moved since, the verdict is stale.
$greviewSha = ''
if ($grt) {
    $gsha = [regex]::Match($grt, '(?m)^\s*review_sha:\s*([0-9a-fA-F]{7,40})')
    if ($gsha.Success) { $greviewSha = $gsha.Groups[1].Value }
}
if (-not $greviewSha -and $req.guardian_review_sha) { $greviewSha = [string]$req.guardian_review_sha }

$GuardianGateFail = ''
if ($req.guardian_required -eq $true) {
    if (-not $gverdict) {
        $GuardianGateFail = 'guardian_required=true but no Guardian verdict found (missing report and guardian_verdict)'
    } elseif (-not $HasPassingGuardianVerdict) {
        $GuardianGateFail = "guardian_required=true but Guardian verdict is $gverdict (need PASS or PASS_WITH_NOTES)"
    } elseif ($greviewSha -and $WorkbenchBranch) {
        $gtip = (git rev-parse --verify "$WorkbenchBranch^{commit}" 2>$null | Out-String).Trim()
        if ($gtip) {
            $ga = $greviewSha.ToLower(); $gb = $gtip.ToLower()
            if (-not ($ga -eq $gb -or $gb.StartsWith($ga) -or $ga.StartsWith($gb))) {
                $GuardianGateFail = "guardian verdict is stale: reviewed $greviewSha but $WorkbenchBranch tip is now $gtip (re-run Guardian on HEAD)"
            }
        }
    }
}

if (-not $RequestId -or -not $WorkbenchBranch -or -not $StudioBranch) {
    Write-Error "Request JSON missing required fields (request_id / workbench_branch / studio_branch)"
    exit 2
}
if ($QualityGateCommands.Count -eq 0) {
    Write-Error "Request JSON has no quality_gate_commands"
    exit 2
}

# === Paths ===
$RequestDir     = Split-Path -Parent $RequestJsonPath
$RequestFile    = Split-Path -Leaf $RequestJsonPath
$MergeGateRoot  = (Resolve-Path -LiteralPath (Split-Path -Parent $RequestDir)).Path
$ResultDir      = Join-Path $MergeGateRoot 'results'
$LogDir         = Join-Path $MergeGateRoot 'logs'
$LockDir        = Join-Path $MergeGateRoot 'locks'
$ArchiveDir     = Join-Path $MergeGateRoot 'archive'
foreach ($d in @($ResultDir, $LogDir, $LockDir, $ArchiveDir)) {
    if (-not (Test-Path $d -PathType Container)) {
        New-Item -ItemType Directory -Path $d -Force | Out-Null
    }
}

$Stem        = [IO.Path]::GetFileNameWithoutExtension($RequestFile)
$ResultTmp   = Join-Path $ResultDir "$Stem.json.tmp"
$ResultFinal = Join-Path $ResultDir "$Stem.json"
$SummaryTmp   = Join-Path $ResultDir "$Stem.summary.json.tmp"
$SummaryFinal = Join-Path $ResultDir "$Stem.summary.json"
$LogFile     = Join-Path $LogDir    "$Stem.log"

# === Project root inference (5 levels up from request file) ===
$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $RequestDir '..\..\..\..\..')).Path
Set-Location -LiteralPath $ProjectRoot

# Observer-policy backstop (DEC-019): if the request did not already require a
# passing verdict, ask the shared bun helper whether [observer_policy]
# mechanically MANDATES one (large diff / protected paths). Refuse if mandated
# and none accompanies the merge. Default-inert; fail-open on tooling error.
if (-not $ObserverGateFail) {
    $policyTs = Join-Path $PSScriptRoot '..\driver\src\observer_policy_check.ts'
    # pm_id is the 3rd segment of garelier/<slug>/<pm_id>/studio.
    $policyPmId = ($StudioBranch -split '/')[2]
    $policyConfig = if ($policyPmId) { Join-Path $ProjectRoot "__garelier/$policyPmId/_pm/setup_config.toml" } else { '' }
    if ((Test-Path -LiteralPath $policyTs) -and $policyConfig -and (Test-Path -LiteralPath $policyConfig) -and (Get-Command bun -ErrorAction SilentlyContinue)) {
        try {
            $hv = if ($HasPassingVerdict) { 'true' } else { 'false' }
            $reason = (& bun $policyTs (Resolve-Path -LiteralPath $policyConfig).Path $ProjectRoot $StudioBranch $WorkbenchBranch $hv 2>$null | Out-String).Trim()
            if ($reason) { $ObserverGateFail = $reason }
        } catch { }
    }
}

# Guardian-policy backstop (DEC-024): same shape for the security gate.
if (-not $GuardianGateFail) {
    $gpolicyTs = Join-Path $PSScriptRoot '..\driver\src\guardian_policy_check.ts'
    $gpolicyPmId = ($StudioBranch -split '/')[2]
    $gpolicyConfig = if ($gpolicyPmId) { Join-Path $ProjectRoot "__garelier/$gpolicyPmId/_pm/setup_config.toml" } else { '' }
    if ((Test-Path -LiteralPath $gpolicyTs) -and $gpolicyConfig -and (Test-Path -LiteralPath $gpolicyConfig) -and (Get-Command bun -ErrorAction SilentlyContinue)) {
        try {
            $ghv = if ($HasPassingGuardianVerdict) { 'true' } else { 'false' }
            $greason = (& bun $gpolicyTs (Resolve-Path -LiteralPath $gpolicyConfig).Path $ProjectRoot $StudioBranch $WorkbenchBranch $ghv 2>$null | Out-String).Trim()
            if ($greason) { $GuardianGateFail = $greason }
        } catch { }
    }
}

# === State ===
$script:StartedAt        = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
$script:StartedEpoch     = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$script:GateSteps        = @()
$script:Status           = $null
$script:StudioCommit     = $null
$script:FailureReason    = $null
$script:ConflictFiles    = $null   # $null means JSON null; array means populated
$script:PreMergeTargetAdvanced = $false

# === Helpers ===
function Iso-Now { [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }

function Write-ResultJson {
    param(
        [string]$Status,
        [string]$StudioCommit,
        [string]$FailureReason,
        [object]$ConflictFiles
    )
    $ended = Iso-Now
    $durationMs = ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - $script:StartedEpoch) * 1000
    $obj = [ordered]@{
        request_id    = $RequestId
        status        = $Status
        studio_commit = if ([string]::IsNullOrEmpty($StudioCommit)) { $null } else { $StudioCommit }
        started_at    = $script:StartedAt
        ended_at      = $ended
        duration_ms   = $durationMs
        gate_steps    = @($script:GateSteps)
        failure_reason = if ([string]::IsNullOrEmpty($FailureReason)) { $null } else { $FailureReason }
        conflict_files = $ConflictFiles
        pre_merge_target_advanced = $script:PreMergeTargetAdvanced
    }
    $json = $obj | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText($ResultTmp, $json, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $ResultTmp -Destination $ResultFinal -Force

    $stepSummary = @($script:GateSteps | ForEach-Object {
        [ordered]@{
            cmd         = $_.cmd
            exit_code   = $_.exit_code
            duration_ms = $_.duration_ms
        }
    })
    $summary = [ordered]@{
        schema_version = 1
        request_id    = $RequestId
        status        = $Status
        quality_gate_mode = 'full'
        quality_gate_command_count = @($QualityGateCommands).Count
        quality_gate_timeout_minutes_per_cmd = $CmdTimeoutMinutes
        studio_commit = if ([string]::IsNullOrEmpty($StudioCommit)) { $null } else { $StudioCommit }
        started_at    = $script:StartedAt
        ended_at      = $ended
        duration_ms   = $durationMs
        gate_steps    = $stepSummary
        failure_reason = if ([string]::IsNullOrEmpty($FailureReason)) { $null } else { $FailureReason }
        conflict_files = $ConflictFiles
        pre_merge_target_advanced = $script:PreMergeTargetAdvanced
        log_file = "runtime/merge_gate/logs/$Stem.log"
    }
    $summaryJson = $summary | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText($SummaryTmp, $summaryJson, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $SummaryTmp -Destination $SummaryFinal -Force
}

function Append-GateStep {
    param(
        [string]$Cmd,
        [int]$ExitCode,
        [long]$DurationMs,
        [string]$StdoutTail,
        [string]$StderrTail
    )
    $script:GateSteps += [ordered]@{
        cmd          = $Cmd
        exit_code    = $ExitCode
        duration_ms  = $DurationMs
        stdout_tail  = $StdoutTail
        stderr_tail  = $StderrTail
    }
}

function Archive-Files {
    # Subprocess archives ONLY the request (to stop driver re-dispatching).
    # Result + log stay in results/ + logs/ so Dock can read them.
    # Dock archives result + log after consuming. Per DEC-007 §2.3 fix.
    if (Test-Path -LiteralPath $RequestJsonPath) {
        try { Move-Item -LiteralPath $RequestJsonPath -Destination (Join-Path $ArchiveDir "$Stem.request.json") -Force }
        catch { }
    }
}

function Clear-LockIfMine {
    $lockFile = Join-Path $LockDir 'active.lock'
    if (Test-Path -LiteralPath $lockFile) {
        $content = Get-Content -Raw -LiteralPath $lockFile -ErrorAction SilentlyContinue
        if ($content -and $content -match "\""pid\""\s*:\s*$PID") {
            Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
        }
    }
}

function Try-AbortMerge {
    try { git merge --abort 2>&1 | Out-Null } catch { }
}

function Cleanup-Abort {
    param([string]$Signal)
    Add-Content -LiteralPath $LogFile -Value "`n=== cleanup_and_abort: signal=$Signal at $(Iso-Now) ==="
    Try-AbortMerge
    if (-not $script:Status) {
        Write-ResultJson -Status 'aborted' -StudioCommit '' -FailureReason "signal $Signal during merge gate" -ConflictFiles $null
    }
    Archive-Files
    Clear-LockIfMine
}

# Trap SIGTERM-equivalent + general errors.
trap {
    Cleanup-Abort -Signal 'EXCEPTION'
    exit 0
}

# === Header log ===
$header = @"
=== merge-gate.ps1 request $RequestId ===
started_at:      $script:StartedAt
workbench:       $WorkbenchBranch
studio:          $StudioBranch
merge_message:   $MergeMessage
pre_merge_base:  $PreMergeBaseTracking
quality_gate:
$($QualityGateCommands | ForEach-Object { "  - $_" } | Out-String)
cmd_timeout_min: $CmdTimeoutMinutes
project_root:    $ProjectRoot

"@
[IO.File]::WriteAllText($LogFile, $header, [Text.UTF8Encoding]::new($false))

# === Observer merge gate (DEC-019) ===
if ($GuardianGateFail) {
    $script:Status = 'failed'
    $script:FailureReason = $GuardianGateFail
    Add-Content -LiteralPath $LogFile -Value "`n--- guardian gate: REFUSED ---`n$GuardianGateFail"
    Write-ResultJson -Status 'failed' -StudioCommit '' -FailureReason $GuardianGateFail -ConflictFiles $null
    Archive-Files
    Clear-LockIfMine
    exit 0
}
if ($ObserverGateFail) {
    $script:Status = 'failed'
    $script:FailureReason = $ObserverGateFail
    Add-Content -LiteralPath $LogFile -Value "`n--- observer gate: REFUSED ---`n$ObserverGateFail"
    Write-ResultJson -Status 'failed' -StudioCommit '' -FailureReason $ObserverGateFail -ConflictFiles $null
    Archive-Files
    Clear-LockIfMine
    exit 0
}

# === Step 1: checkout studio ===
Add-Content -LiteralPath $LogFile -Value "--- step 1: checkout studio ---"
$checkout = git checkout $StudioBranch 2>&1
Add-Content -LiteralPath $LogFile -Value ($checkout -join "`n")
if ($LASTEXITCODE -ne 0) {
    $script:Status = 'failed'
    $script:FailureReason = "could not checkout $StudioBranch (working tree dirty?)"
    Write-ResultJson -Status $script:Status -StudioCommit '' -FailureReason $script:FailureReason -ConflictFiles $null
    Archive-Files
    Clear-LockIfMine
    exit 0
}

# Defense-in-depth (DEC-050): confirm checkout ATTACHED HEAD to the studio
# BRANCH (not a detached commit). A detached HEAD would strand the merge commit
# on a fork instead of advancing the studio ref (the post-rebrand failure mode).
$headRef = (git symbolic-ref -q --short HEAD 2>$null)
if ($headRef -ne $StudioBranch) {
    $script:Status = 'failed'
    $disp = if ($headRef) { $headRef } else { '<detached>' }
    $script:FailureReason = "after checkout, HEAD is '$disp', not studio branch '$StudioBranch' — refusing to merge onto a detached HEAD (would strand the merge on a fork instead of advancing studio; DEC-050)"
    Add-Content -LiteralPath $LogFile -Value "`n--- studio-attached assert: FAILED ($($script:FailureReason)) ---"
    Write-ResultJson -Status $script:Status -StudioCommit '' -FailureReason $script:FailureReason -ConflictFiles $null
    Archive-Files
    Clear-LockIfMine
    exit 0
}

# === Step 2: pre-merge base tracking ===
if ($PreMergeBaseTracking) {
    # Read setup_config.toml from this request's PM tree. Do not glob
    # across sibling PMs; each PM may target a different branch.
    $PmRoot = (Resolve-Path -LiteralPath (Join-Path $MergeGateRoot '..\..')).Path
    $setupConfig = Join-Path $PmRoot '_pm\setup_config.toml'
    if (Test-Path -LiteralPath $setupConfig -PathType Leaf) {
        $targetLine = (Get-Content -LiteralPath $setupConfig) `
            | Where-Object { $_ -match '^target\s*=\s*"([^"]+)"' } `
            | Select-Object -First 1
        if ($targetLine -and $targetLine -match '"([^"]+)"') {
            $TargetBranch = $matches[1]
            Add-Content -LiteralPath $LogFile -Value "`n--- step 2: base tracking ($TargetBranch → studio) ---"
            git merge-base --is-ancestor $TargetBranch HEAD 2>&1 | Out-Null
            $isAncestor = ($LASTEXITCODE -eq 0)
            if ($isAncestor) {
                Add-Content -LiteralPath $LogFile -Value "studio already contains $TargetBranch tip, skipping merge"
            } else {
                $baseOut = git merge --no-edit $TargetBranch 2>&1
                Add-Content -LiteralPath $LogFile -Value ($baseOut -join "`n")
                if ($LASTEXITCODE -eq 0) {
                    $script:PreMergeTargetAdvanced = $true
                } else {
                    $cf = (git diff --name-only --diff-filter=U 2>&1)
                    Try-AbortMerge
                    $script:Status = 'conflict'
                    $script:FailureReason = "base-tracking merge of $TargetBranch into studio produced conflicts"
                    $script:ConflictFiles = @($cf | Where-Object { $_ -and $_ -notmatch '^fatal:' })
                    Write-ResultJson -Status $script:Status -StudioCommit '' -FailureReason $script:FailureReason -ConflictFiles $script:ConflictFiles
                    Archive-Files
                    Clear-LockIfMine
                    exit 0
                }
            }
        }
    }
}

# === Step 3: merge workbench ===
Add-Content -LiteralPath $LogFile -Value "`n--- step 3: git merge --no-ff --no-commit $WorkbenchBranch ---"
$mergeOut = git merge --no-ff --no-commit $WorkbenchBranch 2>&1
Add-Content -LiteralPath $LogFile -Value ($mergeOut -join "`n")
if ($LASTEXITCODE -ne 0) {
    $cf = (git diff --name-only --diff-filter=U 2>&1) | Where-Object { $_ -and $_ -notmatch '^fatal:' }
    Try-AbortMerge
    if ($cf -and $cf.Count -gt 0) {
        $script:Status = 'conflict'
        $script:FailureReason = "merge produced $($cf.Count) conflicted files"
        $script:ConflictFiles = @($cf)
    } else {
        $script:Status = 'failed'
        $script:FailureReason = 'git merge failed (no conflict markers); see log'
        $script:ConflictFiles = $null
    }
    Write-ResultJson -Status $script:Status -StudioCommit '' -FailureReason $script:FailureReason -ConflictFiles $script:ConflictFiles
    Archive-Files
    Clear-LockIfMine
    exit 0
}

# === Step 4: quality gate ===
$timeoutSecs = $CmdTimeoutMinutes * 60
foreach ($cmd in $QualityGateCommands) {
    if ([string]::IsNullOrWhiteSpace($cmd)) { continue }
    Add-Content -LiteralPath $LogFile -Value "`n--- gate: $cmd ---"
    $stdoutFile = [IO.Path]::GetTempFileName()
    $stderrFile = [IO.Path]::GetTempFileName()
    $cmdStart = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    # Use Start-Process with timeout via Wait-Process -Timeout.
    $proc = Start-Process -FilePath 'pwsh' `
        -ArgumentList '-NoProfile', '-NonInteractive', '-Command', $cmd `
        -RedirectStandardOutput $stdoutFile `
        -RedirectStandardError  $stderrFile `
        -NoNewWindow -PassThru
    $exited = $proc.WaitForExit($timeoutSecs * 1000)
    if (-not $exited) {
        try { $proc.Kill() } catch { }
        $exitCode = -1
    } else {
        $exitCode = $proc.ExitCode
    }
    $cmdEnd = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $cmdDurationMs = ($cmdEnd - $cmdStart) * 1000
    $stdoutText = if (Test-Path $stdoutFile) { Get-Content -Raw -LiteralPath $stdoutFile -ErrorAction SilentlyContinue } else { '' }
    $stderrText = if (Test-Path $stderrFile) { Get-Content -Raw -LiteralPath $stderrFile -ErrorAction SilentlyContinue } else { '' }
    Add-Content -LiteralPath $LogFile -Value $stdoutText
    Add-Content -LiteralPath $LogFile -Value $stderrText
    $stdoutTail = if ($stdoutText) { $stdoutText.Substring([Math]::Max(0, $stdoutText.Length - 800)) } else { '' }
    $stderrTail = if ($stderrText) { $stderrText.Substring([Math]::Max(0, $stderrText.Length - 800)) } else { '' }
    Remove-Item -LiteralPath $stdoutFile, $stderrFile -Force -ErrorAction SilentlyContinue

    Append-GateStep -Cmd $cmd -ExitCode $exitCode -DurationMs $cmdDurationMs -StdoutTail $stdoutTail -StderrTail $stderrTail

    if ($exitCode -ne 0) {
        Try-AbortMerge
        $script:Status = 'failed'
        $script:FailureReason = "quality gate command failed: '$cmd' (exit $exitCode)"
        Write-ResultJson -Status $script:Status -StudioCommit '' -FailureReason $script:FailureReason -ConflictFiles $null
        Archive-Files
        Clear-LockIfMine
        exit 0
    }
}

# === Step 5: commit the merge ===
Add-Content -LiteralPath $LogFile -Value "`n--- step 5: git commit (merge message) ---"
$msgFile = [IO.Path]::GetTempFileName()
Set-Content -LiteralPath $msgFile -Value $MergeMessage -Encoding UTF8
$commitOut = git commit -F $msgFile 2>&1
Remove-Item -LiteralPath $msgFile -Force -ErrorAction SilentlyContinue
Add-Content -LiteralPath $LogFile -Value ($commitOut -join "`n")
if ($LASTEXITCODE -ne 0) {
    Try-AbortMerge
    $script:Status = 'failed'
    $script:FailureReason = 'git commit of merge failed; see log'
    Write-ResultJson -Status $script:Status -StudioCommit '' -FailureReason $script:FailureReason -ConflictFiles $null
    Archive-Files
    Clear-LockIfMine
    exit 0
}
$script:StudioCommit = (git rev-parse HEAD).Trim()
$script:Status = 'success'
Write-ResultJson -Status $script:Status -StudioCommit $script:StudioCommit -FailureReason '' -ConflictFiles $null

# === Step 6: archive ===
Archive-Files
Clear-LockIfMine
exit 0
