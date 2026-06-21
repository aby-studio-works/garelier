#!/usr/bin/env pwsh
# jig_render.ps1 — Windows twin of jig_render.sh (DEC-062). Renders the Mode E
# jig tick template for a ONE-OFF manual dispatch: reads [jig] from the project's
# setup_config (documented defaults when absent), substitutes the template
# placeholders, writes a runnable workflow script, and prints {scriptPath, jig,
# args_schema} so the PM runs:  Workflow({ scriptPath, args: { items: [ ... ] } })
# Defaults (mode_e_jig.md): fan_out_cap=3 max_rework_rounds=2 smith_batch_every=5
# review_depth.low=gate review_depth.normal=gate+refute. Flag > config > default.
param(
  [Parameter(Mandatory = $true)][string]$Project,
  [Parameter(Mandatory = $true)][string]$PmId,
  [string]$Template,
  [string]$Out,
  [string]$FanOut,
  [string]$MaxRework,
  [string]$SmithEvery,
  [string]$DepthLow,
  [string]$DepthNormal
)
$ErrorActionPreference = 'Stop'
$core = Split-Path -Parent $PSScriptRoot   # skills/garelier-core
$config = Join-Path $Project "__garelier/$PmId/_pm/setup_config.toml"
if (-not (Test-Path -LiteralPath $config)) { Write-Error "jig_render: no setup_config at $config"; exit 2 }
if (-not $Template) { $Template = Join-Path $core 'templates/jig_tick.workflow.js' }
if (-not (Test-Path -LiteralPath $Template)) { Write-Error "jig_render: template not found: $Template"; exit 2 }
if (-not $Out) { $Out = Join-Path $Project "__garelier/$PmId/runtime/jig/tick.workflow.js" }

function Get-TomlValue([string]$section, [string]$key, [string]$default) {
  $ins = $false
  foreach ($raw in Get-Content -LiteralPath $config) {
    $line = $raw -replace "`r$", ""
    if ($line -eq "[$section]") { $ins = $true; continue }
    if ($line -match '^\[') { $ins = $false }
    if ($ins -and ($line -match ("^\s*" + [regex]::Escape($key) + "\s*="))) {
      $v = ($line -replace '^[^=]*=\s*', '' -replace '\s*#.*$', '').Trim().Trim('"')
      if ($v) { return $v }
    }
  }
  return $default
}

if (-not $FanOut)      { $FanOut      = Get-TomlValue 'jig' 'fan_out_cap' '3' }
if (-not $MaxRework)   { $MaxRework   = Get-TomlValue 'jig' 'max_rework_rounds' '2' }
if (-not $SmithEvery)  { $SmithEvery  = Get-TomlValue 'jig' 'smith_batch_every' '5' }
if (-not $DepthLow)    { $DepthLow    = Get-TomlValue 'jig.review_depth' 'low' 'gate' }
if (-not $DepthNormal) { $DepthNormal = Get-TomlValue 'jig.review_depth' 'normal' 'gate+refute' }

foreach ($p in @(@('fan_out_cap', $FanOut), @('max_rework_rounds', $MaxRework), @('smith_batch_every', $SmithEvery))) {
  if ($p[1] -notmatch '^\d+$') { Write-Error ("jig_render: " + $p[0] + " must be a non-negative integer (got '" + $p[1] + "')"); exit 2 }
}

$coreMixed = $core -replace '\\', '/'
$projMixed = $Project -replace '\\', '/'
$text = Get-Content -LiteralPath $Template -Raw
$text = $text.Replace('{{project_root}}', $projMixed).
  Replace('{{pm_id}}', $PmId).
  Replace('{{garelier_core_dir}}', $coreMixed).
  Replace('{{jig_fan_out_cap}}', $FanOut).
  Replace('{{jig_max_rework_rounds}}', $MaxRework).
  Replace('{{jig_smith_batch_every}}', $SmithEvery).
  Replace('{{jig_depth_low}}', $DepthLow).
  Replace('{{jig_depth_normal}}', $DepthNormal)

$outDir = Split-Path -Parent $Out
if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
Set-Content -LiteralPath $Out -Value $text -NoNewline -Encoding utf8

# Only the knob placeholders must be gone; the template keeps a few literal "{{"
# tokens in its DEC-071 placeholder-DETECTION code, which are not knobs.
if ($text -match '\{\{(jig_|project_root|pm_id|garelier_core_dir)') {
  Write-Error "jig_render: an unsubstituted knob placeholder remains in $Out"; exit 1
}

$outMixed = $Out -replace '\\', '/'
$json = [pscustomobject]@{
  scriptPath  = $outMixed
  jig         = [pscustomobject]@{
    fan_out_cap = [int]$FanOut; max_rework_rounds = [int]$MaxRework
    smith_batch_every = [int]$SmithEvery; depth_low = $DepthLow; depth_normal = $DepthNormal
  }
  args_schema = '{ items: [ { role: worker|smith|librarian|artisan, slug: kebab-slug, assignmentPath: <abs path>, criticality: low|normal|critical } ] }'
} | ConvertTo-Json -Compress -Depth 5
Write-Output $json
