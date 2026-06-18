#Requires -Version 5.1
<#
.SYNOPSIS
    Dispatch a NON-Claude producer (Codex) as a RUN-TO-COMPLETION subprocess for
    the DEC-057/DEC-058 dispatch Dock. PowerShell parity of
    dispatch_codex_producer.sh.

.DESCRIPTION
    The Claude Agent/Workflow tool can only spawn Claude subagents; this is how
    the interactive Dock/PM gives a role to Codex instead: it runs
    `codex exec` SYNCHRONOUSLY in the role's worktree, waits for completion, and
    prints the producer's final message so the Dock can integrate the
    returned branch via the normal merge gate.

    Sets the codex-cli flags (sandbox / approval_policy / model / reasoning effort)
    so a Codex seat behaves like its claude-code peers under dispatch.

    Exit code = codex exec's exit code. The final message is also echoed to
    stdout between sentinels so it is easy to extract from a background-task log.

.PARAMETER Worktree
    Role worktree (cwd; already on its branch off studio).

.PARAMETER Project
    Project root directory (granted to codex via --add-dir).

.PARAMETER Prompt
    File containing the role prompt (assignment); fed to codex on stdin.

.PARAMETER Result
    File where codex's final message is captured (--output-last-message).

.PARAMETER Sandbox
    codex sandbox: read-only | workspace-write. Default workspace-write
    (commit-bearing roles).

.PARAMETER Model
    Optional codex model name.

.PARAMETER Effort
    Optional reasoning effort: low | medium | high | xhigh.

.PARAMETER SkillRoot
    Optional extra read dir (the Garelier skill root), granted via --add-dir.

.EXAMPLE
    ./dispatch_codex_producer.ps1 -Worktree C:\proj\__garelier\pm\_workers\w1\checkout `
      -Project C:\proj -Prompt assignment.md -Result result.txt
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Worktree,
    [Parameter(Mandatory = $true)][string]$Project,
    [Parameter(Mandatory = $true)][string]$Prompt,
    [Parameter(Mandatory = $true)][string]$Result,
    [ValidateSet("read-only", "workspace-write")][string]$Sandbox = "workspace-write",
    [string]$Model = "",
    [string]$Effort = "",
    [string]$SkillRoot = ""
)

if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
    [Console]::Error.WriteLine("codex CLI not on PATH")
    exit 3
}
if (-not (Test-Path -LiteralPath $Prompt)) {
    [Console]::Error.WriteLine("prompt file not found: $Prompt")
    exit 2
}

# Mirror providers/codex_cli.ts flag construction verbatim (array = no shell
# re-quoting; `approval_policy="never"` keeps its inner quotes, as the adapter does).
$codexArgs = @(
    "exec",
    "--cd", $Worktree,
    "--add-dir", $Project,
    "--sandbox", $Sandbox,
    "-c", 'approval_policy="never"',
    "--output-last-message", $Result,
    "--json"
)
if ($SkillRoot) { $codexArgs += @("--add-dir", $SkillRoot) }
if ($Model)     { $codexArgs += @("--model", $Model) }
if ($Effort)    { $codexArgs += @("-c", "model_reasoning_effort=`"$Effort`"") }
$codexArgs += "-"

[Console]::Error.WriteLine("[dispatch_codex_producer] codex exec (sandbox=$Sandbox cwd=$Worktree) - SYNCHRONOUS, waiting...")

# Feed the prompt file to codex on stdin (the trailing `-` arg).
Get-Content -Raw -LiteralPath $Prompt | & codex @codexArgs
$rc = $LASTEXITCODE

Write-Output "__CODEX_RESULT_BEGIN__"
if (Test-Path -LiteralPath $Result) { Get-Content -Raw -LiteralPath $Result } else { Write-Output "(no result file written)" }
Write-Output "__CODEX_RESULT_END__"
Write-Output "__CODEX_EXIT__:$rc"
exit $rc
