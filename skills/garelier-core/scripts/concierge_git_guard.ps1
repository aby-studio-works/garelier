#!/usr/bin/env pwsh
# Garelier Concierge git guard (DEC-030) — PowerShell parity with
# concierge_git_guard.sh. The sanctioned path for any git operation the Concierge
# runs that could touch a remote. Mechanically refuses forbidden operations; the
# pre-push hook is the unconditional backstop for pushes.
#
# Modes:
#   concierge_git_guard.ps1 <git-subcommand> [args...]   (universal bans + run)
#   concierge_git_guard.ps1 preflight-target-push `
#       -Remote <r> -Ref <target> -ExpectedSha <sha> -Verdict <file> -Head <sha>
#
# Exit codes: 0 ok; 2 refused; 3 verify failed; 4 usage.

$ErrorActionPreference = 'Stop'

function Die-Refuse([string]$m) { [Console]::Error.WriteLine("concierge_git_guard: REFUSED — $m"); exit 2 }
function Die-Verify([string]$m) { [Console]::Error.WriteLine("concierge_git_guard: VERIFY FAILED — $m"); exit 3 }
function Die-Usage([string]$m)  { [Console]::Error.WriteLine("concierge_git_guard: usage error — $m"); exit 4 }

$argv = @($args)
if ($argv.Count -lt 1) { Die-Usage 'no command' }
$mode = $argv[0]

if ($mode -eq 'preflight-target-push') {
    $remote = ''; $ref = ''; $expected = ''; $verdict = ''; $head = ''
    for ($i = 1; $i -lt $argv.Count; $i++) {
        switch ($argv[$i]) {
            '--remote'       { $remote = $argv[++$i] }
            '-Remote'        { $remote = $argv[++$i] }
            '--ref'          { $ref = $argv[++$i] }
            '-Ref'           { $ref = $argv[++$i] }
            '--expected-sha' { $expected = $argv[++$i] }
            '-ExpectedSha'   { $expected = $argv[++$i] }
            '--verdict'      { $verdict = $argv[++$i] }
            '-Verdict'       { $verdict = $argv[++$i] }
            '--head'         { $head = $argv[++$i] }
            '-Head'          { $head = $argv[++$i] }
            default          { Die-Usage "unknown preflight arg '$($argv[$i])'" }
        }
    }
    if (-not ($remote -and $ref -and $expected -and $verdict -and $head)) {
        Die-Usage 'preflight-target-push needs --remote --ref --expected-sha --verdict --head'
    }
    if ($ref -like 'garelier/*' -or $ref -like '*/garelier/*') { Die-Refuse "target ref '$ref' is a local-only garelier/* branch" }

    # Drift guard.
    $lsremote = (& git ls-remote $remote "refs/heads/$ref" 2>$null | Select-Object -First 1)
    if (-not $lsremote) {
        [Console]::Error.WriteLine("concierge_git_guard: remote '$remote' has no refs/heads/$ref yet (new branch); skipping drift check.")
    } else {
        $live = ($lsremote -split '\s+')[0]
        if ($live -ne $expected) { Die-Verify "remote $ref tip $live != expected $expected (drift — refuse to clobber)" }
    }

    # Gate guard.
    if (-not (Test-Path $verdict)) { Die-Verify "guardian verdict file not found: $verdict" }
    $vtext = Get-Content -Raw $verdict
    if ($vtext -notmatch '(?im)^\s*verdict\s*:?\s*(PASS|PASS_WITH_NOTES)\b') {
        Die-Verify "guardian verdict in $verdict is not PASS / PASS_WITH_NOTES"
    }
    $m = [regex]::Match($vtext, '(?im)^\s*review_sha\s*:?\s*([0-9a-fA-F]+)')
    if (-not $m.Success) { Die-Verify "guardian verdict in $verdict has no review_sha (cannot bind the gate to the push)" }
    $vsha = $m.Groups[1].Value
    if ($vsha -ne $head) { Die-Verify "guardian review_sha $vsha != head $head (stale verdict — re-gate before pushing)" }
    Write-Output "concierge_git_guard: preflight OK — remote $ref at $expected, PASS verdict bound to $head."
    exit 0
}

# ---- git passthrough mode with universal bans ----
$sub = $mode
$rest = if ($argv.Count -gt 1) { $argv[1..($argv.Count - 1)] } else { @() }

if ($sub -eq 'pull') {
    Die-Refuse "'git pull' is forbidden for the Concierge — use 'fetch' + an explicit, assignment-named merge"
}
if ($sub -eq 'push') {
    foreach ($a in $rest) {
        if ($a -in @('-f', '--force', '--force-with-lease') -or $a -like '--force-with-lease=*') {
            Die-Refuse "force push ('$a') is forbidden (no history rewrite)"
        }
        if ($a -like '*garelier/*') { Die-Refuse "pushing a garelier/* ref ('$a') is forbidden (local-only branches)" }
    }
}

& git @argv
exit $LASTEXITCODE
