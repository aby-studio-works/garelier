[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$JobId,

  [string]$PmId = "",
  [string]$ProjectRoot = ".",
  [string]$Now = ""
)

# v2.1: pm-id aware. Jobs live under __garelier/<pm_id>/control/scheduled_jobs/
# and run state under __garelier/<pm_id>/runtime/scheduled_jobs/.

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

function Resolve-ExistingDirectory {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "Directory not found: $Path"
  }
  return (Resolve-Path -LiteralPath $Path).Path
}

function Get-TomlValue {
  param(
    [string]$File,
    [string]$Section,
    [string]$Key
  )

  $inside = ($Section -eq "")
  $keyPattern = [regex]::Escape($Key)

  foreach ($raw in Get-Content -LiteralPath $File) {
    $line = $raw.Trim()
    if ($line -eq "" -or $line.StartsWith("#")) {
      continue
    }
    if ($line -match '^\[(.+)\]\s*$') {
      $inside = ($Matches[1] -eq $Section)
      continue
    }
    if ($inside -and $line -match "^\s*$keyPattern\s*=(.*)$") {
      $value = $Matches[1] -replace '\s+#.*$', ''
      $value = $value.Trim()
      if ($value.StartsWith('"') -and $value.EndsWith('"') -and $value.Length -ge 2) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      return $value
    }
  }

  return ""
}

function Test-TomlSection {
  param(
    [string]$File,
    [string]$Section
  )

  $sectionPattern = [regex]::Escape($Section)
  foreach ($raw in Get-Content -LiteralPath $File) {
    if ($raw.Trim() -match "^\[$sectionPattern\]\s*$") {
      return $true
    }
  }
  return $false
}

function ConvertTo-TomlEscaped {
  param([string]$Value)
  return $Value.Replace('\', '\\').Replace('"', '\"')
}

function ConvertTo-SafeName {
  param([string]$Value)
  return ($Value -replace '[^A-Za-z0-9._-]', '_')
}

function Resolve-PmId {
  param([string]$GarelierRoot, [string]$Requested)
  if (-not [string]::IsNullOrWhiteSpace($Requested)) { return $Requested }
  $candidates = @()
  foreach ($d in (Get-ChildItem -LiteralPath $GarelierRoot -Directory -ErrorAction SilentlyContinue)) {
    if (Test-Path -LiteralPath (Join-Path $d.FullName '_pm/setup_config.toml') -PathType Leaf) {
      $candidates += $d.Name
    }
  }
  switch ($candidates.Count) {
    0 { throw "No Garelier PM initialized under $GarelierRoot; run setup_wizard." }
    1 { return $candidates[0] }
    default {
      $list = ($candidates | ForEach-Object { "         - $_" }) -join "`n"
      throw "Multiple PMs found under ${GarelierRoot} — pass -PmId <id>.`n       Available PMs:`n$list"
    }
  }
}

function Write-Run {
  param(
    [string]$Status,
    [string]$Reason = ""
  )

  New-Item -ItemType Directory -Force -Path $script:RunDir | Out-Null
  $lines = @(
    "job_id = ""$(ConvertTo-TomlEscaped $script:JobId)"""
    "run_id = ""$(ConvertTo-TomlEscaped $script:RunId)"""
    "pm_id = ""$(ConvertTo-TomlEscaped $script:PmId)"""
    "triggered_at = ""$(ConvertTo-TomlEscaped $script:Now)"""
    "status = ""$(ConvertTo-TomlEscaped $Status)"""
    'adapter = "scheduler_adapter.ps1"'
  )
  if ($Reason -ne "") {
    $lines += "reason = ""$(ConvertTo-TomlEscaped $Reason)"""
  }
  $lines | Set-Content -LiteralPath (Join-Path $script:RunDir "run.toml") -Encoding utf8
}

if ($JobId -notmatch '^J-[A-Za-z0-9._-]+$') {
  throw "Invalid job id: $JobId"
}

$ProjectRoot = Resolve-ExistingDirectory $ProjectRoot
Set-Location -LiteralPath $ProjectRoot
$GarelierRoot = Join-Path $ProjectRoot '__garelier'
if (-not (Test-Path -LiteralPath $GarelierRoot -PathType Container)) {
  throw "Not a Garelier project root: $ProjectRoot"
}

$PmId = Resolve-PmId $GarelierRoot $PmId
$PmConfig = "__garelier/$PmId/_pm/setup_config.toml"
if (-not (Test-Path -LiteralPath $PmConfig -PathType Leaf)) {
  throw "PM '$PmId' not found ($PmConfig missing)."
}

$JobFile = "__garelier/$PmId/control/scheduled_jobs/$JobId.toml"
if (-not (Test-Path -LiteralPath $JobFile -PathType Leaf)) {
  throw "Scheduled job file not found: $JobFile"
}

if ([string]::IsNullOrWhiteSpace($Now)) {
  $Now = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
}
$Stamp = [DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss")
$RunId = ($Now -replace '[:+]', '-' -replace '[^A-Za-z0-9._-]', '-')
$RunDir = "__garelier/$PmId/runtime/scheduled_jobs/runs/$JobId/$RunId"

$manifestJobId = Get-TomlValue $JobFile "" "job_id"
$status = Get-TomlValue $JobFile "" "status"
$ownerRole = Get-TomlValue $JobFile "" "owner_role"
$timezone = Get-TomlValue $JobFile "" "timezone"
$schedule = Get-TomlValue $JobFile "" "schedule"
$purpose = Get-TomlValue $JobFile "" "purpose"
$allowCommits = Get-TomlValue $JobFile "safety" "allow_commits"
$allowPromote = Get-TomlValue $JobFile "safety" "allow_promote"
$allowProductionWrite = Get-TomlValue $JobFile "safety" "allow_production_write"
$lockResource = Get-TomlValue $JobFile "lock" "resource"
$lockMode = Get-TomlValue $JobFile "lock" "mode"

if ($manifestJobId -ne $JobId) {
  Write-Run "failed_validation" "job_id field does not match -JobId"
  throw "job_id field does not match -JobId"
}

if ($status -ne "active") {
  Write-Run "skipped_status" "job status is $status"
  Write-Output "SKIPPED_STATUS $JobId $status"
  exit 0
}

foreach ($field in @("owner_role", "timezone", "schedule", "purpose")) {
  if ([string]::IsNullOrWhiteSpace((Get-TomlValue $JobFile "" $field))) {
    Write-Run "failed_validation" "missing required field: $field"
    throw "Missing required field: $field"
  }
}
foreach ($field in @("allow_commits", "allow_promote", "allow_production_write")) {
  if ([string]::IsNullOrWhiteSpace((Get-TomlValue $JobFile "safety" $field))) {
    Write-Run "failed_validation" "missing required field: safety.$field"
    throw "Missing required field: safety.$field"
  }
}

if ($allowPromote -eq "true") {
  Write-Run "failed_validation" "allow_promote=true is forbidden"
  throw "allow_promote=true is forbidden for scheduled jobs"
}

if ($allowProductionWrite -eq "true") {
  if (-not (Test-TomlSection $JobFile "data_change_guards")) {
    Write-Run "failed_validation" "production write job is missing data_change_guards"
    throw "Production write job is missing data_change_guards"
  }
  if ((Get-TomlValue $JobFile "data_change_guards" "dry_run_supported") -ne "true" -or
      [string]::IsNullOrWhiteSpace((Get-TomlValue $JobFile "data_change_guards" "rollback_plan")) -or
      (Get-TomlValue $JobFile "data_change_guards" "user_approval_required_per_run") -ne "true") {
    Write-Run "failed_validation" "production write job has incomplete data_change_guards"
    throw "Production write job has incomplete data_change_guards"
  }
}

if ([string]::IsNullOrWhiteSpace($lockResource)) {
  $lockResource = $JobId
}
if ([string]::IsNullOrWhiteSpace($lockMode)) {
  $lockMode = "skip_if_running"
}
if ($lockMode -ne "skip_if_running") {
  Write-Run "failed_validation" "unsupported lock mode: $lockMode"
  throw "Unsupported lock mode in reference adapter: $lockMode"
}

$lockName = ConvertTo-SafeName $lockResource
$lockDir = "__garelier/$PmId/runtime/scheduled_jobs/locks/$lockName.lock"

New-Item -ItemType Directory -Force -Path "__garelier/$PmId/runtime/scheduled_jobs/locks" | Out-Null
New-Item -ItemType Directory -Force -Path "__garelier/$PmId/runtime/pm/inbox" | Out-Null

try {
  New-Item -ItemType Directory -Path $lockDir -ErrorAction Stop | Out-Null
} catch {
  Write-Run "skipped_locked" "lock already exists: $lockDir"
  Write-Output "SKIPPED_LOCKED $JobId $lockDir"
  exit 0
}

@(
  "job_id = ""$(ConvertTo-TomlEscaped $JobId)"""
  "run_id = ""$(ConvertTo-TomlEscaped $RunId)"""
  "pm_id = ""$(ConvertTo-TomlEscaped $PmId)"""
  "created_at = ""$(ConvertTo-TomlEscaped $Now)"""
  "resource = ""$(ConvertTo-TomlEscaped $lockResource)"""
  "mode = ""$(ConvertTo-TomlEscaped $lockMode)"""
  'owner = "scheduler_adapter.ps1"'
) | Set-Content -LiteralPath (Join-Path $lockDir "lock.toml") -Encoding utf8

Write-Run "notified_pm"
"lock_dir = ""$(ConvertTo-TomlEscaped $lockDir)""" |
  Add-Content -LiteralPath (Join-Path $RunDir "run.toml") -Encoding utf8

$pmNote = "__garelier/$PmId/runtime/pm/inbox/$Stamp-scheduled-job-$JobId.md"
@(
  "# Scheduled job due: $JobId"
  ""
  "- PM: ``$PmId``"
  "- Owner role: ``$ownerRole``"
  "- Timezone: ``$timezone``"
  "- Schedule: ``$schedule``"
  "- Purpose: $purpose"
  "- Triggered at: ``$Now``"
  "- Job file: ``$JobFile``"
  "- Run directory: ``$RunDir``"
  "- Lock directory: ``$lockDir``"
  "- allow_commits: ``$allowCommits``"
  "- allow_production_write: ``$allowProductionWrite``"
  ""
  "PM action:"
  "1. Review job inputs, safety flags, and dashboard context."
  "2. Convert the due job into normal PM/Dock work as needed."
  "3. Update ``$RunDir/run.toml`` to a terminal status and remove ``$lockDir`` when complete."
) | Set-Content -LiteralPath $pmNote -Encoding utf8

Write-Output "NOTIFIED_PM $JobId $RunId"
