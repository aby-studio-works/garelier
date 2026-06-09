#Requires -Version 5.1
<#
.SYNOPSIS
    Garelier installer (PowerShell version).

.DESCRIPTION
    Creates symbolic links from each skills/garelier-* directory into
    %USERPROFILE%\.claude\skills\ so that Claude Code can discover them
    across all projects.

    Requires Windows Developer Mode to be enabled, OR running as
    Administrator.

    Enable Developer Mode at:
        Settings -> Update & Security -> For Developers -> Developer Mode

.NOTES
    Bash equivalent: install.sh (for MSYS2 or Git Bash).
    Use whichever fits your shell preference; both produce identical
    install layouts.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SourceDir = Join-Path $ScriptDir 'skills'
$SkillsDir = Join-Path $env:USERPROFILE '.claude\skills'

if (-not (Test-Path $SourceDir)) {
    Write-Error "skills directory not found at $SourceDir"
    exit 1
}

if (-not (Test-Path $SkillsDir)) {
    New-Item -ItemType Directory -Path $SkillsDir -Force | Out-Null
}

$installed = 0
$skills = @(Get-ChildItem -Path $SourceDir -Directory -Filter 'garelier-*')

foreach ($skill in $skills) {
    $skillName = $skill.Name
    $skillPath = $skill.FullName
    $target = Join-Path $SkillsDir $skillName

    if (Test-Path $target) {
        $item = Get-Item $target -Force
        $isReparsePoint = ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0

        if ($isReparsePoint) {
            # Existing symlink or junction — safe to replace
            Remove-Item $target -Force
        }
        else {
            # Real directory — preserve it under a timestamped backup
            $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
            $backup = "$target.bak.$stamp"
            Write-Host "  ! $target exists. Backing up to $backup"
            Move-Item $target $backup
        }
    }

    try {
        New-Item -ItemType SymbolicLink -Path $target -Target $skillPath | Out-Null
        Write-Host "  + $skillName"
        $installed++
    }
    catch {
        Write-Error @"
Failed to create symlink for $skillName.
Reason: $($_.Exception.Message)

This usually means Windows Developer Mode is not enabled. Enable it at:
  Settings -> Update & Security -> For Developers -> Developer Mode
Then re-run this script.
"@
        exit 1
    }
}

Write-Host ""
if ($installed -eq 0) {
    Write-Host "No skills found under $SourceDir (yet)."
    Write-Host "Add directories named 'garelier-*' under skills/ and re-run."
}
else {
    Write-Host "Installed $installed skill(s) into $SkillsDir"
    Write-Host ""
    Write-Host "Dev tip: to use the 'garelier <subcommand>' command (e.g. 'garelier doctor')"
    Write-Host "         in this symlink install, add this repo's bin\ to your PATH:"
    Write-Host "           `$env:PATH = `"$ScriptDir\bin;`$env:PATH`""
    Write-Host "         (plugin installs add bin/ to PATH automatically.)"
    Write-Host ""
    Write-Host "See docs/getting_started.md to bootstrap a project."
}
