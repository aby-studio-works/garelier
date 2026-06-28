#Requires -Version 5.1
<#
.SYNOPSIS
    Initialize a Plant-Crust workfolder/container and optionally run setup.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Workfolder,

    [Parameter(Mandatory = $true)]
    [string]$ContainerId,

    [Parameter(Mandatory = $false)]
    [string]$WorkfolderId,

    [Parameter(Mandatory = $false)]
    [string]$TargetRemote,

    [Parameter(Mandatory = $false)]
    [string]$TargetBranch = 'main',

    [Parameter(Mandatory = $false)]
    [switch]$TargetInit,

    [Parameter(Mandatory = $false)]
    [string]$PmId = '_workshop',

    [Parameter(Mandatory = $false)]
    [string]$ProjectName,

    [Parameter(Mandatory = $false)]
    [switch]$SkipSetup,

    [Parameter(Mandatory = $false)]
    [switch]$SkipConfirm,

    [Parameter(Mandatory = $false)]
    [switch]$Resume,

    [Parameter(Mandatory = $false)]
    [switch]$RepairLock
)

$ErrorActionPreference = 'Stop'

if ($ContainerId -match '[\\/]' -or $ContainerId -match '^\.' -or $ContainerId -notmatch '^[A-Za-z0-9._-]+$') {
    Write-Error "unsafe -ContainerId '$ContainerId'"
    exit 1
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$skillsDir = (Resolve-Path (Join-Path $scriptDir '..\..')).Path
$coreTemplatesDir = if ($env:GARELIER_CORE_TEMPLATES_DIR) { $env:GARELIER_CORE_TEMPLATES_DIR } else { Join-Path $skillsDir 'garelier-core\templates' }
$plantTs = Join-Path $skillsDir 'garelier-core\driver\src\plant.ts'
$setupWizard = Join-Path $skillsDir 'garelier-pm\scripts\setup_wizard.ps1'

New-Item -ItemType Directory -Force -Path $Workfolder | Out-Null
$workfolderPath = (Resolve-Path -LiteralPath $Workfolder).Path
if ([string]::IsNullOrWhiteSpace($WorkfolderId)) {
    $WorkfolderId = ((Split-Path -Leaf $workfolderPath) -replace '[^A-Za-z0-9._-]', '-').Trim('-')
    if ([string]::IsNullOrWhiteSpace($WorkfolderId)) { $WorkfolderId = 'workfolder' }
}
if ([string]::IsNullOrWhiteSpace($ProjectName)) { $ProjectName = $ContainerId }

$containerRoot = Join-Path $workfolderPath $ContainerId
$garelierRoot = Join-Path $containerRoot '__garelier'
$targetRoot = Join-Path $containerRoot 'target'

function Get-CrustContainerPath {
    param([string]$CrustPath, [string]$Id)
    $inContainer = $false
    $cid = ''
    $cpath = ''
    foreach ($line in (Get-Content -LiteralPath $CrustPath)) {
        if ($line -match '^\[\[containers\]\]\s*$') {
            if ($inContainer -and $cid -eq $Id) {
                if ([string]::IsNullOrWhiteSpace($cpath)) { return $cid }
                return $cpath
            }
            $inContainer = $true; $cid = ''; $cpath = ''; continue
        }
        if ($line -match '^\[') {
            if ($inContainer -and $cid -eq $Id) {
                if ([string]::IsNullOrWhiteSpace($cpath)) { return $cid }
                return $cpath
            }
            $inContainer = $false; $cid = ''; $cpath = ''; continue
        }
        if ($inContainer -and $line -match '^\s*id\s*=\s*"([^"]+)"') { $cid = $matches[1]; continue }
        if ($inContainer -and $line -match '^\s*path\s*=\s*"([^"]+)"') { $cpath = $matches[1]; continue }
    }
    if ($inContainer -and $cid -eq $Id) {
        if ([string]::IsNullOrWhiteSpace($cpath)) { return $cid }
        return $cpath
    }
    return ''
}

New-Item -ItemType Directory -Force -Path $garelierRoot | Out-Null

if (-not (Test-Path -LiteralPath $targetRoot)) {
    if (-not [string]::IsNullOrWhiteSpace($TargetRemote)) {
        & git clone --branch $TargetBranch $TargetRemote $targetRoot
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } elseif ($TargetInit) {
        New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null
        & git -C $targetRoot init
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        & git -C $targetRoot checkout -B $TargetBranch *>$null
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        & git -C $targetRoot commit --allow-empty -m 'chore: initialize target' *>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Error "target repo initialized but initial empty commit failed. Fix git user.name/user.email, create the first commit, then rerun setup from $garelierRoot."
            exit 1
        }
    } else {
        Write-Error "$targetRoot does not exist. Pass -TargetRemote, -TargetInit, or create target/ first."
        exit 1
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $targetRoot '.git'))) {
    Write-Error "target root is not a git repository: $targetRoot"
    exit 1
}
if (Test-Path -LiteralPath (Join-Path $targetRoot '__garelier')) {
    Write-Error "Plant-Crust forbids target_root/__garelier: $(Join-Path $targetRoot '__garelier')"
    exit 1
}
& git -C $targetRoot rev-parse HEAD *>$null
if ($LASTEXITCODE -ne 0) {
    Write-Error 'target repository has no commits. Create one before setup.'
    exit 1
}
& git -C $targetRoot rev-parse --verify $TargetBranch *>$null
if ($LASTEXITCODE -ne 0) {
    Write-Error "target branch '$TargetBranch' does not exist in $targetRoot."
    exit 1
}

$crustPath = Join-Path $workfolderPath 'crust.toml'
$lockPath = Join-Path $containerRoot 'container.lock.toml'
$oldErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    $addOutput = & bun $plantTs add-container --crust $crustPath --workfolder-id $WorkfolderId --container-id $ContainerId --container-path $ContainerId 2>&1
    $addExit = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $oldErrorActionPreference
}
if ($addExit -ne 0) {
    if (($Resume -or $RepairLock) -and (($addOutput | Out-String) -match 'container already exists')) {
        $existingPath = Get-CrustContainerPath -CrustPath $crustPath -Id $ContainerId
        if ($existingPath -ne $ContainerId) {
            Write-Error "existing container '$ContainerId' uses path '$existingPath'; crust-init resume only supports path '$ContainerId'."
            exit 1
        }
    } else {
        $addOutput | ForEach-Object { Write-Error $_ }
        exit $addExit
    }
}

& bun $plantTs write-lock --crust $crustPath --lock $lockPath --container $ContainerId --target-remote ([string]$TargetRemote) --target-branch $TargetBranch > $null
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($RepairLock) {
    Write-Host "Plant-Crust lock repaired: $lockPath"
    exit 0
}

$ignoreTemplate = Join-Path $coreTemplatesDir 'plant_crust_gitignore'
$ignorePath = Join-Path $workfolderPath '.gitignore'
if ((Test-Path -LiteralPath $ignoreTemplate) -and -not (Test-Path -LiteralPath $ignorePath)) {
    Copy-Item -LiteralPath $ignoreTemplate -Destination $ignorePath
}

Write-Host 'Plant-Crust initialized:'
Write-Host "  workfolder: $workfolderPath"
Write-Host "  container:  $containerRoot"
Write-Host "  control:    $garelierRoot"
Write-Host "  target:     $targetRoot"

if ($SkipSetup) { exit 0 }

Write-Host ''
Write-Host 'Running Garelier setup inside Plant-Crust container...'
Push-Location $garelierRoot
try {
    if ($SkipConfirm) {
        & $setupWizard -Mode Fresh -PmId $PmId -ProjectName $ProjectName -Target $TargetBranch -TargetRoot 'target' -SkipConfirm
    } else {
        & $setupWizard -Mode Fresh -PmId $PmId -ProjectName $ProjectName -Target $TargetBranch -TargetRoot 'target'
    }
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
