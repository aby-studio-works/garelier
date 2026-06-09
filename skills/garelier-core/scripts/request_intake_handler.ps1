[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$RequestDir,

  [Parameter(Mandatory = $true)]
  [string]$RequestBranch,

  [Parameter(Mandatory = $true)]
  [string]$TargetPm,

  [string]$ProjectRoot = ".",
  [string]$CommitSha = "",
  [string]$Now = ""
)

# v2.1: pm-id aware. The target PM is named in the request branch
# (`garelier/request/<target_pm>/<source_pm>/<id>-<uid>`) and passed via
# -TargetPm. All writes go under __garelier/<target_pm>/{control,runtime}/.

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

function Test-TomlListContains {
  param(
    [string]$List,
    [string]$Needle
  )

  $value = $List.Trim()
  if ($value.StartsWith("[") -and $value.EndsWith("]")) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  $items = $value -replace '"', '' -replace '\s+', ''
  if ($items -eq "") {
    return $false
  }
  return (($items -split ',') -contains $Needle)
}

function Test-TomlListEmpty {
  param([string]$List)
  $value = $List.Trim()
  if ($value.StartsWith("[") -and $value.EndsWith("]")) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  $value = $value -replace '"', '' -replace '\s+', ''
  return ($value -eq "")
}

function Test-SourceId {
  param(
    [string]$File,
    [string]$SourceId
  )

  foreach ($raw in Get-Content -LiteralPath $File) {
    if ($raw -match '^\s*id\s*=\s*"([^"]+)"\s*$' -and $Matches[1] -eq $SourceId) {
      return $true
    }
  }
  return $false
}

function Get-PriorityRank {
  param([string]$Priority)
  switch ($Priority) {
    "low" { return 1 }
    "normal" { return 2 }
    "high" { return 3 }
    "urgent" { return 4 }
    default { return 0 }
  }
}

function ConvertTo-TomlEscaped {
  param([string]$Value)
  return $Value.Replace('\', '\\').Replace('"', '\"')
}

function Write-Rejection {
  param(
    [string]$RequestId,
    [string]$Reason
  )

  $safeId = $RequestId
  if ([string]::IsNullOrWhiteSpace($safeId)) {
    $safeId = "unknown-$script:Stamp"
  }

  New-Item -ItemType Directory -Force -Path "$script:PmRuntime/requests/rejected" | Out-Null
  New-Item -ItemType Directory -Force -Path "$script:PmControl/reports/requests" | Out-Null

  @(
    "# Rejected delegated request"
    "request_id = ""$(ConvertTo-TomlEscaped $safeId)"""
    "target_pm = ""$(ConvertTo-TomlEscaped $script:TargetPm)"""
    "request_branch = ""$(ConvertTo-TomlEscaped $script:RequestBranch)"""
    "commit_sha = ""$(ConvertTo-TomlEscaped $script:CommitSha)"""
    "rejected_at = ""$(ConvertTo-TomlEscaped $script:Now)"""
    "reason = ""$(ConvertTo-TomlEscaped $Reason)"""
  ) | Set-Content -LiteralPath "$script:PmRuntime/requests/rejected/$safeId.toml" -Encoding utf8

  $report = @(
    "# Request rejected: $safeId"
    ""
    "- Target PM: ``$script:TargetPm``"
    "- Request branch: ``$script:RequestBranch``"
    "- Commit SHA: ``$script:CommitSha``"
    "- Rejected at: ``$script:Now``"
    "- Reason: $Reason"
  )
  if (Test-Path -LiteralPath $script:RequestToml -PathType Leaf) {
    $report += "- Manifest: ``$script:RequestToml``"
  }
  $report | Set-Content -LiteralPath "$script:PmControl/reports/requests/$safeId-rejected.md" -Encoding utf8

  Write-Error "REJECTED ${safeId}: $Reason" -ErrorAction Continue
}

$ProjectRoot = Resolve-ExistingDirectory $ProjectRoot
Set-Location -LiteralPath $ProjectRoot
$GarelierRoot = Join-Path $ProjectRoot '__garelier'
if (-not (Test-Path -LiteralPath $GarelierRoot -PathType Container)) {
  throw "Not a Garelier project root: $ProjectRoot"
}

# Verify target PM exists locally.
$TargetPmConfig = "__garelier/$TargetPm/_pm/setup_config.toml"
if (-not (Test-Path -LiteralPath $TargetPmConfig -PathType Leaf)) {
  $available = @()
  foreach ($d in (Get-ChildItem -LiteralPath $GarelierRoot -Directory -ErrorAction SilentlyContinue)) {
    if (Test-Path -LiteralPath (Join-Path $d.FullName '_pm/setup_config.toml') -PathType Leaf) {
      $available += $d.Name
    }
  }
  if ($available.Count -gt 0) {
    $list = ($available | ForEach-Object { "         - $_" }) -join "`n"
    throw "Target PM '$TargetPm' is not initialized at $TargetPmConfig.`n       Available PMs:`n$list"
  } else {
    throw "Target PM '$TargetPm' is not initialized at $TargetPmConfig. No PMs initialized; run setup_wizard."
  }
}

$RequestDir = Resolve-ExistingDirectory $RequestDir

$RequestToml = Join-Path $RequestDir ".garelier/request.toml"
$RequestMd = Join-Path $RequestDir ".garelier/request.md"

$PmControl = "__garelier/$TargetPm/control"
$PmRuntime = "__garelier/$TargetPm/runtime"
$AllowSources = "$PmControl/request_intake/allowed_sources.toml"
$AllowKinds = "$PmControl/request_intake/allowed_request_kinds.toml"
$Capabilities = "$PmControl/delegation/capability_registry.toml"

if (-not (Test-Path -LiteralPath $RequestToml -PathType Leaf)) {
  throw "Missing request manifest: $RequestToml"
}

if ([string]::IsNullOrWhiteSpace($Now)) {
  $Now = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
}
$Stamp = [DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss")

if ([string]::IsNullOrWhiteSpace($CommitSha)) {
  try {
    $CommitSha = (& git -C $RequestDir rev-parse HEAD 2>$null).Trim()
  } catch {
    $CommitSha = "unknown"
  }
  if ([string]::IsNullOrWhiteSpace($CommitSha)) {
    $CommitSha = "unknown"
  }
}

$Reasons = [System.Collections.Generic.List[string]]::new()
function Add-RejectReason {
  param([string]$Reason)
  $script:Reasons.Add($Reason) | Out-Null
}

$RequestId = Get-TomlValue $RequestToml "" "request_id"
$ShortUid = Get-TomlValue $RequestToml "" "short_uid"
$SourcePm = Get-TomlValue $RequestToml "" "source_pm"
$ManifestTargetPm = Get-TomlValue $RequestToml "" "target_pm"
$Kind = Get-TomlValue $RequestToml "" "kind"
$Priority = Get-TomlValue $RequestToml "" "priority"
$ManifestBranch = Get-TomlValue $RequestToml "git" "request_branch"
$AllowCommits = Get-TomlValue $RequestToml "safety" "allow_commits"
$AllowPromote = Get-TomlValue $RequestToml "safety" "allow_promote"
$AllowProductionWrite = Get-TomlValue $RequestToml "safety" "allow_production_write"

$branchTarget = ""
$branchSource = ""
$branchRequestId = ""
$branchUid = ""
if ($RequestBranch -match '^garelier/request/([^/]+)/([^/]+)/(R-[0-9]{8}-[0-9]{4}-[a-z0-9-]+)-([a-f0-9]{6,8})$') {
  $branchTarget = $Matches[1]
  $branchSource = $Matches[2]
  $branchRequestId = $Matches[3]
  $branchUid = $Matches[4]
} else {
  Add-RejectReason "request branch does not match garelier/request/<target>/<source>/<request_id>-<uid>"
}

foreach ($field in @("request_id", "short_uid", "source_pm", "target_pm", "kind", "priority", "created_at")) {
  if ([string]::IsNullOrWhiteSpace((Get-TomlValue $RequestToml "" $field))) {
    Add-RejectReason "missing required field: $field"
  }
}
if ([string]::IsNullOrWhiteSpace((Get-TomlValue $RequestToml "git" "request_branch"))) {
  Add-RejectReason "missing required field: git.request_branch"
}
foreach ($field in @("allow_commits", "allow_promote", "allow_production_write")) {
  if ([string]::IsNullOrWhiteSpace((Get-TomlValue $RequestToml "safety" $field))) {
    Add-RejectReason "missing required field: safety.$field"
  }
}

if (Select-String -LiteralPath $RequestToml -Pattern '^\s*(command|commands|script|shell|exec|run|entrypoint|arguments|args|env)\s*=' -Quiet) {
  Add-RejectReason "request manifest contains a forbidden executable field"
}

if ($branchRequestId -ne "" -and $RequestId -ne $branchRequestId) {
  Add-RejectReason "request_id does not match request branch"
}
if ($branchUid -ne "" -and $ShortUid -ne $branchUid) {
  Add-RejectReason "short_uid does not match request branch"
}
if ($branchSource -ne "" -and $SourcePm -ne $branchSource) {
  Add-RejectReason "source_pm does not match request branch"
}
if ($branchTarget -ne "" -and $branchTarget -ne $TargetPm) {
  Add-RejectReason "branch target_pm '$branchTarget' does not match -TargetPm '$TargetPm'"
}
if ($ManifestBranch -ne $RequestBranch) {
  Add-RejectReason "git.request_branch does not match request branch"
}
if ($ManifestTargetPm -ne $TargetPm) {
  Add-RejectReason "target_pm is not this local PM"
}

if (-not (Test-Path -LiteralPath $AllowSources -PathType Leaf)) {
  Add-RejectReason "allowed_sources.toml is missing for target PM '$TargetPm'"
} elseif ($SourcePm -ne "" -and -not (Test-SourceId $AllowSources $SourcePm)) {
  Add-RejectReason "source_pm is not allowlisted"
}

if (-not (Test-Path -LiteralPath $AllowKinds -PathType Leaf)) {
  Add-RejectReason "allowed_request_kinds.toml is missing for target PM '$TargetPm'"
} elseif ($Kind -ne "") {
  if (-not (Test-TomlSection $AllowKinds "kind.$Kind")) {
    Add-RejectReason "kind is not listed in allowed_request_kinds.toml"
  } elseif ((Get-TomlValue $AllowKinds "kind.$Kind" "allowed") -eq "false") {
    Add-RejectReason "kind is explicitly disabled"
  }
}

if (-not (Test-Path -LiteralPath $Capabilities -PathType Leaf)) {
  Add-RejectReason "capability_registry.toml is missing for target PM '$TargetPm'"
} elseif ($Kind -ne "") {
  if (-not (Test-TomlSection $Capabilities "capability.$Kind")) {
    Add-RejectReason "kind is not present in capability_registry.toml"
  } else {
    $capEnabled = Get-TomlValue $Capabilities "capability.$Kind" "enabled"
    $capAllowCommits = Get-TomlValue $Capabilities "capability.$Kind" "allow_commits"
    $capAllowProd = Get-TomlValue $Capabilities "capability.$Kind" "allow_production_write"
    $capSources = Get-TomlValue $Capabilities "capability.$Kind" "allowed_sources"
    $capMaxPriority = Get-TomlValue $Capabilities "capability.$Kind" "max_priority"

    if ($capEnabled -ne "true") {
      Add-RejectReason "capability is not enabled"
    }
    if ($AllowCommits -eq "true" -and $capAllowCommits -ne "true") {
      Add-RejectReason "request allows commits but capability does not"
    }
    if ($AllowProductionWrite -eq "true" -and $capAllowProd -ne "true") {
      Add-RejectReason "request allows production write but capability does not"
    }
    if ([string]::IsNullOrWhiteSpace($capSources) -or (Test-TomlListEmpty $capSources)) {
      Add-RejectReason "capability has no enrolled source PMs"
    } elseif (-not (Test-TomlListContains $capSources $SourcePm)) {
      Add-RejectReason "source_pm is not enrolled for this capability"
    }
    if ($capMaxPriority -ne "" -and (Get-PriorityRank $Priority) -gt (Get-PriorityRank $capMaxPriority)) {
      Add-RejectReason "priority exceeds capability max_priority"
    }
  }
}

if ($AllowPromote -eq "true") {
  Add-RejectReason "allow_promote=true is forbidden"
}

if ($AllowProductionWrite -eq "true") {
  if (-not (Test-TomlSection $RequestToml "data_change_guards")) {
    Add-RejectReason "production write request is missing data_change_guards"
  } else {
    if ((Get-TomlValue $RequestToml "data_change_guards" "dry_run_supported") -ne "true") {
      Add-RejectReason "production write request must support dry_run"
    }
    if ([string]::IsNullOrWhiteSpace((Get-TomlValue $RequestToml "data_change_guards" "rollback_plan"))) {
      Add-RejectReason "production write request is missing rollback_plan"
    }
    if ((Get-TomlValue $RequestToml "data_change_guards" "user_approval_required_per_run") -ne "true") {
      Add-RejectReason "production write request must require per-run user approval"
    }
  }
}

$inboxToml = "$PmRuntime/requests/inbox/$RequestId.toml"
$processedToml = "$PmRuntime/requests/processed/$RequestId.toml"
if ($RequestId -ne "") {
  foreach ($existing in @($inboxToml, $processedToml)) {
    if (Test-Path -LiteralPath $existing -PathType Leaf) {
      $existingSha = Get-TomlValue $existing "intake" "commit_sha"
      if ($existingSha -eq $CommitSha) {
        Write-Output "ALREADY_ACCEPTED $RequestId $CommitSha"
        exit 0
      }
      Add-RejectReason "duplicate request_id exists with a different commit SHA"
    }
  }
}

if ($Reasons.Count -gt 0) {
  Write-Rejection $RequestId ($Reasons -join "; ")
  exit 2
}

New-Item -ItemType Directory -Force -Path "$PmRuntime/requests/inbox" | Out-Null
New-Item -ItemType Directory -Force -Path "$PmRuntime/pm/inbox" | Out-Null
New-Item -ItemType Directory -Force -Path "$PmRuntime/requests/processed" | Out-Null
New-Item -ItemType Directory -Force -Path "$PmRuntime/requests/rejected" | Out-Null
New-Item -ItemType Directory -Force -Path "$PmControl/reports/requests" | Out-Null

$original = Get-Content -LiteralPath $RequestToml -Raw
$normalized = @(
  "# Normalized by Garelier request_intake_handler.ps1"
  $original.TrimEnd()
  ""
  "[intake]"
  "target_pm = ""$(ConvertTo-TomlEscaped $TargetPm)"""
  "commit_sha = ""$(ConvertTo-TomlEscaped $CommitSha)"""
  "received_at = ""$(ConvertTo-TomlEscaped $Now)"""
  "request_dir = ""$(ConvertTo-TomlEscaped $RequestDir)"""
  'handler = "request_intake_handler.ps1"'
) -join [Environment]::NewLine
$normalized | Set-Content -LiteralPath $inboxToml -Encoding utf8

$pmNote = "$PmRuntime/pm/inbox/$Stamp-request-$RequestId.md"
$note = @(
  "# Delegated request accepted: $RequestId"
  ""
  "- Source PM: ``$SourcePm``"
  "- Target PM: ``$ManifestTargetPm``"
  "- Kind: ``$Kind``"
  "- Priority: ``$Priority``"
  "- Request branch: ``$RequestBranch``"
  "- Commit SHA: ``$CommitSha``"
  "- Received at: ``$Now``"
  "- Normalized request: ``$inboxToml``"
)
if (Test-Path -LiteralPath $RequestMd -PathType Leaf) {
  $note += "- Request brief: ``$RequestMd``"
}
$note += @(
  ""
  "PM action:"
  "1. Review the normalized request and delegated capability bounds."
  "2. Convert acceptable work into a blueprint or dashboard task."
  "3. Move the normalized request to ``$PmRuntime/requests/processed/`` when handled."
)
$note | Set-Content -LiteralPath $pmNote -Encoding utf8

Write-Output "ACCEPTED $RequestId $CommitSha"
